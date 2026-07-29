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

module.exports = { getTranscriptionQueue, addTranscriptionJob, closeTranscriptionQueue };
