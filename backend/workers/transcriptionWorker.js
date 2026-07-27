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
  // Naudojam bendrą apsaugą (workers/index.js) - atsisako startuoti, jei nėra REDIS_URL
  // arba jobStore fallback'ino į memory (BullMQ worker su memory store nematytų backend
  // jobų). Ta pati logika kaip index.js ir protocolWorker - viena vieta.
  const { initializeWorkerOrFail } = require("./index");
  initializeWorkerOrFail("Transkripcijos worker")
    .then(() => {
      startTranscriptionWorker();
      console.log("[stenograma] Transkripcijos worker'is paleistas.");
    })
    .catch((error) => {
      console.error(`[stenograma] Transkripcijos worker nepaleistas: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { startTranscriptionWorker };
