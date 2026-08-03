const express = require("express");
const { generateProtocol, HttpError } = require("../services/protocolService");
const { VARIANT } = require("../utils/redactedArtefact");
const rateLimiter = require("../middleware/rateLimiter");
const authenticate = require("../middleware/authenticate");
const { requirePermission } = require("../middleware/authorize");
const { PERMISSIONS } = require("../utils/permissions");
const { sanitizeServerError } = require("../utils/sanitizeError");
const { validate, schemas } = require("../middleware/validate");

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
router.post("/generate", rateLimiter, authenticate, requirePermission(PERMISSIONS.PROTOCOL_GENERATE), validate({ body: schemas.generateBody }), async (req, res) => {
  try {
    const result = await generateProtocol(req.validated.body);
    /**
     * VARIANTŲ SEMANTIKA (GDPR #4).
     *
     * Protokolas NĖRA redaguotas artefaktas - jis yra LLM SUGENERUOTAS tekstas,
     * sukurtas iš redaguoto įėjimo. Tai ne tas pats: modelis gali įrašyti vardą,
     * iš konteksto atkurtą numerį ar savo sugalvotą identifikatorių, kurio
     * redaguotame įėjime nebuvo.
     *
     * Todėl žymim DU dalykus atskirai: kas yra pats protokolas
     * (`protocolVariant: "generated"`) ir iš ko jis padarytas
     * (`sourceTranscriptVariant`). Vienas bendras `variant: "redacted"` leistų
     * klientui manyti, kad protokolas jau saugus platinti - o tai netiesa.
     */
    return res.json({
      ...result,
      protocolVariant: VARIANT.GENERATED,
      sourceTranscriptVariant: result.redaction ? VARIANT.REDACTED : VARIANT.ORIGINAL,
    });
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
