const { QUEUE_NAMES, DEFAULT_JOB_OPTIONS, createQueueConnection } = require("./config");

/**
 * Transkripcijos eilė (atskiras modulis pagal 1 etapo struktūros reikalavimą).
 *
 * Sukuria BullMQ Queue transkripcijos jobams. HTTP endpoint'as per jobRunner
 * įdeda jobus (add), atskiras worker (workers/transcriptionWorker.js) juos vykdo.
 * Eilė sukuriama lazy (pirmo naudojimo metu), kad be REDIS_URL nebūtų bandoma jungtis.
 */
let _queue = null;
let _connection = null;

function getTranscriptionQueue() {
  if (_queue) return _queue;
  const { Queue } = require("bullmq");
  _connection = createQueueConnection();
  _queue = new Queue(QUEUE_NAMES.TRANSCRIPTION, { connection: _connection });
  return _queue;
}

async function addTranscriptionJob(jobId, payload) {
  const queue = getTranscriptionQueue();
  // DEFAULT_JOB_OPTIONS (attempts/backoff/removeOnFail) BŪTINA - be jų nebūtų retry.
  return queue.add("transcribe", { jobId, payload }, { ...DEFAULT_JOB_OPTIONS, jobId });
}

/**
 * Pašalina jobą IŠ EILĖS (BullMQ hash'ai Redis'e). Būtina GDPR ištrynimui:
 * removeOnComplete/removeOnFail palieka job.data (storageKey, meetingId) ir
 * grąžintą REZULTATĄ (transkripciją) Redis'e dar 1-24 val. po užbaigimo.
 * Grąžina pašalinto jobo data (kad iškviečiantis galėtų dar išvalyti storage)
 * arba null, jei jobo eilėje nebėra.
 */
async function removeTranscriptionJob(jobId) {
  const queue = getTranscriptionQueue();
  const job = await queue.getJob(jobId);
  if (!job) return null;

  const data = job.data;
  await job.remove();
  return data;
}

async function closeTranscriptionQueue() {
  if (_queue) {
    await _queue.close();
    _queue = null;
  }

  if (_connection) {
    await _connection.quit();
    _connection = null;
  }
}

module.exports = { getTranscriptionQueue, addTranscriptionJob, removeTranscriptionJob, closeTranscriptionQueue };
