const test = require("node:test");
const assert = require("node:assert/strict");

const { createRedisStore, serialize, deserialize } = require("../utils/jobStore/redisStore");
const { newJob } = require("../utils/jobStore/common");

/**
 * FAKE Redis klientas - imituoja ioredis API (hset/hgetall/zadd/...) in-memory,
 * kad Redis backend'o LOGIKĄ (serialize/deserialize, raktų schema, sweep) būtų
 * galima testuoti BE tikro Redis serverio (sandbox'e jo nėra). Tai NEtikrina
 * tikro Redis tinklo elgesio, bet tikrina, kad mūsų kodas teisingai naudoja
 * Redis komandas ir teisingai (de)serializuoja job'us.
 */
class FakeRedis {
  constructor() {
    this.hashes = new Map(); // key -> {field: value}
    this.zsets = new Map(); // key -> Map(member -> score)
    this.expires = new Map();
  }
  async hset(key, obj) {
    this.hashes.set(key, { ...(this.hashes.get(key) || {}), ...obj });
    return "OK";
  }
  async hgetall(key) {
    return this.hashes.get(key) || {};
  }
  async zadd(key, score, member) {
    if (!this.zsets.has(key)) this.zsets.set(key, new Map());
    this.zsets.get(key).set(member, score);
    return 1;
  }
  async zrangebyscore(key, min, max) {
    const z = this.zsets.get(key);
    if (!z) return [];
    return [...z.entries()].filter(([, s]) => s >= min && s <= max).map(([m]) => m);
  }
  async zrem(key, member) {
    const z = this.zsets.get(key);
    if (z) z.delete(member);
    return 1;
  }
  async zcard(key) {
    return this.zsets.get(key)?.size || 0;
  }
  async zrange(key, start, stop) {
    const z = this.zsets.get(key);
    if (!z) return [];
    // Rūšiuojam pagal score (kaip Redis), grąžinam member'ius. start/stop: 0,-1 = visi.
    const sorted = [...z.entries()].sort((a, b) => a[1] - b[1]).map(([m]) => m);
    const end = stop === -1 ? sorted.length : stop + 1;
    return sorted.slice(start, end);
  }
  pipeline() {
    // Minimalus pipeline mock: kaupia komandas, exec() grąžina [[null, rezultatas], ...].
    const cmds = [];
    const self = this;
    const p = {
      exists(key) { cmds.push(["exists", key]); return p; },
      async exec() {
        const out = [];
        for (const [cmd, key] of cmds) {
          if (cmd === "exists") out.push([null, self.hashes.has(key) ? 1 : 0]);
        }
        return out;
      },
    };
    return p;
  }
  async exists(key) {
    return this.hashes.has(key) ? 1 : 0;
  }
  async expire(key, seconds) {
    this.expires.set(key, seconds);
    return 1;
  }
  // Imituojam expire efektą testui: pašalinam hash, paliekam zset įrašą.
  _forceExpire(key) {
    this.hashes.delete(key);
  }
}

test("serialize/deserialize: išlaiko visus laukus, JSON reikšmes ir null'us", () => {
  const job = newJob();
  job.result = { protocol: { title: "Testas" } };
  job.progress = { current: 5, total: 10 };
  job.attempt_count = 2;

  const flat = serialize(job);
  // Redis hash reikšmės - tik string'ai.
  for (const v of Object.values(flat)) assert.equal(typeof v, "string");

  const restored = deserialize(flat);
  assert.deepEqual(restored.result, { protocol: { title: "Testas" } });
  assert.deepEqual(restored.progress, { current: 5, total: 10 });
  assert.equal(restored.attempt_count, 2);
  assert.equal(restored.started_at, null); // tuščias -> null
});

test("deserialize: tuščias hash grąžina null (jobas nerastas)", () => {
  assert.equal(deserialize({}), null);
  assert.equal(deserialize(null), null);
});

test("Redis store: create -> get grąžina tą patį jobą", async () => {
  const store = createRedisStore(new FakeRedis());
  const job = await store.create();
  const fetched = await store.get(job.id);
  assert.equal(fetched.id, job.id);
  assert.equal(fetched.status, store.STATUS.QUEUED);
});

test("Redis store: update išlaiko laukus ir nustato timestamps", async () => {
  const store = createRedisStore(new FakeRedis());
  const job = await store.create();
  await store.update(job.id, { status: store.STATUS.PROCESSING, attempt_count: 1 });
  const updated = await store.update(job.id, { status: store.STATUS.COMPLETED, result: { ok: true } });
  assert.equal(updated.status, store.STATUS.COMPLETED);
  assert.ok(updated.started_at);
  assert.ok(updated.completed_at);
  assert.deepEqual(updated.result, { ok: true });
});

test("Redis store: get nesamo jobo grąžina null", async () => {
  const store = createRedisStore(new FakeRedis());
  assert.equal(await store.get("nera-tokio"), null);
});

test("Redis store: sweepExpired išvalo indeksą nuo expiravusių raktų", async () => {
  const fake = new FakeRedis();
  const store = createRedisStore(fake);
  const job = await store.create();
  await store.update(job.id, { status: store.STATUS.COMPLETED });

  // Imituojam, kad hash expiravo (Redis EXPIRE suveikė), bet zset įrašas liko.
  fake._forceExpire("job:" + job.id);

  const removed = await store.sweepExpired(Date.now() + 999 * 60 * 1000);
  assert.equal(removed, 1); // indeksas išvalytas
  assert.equal(await store.size(), 0);
});

test("Redis store: size() NEįskaito jobų, kurių hash išnyko (TTL), bet indekse liko", async () => {
  // P3 regresija: zcard(INDEX_KEY) skaičiuotų ir "vaiduoklius" - jobus, kurių hash
  // pasibaigė per TTL, bet indekso įrašas dar nepašalintas (sweepExpired daro periodiškai).
  // size() dabar tikrina realų egzistavimą.
  const fake = new FakeRedis();
  const store = createRedisStore(fake);
  const job1 = await store.create();
  const job2 = await store.create();
  assert.equal(await store.size(), 2, "du sukurti jobai");

  // Simuliuojam TTL: job1 hash IŠNYKO (ištrinam iš hashes), bet indekse (zsets) LIEKA.
  fake.hashes.delete("job:" + job1.id);
  assert.equal(await store.size(), 1, "size() turi skaičiuoti tik realiai egzistuojantį (job2)");
});
