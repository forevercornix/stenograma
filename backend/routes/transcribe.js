const express = require("express");
const fs = require("fs/promises");
const { transcribeAudio, HttpError } = require("../services/transcriptionService");
const rateLimiter = require("../middleware/rateLimiter");
const apiKeyAuth = require("../middleware/apiKeyAuth");
const { safeUnlinkUpload, resolveExistingUploadPath } = require("../utils/uploadPath");
const { createAudioUpload } = require("../utils/uploadStorage");
const { VARIANT } = require("../utils/redactedArtefact");

const router = express.Router();


const upload = createAudioUpload();

function uploadSingleAudio(req, res, next) {
  // Priimame IR "audio", IR "file" lauką (žr. transcribeJobs.js paaiškinimą).
  const handler = upload.fields([
    { name: "audio", maxCount: 1 },
    { name: "file", maxCount: 1 },
  ]);
  handler(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
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
router.post("/transcribe", rateLimiter, apiKeyAuth, uploadSingleAudio, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Trūksta audio failo (laukas 'audio')." });

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
      language: req.body.language || "lt",
      diarize: req.body.diarize === "true" || req.body.diarize === true,
      audioUrl: req.body.audioUrl,
      numSpeakers: req.body.numSpeakers ? parseInt(req.body.numSpeakers, 10) : undefined,
      transcriptionProviderOverride: req.body.provider,
      diarizationModeOverride: req.body.diarizationProvider,
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
});

module.exports = router;
