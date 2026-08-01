const express = require("express");
const jobStore = require("../utils/jobStore");
const jobRunner = require("../queues/jobRunner");
const rateLimiter = require("../middleware/rateLimiter");
const { pollRateLimiter } = require("../middleware/rateLimiter");
const apiKeyAuth = require("../middleware/apiKeyAuth");
const { eraseJob, eraseOrphanedJobData } = require("../utils/jobErasure");
const { getRequestId, getActor } = require("../utils/requestContext");
const { createLogger } = require("../utils/logger");
const log = createLogger("route:jobs");

const router = express.Router();

/**
 * POST /api/jobs - ASINCHRONINIS variantas POST /api/generate.
 *
 * Rekomenduojamas ilgiems susitikimams (1-2 val. transkripcijoms, lėtesniems
 * tiekėjams) - klientas gauna jobId IŠ KARTO (nelaukdamas LLM atsakymo per tą
 * patį HTTP ryšį) ir toliau apklausia GET /api/jobs/:id kas kelias sekundes.
 *
 * body: tas pats kaip POST /api/generate.
 * response: { jobId, status: "queued" }
 *
 * PASTABA: šis jobStore yra atmintyje (žr. utils/jobStore.js) - MVP pavyzdys,
 * kaip struktūruoti async pipeline'ą, ne pilna production queue (Redis/BullMQ/
 * SQS) su retry politika, dead-letter queue ir keliais worker procesais.
 */
router.post("/jobs", rateLimiter, apiKeyAuth, async (req, res) => {
  const body = req.body || {};
  if (!body.transcript || body.transcript.trim().length < 10) {
    return res.status(400).json({ error: "Transkripcija per trumpa arba tuščia." });
  }

  const job = await jobStore.create({
    type: jobStore.JOB_TYPES.PROTOCOL,
    // Koreliacija su HTTP užklausa (GDPR #17).
    requestId: getRequestId(),
    actor: getActor(),
  });

  // HTTP endpoint'as TIK įdeda jobą į eilę (BullMQ) arba paleidžia inline (be Redis)
  // ir grąžina 202. Protokolo generavimo (LLM) darbą vykdo worker procesas ar
  // setImmediate - ne šis HTTP handler'is. Žr. queues/jobRunner.js.
  await jobRunner.enqueueProtocol(job.id, body);

  res.status(202).json({ jobId: job.id, status: job.status });
});

/**
 * GET /api/jobs/:id - būsenos/rezultato apklausa (polling).
 * response: { jobId, status: queued|processing|completed|failed, result?, error?, createdAt, updatedAt }
 */
router.get("/jobs/:id", pollRateLimiter, apiKeyAuth, async (req, res) => {
  const job = await jobStore.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Jobas nerastas (galbūt serveris persileido, o job store buvo tik atmintyje - persistencijai naudokite Redis)." });

  res.json({
    jobId: job.id,
    status: job.status,
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
 * DELETE /api/jobs/:id - GDPR ištrynimas protokolo jobams.
 *
 * Simetriškas DELETE /api/transcribe-jobs/:id. Buvo praleistas, nors būtent
 * protokolo jobai laiko jautriausius duomenis: payload'e - visa TRANSKRIPCIJA
 * ir dalyvių sąrašas, rezultate - sugeneruotas protokolas.
 */
router.delete("/jobs/:id", rateLimiter, apiKeyAuth, async (req, res) => {
  const job = await jobStore.get(req.params.id);

  if (!job) {
    // jobStore įrašas galėjo dingti pagal TTL (numatytai 60 min), o BullMQ (iki
    // 24 val.) ir auditas (iki 30 d.) duomenis dar laiko. Prieš 404 pabandom
    // ištrinti tai, kas dar egzistuoja - kitaip teisė ištrinti dingtų anksčiau
    // nei patys duomenys.
    const orphan = await eraseOrphanedJobData(req.params.id);

    if (orphan.criticalFailure) {
      log.error(
        `NEPAVYKO ištrinti likusių jobo ${req.params.id} duomenų: ${orphan.errors.join("; ")}`
      );
      return res.status(503).json({
        error: "Nepavyko visiškai ištrinti jobo duomenų. Užklausą galima pakartoti.",
        deletion: orphan,
      });
    }

    if (orphan.found) return res.status(204).send();

    return res.status(404).json({ error: "Jobas nerastas." });
  }

  // Tipo patikra: abu endpoint'ai naudoja TĄ PATĮ jobStore, tad be jos transkripcijos
  // jobo ID, pateiktas šiam endpoint'ui, būtų surastas, ištrintas iš jobStore, o
  // valymas vyktų NE TOJE BullMQ eilėje - duomenys liktų, klientas gautų 204.
  // Legacy jobai (sukurti prieš `type` įvedimą) lauko neturi - jų neatmetam,
  // kitaip po deployment'o jau egzistuojantys jobai taptų neištrinami. Jiems
  // eraseJob() valo ABI eiles (žr. utils/jobErasure.js).
  if (job.type && job.type !== jobStore.JOB_TYPES.PROTOCOL) {
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
      `NEPAVYKO visiškai ištrinti jobo ${job.id}: ${outcome.errors.join("; ")}`
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
