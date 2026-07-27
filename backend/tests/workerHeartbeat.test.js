const test = require("node:test");
const assert = require("node:assert/strict");
const { startHeartbeat, isWorkerAlive, HEARTBEAT_KEY, HEARTBEAT_TTL_SEC } = require("../utils/workerHeartbeat");

// Heartbeat logika unit-testuota su mock Redis. TIKRAS Redis srautas (worker rašo, ready
// skaito per tinklą) NETESTUOTAS - sandbox neturi Redis.

function mockConnection() {
  const store = new Map();
  return {
    store,
    async set(key, value, mode, ttl) {
      store.set(key, { value, ttl, mode });
      return "OK";
    },
    async exists(key) {
      return store.has(key) ? 1 : 0;
    },
    async quit() {},
    // testui: simuliuojam TTL pasibaigimą
    _expire(key) { store.delete(key); },
  };
}

test("startHeartbeat rašo raktą su TTL iš karto", async () => {
  const conn = mockConnection();
  const stop = startHeartbeat(conn);
  // beat() kviečiamas iškart (async) - palaukiam microtask.
  await new Promise((r) => setImmediate(r));
  const entry = conn.store.get(HEARTBEAT_KEY);
  assert.ok(entry, "heartbeat raktas turi būti parašytas");
  assert.equal(entry.mode, "EX");
  assert.equal(entry.ttl, HEARTBEAT_TTL_SEC);
  stop();
});

test("isWorkerAlive grąžina true kai raktas egzistuoja", async () => {
  const conn = mockConnection();
  await conn.set(HEARTBEAT_KEY, String(Date.now()), "EX", HEARTBEAT_TTL_SEC);
  assert.equal(await isWorkerAlive(conn), true);
});

test("isWorkerAlive grąžina false kai raktas išnyko (TTL / worker miręs)", async () => {
  const conn = mockConnection();
  await conn.set(HEARTBEAT_KEY, String(Date.now()), "EX", HEARTBEAT_TTL_SEC);
  conn._expire(HEARTBEAT_KEY); // simuliuojam TTL pabaigą / worker mirtį
  assert.equal(await isWorkerAlive(conn), false);
});

test("stop() sustabdo heartbeat rašymą", async () => {
  const conn = mockConnection();
  const stop = startHeartbeat(conn);
  await new Promise((r) => setImmediate(r));
  stop();
  conn.store.clear();
  // po stop - naujų rašymų neturi būti (interval sustabdytas). Palaukiam trumpai.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(conn.store.has(HEARTBEAT_KEY), false, "po stop() naujų heartbeat rašymų nėra");
});
