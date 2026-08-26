const express = require("express");
const { verifyCredentials, USERNAME_PATTERN } = require("../utils/credentials");
const sessionStore = require("../utils/sessionStore");
const {
  requireSession,
  setSessionCookie,
  clearSessionCookie,
  sessionStoreUnavailable,
  readCookie,
  COOKIE_NAME,
} = require("../middleware/sessionAuth");
const { loginIpLimiter, loginAccountLimiter } = require("../middleware/rateLimiter");
const { validate, z } = require("../middleware/validate");
const { createLogger } = require("../utils/logger");
const { rasytiAudita, AuditWriteError } = require("../utils/auditWrite");
const { auditoGedimas } = require("../utils/auditHttp");
const { permissionsForRole } = require("../utils/permissions");

const log = createLogger("route:auth");

const router = express.Router();

const loginBody = z
  .object({
    username: z.string().trim().min(1).max(64),
    password: z.string().min(1).max(1024),
  })
  .strict();

/**
 * POST /api/auth/login
 *
 * VIENODAS atsakymas nežinomam vartotojui IR neteisingam slaptažodžiui –
 * abu 401 su ta pačia žinute. Skirtingi pranešimai leistų išvardyti
 * galiojančius vartotojų vardus (username enumeration).
 */
/**
 * DU limiteriai IŠ KARTO, PRIEŠ validaciją.
 *
 * IP limitas turi taikytis net jei body iškraipytas ar trūksta vardo - kitaip
 * atakuotojas galėtų siųsti netinkamą body, kad apeitų limitą (validacija
 * kristų PRIEŠ limitą suveikiant). Account limitas savo rakte naudoja `req.body`
 * TIESIOGIAI (dar be Zod), nes rate-limit sluoksnis turi veikti PRIEŠ
 * validaciją - žr. middleware/rateLimiter.js canonicalUsername() komentarą.
 */
