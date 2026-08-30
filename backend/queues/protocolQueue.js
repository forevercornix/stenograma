const { QUEUE_NAMES, DEFAULT_JOB_OPTIONS, createQueueConnection, enqueue } = require("./config");

/**
 * Protokolo generavimo eilė (atskiras modulis pagal 1 etapo struktūros reikalavimą).
 *
 * Analogiška transcriptionQueue.js, tik protokolo (LLM) jobams. Vykdo
 * workers/protocolWorker.js.
 */
let _queue = null;
let _connection = null;

function getProtocolQueue() {
  if (_queue) return _queue;
  const { Queue } = require("bullmq");
  _connection = createQueueConnection();
  _queue = new Queue(QUEUE_NAMES.PROTOCOL, { connection: _connection });
  return _queue;
}

async function addProtocolJob(jobId, payload) {
  const queue = getProtocolQueue();
  /** ⚠️ Per `enqueue()` - žr. `transcriptionQueue` komentarą (#155, 7.5a). */
  return enqueue(queue, "generate", { jobId, payload }, { ...DEFAULT_JOB_OPTIONS, jobId });
}

/**
 * Analogiškai transcriptionQueue.removeTranscriptionJob - pašalina protokolo
 * jobą iš eilės kartu su jo payload'u (transkriptu!) ir rezultatu.
 */
async function removeProtocolJob(jobId) {
  const queue = getProtocolQueue();
  const job = await queue.getJob(jobId);
  if (!job) return null;

  const data = job.data;
  await job.remove();
  return data;
}

async function closeProtocolQueue() {
  if (_queue) {
    await _queue.close();
    _queue = null;
  }

  if (_connection) {
    await _connection.quit();
    _connection = null;
  }
}

module.exports = { getProtocolQueue, addProtocolJob, removeProtocolJob, closeProtocolQueue };
