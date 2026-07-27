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
      // update() grąžina null, jei jobo įrašo NĖRA (pvz. nesuderintas store, P1 scenarijus,
      // arba job'as pasibaigė TTL). Tada BullMQ nemato problemos, bet vartotojo jobo įrašo
      // nėra - klaidiname klientą. Todėl tikrinam ir metam, kad BullMQ pažymėtų failed +
      // retry (ne tyliai "sėkmė" be įrašo).
      const processingJob = await jobStore.update(jobId, {
        status: jobStore.STATUS.PROCESSING,
        attempt_count: job.attemptsMade + 1,
      });
      if (!processingJob) {
        throw new Error(`Job store įrašas nerastas (PROCESSING): ${jobId}. Galimai nesuderintas store/runner arba pasibaigęs TTL.`);
      }

      const result = await processor(payload, jobId);

      // COMPLETED rašom čia (ne on-completed), kad rezultatas tikrai išsaugotas.
      const completedJob = await jobStore.update(jobId, { status: jobStore.STATUS.COMPLETED, result });
      if (!completedJob) {
        throw new Error(`Nepavyko išsaugoti job rezultato (COMPLETED): ${jobId}. Job store įrašo nebėra.`);
      }

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

  // Heartbeat: worker rašo Redis raktą su TTL, /api/ready jį tikrina - taip readiness
  // patvirtina, kad worker'is GYVAS (ne tik kad Redis pasiekiamas).
  const { createQueueConnection } = require("../queues/config");
  const { startHeartbeat } = require("../utils/workerHeartbeat");
  const heartbeatConn = createQueueConnection();
  const stopHeartbeat = startHeartbeat(heartbeatConn);

  // Graceful shutdown - laukiam vykdomo darbo pabaigos prieš uždarant.
  async function shutdown(signal) {
    console.log(`[stenograma] Worker gauna ${signal}, baigiu darbus...`);
    stopHeartbeat();
    await heartbeatConn.quit().catch(() => {});
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

/**
 * Bendra worker paleidimo apsauga (naudoja index.js, transcriptionWorker.js,
 * protocolWorker.js - kad nesidubliuotų 3 skirtingos realizacijos). Inicijuoja jobStore
 * ir MET klaidą, jei jis fallback'ino į memory. Worker'iui NĖRA prasmingo memory
 * fallback: jis klausytų Redis eilės, bet jobų būseną laikytų SAVO proceso atmintyje,
 * nematytų backend proceso sukurtų jobų -> "Job store įrašas nerastas". Todėl elgiamės
 * kaip su REDIS_REQUIRED=true nepriklausomai nuo aplinkos.
 * @throws jei nėra REDIS_URL arba jobStore backend ne "redis".
 */
async function initializeWorkerOrFail(workerName) {
  if (!process.env.REDIS_URL) {
    throw new Error(`${workerName} reikia REDIS_URL (BullMQ). Be jo naudokite inline režimą (darbas HTTP procese).`);
  }
  await jobStore.init();
  if (jobStore.getBackend() !== "redis") {
    throw new Error(
      `${workerName} negali veikti be Redis job store (jobStore fallback'ino į memory). ` +
      "Patikrinkite REDIS_URL ir Redis pasiekiamumą."
    );
  }
}

if (require.main === module) {
  initializeWorkerOrFail("BullMQ worker")
    .then(() => startWorkers())
    .catch((error) => {
      console.error(`[stenograma] Worker nepaleistas: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { createWorker, startWorkers, initializeWorkerOrFail };
