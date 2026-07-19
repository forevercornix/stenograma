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
