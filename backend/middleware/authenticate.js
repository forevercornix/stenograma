const sessionStore = require("../utils/sessionStore");
const { readCookie, COOKIE_NAME } = require("./sessionAuth");
const { setActor, actorFingerprint } = require("../utils/requestContext");
const { createLogger } = require("../utils/logger");

const log = createLogger("auth");

/**
 * VIENINGA AUTENTIFIKACIJA (#18 PR2).
 *
 * Pakeičia `apiKeyAuth` maršrutuose, kuriems reikia tapatybės. Priima DU
 * mechanizmus, nes bendras `API_KEY` jau naudojamas esamuose diegimuose, o
 * sesijos (#18 PR1) yra kryptis į priekį – staigus rakto pašalinimas
 * sulaužytų veikiančią automatiką be įspėjimo.
 *
 * SESIJA TURI PIRMENYBĘ. Jei klientas atsiuntė ir cookie, ir raktą,
 * autoritetinga yra konkreti vartotojo tapatybė. Priešingu atveju `operator`
 * galėtų pasikelti teises vien pridėdamas bendrą raktą prie savo užklausos.
 *
 * Šis middleware NENUSPRENDŽIA, ar leidžiama – tik kas prašo. Leidimą tikrina
 * `middleware/authorize.js requirePermission()`.
 */
async function authenticate(req, res, next) {
  // 1. SESIJA (pirmenybė).
  const sessionId = readCookie(req, COOKIE_NAME);
  if (sessionId) {
    const session = await sessionStore.touch(sessionId);
    if (session) {
      req.user = { username: session.username, role: session.role };
      setActor(session.username);
      return next();
    }
    /**
     * Sesijos cookie YRA, bet negalioja (pasibaigė ar revokuota).
     *
     * NEGRĄŽINAM 401 iš karto – klientas gali turėti ir galiojantį API raktą
     * (pvz. skriptas su senu cookie naršyklės eksporte). Krentam į rakto
     * patikrą; jei ir jos nėra, 401 grąžinsim žemiau.
     */
  }

  // 2. BENDRAS API RAKTAS.
  const configuredKey = process.env.API_KEY;

  if (configuredKey) {
    const provided = req.header("x-api-key");
    if (provided !== configuredKey) {
      return res.status(401).json({ error: "Reikalingas prisijungimas.", code: "SESSION_REQUIRED" });
    }
    // AKTORIUS audito įrašams (#17). Saugom rakto HASH, ne patį raktą.
    setActor(actorFingerprint(configuredKey));
    req.apiKeyAuthenticated = true;
    return next();
  }

  /**
   * 3. AR APSKRITAI KAS NORS SUKONFIGŪRUOTA?
   *
   * ⚠️ TIKRINAM IR `AUTH_USERS`, ne tik `API_KEY`.
   *
   * Ankstesnė versija žiūrėjo tik į raktą, tad sistema su SUKONFIGŪRUOTAIS
   * vartotojais, bet be `API_KEY`, dev režime likdavo ATVIRA: anoniminė
   * užklausa krisdavo į žemiau esantį praleidimą ir gaudavo `administrator`
   * teises.
   *
   * Tai nebuvo teorinis atvejis – būtent tokia konfigūracija natūrali
   * diegimui, pereinančiam nuo bendro rakto prie sesijų (#18). Rasta
   * rašant #20 PR4 endpointų testus.
   */
  const hasUsers = Boolean((process.env.AUTH_USERS || "").trim());

  if (hasUsers) {
    /**
     * Vartotojai sukonfigūruoti, bet galiojančios sesijos nėra – tai
     * NEAUTENTIFIKUOTA užklausa, ne „nesukonfigūruota sistema".
     */
    return res.status(401).json({ error: "Reikalingas prisijungimas.", code: "SESSION_REQUIRED" });
  }

  if (process.env.NODE_ENV === "production") {
    return res.status(503).json({
      error: "Endpoint'as uždarytas produkcijoje, kol nenustatytas nei API_KEY, nei AUTH_USERS.",
    });
  }

  /**
   * DEV režimas be jokios konfigūracijos – praleidžiam, bet su AIŠKIA role.
   *
   * `administrator` čia yra sąmoningas pasirinkimas: lokalus kūrėjas turi
   * matyti VISKĄ, kitaip pusė funkcijų neveiktų be jokios saugumo naudos
   * (apsaugos vis tiek nėra – bet kas gali kviesti endpointą).
   */
  log.warn(
    `Nei API_KEY, nei sesija - ${req.path} atviras be autentifikacijos ` +
      "(leidžiama tik NODE_ENV != production). Nediekite taip viešai."
  );
  req.apiKeyAuthenticated = true;
  return next();
}

module.exports = authenticate;
