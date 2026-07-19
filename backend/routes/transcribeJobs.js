const express = require("express");
const multer = require("multer");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const jobStore = require("../utils/jobStore");
const jobRunner = require("../queues/jobRunner");
const fileStorage = require("../utils/fileStorage");
const { HttpError } = require("../services/transcriptionService");
const { sanitizeServerError } = require("../utils/sanitizeError");
const rateLimiter = require("../middleware/rateLimiter");
const { pollRateLimiter } = require("../middleware/rateLimiter");
const apiKeyAuth = require("../middleware/apiKeyAuth");

const router = express.Router();

const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || "50", 10);

// Tas pats whitelist principas kaip routes/transcribe.js (žr. ten pilną
// paaiškinimą dėl video/mp4+webm sąmoningo leidimo).
const ALLOWED_MIME_TYPES = new Set([
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/wave", "audio/x-wav",
  "audio/mp4", "video/mp4", "audio/x-m4a", "audio/m4a",
  "audio/webm", "video/webm", "audio/ogg", "audio/aac", "audio/flac",
]);
const ALLOWED_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".mp4", ".webm", ".ogg", ".aac", ".flac"]);

function isAllowedAudio(file) {
  const ext = path.extname(file.originalname || "").toLowerCase();
  return ALLOWED_MIME_TYPES.has((file.mimetype || "").toLowerCase()) || ALLOWED_EXTENSIONS.has(ext);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, os.tmpdir()),
  filename: (req, file, cb) => cb(null, `stenograma-job-${crypto.randomUUID()}${path.extname(file.originalname || "")}`),
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!isAllowedAudio(file)) {
      return cb(new Error(`Neleidžiamas failo formatas "${file.mimetype}" (${path.extname(file.originalname || "")}).`));
    }
    cb(null, true);
  },
});
function uploadSingleAudio(req, res, next) {
  upload.single("audio")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

/**
 * POST /api/transcribe-jobs - ASINCHRONINIS variantas POST /api/transcribe.
 *
 * KODĖL TAI BŪTINA (ne tik "gera praktika"): jei backend'as pasiekiamas per
 * HTTP proxy su savo (jums nekontroliuojamu) užklausos trukmės limitu - pvz.
 * RunPod HTTP proxy turi KIETĄ 100 sekundžių limitą - bet koks transkribavimas,
 * ilgesnis už tą limitą, NIEKADA nespės grąžinti atsakymo per sinchroninį
 * POST /api/transcribe, NEPRIKLAUSOMAI nuo šio serverio FASTER_WHISPER_
 * EMBEDDED_TIMEOUT_MS nustatymo - proxy tiesiog nutrauks ryšį anksčiau.
 *
 * Šis endpoint'as išsprendžia tai: pats failo įkėlimas + jobId grąžinimas
 * trunka SEKUNDES (spėja per bet kokį proxy timeout), o pats transkribavimas
 * vyksta FONE - klientas apklausia GET /api/transcribe-jobs/:id trumpais,
 * greitais kvietimais, kurių kiekvienas taip pat spėja per bet kokį proxy limitą.
 *
 * response: { jobId, status: "queued" }
 */
router.post("/transcribe-jobs", rateLimiter, apiKeyAuth, uploadSingleAudio, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Trūksta audio failo (laukas 'audio')." });

  const body = { ...req.body };
  const fileMeta = { filename: req.file.originalname, mimeType: req.file.mimetype };

  try {
    // Įrašom audio į BENDRĄ storage (ne lokalų /tmp), gaunam storageKey. BullMQ
    // režime atskiras worker procesas failą pasieks per šį raktą.
    const buffer = await fs.readFile(req.file.path);
    const ext = path.extname(req.file.originalname || "") || "";
    const storageKey = await fileStorage.put(buffer, { ext });

    const job = await jobStore.create();

    // HTTP endpoint'as TIK įdeda jobą į eilę (ar inline) ir grąžina 202. Darbą
    // vykdo worker (BullMQ) arba setImmediate (inline). Backend nevykdo transkripcijos
    // sinchroniškai - žr. queues/jobRunner.js.
    await jobRunner.enqueueTranscription(job.id, {
      storageKey,
      filename: fileMeta.filename,
      mimeType: fileMeta.mimeType,
      language: body.language || "lt",
      diarize: body.diarize,
      audioUrl: body.audioUrl,
      numSpeakers: body.numSpeakers,
      transcriptionProviderOverride: body.provider,
      diarizationModeOverride: body.diarizationProvider,
      meetingId: body.meetingId,
    });

    res.status(202).json({ jobId: job.id, status: job.status });
  } catch (e) {
    const message = e instanceof HttpError && e.statusCode !== 500 ? e.message : sanitizeServerError(e, "transcribe-jobs enqueue");
    res.status(500).json({ error: message });
  } finally {
    // Multer laikiną failą visada ištrinam (audio jau nukopijuotas į storage).
    await fs.unlink(req.file.path).catch(() => {});
  }
});

/**
 * GET /api/transcribe-jobs/:id - būsenos/rezultato apklausa (polling).
 * response: { jobId, status: queued|processing|completed|failed|cancelled, progress?, result?, error?, ... }
 */
router.get("/transcribe-jobs/:id", pollRateLimiter, apiKeyAuth, async (req, res) => {
  const job = await jobStore.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Jobas nerastas (galbūt serveris persileido, o job store buvo tik atmintyje - persistencijai naudokite Redis)." });

  res.json({
    jobId: job.id,
    status: job.status,
    progress: job.progress || null,
    result: job.result,
    error: job.error,
    error_code: job.error_code,
    attempt_count: job.attempt_count,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    started_at: job.started_at,
    completed_at: job.completed_at,
  });
});

module.exports = router;
