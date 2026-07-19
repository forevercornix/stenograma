const express = require("express");
const { generateProtocol, HttpError } = require("../services/protocolService");
const rateLimiter = require("../middleware/rateLimiter");
const apiKeyAuth = require("../middleware/apiKeyAuth");
const { sanitizeServerError } = require("../utils/sanitizeError");

const router = express.Router();

/**
 * POST /api/generate - SINCHRONINIS variantas: klientas laukia, kol LLM baigs.
 *
 * Tinka trumpiems susitikimams / greitiems LLM atsakymams. Ilgesniems susitikimams
 * (pvz. 1-2 val., ilga transkripcija, lėtesnis tiekėjas) rekomenduojama naudoti
 * POST /api/jobs + GET /api/jobs/:id (žr. routes/jobs.js) - klientas gauna jobId
 * iš karto ir apklausia (poll) rezultatą, HTTP ryšys nelaukia be galo.
 *
 * body: { title, date, participants: string[], transcript: string, segments?: [...], meetingId? }
 * Raktas NIEKADA nekeliauja į klientą - jis skaitomas iš env čia, serveryje.
 *
 * Klaidų politika: 4xx (validacija/auth/whitelist) klaidos rodomos klientui
 * pilnai - jos saugios ir naudingos. 5xx (tiekėjo/vidinės) klaidos sanitizuojamos
 * prieš siunčiant klientui, pilnas tekstas visada logguojamas serveryje.
 */
router.post("/generate", rateLimiter, apiKeyAuth, async (req, res) => {
  try {
    const result = await generateProtocol(req.body || {});
    return res.json(result);
  } catch (e) {
    // 400/403/502 iš HttpError yra saugūs, naudingi pranešimai (bloga užklausa,
    // override išjungtas, arba LLM negrąžino validaus JSON po repair bandymo -
    // pastarasis NĖRA jautrus, tai naudinga info kūrėjui apie prompt/schema).
    // Tik "tikras" 500 (netikėta vidinė/tiekėjo klaida) sanitizuojamas.
    if (e instanceof HttpError && e.statusCode !== 500) {
      return res.status(e.statusCode).json({ error: e.message, details: e.details });
    }
    const statusCode = e instanceof HttpError ? e.statusCode : 500;
    const safeMessage = sanitizeServerError(e, "POST /api/generate");
    return res.status(statusCode).json({ error: safeMessage });
  }
});

module.exports = router;