router.post("/auth/login", loginIpLimiter, loginAccountLimiter, validate({ body: loginBody }), async (req, res) => {
  const { username, password } = req.validated.body;

  try {
    const identity = verifyCredentials(username, password);

    if (!identity) {
      // AUDITAS: nesėkmingas bandymas įrašomas BE slaptažodžio - tik vardas,
      // kurį pats vartotojas pateikė (jis gali būti klaidingas, bet nėra
      // paslaptis tokiu pačiu būdu kaip slaptažodis).
      await rasytiAudita({
        event: "LOGIN_FAILED",
        success: false,
        outcome: "invalid_credentials",
        details: `username=${USERNAME_PATTERN.test(username) ? username : "[invalid_format]"}`,
      });
      log.warn("Nepavykęs prisijungimas");

      return res.status(401).json({ error: "Neteisingas vartotojo vardas arba slaptažodis.", code: "INVALID_CREDENTIALS" });
    }

    /**
     * ⚠️ SESIJOS KŪRIMAS YRA FAIL-CLOSED, IR TVARKA SVARBI (#155, 7.3).
     *
     * `Set-Cookie` išsiunčiamas TIK po patvirtinto įrašymo. Cookie prieš tai
     * paliktų klientą su bearer token'u, kurio saugykloje nėra: vartotojas
     * atrodytų prisijungęs iki pirmos užklausos, o auditas rodytų sėkmę.
     *
     * `create()` grąžina `{ session, token }`. Į cookie keliauja TOKEN'AS -
     * `session.id` yra DB pirminis raktas ir klientui nerodomas niekada.
     */
    /**
     * ⚠️ TAS PATS PARUOŠTUMO SARGAS KAIP ATSIJUNGIME.
     *
     * Iki `init()` fasadas rodo į atmintį. Sukonfigūravus `postgres`, bet dar
     * nebaigus inicijavimo, `create()` SĖKMINGAI sukurtų sesiją ATMINTYJE ir
     * išsiųstų galiojančią cookie, kurios nėra DB: ji neišgyventų restarto ir
     * jos nematytų kitas procesas - t. y. tyliai veiktų režimas, kurio
     * operatorius eksplicitiškai atsisakė.
     */
    if (!sessionStore.isReady()) {
      await rasytiAudita({
        event: "LOGIN_FAILED",
        success: false,
        outcome: "store_not_ready",
        details: `username=${identity.username} role=${identity.role}`,
      });
      log.error("Prisijungimas atmestas: sesijų autoritetas dar nepasiruošęs.");
      return sessionStoreUnavailable(res);
    }

    let sukurta;
    try {
      sukurta = await sessionStore.create(identity);
    } catch (err) {
      await rasytiAudita({
        event: "LOGIN_FAILED",
        success: false,
        /** ⚠️ `outcome` audite trumpinamas iki 20 simbolių (`auditLog.js`) - ilgesnė reikšmė taptų nebeatpažįstama. */
        outcome: err.code === "IDENTITY_UNAVAILABLE" ? "identity_unavailable" : "store_unavailable",
        details: `username=${identity.username} role=${identity.role}`,
      });
      log.error(`Sesijos sukurti nepavyko: ${err.message}`);

      /**
       * Tapatybės trūkumas yra KONFIGŪRACIJOS, ne prieinamumo problema, tad
       * atsakymai skiriasi (AGENTS.md §11): 503 reiškia „bandykite vėliau",
       * o čia pakartojimas nepadėtų.
       */
      if (err.code === "IDENTITY_UNAVAILABLE") {
        return res.status(500).json({
          error: "Prisijungimas negalimas: vartotojo tapatybė nepilna.",
          code: "IDENTITY_UNAVAILABLE",
        });
      }
      return sessionStoreUnavailable(res);
    }

    /**
     * ⚠️ AUDITAS PRIEŠ `Set-Cookie` (#155, 7.4a / #210).
     *
     * `LOGIN_SUCCESS` yra BLOKUOJANTIS įvykis: „sėkmė negali būti deklaruota
     * prieš patvirtintą write". Cookie yra būtent ta deklaracija - ją nustačius
     * anksčiau, audito gedimas paliktų klientą su GALIOJANČIU bearer token'u,
     * apie kurį audite nėra nė vieno įrašo. 7.3 ta pati tvarka jau galioja
     * sesijos įrašymui (`create()` → cookie); 7.4a prideda auditą į tą pačią
     * grandinę: sesija → auditas → cookie.
     */
    try {
      await rasytiAudita({
        event: "LOGIN_SUCCESS",
        success: true,
        outcome: "session_created",
        details: `username=${identity.username} role=${identity.role}`,
      });
    } catch (error) {
      /**
       * ⚠️ SESIJA ATŠAUKIAMA, KAI AUDITAS KRINTA.
       *
       * `create()` jau įvyko, tad be šio atšaukimo liktų GYVA sesija, kurios
       * token'as niekam neišsiųstas: klientas jos revokuoti negali, o per
       * audito gedimo langą pakartotiniai bandymai jų prikauptų. Atmintyje tai
       * nutekėjimas, PostgreSQL režime - eilutės, kurios gyvuoja iki
       * `expires_at`.
       *
       * Revokacijos klaida NENUSLEPIA audito klaidos: pastaroji yra priežastis,
       * dėl kurios prisijungimas atmetamas, tad ji ir keliama toliau.
       */
      await sessionStore.destroy(sukurta.token).catch((revokacijosKlaida) =>
        log.error(`Nepavyko atšaukti sesijos po audito gedimo: ${revokacijosKlaida.message}`)
      );
      throw error;
    }

    setSessionCookie(res, sukurta.token, sessionStore.absoluteTimeoutMs());
    log.info("Prisijungta", { role: identity.role });

    res.json({ username: identity.username, role: identity.role });
  } catch (error) {
    if (error instanceof AuditWriteError) return auditoGedimas(res, error, "auth/login auditas");
    throw error;
  }
});

/**
 * POST /api/auth/logout
 *
 * Idempotentinis: atsijungimas be aktyvios sesijos NĖRA klaida – klientas
 * galėjo jau būti atsijungęs kitame skirtuke.
 */
