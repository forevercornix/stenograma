const { hasPermission } = require("../utils/permissions");
const { KNOWN_ROLES } = require("../utils/credentials");
const { createLogger } = require("../utils/logger");
const { rasytiAudita, AuditWriteError } = require("../utils/auditWrite");
const { auditoGedimas } = require("../utils/auditHttp");

const log = createLogger("authz");

/**
 * AUTORIZACIJA (#18 PR2).
 *
 * Šis middleware sprendžia TIK „ar leidžiama", ne „kas tu esi" – tapatybę jau
 * nustatė `sessionAuth` (sesija) arba `apiKeyAuth` (bendras raktas).
 *
 * DU AUTENTIFIKACIJOS MECHANIZMAI VIENU METU – kodėl.
 *
 * Sesijos (#18 PR1) yra kryptis į priekį, bet bendras `API_KEY` jau naudojamas
 * esamuose diegimuose ir skriptuose. Staigus jo pašalinimas sulaužytų juos be
 * įspėjimo. Todėl abu veikia lygiagrečiai, o `API_KEY` turėtojui priskiriama
 * rolė per `API_KEY_ROLE`.
 */

/**
 * `API_KEY` rolė.
 *
 * NUMATYTA `administrator` SĄMONINGAI – tai IŠLAIKO esamą elgesį: iki šio PR
 * rakto turėtojas galėjo viską, įskaitant `DELETE`. Numatytoji `operator`
 * tyliai sulaužytų veikiančią automatiką.
 *
 * ⚠️ KAINA, kurią reikia žinoti: kol `API_KEY_ROLE=administrator`, RBAC
 * NERIBOJA rakto turėtojų – jie ir toliau gali viską. Realiam rolių atskyrimui
 * reikia arba susiaurinti šią reikšmę iki `operator`, arba pereiti prie
 * sesijų. Tai dokumentuota README ir tikrinama startup įspėjimu.
 */
function resolveApiKeyRole(env = process.env) {
  const raw = (env.API_KEY_ROLE || "administrator").trim().toLowerCase();
  return KNOWN_ROLES.includes(raw) ? raw : null;
}

/**
 * Vienoda tapatybė iš BET KURIO mechanizmo.
 *
 * Sesija turi PIRMENYBĘ prieš API raktą: jei klientas atsiuntė ir sesijos
 * cookie, ir raktą, autoritetinga yra konkreti vartotojo tapatybė, ne bendras
 * raktas. Priešingu atveju vartotojas su `operator` role galėtų pakelti savo
 * teises vien pridėdamas bendrą raktą prie užklausos.
 */
function resolveIdentity(req) {
  if (req.user && req.user.role) {
    return { actor: req.user.username, role: req.user.role, source: "session" };
  }

  if (req.apiKeyAuthenticated) {
    const role = resolveApiKeyRole();
    return role ? { actor: "api-key", role, source: "api-key" } : null;
  }

  return null;
}

/**
 * Reikalauja KONKRETAUS leidimo (ne rolės).
 *
 * Maršrutai nurodo leidimą, ne rolę – kitaip rolių žemėlapio pakeitimas
 * reikštų kiekvieno maršruto redagavimą, ir dvi vietos ilgainiui išsiskirtų.
 */
function requirePermission(permission) {
  /**
   * ⚠️ ASYNC NUO 7.4a (#210). `AUTHORIZATION_DENIED` yra BLOKUOJANTIS įvykis:
   * 403 negali būti grąžintas anksčiau, nei patvirtintas audito įrašas - kitaip
   * bandymai viršyti teises liktų be pėdsako būtent tada, kai audito labiausiai
   * reikia. Express 5 palaiko async middleware.
   */
  return async function authorize(req, res, next) {
    const identity = resolveIdentity(req);

    /**
     * 401 vs 403 – SKIRTINGI dalykai, ir klientas turi juos atskirti.
     *
     * 401: „nežinau, kas tu esi" -> prisijunk.
     * 403: „žinau, kas tu esi, bet neleidžiama" -> prisijungimas nepadės.
     *
     * Grąžinus 403 neautentifikuotam klientui, frontend rodytų „neturite
     * teisės" ten, kur realiai tereikia prisijungti.
     */
    if (!identity) {
      return res.status(401).json({ error: "Reikalingas prisijungimas.", code: "SESSION_REQUIRED" });
    }

    if (!hasPermission(identity.role, permission)) {
      /** Audito gedimas čia reiškia, kad 403 negali būti deklaruotas - žr. `auditoGedimas`. */
      /**
       * AUDITAS: atmestas leidimas yra saugumo įvykis (#17 modelis) – be jo
       * nematytume nei bandymų viršyti teises, nei per siaurai sukonfigūruotų
       * rolių, kurios trukdo teisėtam darbui.
       */
      try {
        await rasytiAudita({
          event: "AUTHORIZATION_DENIED",
          success: false,
          outcome: "forbidden",
          details: `permission=${permission} role=${identity.role} source=${identity.source}`,
        });
      } catch (error) {
        if (error instanceof AuditWriteError) return auditoGedimas(res, error, "authorize auditas");
        throw error;
      }
      log.warn("Prieiga atmesta", { permission, role: identity.role, source: identity.source });

      return res.status(403).json({
        error: "Neturite teisės atlikti šio veiksmo.",
        code: "PERMISSION_DENIED",
        // Klientui pasakom, KO trūksta - be to frontend negalėtų paaiškinti
        // vartotojui, kodėl mygtukas neveikia. Tai NĖRA jautri informacija:
        // leidimų sąrašas viešai dokumentuotas README.
        requiredPermission: permission,
      });
    }

    req.authz = identity;
    next();
  };
}

module.exports = { requirePermission, resolveIdentity, resolveApiKeyRole };
