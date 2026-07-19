const { QUEUE_NAMES } = require("../queues/config");
const { transcriptionProcessor } = require("../queues/processors");
const { createWorker } = require("./index");

/**
 * Transkripcijos worker'is (atskiras modulis pagal 1 etapo struktūros reikalavimą).
 *
 * Klausosi TIK transkripcijos eilės. Gali būti paleistas atskirai nuo protokolo
 * worker'io (skirtingas skalavimas - transkripcija imlesnė GPU nei LLM):
 *   node workers/transcriptionWorker.js
 *
 * Bendrą vykdymo logiką (retry, failed, storage cleanup) teikia createWorker
 * (workers/index.js), kad kodas nesidubliuotų.
 */
function startTranscriptionWorker() {
  return createWorker(QUEUE_NAMES.TRANSCRIPTION, transcriptionProcessor);
}

if (require.main === module) {
  if (!process.env.REDIS_URL) {
    console.error("[stenograma] transcriptionWorker reikia REDIS_URL (BullMQ).");
    process.exit(1);
  }
  const jobStore = require("../utils/jobStore");
  jobStore.init().then(() => {
    startTranscriptionWorker();
    console.log("[stenograma] Transkripcijos worker'is paleistas.");
  });
}

module.exports = { startTranscriptionWorker };