router.post("/auth/logout", async (req, res) => {
  /**
   * ⚠️ COOKIE REIKŠMĖ YRA TOKEN'AS, NE `session.id` (#155, 7.3).
   *
   * Palikus seną `destroy(sessionId)` semantiką, atsijungimas TYLIAI nustotų
   * veikti: `destroy()` gautų token'ą, ieškotų pagal `id`, nerastų eilutės,
   * grąžintų `false`, o cookie liktų galiojanti.
   */
  const token = readCookie(req, COOKIE_NAME);

  try {
    if (token) {
      /**
       * ⚠️ PARUOŠTUMO SARGAS PRIEŠ REVOKACIJĄ.
       *
       * `sessionStore` fasadas iki `init()` rodo į ATMINTIES saugyklą. Jei
       * sukonfigūruotas `SESSION_STORE_BACKEND=postgres`, bet inicijavimas /
       * suderinimas dar nebaigtas (embedded naudojimas, testai, ankstyva užklausa),
       * `destroy(token)` nueitų į atmintį, nerastų persistentinio token'o,
       * grąžintų `false` BE klaidos - ir žemiau esantis kelias išvalytų cookie bei
       * atsakytų `{ ok: true }`. Vartotojui būtų pasakyta „atsijungta", nors
       * persistentinė sesija liktų galiojanti kiekviename procese.
       *
       * Tas pats sargas jau saugo `requireSession`, `optionalSession`,
       * `authenticate` ir audito kelią; atsijungimas negali būti vienintelė
       * išimtis (AGENTS.md §16).
       *
       * ⚠️ SARGAS YRA VIDUJE `if (token)`. Be cookie atsijungimas lieka
       * IDEMPOTENTINIS ir grąžina 200 net tada, kai saugykla nepasiruošusi -
       * klientas neturi ko revokuoti, tad nėra ir ko nepavykti.
       */
      if (!sessionStore.isReady()) {
        await rasytiAudita({ event: "LOGOUT", success: false, outcome: "store_not_ready" });
        log.error("Atsijungimas atmestas: sesijų autoritetas dar nepasiruošęs.");
        return sessionStoreUnavailable(res);
      }

      /**
       * ⚠️ REVOKACIJOS KLAIDA NEGALI VIRSTI „atsijungta".
       *
       * Išvalyta cookie be revokacijos reikštų, kad ta pati reikšmė kitame
       * procese vis dar autentifikuoja - būtent to globali revokacija ir
       * neleidžia. Todėl gedimas grąžinamas klientui, o ne nutylimas.
       */
      try {
        await sessionStore.destroy(token);
      } catch (err) {
        await rasytiAudita({ event: "LOGOUT", success: false, outcome: "store_unavailable" });
        log.error(`Atsijungimas nepavyko: ${err.message}`);
        return sessionStoreUnavailable(res);
      }
      await rasytiAudita({ event: "LOGOUT", success: true, outcome: "session_destroyed" });
    }

    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (error) {
    if (error instanceof AuditWriteError) return auditoGedimas(res, error, "auth/logout auditas");
    throw error;
  }
});

/**
 * GET /api/auth/me
 *
 * Frontend naudoja šį endpointą nustatyti, ar vartotojas prisijungęs, ir su
 * kokia role – be jo kiekvienas puslapio įkėlimas turėtų spėti iš cookie
 * buvimo, kurio JS net negali perskaityti (HttpOnly).
 */
/**
 * DEV REŽIMO NUOSEKLUMAS (#18 PR4).
 *
 * Kai NĖRA nei `AUTH_USERS`, nei `API_KEY`, ir `NODE_ENV != production`,
 * `middleware/authenticate.js` praleidžia VISAS užklausas su `administrator`
 * role. Bet `/auth/me` su `requireSession` tokiu atveju grąžindavo 401, ir
 * frontend rodydavo prisijungimo formą – vartotojas būdavo užblokuotas nuo
 * sistemos, kuri realiai leidžia jam viską.
 *
 * Toks neatitikimas blogesnis nei bet kuris vienas sprendimas atskirai: UI
 * sako „prisijunk", o prisijungti nėra kaip (vartotojų nesukonfigūruota), nors
 * API veikia. Būtent tai sulaužė E2E testus.
 *
 * Šis middleware suvienodina abu kelius: jei autentifikacija nesukonfigūruota,
 * `/auth/me` grąžina tą pačią dev tapatybę, kurią naudoja `authenticate`.
 * `authConfigured: false` leidžia UI parodyti, kad tai NĖRA tikras
 * prisijungimas.
 */
function devIdentityWhenUnconfigured(req, res, next) {
  const hasUsers = Boolean((process.env.AUTH_USERS || "").trim());
  const hasApiKey = Boolean(process.env.API_KEY);
  const isProduction = process.env.NODE_ENV === "production";

  if (hasUsers || hasApiKey || isProduction) return next();

  return res.json({
    username: "dev",
    role: "administrator",
    permissions: permissionsForRole("administrator"),
    authConfigured: false,
  });
}

router.get("/auth/me", devIdentityWhenUnconfigured, requireSession, (req, res) => {
  /**
   * LEIDIMAI grąžinami kartu su role (#18 PR2).
   *
   * Frontend turi žinoti, kuriuos veiksmus rodyti - bet jis NETURI to spręsti
   * pats pagal rolės pavadinimą. Priešingu atveju rolių žemėlapis egzistuotų
   * dviejose vietose (backend ir UI), ir jos ilgainiui išsiskirtų.
   *
   * Backend lieka AUTORITETINGAS: šis sąrašas skirtas ATVAIZDAVIMUI, o ne
   * apsaugai. Kiekvieną užklausą vis tiek tikrina `requirePermission`.
   */
  res.json({
    username: req.user.username,
    role: req.user.role,
    permissions: permissionsForRole(req.user.role),
  });
});

module.exports = router;
