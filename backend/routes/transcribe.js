const express = require("express");
const fs = require("fs/promises");
const { transcribeAudio, HttpError } = require("../services/transcriptionService");
const rateLimiter = require("../middleware/rateLimiter");
const apiKeyAuth = require("../middleware/apiKeyAuth");
const { safeUnlinkUpload, resolveExistingUploadPath } = require("../utils/uploadPath");
const { createAudioUpload } = require("../utils/uploadStorage");
const { VARIANT } = require("../utils/redactedArtefact");
const { recordRejectedUpload, reasonFromMulterError, REASONS } = require("../utils/uploadEvents");
const { MAX_UPLOAD_MB } = require("../utils/uploadStorage");
const { validate, schemas } = require("../middleware/validate");

const router = express.Router();


const upload = createAudioUpload();

function uploadSingleAudio(req, res, next) {
  // Priimame IR "audio", IR "file" lauką (žr. transcribeJobs.js paaiškinimą).
  const handler = upload.fields([
    { name: "audio", maxCount: 1 },
    { name: "file", maxCount: 1 },
  ]);
  handler(req, res, (err) => {
    if (err) {
      const reason = reasonFromMulterError(err);
      recordRejectedUpload(reason, {
        route: "/api/transcribe",
        // MIME išsaugotas fileFilter'yje - multer klaidos objekte jo nėra.
        mimetype: req.uploadObservation && req.uploadObservation.mimetype,
        // Faktinio dydžio multer nežino (nutraukia skaitymą), tad fiksuojam limitą.
        limitBytes: reason === REASONS.TOO_LARGE ? MAX_UPLOAD_MB() * 1024 * 1024 : undefined,
      });
      return res.status(400).json({ error: err.message });
    }
    const f = (req.files && (req.files.audio?.[0] || req.files.file?.[0])) || null;
    if (f) req.file = f;
    next();
  });
}


/**
 * POST /api/transcribe (multipart/form-data, laukas "audio") - SINCHRONINIS.
 *
 * ⚠️ SVARBU: jei šis backend'as yra už HTTP proxy su savo užklausos trukmės
 * limitu (pvz. RunPod HTTP proxy = KIETAS 100s limitas, nepriklausomas nuo šio
 * serverio nustatymų), ilgi/GPU-heavy transkribavimai gali NIEKADA nespėti grąžinti
 * atsakymo per šį kelią, NEPRIKLAUSOMAI nuo FASTER_WHISPER_EMBEDDED_TIMEOUT_MS.
 * Tokiu atveju naudokite POST /api/transcribe-jobs (asinchroninis, žr.
 * routes/transcribeJobs.js) arba TCP prievado eksponavimą vietoj HTTP proxy.
 *
 * ARCHITEKTŪRA: transkribavimas ir diarizacija yra DU NEPRIKLAUSOMI etapai - žr.
 * services/transcriptionService.js pilną paaiškinimą.
 */
/**
 * Validacija eina PO rate limito, autentifikacijos ir įkėlimo.
 *
 * Prieš juos ji verstų schemas dirbti neautentifikuotam srautui, o multipart
 * laukų iki `uploadSingleAudio` dar apskritai nėra.
 */
router.post(
  "/transcribe",
  rateLimiter,
  apiKeyAuth,
  uploadSingleAudio,
  validate({ body: schemas.transcribeBody }),
  async (req, res) => {
  if (!req.file) {
    // Ir šis kelias yra atmestas įkėlimas - be įvykio pėdsakas būtų dalinis.
    recordRejectedUpload(REASONS.MISSING, { route: "/api/transcribe" });
    return res.status(400).json({ error: "Trūksta audio failo (laukas 'audio')." });
  }

  try {
    // Kelias tikrinamas PRIEŠ skaitymą, su realpath - tekstinė patikra
    // nesustabdytų simbolinės nuorodos į išorę (žr. utils/uploadPath.js).
    const uploadedPath = await resolveExistingUploadPath(req.file.path);
    if (!uploadedPath) throw new HttpError(400, "Įkeltas failas nebepasiekiamas.");
    const buffer = await fs.readFile(uploadedPath);
    const result = await transcribeAudio({
      buffer,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      // Reikšmės jau patikrintos ir konvertuotos schema (multipart laukai
      // ateina kaip eilutės - žr. middleware/validate.js).
      language: req.validated.body.language || "lt",
      diarize: req.validated.body.diarize === true,
      audioUrl: req.validated.body.audioUrl || undefined,
      numSpeakers: req.validated.body.numSpeakers ?? undefined,
      transcriptionProviderOverride: req.validated.body.provider || undefined,
      diarizationModeOverride: req.validated.body.diarizationProvider || undefined,
    });
    // VARIANTO ŽYMUO (GDPR #4: „Redacted API responses contain an explicit
    // variant field and cannot be confused with original content").
    //
    // Šis endpointas grąžina ORIGINALĄ - ir būtent todėl laukas privalomas.
    // Jei variantą žymėtų tik redaguoti atsakymai, klientas negalėtų atskirti
    // „originalas" nuo „senesnė API versija, kuri lauko dar neturi".
    return res.json({ ...result, variant: VARIANT.ORIGINAL });
  } catch (e) {
    if (e instanceof HttpError) {
      return res.status(e.statusCode).json({ error: e.message, details: e.details });
    }
    return res.status(500).json({ error: e.message });
  } finally {
      await safeUnlinkUpload(req.file.path);
    }
  }
);

module.exports = router;
