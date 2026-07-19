const jobRunner = require("./jobRunner");
const { transcriptionProcessor, protocolProcessor } = require("./processors");

/**
 * Registruoja processor'ius jobRunner'iui, kad INLINE režimas (be Redis) vykdytų
 * tą patį kodą, kaip BullMQ worker'iai. Importuojamas server.js paleidime.
 */
function registerProcessors() {
  jobRunner.registerProcessor("transcription", transcriptionProcessor);
  jobRunner.registerProcessor("protocol", protocolProcessor);
}

module.exports = { registerProcessors };
