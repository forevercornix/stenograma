const { QUEUE_NAMES } = require("../queues/config");
const { protocolProcessor } = require("../queues/processors");
const { createWorker } = require("./index");

/**
 * Protokolo generavimo worker'is (atskiras modulis pagal struktūros reikalavimą).
 *
 * Klausosi TIK protokolo eilės. Gali būti paleistas atskirai:
 *   node workers/protocolWorker.js
 *
 * Bendrą logiką teikia createWorker (workers/index.js).
 */
function startProtocolWorker() {
  return createWorker(QUEUE_NAMES.PROTOCOL, protocolProcessor);
}

if (require.main === module) {
  // Bendra apsauga (žr. workers/index.js) - ta pati kaip transcriptionWorker.
  const { initializeWorkerOrFail } = require("./index");
  initializeWorkerOrFail("Protokolo worker")
    .then(() => {
      startProtocolWorker();
      console.log("[stenograma] Protokolo worker'is paleistas.");
    })
    .catch((error) => {
      console.error(`[stenograma] Protokolo worker nepaleistas: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { startProtocolWorker };
