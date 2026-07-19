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
  if (!process.env.REDIS_URL) {
    console.error("[stenograma] protocolWorker reikia REDIS_URL (BullMQ).");
    process.exit(1);
  }
  const jobStore = require("../utils/jobStore");
  jobStore.init().then(() => {
    startProtocolWorker();
    console.log("[stenograma] Protokolo worker'is paleistas.");
  });
}

module.exports = { startProtocolWorker };
