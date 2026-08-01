const { createLogger } = require("../utils/logger");
const log = createLogger("heartbeat");
// Worker heartbeat: worker'is periodiškai rašo Redis raktą su TTL, o /api/ready tikrina,
// ar raktas šviežias. Taip readiness patvirtina ne tik kad Redis pasiekiamas, bet ir kad
// worker'is GYVAS ir apdoros jobus. Be šio - readiness galėtų rodyti ready=true, kai
// worker konteineris išjungtas, ir jobai liktų amžinai queued.
//
// PER-TIPO RAKTAI (transcription/protocol atskirai): kadangi worker'iai gali būti
// paleisti kaip DU ATSKIRI procesai/konteineriai (žr. workers/transcriptionWorker.js,
// workers/protocolWorker.js, docker-compose.gpu.yml/server.yml), vienas bendras
// raktas NEATSPINDĖTŲ tikrosios būsenos - jei tik protokolo worker'is gyvas, o
// transkripcijos miręs, bendras raktas vis tiek rodytų "gyva", nors pusė sistemos
// neveiktų. `workerType` parametras leidžia tikrinti KIEKVIENĄ eilę atskirai.
//
// ATGALINIS SUDERINAMUMAS: jei `workerType` nenurodytas, paliekamas legacy
// bendro rakto režimas (`HEARTBEAT_KEY`) atgaliniam API suderinamumui ir
// senesniems testams (`tests/workerHeartbeat.test.js`). Dabartiniai worker
// entrypoint'ai (`workers/index.js` startWorkers(), `workers/transcriptionWorker.js`,
// `workers/protocolWorker.js`) VISI naudoja tipinius raktus (`["transcription",
// "protocol"]` arba pavienį tipą) - NĖ VIENAS jų NENAUDOJA šio legacy bendro
// rakto realiame paleidime.
//
// Unit logika (startHeartbeat/isWorkerAlive/getWorkerStatus) testuojama su mock
// Redis (`tests/workerHeartbeat.test.js`, `tests/runWorkerProcess.test.js`), o
// visa heartbeat -> Redis -> /api/ready grandinė TIKRU Redis patikrinta
// `tests/heartbeatReadiness.integration.test.js`.

const HEARTBEAT_KEY = "stenograma:worker:lastSeen"; // legacy bendras raktas (atgaliniam suderinamumui)
// TTL turi būti ženkliai didesnis nei rašymo intervalas (kad tinklo trumpas šuolis
// nepaskelbtų worker'io mirusiu). Rašom kas 10s, TTL 30s (praleidžiam iki 2 rašymų).
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TTL_SEC = 30;

const WORKER_TYPES = ["transcription", "protocol"];

/**
 * Grąžina Redis raktą konkrečiam worker tipui.
 * @param {string} workerType - "transcription" | "protocol"
 * @throws jei workerType nėra WORKER_TYPES sąraše (fail-fast apsauga nuo rašybos
 *   klaidos entrypoint'e - be šito, worker'is veiktų, bet /api/ready jo NIEKADA
 *   nepamatytų, nes rašytų į raktą, kurio niekas netikrina).
 */
function heartbeatKey(workerType) {
  if (!WORKER_TYPES.includes(workerType)) {
    throw new Error(
      `Nežinomas worker tipas: "${workerType}". Turi būti vienas iš: ${WORKER_TYPES.join(", ")}.`
    );
  }
  return `stenograma:worker:${workerType}:lastSeen`;
}

/**
 * Paleidžia periodinį heartbeat rašymą. Grąžina stop() funkciją (graceful shutdown).
 * @param {object} connection - ioredis klientas (createQueueConnection()).
 * @param {string|string[]} [workerType] - "transcription", "protocol", abu kaip
 *   masyvas (`["transcription","protocol"]` - naudoja workers/index.js kombinuotas
 *   procesas), arba NENURODYTA (legacy bendras HEARTBEAT_KEY).
 */
function startHeartbeat(connection, workerType) {
  const keys = workerType === undefined
    ? [HEARTBEAT_KEY]
    : (Array.isArray(workerType) ? workerType : [workerType]).map(heartbeatKey);

  async function beat() {
    try {
      // SET su EX (TTL) - raktas pats išnyksta, jei worker'is nustoja rašyti.
      // Visi raktai rašomi lygiagrečiai (paprastai tik vienas, bet kombinuotam
      // workers/index.js atvejui gali būti keli).
      await Promise.all(
        keys.map((key) => connection.set(key, String(Date.now()), "EX", HEARTBEAT_TTL_SEC))
      );
    } catch (e) {
      // Heartbeat rašymo klaida neturi griauti worker'io - tik logas.
      log.warn(`Heartbeat rašymo klaida: ${e.message}`);
    }
  }
  beat(); // rašom iškart (nelaukiam pirmo intervalo)
  const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  timer.unref(); // netrukdo procesui baigtis
  return function stop() {
    clearInterval(timer);
  };
}

/**
 * Tikrina, ar worker heartbeat šviežias. Naudoja /api/ready.
 * @param {object} connection - ioredis klientas.
 * @param {string} [workerType] - "transcription" | "protocol" | nenurodyta (legacy raktas).
 * @returns {Promise<boolean>} true, jei raktas egzistuoja (worker gyvas per TTL langą).
 */
async function isWorkerAlive(connection, workerType) {
  const key = workerType === undefined ? HEARTBEAT_KEY : heartbeatKey(workerType);
  // Raktas su TTL: jei egzistuoja, worker rašė per paskutines HEARTBEAT_TTL_SEC sekundes.
  // exists grąžina 1/0. Papildomai netikrinam timestamp - TTL pats užtikrina šviežumą.
  const exists = await connection.exists(key);
  return exists === 1;
}

/**
 * Patogumo funkcija /api/ready'iui - grąžina KIEKVIENO worker tipo būseną atskirai,
 * kad readiness atsakymas galėtų parodyti, kuri konkrečiai eilė neturi gyvo worker'io
 * (žr. server.js `/api/ready`).
 * @param {object} connection - ioredis klientas.
 * @returns {Promise<{transcription: boolean, protocol: boolean}>}
 */
async function getWorkerStatus(connection) {
  const entries = await Promise.all(
    WORKER_TYPES.map(async (type) => [type, await isWorkerAlive(connection, type)])
  );
  return Object.fromEntries(entries);
}

module.exports = {
  HEARTBEAT_KEY,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TTL_SEC,
  WORKER_TYPES,
  heartbeatKey,
  startHeartbeat,
  isWorkerAlive,
  getWorkerStatus,
};
