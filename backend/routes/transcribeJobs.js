const express = require("express");
const fs = require("fs/promises");
const jobStore = require("../utils/jobStore");
const { eraseJob, eraseOrphanedJobData } = require("../utils/jobErasure");
const jobRunner = require("../queues/jobRunner");
const fileStorage = require("../utils/fileStorage");
const { HttpError } = require("../services/transcriptionService");
const { detectAudioMagic } = require("../utils/audioMagicBytes");
const { safeUnlinkUpload, safeExtension } = require("../utils/uploadPath");
const { createAudioUpload } = require("../utils/uploadStorage");
const { VARIANT } = require("../utils/redactedArtefact");
const { getRequestId, getActor } = require("../utils/requestContext");
const { sanitizeServerError } = require("../utils/sanitizeError");
const rateLimiter = require("../middleware/rateLimiter");
const { pollRateLimiter } = require("../middleware/rateLimiter");
const apiKeyAuth = require("../middleware/apiKeyAuth");
const { createLogger } = require("../utils/logger");
const { recordRejectedUpload, reasonFromMulterError, REASONS } = require("../utils/uploadEvents");
const { MAX_UPLOAD_MB } = require("../utils/uploadStorage");
const log = createLogger("route:transcribe-jobs");

const router = express.Router();


// Tas pats whitelist principas kaip routes/transcribe.js (žr. ten pilną
// paaiškinimą dėl video/mp4+webm sąmoningo leidimo).


