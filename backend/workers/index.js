/**
 * BullMQ worker procesas - ATSKIRAS nuo HTTP backend'o.
 *
 * Paleidimas:  node workers/index.js
 * Docker:      atskiras servisas (žr. docker-compose.server.yml worker)
 *
 * Ką daro: klausosi transcription ir protocol eilių, vykdo darbą, atnaujina jobStore
 * būseną. Kadangi tai atskiras procesas:
 *   - HTTP backend restartas NEnutraukia čia vykdomo darbo;
 *   - jei ŠIS worker'is krenta vykdymo metu, BullMQ (attempts/backoff) grąžina jobą
 *     į eilę - kitas worker'is (ar tas pats po restarto) jį pakartos;
 *   - keli worker'iai gali veikti lygiagrečiai (BullMQ atominis job reservation
 *     užtikrina, kad to paties jobo nepaims du).
 *
 * Būsena rašoma per jobStore (Redis), tad HTTP GET /api/jobs/:id mato progresą.
 */
const jobStore = require("../utils/jobStore");
const jobRunner = require("../queues/jobRunner");
const { QUEUE_NAMES, DEFAULT_JOB_OPTIONS, WORKER_OPTIONS, createQueueConnection } = require("../queues/config");
const { transcriptionProcessor, protocolProcessor } = require("../queues/processors");


// Klaidos klasifikacija su sanitizacija - naudojam tą pačią kaip inline runner'is,
// kad worker'io ir inline elgesys būtų identiškas (paslaptys nepatenka į jobStore).
const _classifyError = (e) => jobRunner._classifyError(e, "worker job");

// Ištrina audio iš storage po GALUTINIO statuso (sėkmės ar išnaudotų bandymų).
// NEtrina tarp retry - kad kitas bandymas rastų failą.
async function _cleanupStorage(payload) {
  if (payload && payload.storageKey) {
    const fileStorage = require("../utils/fileStorage");
    await fileStorage.del(payload.storageKey).catch(() => {});
  }
}

/**
 * Sukuria BullMQ Worker vienai eilei. Processor'ius vykdo darbą; on-events atnaujina
 * jobStore būseną (started/completed/failed su attempt_count).
 */
function createWorker(queueName, processor) {
  const { Worker } = require("bullmq");
  const connection = createQueueConnection();

  const worker = new Worker(
    queueName,
    async (job) => {
      const { jobId, payload } = job.data;
      // Pažymim PROCESSING su realiu attempt numeriu (BullMQ job.attemptsMade).
      await jobStore.update(jobId, {
        status: jobStore.STATUS.PROCESSING,
        attempt_count: job.attemptsMade + 1,
      });
      const result = await processor(payload, jobId);
      // COMPLETED rašom čia (ne on-completed), kad rezultatas tikrai išsaugotas.
      await jobStore.update(jobId, { status: jobStore.STATUS.COMPLETED, result });
      // SĖKMĖ - audio nebereikalingas, trinam iš storage (jei transkripcija).
      await _cleanupStorage(payload);
      return result;
    },
    { connection, ...WORKER_OPTIONS }
  );

  worker.on("failed", async (job, err) => {
    if (!job) return;
    const { jobId, payload } = job.data;
    const attemptsExhausted = job.attemptsMade >= (job.opts.attempts || DEFAULT_JOB_OPTIONS.attempts);
    const { errorCode, message } = _classifyError(err);
    if (attemptsExhausted) {
      // Galutinė nesėkmė po visų bandymų - jobas FAILED (dead-letter).
      await jobStore.update(jobId, { status: jobStore.STATUS.FAILED, error: message, error_code: errorCode });
      // Tik dabar (po VISŲ bandymų) trinam audio - kad retry turėtų failą.
      await _cleanupStorage(payload);
    } else {
      // Dar bus retry - paliekam PROCESSING, audio NETRINAM (kitas bandymas jį naudos).
      await jobStore.update(jobId, { attempt_count: job.attemptsMade + 1, error: message, error_code: errorCode });
    }
  });

  worker.on("error", (err) => {
    console.error(`[worker:${queueName}] klaida:`, err.message);
  });

  return worker;
}

function startWorkers() {
  // Naudojam ATSKIRUS worker modulius (transcriptionWorker.js, protocolWorker.js) -
  // pagal struktūros reikalavimą. index.js paleidžia ABU viename procese; atskirai
  // galima paleisti po vieną (skirtingam skalavimui).
  const { startTranscriptionWorker } = require("./transcriptionWorker");
  const { startProtocolWorker } = require("./protocolWorker");
  const workers = [startTranscriptionWorker(), startProtocolWorker()];
  console.log(`[stenograma] Worker'iai paleisti (concurrency=${WORKER_OPTIONS.concurrency}, stalled recovery=${WORKER_OPTIONS.stalledInterval}ms): transcription, protocol`);

  // Graceful shutdown - laukiam vykdomo darbo pabaigos prieš uždarant.
  async function shutdown(signal) {
    console.log(`[stenograma] Worker gauna ${signal}, baigiu darbus...`);
    await Promise.all(workers.map((w) => w.close()));
    process.exit(0);
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return workers;
}

// Registruojam processor'ius ir inline runner'iui (kad be Redis veiktų tas pats kodas).
jobRunner.registerProcessor("transcription", transcriptionProcessor);
jobRunner.registerProcessor("protocol", protocolProcessor);

if (require.main === module) {
  if (!process.env.REDIS_URL) {
    console.error("[stenograma] Worker procesui reikia REDIS_URL (BullMQ). Be jo naudokite inline režimą (darbas HTTP procese).");
    process.exit(1);
  }
  jobStore.init().then(startWorkers);
}

module.exports = { createWorker, startWorkers };
