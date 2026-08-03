const express = require("express");
const { verifyCredentials, USERNAME_PATTERN } = require("../utils/credentials");
const sessionStore = require("../utils/sessionStore");
const { requireSession, setSessionCookie, clearSessionCookie, readCookie, COOKIE_NAME } = require("../middleware/sessionAuth");
const { loginIpLimiter, loginAccountLimiter } = require("../middleware/rateLimiter");
const { validate, z } = require("../middleware/validate");
const { createLogger } = require("../utils/logger");
const auditLog = require("../utils/auditLog");
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

  const identity = verifyCredentials(username, password);

  if (!identity) {
    // AUDITAS: nesėkmingas bandymas įrašomas BE slaptažodžio - tik vardas,
    // kurį pats vartotojas pateikė (jis gali būti klaidingas, bet nėra
    // paslaptis tokiu pačiu būdu kaip slaptažodis).
    auditLog.record({
      event: "LOGIN_FAILED",
      success: false,
      outcome: "invalid_credentials",
      details: `username=${USERNAME_PATTERN.test(username) ? username : "[invalid_format]"}`,
    });
    log.warn("Nepavykęs prisijungimas");

    return res.status(401).json({ error: "Neteisingas vartotojo vardas arba slaptažodis.", code: "INVALID_CREDENTIALS" });
  }

  const session = await sessionStore.create(identity);
  setSessionCookie(res, session.id, sessionStore.absoluteTimeoutMs());

  auditLog.record({
    event: "LOGIN_SUCCESS",
    success: true,
    outcome: "session_created",
    details: `username=${identity.username} role=${identity.role}`,
  });
  log.info("Prisijungta", { role: identity.role });

  res.json({ username: identity.username, role: identity.role });
});

/**
 * POST /api/auth/logout
 *
 * Idempotentinis: atsijungimas be aktyvios sesijos NĖRA klaida – klientas
 * galėjo jau būti atsijungęs kitame skirtuke.
 */
router.post("/auth/logout", async (req, res) => {
  const sessionId = readCookie(req, COOKIE_NAME);

  if (sessionId) {
    await sessionStore.destroy(sessionId);
    auditLog.record({ event: "LOGOUT", success: true, outcome: "session_destroyed" });
  }

  clearSessionCookie(res);
  res.json({ ok: true });
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
