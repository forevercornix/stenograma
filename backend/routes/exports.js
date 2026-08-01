const express = require("express");
const rateLimiter = require("../middleware/rateLimiter");
const apiKeyAuth = require("../middleware/apiKeyAuth");
const auditLog = require("../utils/auditLog");
const jobStore = require("../utils/jobStore");
const { sanitizeServerError } = require("../utils/sanitizeError");
const { buildExport, FORMATS } = require("../services/exportService");
const { createLogger } = require("../utils/logger");
const { getPrivacyPolicy } = require("../utils/privacyPolicy");
const { VARIANT, REQUESTABLE_VARIANTS, parseRequestedVariant } = require("../utils/redactedArtefact");
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

  /**
   * VARIANTAS PRIVALOMAS (GDPR #8: „Require an explicit variant parameter and
   * never infer or silently substitute it").
   *
   * Numatytosios reikšmės nėra sąmoningai. Jei numatytasis būtų `redacted`,
   * senas klientas tyliai gautų kitą turinį nei tikėjosi; jei `original` -
   * tyliai gautų neredaguotą. Abu atvejai blogesni už aiškią klaidą.
   */
  const variant = parseRequestedVariant(req.body?.variant);

  if (!variant) {
    return res.status(400).json({
      error: `Privalomas 'variant' laukas. Galimos reikšmės: ${REQUESTABLE_VARIANTS.join(", ")}.`,
    });
  }

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
        "Eksporto audito ryšio patikra nepavyko (saugyklos klaida) - " +
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

  /**
   * Kokį VARIANTĄ realiai gaus vartotojas.
   *
   * Šiame etape jį lemia politika (`EXPORT_ALLOW_ORIGINAL`), ne užklausa -
   * eksplicitinis `variant` parametras ateis su #8. Bet audito laukas
   * reikalingas jau dabar: be jo klausimas „kas eksportavo NEREDAGUOTĄ
   * variantą" lieka neatsakomas net turint žurnalą.
   */
  // Auditui fiksuojam TIKRAI PRAŠYTĄ variantą - jis nėra išvedamas iš politikos.
  const exportVariant = variant;

  auditLog.record({
    event: "EXPORT_STARTED",
    success: true,
    jobId: linkedJobId,
    format,
    variant: exportVariant,
    outcome: "started",
    details: `link=${linkState}`,
  });

  try {
    const result = await buildExport(protocol, format, variant);

    auditLog.record({
      event: "EXPORT_COMPLETED",
      success: true,
      jobId: linkedJobId,
      processingTimeMs: Date.now() - started,
      format,
      variant: exportVariant,
      outcome: "delivered",
      // Baitų skaičius yra dydis, ne turinys - jis lieka naudingas diagnostikai.
      details: `link=${linkState} bytes=${result.buffer.length}`,
    });

    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
    res.setHeader("Content-Length", String(result.buffer.length));
    // Eksportas gali turėti asmens duomenų - jokio tarpinio kešavimo.
    res.setHeader("Cache-Control", "no-store");

    return res.status(200).send(result.buffer);
  } catch (error) {
    // Politikos atmetimas nėra serverio klaida - klientas turi matyti, kad
    // variantas neleidžiamas, o ne „kažkas sulūžo".
    const status = error && error.code === "EXPORT_ORIGINAL_FORBIDDEN" ? 403 : 500;

    auditLog.record({
      event: "EXPORT_FAILED",
      success: false,
      format,
      variant: exportVariant,
      outcome: "failed",
      jobId: linkedJobId,
      processingTimeMs: Date.now() - started,
      details: `format=${format} link=${linkState}`,
      error: error.message,
    });

    // sanitizeServerError logguoja pilną klaidą serveryje ir grąžina saugų tekstą.
    // Politikos atmetimo pranešimas yra saugus ir naudingas (jame nurodyta, kaip
    // gauti leidžiamą variantą); tik tikros vidinės klaidos sanitizuojamos.
    return status === 403
      ? res.status(403).json({ error: error.message })
      : res.status(500).json({ error: sanitizeServerError(error, "eksportas") });
  }
});

module.exports = router;
