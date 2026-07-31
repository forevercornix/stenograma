const express = require("express");
const multer = require("multer");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { transcribeAudio, HttpError } = require("../services/transcriptionService");
const rateLimiter = require("../middleware/rateLimiter");
const apiKeyAuth = require("../middleware/apiKeyAuth");
const { uploadDir, safeExtension, resolveExistingUploadPath } = require("../utils/uploadPath");

const router = express.Router();

const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || "500", 10);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir()),
  // Plėtinys ateina iš VARTOTOJO failo vardo, tad praleidžiamas pro whitelist
  // (utils/uploadPath.js) - kitaip vienintelė vartotojo valdoma kelio dalis
  // liktų nepatikrinta.
  filename: (req, file, cb) => cb(null, `stenograma-${crypto.randomUUID()}${safeExtension(file.originalname)}`),
});

// Leidžiami audio formatai - tikriname IR mimetype, IR plėtinį, nes naršyklės
// kartais siunčia netikslų ar bendrinį mimetype (pvz. application/octet-stream).
//
// SVARBI PASTABA (patikrinta realiai su tikru faster-whisper modeliu ir ffmpeg
// sugeneruotais .mp4/.webm failais, turinčiais IR video, IR audio takelį): MP4/
// WebM KONTEINERIAI yra struktūriškai IDENTIŠKI nepriklausomai nuo to, ar juose
// yra tik audio, ar audio+video (kamera/ekranas) - tad "video/mp4" ir "video/webm"
// ČIA SĄMONINGAI leidžiami. faster-whisper (per ffmpeg/PyAV) automatiškai
// ištraukia TIK audio takelį ir ignoruoja vaizdą - abu formatai realiai
// transkribuoti teisingai (žr. testus). Tas pats principo lygmeniu tikėtina ir
// su OpenAI Whisper API (jų dokumentacija tai patvirtina), bet NEBUVO patikrinta
// su Azure/Google/Deepgram/AssemblyAI - jie dažnai reikalauja žaliavinio audio
// encoding, ne video konteinerio.
const ALLOWED_MIME_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/mp4",
  "video/mp4", // MP4 su video+audio takeliais - žr. pastabą aukščiau
  "audio/x-m4a",
  "audio/m4a",
  "audio/webm",
  "video/webm", // WebM su video+audio (pvz. ekrano įrašymas) - realiai patikrinta
  "audio/ogg",
  "audio/aac",
  "audio/flac",
]);
const ALLOWED_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".mp4", ".webm", ".ogg", ".aac", ".flac"]);

function isAllowedAudio(file) {
  const ext = path.extname(file.originalname || "").toLowerCase();
  const mimeOk = ALLOWED_MIME_TYPES.has((file.mimetype || "").toLowerCase());
  const extOk = ALLOWED_EXTENSIONS.has(ext);
  return mimeOk || extOk;
}

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!isAllowedAudio(file)) {
      return cb(new Error(`Neleidžiamas failo formatas "${file.mimetype}" (${path.extname(file.originalname || "")}). Leidžiami formatai: mp3, wav, m4a, mp4, webm, ogg, aac, flac.`));
    }
    cb(null, true);
  },
});

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

async function safeUnlink(filePath) {
  try {
    // Trynimas irgi eina pro tą pačią patikrą - kitaip apsauga dengtų tik
    // skaitymą, o pavojingesnė operacija liktų atvira.
    const resolved = await resolveExistingUploadPath(filePath);
    if (resolved) await fs.unlink(resolved);
  } catch (_) {
    // failas jau gali būti pašalintas arba niekada nebuvo sukurtas - nekritinga
  }
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
    return res.json(result);
  } catch (e) {
    if (e instanceof HttpError) {
      return res.status(e.statusCode).json({ error: e.message, details: e.details });
    }
    return res.status(500).json({ error: e.message });
  } finally {
    await safeUnlink(req.file.path);
  }
});

module.exports = router;
