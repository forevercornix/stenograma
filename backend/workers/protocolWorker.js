const { QUEUE_NAMES } = require("../queues/config");
const { protocolProcessor } = require("../queues/processors");
const { createWorker } = require("./index");
const { createLogger } = require("../utils/logger");
const log = createLogger("worker:protocol");

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
  // runWorkerProcess (workers/index.js): Redis job store patikra, heartbeat SU
  // "protocol" tipu, graceful shutdown - žr. transcriptionWorker.js analogišką pastabą.
  const { runWorkerProcess } = require("./index");
  runWorkerProcess("Protokolo worker", startProtocolWorker, "protocol")
    .then(() => {
      log.info("[stenograma] Protokolo worker'is paleistas.");
    })
    .catch((error) => {
      log.error(`Protokolo worker nepaleistas: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { startProtocolWorker };
