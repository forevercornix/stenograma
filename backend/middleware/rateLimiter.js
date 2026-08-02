const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");
const { createLogger } = require("../utils/logger");
const { pseudonymizeIp } = require("../utils/clientIp");
const { requirePositiveInt } = require("../utils/securityBaseline");

const log = createLogger("rate-limit");

/**
 * RATE LIMIT ĮVYKIS BE JAUTRAUS TURINIO (GDPR #17).
 *
 * Limito suveikimas yra piktnaudžiavimo signalas, tad jį reikia matyti. Bet
 * pilnas IP yra asmens duomuo, o kelias ir kūnas gali turėti turinio - todėl
 * loguojam PSEUDONIMĄ (HMAC su druska), maršruto pavadinimą ir nieko daugiau.
 * Pseudonimas atsako į klausimą „ar tas pats klientas?", bet adreso neatkuria.
 */
function _onLimit(kind) {
  return (req, res, next, options) => {
    log.warn("Rate limitas viršytas", {
      kind,
      // `req.route?.path` vietoj `req.originalUrl`: pastarasis turi ID ir
      // užklausos parametrus, kurie gali būti asmens duomenys.
      route: (req.route && req.route.path) || req.baseUrl || "unknown",
      method: req.method,
      client: pseudonymizeIp(req.ip),
    });

    res.status(options.statusCode).json(options.message);
  };
}

const windowMinutes = parseInt(process.env.RATE_LIMIT_WINDOW_MINUTES || "15", 10);
const maxRequests = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "20", 10);

/**
 * /api/generate ir /api/transcribe(-jobs) POST kviečia apmokamus išorinius API
 * (LLM/ASR) - be rate limitingo vienas klientas (ar botas) gali sugeneruoti
 * didelę sąskaitą per kelias sekundes. Numatyta: 20 užklausų / 15 min vienam IP.
 */
const expensiveEndpointLimiter = rateLimit({
  windowMs: windowMinutes * 60 * 1000,
  max: maxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: `Per daug užklausų. Limitas: ${maxRequests} per ${windowMinutes} min. Bandykite vėliau.` },
  handler: _onLimit("expensive"),
});

/**
 * RASTA REALIAI TESTUOJANT (ne teoriškai): GET /api/jobs/:id ir GET
 * /api/transcribe-jobs/:id yra POLLING endpoint'ai - frontend'as juos kviečia
 * kas ~3s, kol jobas baigsis. Su TA PAČIA griežta `expensiveEndpointLimiter`
 * (20 per 15 min) bet koks transkribavimas/generavimas, trunkantis ilgiau nei
 * ~1 minutę (20 kvietimų * 3s = 60s), REALIAI atsitrenkė į rate limitą per
 * paties poll'inimo procesą - ne dėl piktnaudžiavimo, o dėl to, kad polling
 * PATS SAVAIME yra dažnas, bet PIGUS (tik atmintyje esančio jobStore skaitymas,
 * jokio LLM/ASR kvietimo). Todėl polling'ui reikalingas ATSKIRAS, žymiai
 * laisvesnis limitas.
 */
const pollRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minutė
  max: parseInt(process.env.RATE_LIMIT_POLL_MAX_REQUESTS || "120", 10), // ~1 užklausa/500ms su dideliu rezervu
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Per daug jobo statuso patikrinimų per trumpą laiką. Bandykite vėliau." },
  handler: _onLimit("poll"),
});

module.exports = expensiveEndpointLimiter;
/**
 * BENDRAS API limiteris (#14).
 *
 * Brangūs maršrutai jau turi griežtus limitus, bet likę endpointai neturėjo
 * jokių - t. y. bazė buvo „ribojama tik tai, ką kas nors prisiminė apriboti".
 * Ši riba plati (300/min): ji skirta ne piktnaudžiavimui stabdyti, o tam, kad
 * neribotų kelių apskritai neliktų.
 */
const generalApiLimiter = rateLimit({
  windowMs: 60_000,
  // `0` užblokuotų visą API, `abc` duotų NaN - abu tyliai. Žr. securityBaseline.
  max: require("../utils/securityBaseline").requirePositiveInt(process.env, "RATE_LIMIT_GENERAL_MAX", 300, {
    min: 1,
    max: 1_000_000,
  }),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Per daug užklausų. Bandykite vėliau." },
  handler: _onLimit("general"),
});

/**
 * KANONIZUOTAS vartotojo vardas rate-limit raktui.
 *
 * VIEN `.toLowerCase()` NEPAKANKA - `"admin"`, `"admin "`, `"admin	"` duotų
 * SKIRTINGUS raktus, tad atakuotojas galėtų nuolat kaitalioti tarpus/tabuliaciją
 * aplink tą patį vardą ir kiekvieną kartą gauti naują limito langą - t. y.
 * praktiškai apeiti limitą pagal IP+vardą.
 *
 * Ši funkcija turi atitikti TĄ PAČIĄ normalizaciją, kurią naudoja
 * `credentials.js verifyCredentials()` - kitaip rate limitas ir realus
 * paieškos raktas galėtų nesutapti.
 */
function canonicalUsername(raw) {
  return String(raw || "").trim().toLowerCase();
}

/**
 * DU NEPRIKLAUSOMI limitai prisijungimui (#18 PR1, sugriežtinta po review).
 *
 * Vien IP+vardas limiteris yra APEINAMAS: atakuotojas, keičiantis vardą
 * kiekvienam bandymui (`admin1`, `admin2`, `admin3`...), niekada nepasiekia
 * to paties rakto, tad `loginAccountLimiter` vienas nesustabdytų brute-force
 * paieškos per daug vardų.
 *
 * `loginIpLimiter` uždaro būtent šią spragą: jis SKAIČIUOJA TIK PAGAL IP,
 * nepriklausomai nuo to, kokį vardą siunčia klientas. Abu limitai taikomi
 * KARTU (žr. routes/auth.js) - IP limitas sustabdo plataus masto vardų
 * perrinkimą, account limitas apsaugo VIENĄ vardą nuo tikslinio brute-force.
 */
const loginIpLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: requirePositiveInt(process.env, "RATE_LIMIT_LOGIN_IP_MAX", 30, { min: 1, max: 10_000 }),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: { error: "Per daug prisijungimo bandymų iš šio adreso. Bandykite vėliau.", code: "LOGIN_RATE_LIMITED" },
  handler: _onLimit("login_ip"),
});

const loginAccountLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: requirePositiveInt(process.env, "RATE_LIMIT_LOGIN_ACCOUNT_MAX", 10, { min: 1, max: 10_000 }),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${canonicalUsername(req.body?.username)}`,
  message: { error: "Per daug prisijungimo bandymų šiam vartotojui. Bandykite vėliau.", code: "LOGIN_RATE_LIMITED" },
  handler: _onLimit("login_account"),
});

module.exports.canonicalUsername = canonicalUsername;
module.exports.loginIpLimiter = loginIpLimiter;
module.exports.loginAccountLimiter = loginAccountLimiter;
module.exports.generalApiLimiter = generalApiLimiter;
module.exports.expensiveEndpointLimiter = expensiveEndpointLimiter;
module.exports.pollRateLimiter = pollRateLimiter;
