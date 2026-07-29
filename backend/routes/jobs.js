const express = require("express");
const jobStore = require("../utils/jobStore");
const jobRunner = require("../queues/jobRunner");
const rateLimiter = require("../middleware/rateLimiter");
const { pollRateLimiter } = require("../middleware/rateLimiter");
const apiKeyAuth = require("../middleware/apiKeyAuth");
const { eraseJob } = require("../utils/jobErasure");

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

  const job = await jobStore.create();

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

  const outcome = await eraseJob(job.id, "protocol");

  if (!outcome.jobRemoved) {
    return res.status(404).json({ error: "Jobas nerastas." });
  }

  if (outcome.errors.length) {
    console.error(
      `[stenograma] Dalinis jobo ištrynimas (${job.id}): ${outcome.errors.join("; ")}`
    );
  }

  return res.status(204).send();
});

module.exports = router;
