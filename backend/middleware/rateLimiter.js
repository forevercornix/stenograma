const rateLimit = require("express-rate-limit");

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
});

module.exports = expensiveEndpointLimiter;
module.exports.expensiveEndpointLimiter = expensiveEndpointLimiter;
module.exports.pollRateLimiter = pollRateLimiter;