const upload = createAudioUpload();
function uploadSingleAudio(req, res, next) {
  // Priimame IR "audio", IR "file" lauką - vartotojai natūraliai bando abu, o
  // .single("audio") mesdavo "Unexpected field", jei ateidavo "file" (RASTA realiai
  // testuojant). .fields() leidžia abu; normalizuojame į req.file.
  const handler = upload.fields([
    { name: "audio", maxCount: 1 },
    { name: "file", maxCount: 1 },
  ]);
  handler(req, res, (err) => {
    if (err) {
      const reason = reasonFromMulterError(err);
      recordRejectedUpload(reason, {
        route: "/api/transcribe-jobs",
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
  if (!req.file) {
    recordRejectedUpload(REASONS.MISSING, { route: "/api/transcribe-jobs" });
    return res.status(400).json({ error: "Trūksta audio failo (laukas 'audio')." });
  }

  const body = { ...req.body };
  const fileMeta = { filename: req.file.originalname, mimeType: req.file.mimetype };

  let storageKey = null;
  let enqueued = false;
  let job = null;

  try {
    // ANKSTYVA magic-bytes patikra: skaitom TIK antraštę (64 baitus), ne visą failą.
    // Jei turinys ne audio, atmetam IŠ KARTO - be viso failo skaitymo į RAM, be storage
    // kopijos, be job'o/eilės apkrovimo (netikras failas anksčiau būdavo atmetamas tik
    // worker'io viduje). Pilna patikra lieka transcriptionService (defense-in-depth).
    const handle = await fs.open(req.file.path, "r");
    try {
      const header = Buffer.alloc(64);
      await handle.read(header, 0, header.length, 0);
      if (!detectAudioMagic(header)) {
        recordRejectedUpload(REASONS.SIGNATURE, { route: "/api/transcribe-jobs", mimetype: req.file.mimetype });
        return res.status(400).json({ error: "Failo turinys neatitinka palaikomo audio formato (magic bytes)." });
      }
    } finally {
      await handle.close();
    }

    // Įrašom audio į BENDRĄ storage per FAILO KELIĄ (putFile) - NEįkeliant viso failo
    // į RAM. put(buffer) su fs.readFile perskaitytų visą 500MB į atmintį; keli vienalaikiai
    // įkėlimai sukeltų OOM. putFile kopijuoja OS lygmenyje. BullMQ režime atskiras worker
    // procesas failą pasieks per šį raktą.
    // safeExtension(), o NE path.extname(): raktas keliauja į fileStorage kelio
    // sudarymą, tad vartotojo vardo dalis ir čia turi eiti pro tą patį whitelist'ą.
    const ext = safeExtension(req.file.originalname);
    storageKey = await fileStorage.putFile(req.file.path, { ext });

    job = await jobStore.create({
      type: jobStore.JOB_TYPES.TRANSCRIPTION,
      // Koreliacija su HTTP užklausa (GDPR #17).
      requestId: getRequestId(),
      actor: getActor(),
      // storageKey saugom JOBE, ne tik BullMQ payload'e - kad GDPR ištrynimas
      // rastų likusį audio ir INLINE režime (ten BullMQ jobo išvis nėra).
      storageKey,
    });

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

    enqueued = true;
    // Variantas nurodomas JAU kuriant jobą: klientas turi žinoti, kokį turinį
    // gaus, dar prieš pirmą polling'ą (GDPR #4).
    res.status(202).json({ jobId: job.id, status: job.status, variant: VARIANT.ORIGINAL });
  } catch (e) {
    // Jei enqueue nepavyko (Redis/BullMQ eilė krito, add() metė klaidą ir pan.), audio
    // jau perkeltas į storage - reikia jį ištrinti, kad neliktų NAŠLAITINIS failas
    // (storageKey niekur nebenaudojamas, nes job'as neįvyko).
    if (storageKey && !enqueued) {
      await fileStorage.del(storageKey).catch(() => {});
    }
    // Jei job'as jau sukurtas, bet enqueue nepavyko - pažymim FAILED, kitaip jis liktų
    // QUEUED amžinai (sweepExpired sąmoningai nešalina queued/processing jobų).
    if (job && !enqueued) {
      await jobStore.update(job.id, {
        status: jobStore.STATUS.FAILED,
        error: "Nepavyko įdėti darbo į vykdymo eilę.",
        error_code: "enqueue_failed",
      }).catch(() => {});
    }
    // HttpError (pvz. validacijos 400) grąžinamas su SAVO statusu, ne visada 500.
    // Anksčiau parinkdavom teisingą žinutę, bet statusas likdavo 500 - klaidinanti kombinacija
    // (klientas gautų "400-tinę" žinutę su 500 kodu). 500 klaidos vis tiek sanitizuojamos.
    if (e instanceof HttpError) {
      const message = e.statusCode === 500 ? sanitizeServerError(e, "transcribe-jobs enqueue") : e.message;
      return res.status(e.statusCode).json({ error: message });
    }
    res.status(500).json({ error: sanitizeServerError(e, "transcribe-jobs enqueue") });
  } finally {
    // Multer laikiną failą visada ištrinam (audio jau nukopijuotas į storage).
    // Per TĄ PAČIĄ patikrą kaip /api/transcribe - kitaip apsauga nuo symlink
    // pabėgimo galiotų viename maršrute, o kitame ne.
    await safeUnlinkUpload(req.file.path);
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
    /**
     * VARIANTAS KIEKVIENAME atsakyme, ne tik redaguotame (GDPR #4:
     * „Original and redacted versions cannot be confused in API responses").
     *
     * Jei žymėtume tik redaguotus, atsakymas be lauko būtų dviprasmis: arba tai
     * originalas, arba senesnė API versija, kuri lauko dar neturi. Klientas
     * negalėtų atskirti - tad laukas privalomas abiem atvejais.
     *
     * Transkribavimo jobas visada duoda ORIGINALĄ: redakcija taikoma vėliau,
     * ties išsiuntimu išoriniam tiekėjui arba eksportu.
     */
    variant: VARIANT.ORIGINAL,
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

/**
 * DELETE /api/transcribe-jobs/:id
 *
 * GDPR duomenų ištrynimas. Pašalina VISUS jobo pėdsakus (žr. utils/jobErasure.js):
 * jobStore įrašą su rezultatu, BullMQ jobą Redis'e (jo payload'e - storageKey,
 * grąžintoje reikšmėje - transkripcija), likusį audio storage faile ir
 * pseudonimizuotus audito įrašus.
 *
 * Aktyvių jobų netrina, nes worker'is dar gali juos atnaujinti.
 *
 * PASTABA dėl autorizacijos: naudojamas BENDRAS API_KEY (žr. middleware/apiKeyAuth.js),
 * tad bet kuris rakto turėtojas gali ištrinti bet kurį jobą. Viešam diegimui su
 * realiais vartotojais reikia per-user auth - žr. backend README.
 */
router.delete("/transcribe-jobs/:id", rateLimiter, apiKeyAuth, async (req, res) => {
  const job = await jobStore.get(req.params.id);

  if (!job) {
    // jobStore įrašas galėjo dingti pagal TTL (numatytai 60 min), o BullMQ (iki
    // 24 val.) ir auditas (iki 30 d.) duomenis dar laiko. Prieš 404 pabandom
    // ištrinti tai, kas dar egzistuoja - kitaip teisė ištrinti dingtų anksčiau
    // nei patys duomenys.
    const orphan = await eraseOrphanedJobData(req.params.id);

    if (orphan.criticalFailure) {
      log.error(
        `[stenograma] NEPAVYKO ištrinti likusių jobo ${req.params.id} duomenų: ${orphan.errors.join("; ")}`
      );
      return res.status(503).json({
        error: "Nepavyko visiškai ištrinti jobo duomenų. Užklausą galima pakartoti.",
        deletion: orphan,
      });
    }

    if (orphan.found) return res.status(204).send();

    return res.status(404).json({ error: "Jobas nerastas." });
  }

  // Tipo patikra: abu endpoint'ai naudoja TĄ PATĮ jobStore, tad be jos protokolo
  // jobo ID, pateiktas šiam endpoint'ui, būtų surastas, ištrintas iš jobStore, o
  // valymas vyktų NE TOJE BullMQ eilėje - duomenys liktų, klientas gautų 204.
  // Legacy jobai (sukurti prieš `type` įvedimą) lauko neturi - jų neatmetam,
  // kitaip po deployment'o jau egzistuojantys jobai taptų neištrinami. Jiems
  // eraseJob() valo ABI eiles (žr. utils/jobErasure.js).
  if (job.type && job.type !== jobStore.JOB_TYPES.TRANSCRIPTION) {
    return res.status(404).json({ error: "Jobas nerastas." });
  }

  const deletableStatuses = new Set([
    jobStore.STATUS.COMPLETED,
    jobStore.STATUS.FAILED,
    jobStore.STATUS.CANCELLED,
  ]);

  if (!deletableStatuses.has(job.status)) {
    return res.status(409).json({
      error:
        "Aktyvaus jobo ištrinti negalima. Palaukite, kol jis bus užbaigtas arba atšauktas.",
    });
  }

  const outcome = await eraseJob(job);

  if (outcome.criticalFailure) {
    // NEGRĄŽINAME 204: jobStore įrašas sąmoningai paliktas (deletion_pending),
    // kad operaciją būtų galima pakartoti tuo pačiu ID. GDPR ištrynime serverio
    // logas nėra pakankamas patvirtinimas - klientas turi matyti, kad nepavyko.
    log.error(
      `[stenograma] NEPAVYKO visiškai ištrinti jobo ${job.id}: ${outcome.errors.join("; ")}`
    );
    return res.status(503).json({
      error:
        "Nepavyko visiškai ištrinti jobo duomenų. Jobas paliktas, kad užklausą būtų galima pakartoti.",
      deletion: {
        queueJobRemoved: outcome.queueJobRemoved,
        storageRemoved: outcome.storageRemoved,
        auditEntriesRemoved: outcome.auditEntriesRemoved,
        errors: outcome.errors,
      },
    });
  }

  if (!outcome.jobRemoved) {
    return res.status(404).json({ error: "Jobas nerastas." });
  }

  return res.status(204).send();
});

module.exports = router;
