const rateLimit = require("express-rate-limit");
const { createLogger } = require("../utils/logger");
const { pseudonymizeIp } = require("../utils/clientIp");

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
module.exports.expensiveEndpointLimiter = expensiveEndpointLimiter;
module.exports.pollRateLimiter = pollRateLimiter;
