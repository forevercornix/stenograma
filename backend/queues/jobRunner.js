const jobStore = require("../utils/jobStore");

/**
 * Job runner - abstrakcija tarp HTTP endpoint'o ir darbo vykdymo.
 *
 * DU REŽIMAI (parenkama automatiškai pagal REDIS_URL, kaip jobStore):
 *
 *  1) BULLMQ (su REDIS_URL): endpoint'as tik queue.add() ir grąžina 202. Darbą
 *     vykdo ATSKIRAS worker procesas (workers/). HTTP backend restartas nenutraukia
 *     darbo. Tai TIKRA job queue.
 *
 *  2) INLINE (be REDIS_URL): endpoint'as vykdo darbą TAME PAČIAME procese
 *     (setImmediate, po 202 atsakymo). Dabartinis elgesys - tinka dev/desktop
 *     vienam vartotojui. Backend restartas nutraukia vykdomą darbą (žinomas
 *     apribojimas, dokumentuotas). Fallback, kai Redis nėra.
 *
 * Abu režimai naudoja tą patį jobStore būsenai, tad GET /api/jobs/:id veikia vienodai.
 */

let _mode = null; // "bullmq" | "inline"

// Vykdymo funkcijos (registruojamos, kad inline režimas ir worker'iai naudotų tą patį kodą).
const _processors = {};

function registerProcessor(type, fn) {
  _processors[type] = fn;
}

async function init() {
  if (_mode) return _mode;

  const useBullMq = !!process.env.REDIS_URL;
  if (!useBullMq) {
    _mode = "inline";
    console.log("[stenograma] Job runner: inline (in-proceso; be atskirų worker'ių - nustatykite REDIS_URL BullMQ eilei)");
    return _mode;
  }

  try {
    // Naudojam ATSKIRAS eiles (queues/transcriptionQueue.js, protocolQueue.js) -
    // pagal struktūros reikalavimą. Jos sukuriamos lazy pirmo add metu.
    require("bullmq"); // patikrinam, kad bullmq įdiegtas (mes fallback jei ne)
    _mode = "bullmq";
    console.log("[stenograma] Job runner: BullMQ (atskiri worker procesai; atsparu restartams)");
    return _mode;
  } catch (e) {
    if (process.env.REDIS_REQUIRED === "true") {
      throw new Error(`BullMQ init nepavyko (${e.message}), o REDIS_REQUIRED=true.`);
    }
    console.warn(`[stenograma] ⚠️  BullMQ init nepavyko (${e.message}). Grįžtu į inline runner'į (darbas vykdomas HTTP procese).`);
    _mode = "inline";
    return _mode;
  }
}

function getMode() {
  return _mode || "inline";
}

/**
 * Įdeda transkribavimo jobą. BullMQ režime - į eilę (worker pasiims). Inline - vykdo
 * tame pačiame procese po grąžinimo.
 *
 * @param {string} jobId - jobStore jobo ID (jau sukurtas prieš tai)
 * @param {object} payload - { storageKey, filename, mimeType, language, diarize, ... }
 */
async function enqueueTranscription(jobId, payload) {
  await init();
  if (_mode === "bullmq") {
    const { addTranscriptionJob } = require("./transcriptionQueue");
    await addTranscriptionJob(jobId, payload);
  } else {
    // Inline: vykdom po atsakymo (setImmediate), kad neblokuotų HTTP atsakymo.
    setImmediate(() => _runInline("transcription", jobId, payload));
  }
}

async function enqueueProtocol(jobId, payload) {
  await init();
  if (_mode === "bullmq") {
    const { addProtocolJob } = require("./protocolQueue");
    await addProtocolJob(jobId, payload);
  } else {
    setImmediate(() => _runInline("protocol", jobId, payload));
  }
}

/**
 * Inline vykdymas - naudoja tą patį processor'ių, kaip BullMQ worker'iai, kad
 * kodas nesidubliuotų. Būsena rašoma per jobStore (kaip ir worker'iuose).
 */
async function _runInline(type, jobId, payload) {
  const processor = _processors[type];
  if (!processor) {
    console.error(`[stenograma] Nėra processor'iaus tipui '${type}'`);
    return;
  }
  try {
    await jobStore.update(jobId, { status: jobStore.STATUS.PROCESSING, attempt_count: 1 });
    const result = await processor(payload, jobId);
    await jobStore.update(jobId, { status: jobStore.STATUS.COMPLETED, result });
  } catch (e) {
    const { errorCode, message } = _classifyError(e, `${type} job`);
    await jobStore.update(jobId, { status: jobStore.STATUS.FAILED, error: message, error_code: errorCode });
  } finally {
    // Inline režimas neturi retry - tad audio galima trinti iškart po galutinio
    // statuso (sėkmė ar nesėkmė). Trinam tik jei payload turi storageKey (transkripcija).
    if (payload && payload.storageKey) {
      const fileStorage = require("../utils/fileStorage");
      await fileStorage.del(payload.storageKey).catch(() => {});
    }
  }
}

// Klaidos klasifikacija (bendra inline ir worker'iams). Vidinės (500/nežinomos)
// klaidos SANITIZUOJAMOS - kad paslaptys (API raktai, keliai) nepatektų į jobStore,
// kurį skaito klientas per GET /api/jobs/:id. HttpError su ne-500 statusu (validacija,
// override) yra saugu rodyti kaip yra.
function _classifyError(e, context = "job") {
  const { sanitizeServerError } = require("../utils/sanitizeError");
  if (e && e.statusCode && e.statusCode !== 500) {
    return { errorCode: `http_${e.statusCode}`, message: e.message };
  }
  return { errorCode: "internal_error", message: sanitizeServerError(e, context) };
}

async function close() {
  if (_mode === "bullmq") {
    const { closeTranscriptionQueue } = require("./transcriptionQueue");
    const { closeProtocolQueue } = require("./protocolQueue");
    await closeTranscriptionQueue().catch(() => {});
    await closeProtocolQueue().catch(() => {});
  }
}

module.exports = {
  init,
  getMode,
  registerProcessor,
  enqueueTranscription,
  enqueueProtocol,
  close,
  _classifyError, // eksportuojama testams
};

// AUTO-registracija: processor'iai užregistruojami vos įkėlus modulį, kad inline
// režimas veiktų ir tada, kai importuojamas tik `app` (pvz. testuose per supertest),
// ne visas server.js. Reikalaujame čia (o ne viršuje) - kad išvengtume ciklinės
// priklausomybės (processors -> services, ne atgal į jobRunner).
try {
  const { transcriptionProcessor, protocolProcessor } = require("./processors");
  registerProcessor("transcription", transcriptionProcessor);
  registerProcessor("protocol", protocolProcessor);
} catch (e) {
  // Jei processors dar neįkeliami (pvz. dalinė testų aplinka), tylим - server.js
  // vis tiek registruos per registerProcessors().
}
