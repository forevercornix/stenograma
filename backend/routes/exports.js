const express = require("express");
const rateLimiter = require("../middleware/rateLimiter");
const apiKeyAuth = require("../middleware/apiKeyAuth");
const auditLog = require("../utils/auditLog");
const jobStore = require("../utils/jobStore");
const { sanitizeServerError } = require("../utils/sanitizeError");
const { buildExport, FORMATS } = require("../services/exportService");
const { createLogger } = require("../utils/logger");
const log = createLogger("route:exports");

const router = express.Router();

const ALLOWED_FORMATS = new Set(Object.values(FORMATS));

/**
 * POST /api/exports - protokolo eksportas (txt / csv / docx).
 *
 * KODĖL SERVERYJE: eksporto įvykių auditas (GDPR #6 DoD) neįmanomas, kai failas
 * generuojamas naršyklėje - serveris apie tai nieko nežino. Klientu paremtas
 * "pranešiau, kad eksportavau" audito įrašas nebūtų patikimas.
 *
 * Į auditą rašomas TIK: įvykio tipas, formatas, baitų kiekis, pseudonimizuotas
 * jobId (jei paduotas) ir rezultatas. Protokolo turinys, pavadinimas, dalyvių
 * vardai ar failo vardas NErašomi.
 *
 * body: { format: "txt"|"csv"|"docx", protocol: {...}, jobId?: string }
 *
 * DĖL `jobId` PATIKROS: klientas negali savavališkai pasirinkti audito ryšio.
 * `jobId` naudojamas TIK jei toks jobas realiai egzistuoja IR yra transkribavimo
 * tipo. Kitaip įvykis rašomas BE ryšio, o ne su išgalvotu ar svetimo tipo
 * subjektu - antraip vėliau to jobo ištrynimas pašalintų ir jam nepriklausančius
 * eksporto įrašus.
 *
 * `link=` reikšmė audite rodo TIKSLIĄ priežastį, o ne bendrą "unresolved":
 * infrastruktūros problema (neveikiantis Redis) neturi atrodyti taip pat kaip
 * išgalvotas ID, nes kitaip auditas ją paslėptų.
 *
 * Sąmoningai NEgrąžinama 400: jobo įrašas gali būti teisėtai išnykęs pagal
 * JOB_TTL_MINUTES (numatytai 60 min), kol vartotojas dar redaguoja protokolą
 * naršyklėje. Eksportas neturi nutrūkti dėl to, kad audito ryšio nebėra - tai
 * audito, ne vartotojo veiksmo problema. Nepatikrintas `jobId` niekur nesaugomas
 * jokia forma.
 */
router.post("/exports", rateLimiter, apiKeyAuth, async (req, res) => {
  const format = String(req.body?.format || "").toLowerCase();
  const protocol = req.body?.protocol;
  const jobId = typeof req.body?.jobId === "string" ? req.body.jobId : undefined;

  if (!ALLOWED_FORMATS.has(format)) {
    return res.status(400).json({
      error: `Nežinomas eksporto formatas. Galimi: ${[...ALLOWED_FORMATS].join(", ")}.`,
    });
  }

  if (!protocol || typeof protocol !== "object" || Array.isArray(protocol)) {
    return res.status(400).json({ error: "Trūksta `protocol` objekto." });
  }

  // Ryšys naudojamas tik patikrintas (žr. komentarą aukščiau).
  //
  // link reikšmės: none (nepaduota) | job (patvirtinta) | missing (jobo nėra) |
  // invalid_type (yra, bet ne transkribavimo) | store_error (saugyklos klaida).
  let linkedJobId;
  let linkState = "none";

  if (jobId) {
    let job;
    let storeFailed = false;

    try {
      job = await jobStore.get(jobId);
    } catch (e) {
      storeFailed = true;

      // Saugyklos klaida NĖRA tas pats kas neegzistuojantis jobas - ją reikia
      // matyti. Pranešimas sanitizuojamas, nes jame gali būti prisijungimo
      // duomenų (pvz. redis://user:pass@host).
      const { sanitizeForLogging } = auditLog;
      log.warn(
        "[stenograma] Eksporto audito ryšio patikra nepavyko (saugyklos klaida) - " +
          "įvykis rašomas be ryšio. Patikrinkite job saugyklą (Redis):",
        sanitizeForLogging(e)
      );
    }

    if (storeFailed) {
      linkState = "store_error";
    } else if (!job) {
      linkState = "missing";
    } else if (job.type !== jobStore.JOB_TYPES.TRANSCRIPTION) {
      linkState = "invalid_type";
    } else {
      linkedJobId = jobId;
      linkState = "job";
    }
  }

  const started = Date.now();

  auditLog.record({
    event: "EXPORT_STARTED",
    success: true,
    jobId: linkedJobId,
    details: `format=${format} link=${linkState}`,
  });

  try {
    const result = await buildExport(protocol, format);

    auditLog.record({
      event: "EXPORT_COMPLETED",
      success: true,
      jobId: linkedJobId,
      processingTimeMs: Date.now() - started,
      details: `format=${format} link=${linkState} bytes=${result.buffer.length}`,
    });

    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
    res.setHeader("Content-Length", String(result.buffer.length));
    // Eksportas gali turėti asmens duomenų - jokio tarpinio kešavimo.
    res.setHeader("Cache-Control", "no-store");

    return res.status(200).send(result.buffer);
  } catch (error) {
    auditLog.record({
      event: "EXPORT_FAILED",
      success: false,
      jobId: linkedJobId,
      processingTimeMs: Date.now() - started,
      details: `format=${format} link=${linkState}`,
      error: error.message,
    });

    // sanitizeServerError logguoja pilną klaidą serveryje ir grąžina saugų tekstą.
    return res.status(500).json({ error: sanitizeServerError(error, "eksportas") });
  }
});

module.exports = router;
