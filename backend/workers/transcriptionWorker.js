const { QUEUE_NAMES } = require("../queues/config");
const { transcriptionProcessor } = require("../queues/processors");
const { createWorker } = require("./index");
const { createLogger } = require("../utils/logger");
const log = createLogger("worker:transcription");

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
  // runWorkerProcess (workers/index.js): Redis job store patikra, heartbeat SU
  // "transcription" tipu (kad /api/ready matytų šį worker'į gyvą), graceful
  // shutdown (SIGTERM/SIGINT laukia vykdomo darbo prieš uždarant).
  const { runWorkerProcess } = require("./index");
  runWorkerProcess("Transkripcijos worker", startTranscriptionWorker, "transcription")
    .then(() => {
      log.info("Transkripcijos worker'is paleistas.");
    })
    .catch((error) => {
      log.error(`Transkripcijos worker nepaleistas: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { startTranscriptionWorker };
