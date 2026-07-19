const { QUEUE_NAMES, DEFAULT_JOB_OPTIONS, createQueueConnection } = require("./config");

/**
 * Protokolo generavimo eilė (atskiras modulis pagal 1 etapo struktūros reikalavimą).
 *
 * Analogiška transcriptionQueue.js, tik protokolo (LLM) jobams. Vykdo
 * workers/protocolWorker.js.
 */
let _queue = null;

function getProtocolQueue() {
  if (_queue) return _queue;
  const { Queue } = require("bullmq");
  _queue = new Queue(QUEUE_NAMES.PROTOCOL, { connection: createQueueConnection() });
  return _queue;
}

async function addProtocolJob(jobId, payload) {
  const queue = getProtocolQueue();
  return queue.add("generate", { jobId, payload }, { ...DEFAULT_JOB_OPTIONS, jobId });
}

async function closeProtocolQueue() {
  if (_queue) {
    await _queue.close();
    _queue = null;
  }
}

module.exports = { getProtocolQueue, addProtocolJob, closeProtocolQueue };
