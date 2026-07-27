// Worker heartbeat: worker'is periodiškai rašo Redis raktą su TTL, o /api/ready tikrina,
// ar raktas šviežias. Taip readiness patvirtina ne tik kad Redis pasiekiamas, bet ir kad
// worker'is GYVAS ir apdoros jobus. Be šio - readiness galėtų rodyti ready=true, kai
// worker konteineris išjungtas, ir jobai liktų amžinai queued.
//
// NETESTUOTA su realiu Redis (sandbox neturi) - logika unit-testuota su mock.

const HEARTBEAT_KEY = "stenograma:worker:lastSeen";
// TTL turi būti ženkliai didesnis nei rašymo intervalas (kad tinklo trumpas šuolis
// nepaskelbtų worker'io mirusiu). Rašom kas 10s, TTL 30s (praleidžiam iki 2 rašymų).
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TTL_SEC = 30;

/**
 * Paleidžia periodinį heartbeat rašymą. Grąžina stop() funkciją (graceful shutdown).
 * @param {object} connection - ioredis klientas (createQueueConnection()).
 */
function startHeartbeat(connection) {
  async function beat() {
    try {
      // SET su EX (TTL) - raktas pats išnyksta, jei worker'is nustoja rašyti.
      await connection.set(HEARTBEAT_KEY, String(Date.now()), "EX", HEARTBEAT_TTL_SEC);
    } catch (e) {
      // Heartbeat rašymo klaida neturi griauti worker'io - tik logas.
      console.warn(`[stenograma] Heartbeat rašymo klaida: ${e.message}`);
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
 * @returns {Promise<boolean>} true, jei raktas egzistuoja (worker gyvas per TTL langą).
 */
async function isWorkerAlive(connection) {
  // Raktas su TTL: jei egzistuoja, worker rašė per paskutines HEARTBEAT_TTL_SEC sekundes.
  // exists grąžina 1/0. Papildomai netikrinam timestamp - TTL pats užtikrina šviežumą.
  const exists = await connection.exists(HEARTBEAT_KEY);
  return exists === 1;
}

module.exports = {
  HEARTBEAT_KEY,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TTL_SEC,
  startHeartbeat,
  isWorkerAlive,
};
