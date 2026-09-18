/**
 * ⚠️ Šis failas testuoja REDIS BACKEND'Ą TIESIOGIAI (`createRedisStore`), ne
 * `jobStore` fasadą. Backend'as fazių metodų (`startPhase`/`finish`) neturi –
 * jie gyvena fasade (#154). Todėl čia `update({ status })` yra TEISINGAS
 * kelias, o ne invarianto apėjimas.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { createRedisStore, serialize, deserialize } = require("../utils/jobStore/redisStore");
const { newJob } = require("../utils/jobStore/common");

/**
 * `FakeRedis` gyvena `helpers/fakeRedis.js` (#205, 7.2c).
 *
 * Iškelta, kai antram testui prireikė tos pačios imitacijos. Antra kopija
 * reikštų du fake'us, kurie ilgainiui elgtųsi skirtingai - ir du testus,
 * matuojančius skirtingą Redis.
 */
const { FakeRedis } = require("./helpers/fakeRedis");

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
  const job = await store.create({ ownerKind: "unowned" });
  const fetched = await store.get(job.id);
  assert.equal(fetched.id, job.id);
  assert.equal(fetched.status, store.STATUS.QUEUED);
});

test("Redis store: update išlaiko laukus ir nustato timestamps", async () => {
  const store = createRedisStore(new FakeRedis());
  const job = await store.create({ ownerKind: "unowned" });
  await store.update(job.id, { status: "processing", attempt_count: 1 });
  const updated = await store.update(job.id, { status: "completed", result: { ok: true } });
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
  const job = await store.create({ ownerKind: "unowned" });
  await store.update(job.id, { status: "completed" });

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
  const job1 = await store.create({ ownerKind: "unowned" });
  await store.create({ ownerKind: "unowned" });
  assert.equal(await store.size(), 2, "du sukurti jobai");

  // Simuliuojam TTL: job1 hash IŠNYKO (ištrinam iš hashes), bet indekse (zsets) LIEKA.
  fake.hashes.delete("job:" + job1.id);
  assert.equal(await store.size(), 1, "size() turi skaičiuoti tik realiai egzistuojantį (job2)");
});

test("remove deletes redis job", async () => {
  const redis = new FakeRedis();
  const store = createRedisStore(redis);

  const job = await store.create({ ownerKind: "unowned" });

  assert.ok(await store.get(job.id));

  const removed = await store.remove(job.id);

  assert.equal(removed, true);
  assert.equal(await store.get(job.id), null);
});

test("listReferencedStorageKeys naudoja VIENĄ pipeline round-trip", async () => {
  // Prie tūkstančių jobų N atskirų HGETALL reikštų N tinklo apsikeitimų.
  const client = new FakeRedis();
  const store = createRedisStore(client);

  const keys = [];
  for (let i = 0; i < 5; i += 1) {
    const job = await store.create({ ownerKind: "unowned", storageKey: `uploads/audio-${i}.wav` });
    keys.push(job.storageKey);
  }
  await store.create({ ownerKind: "unowned" }); // be storageKey

  let pipelinesCreated = 0;
  const originalPipeline = client.pipeline.bind(client);
  client.pipeline = () => {
    pipelinesCreated += 1;
    return originalPipeline();
  };

  const referenced = await store.listReferencedStorageKeys();

  assert.deepEqual(referenced.sort(), keys.sort());
  assert.equal(pipelinesCreated, 1, "turi būti vienas pipeline, ne N kvietimų");
});

test("listByFlag irgi eina per pipeline ir gaudo vėliavas", async () => {
  const client = new FakeRedis();
  const store = createRedisStore(client);

  const plain = await store.create({ ownerKind: "unowned", storageKey: "uploads/a.wav" });
  const flagged = await store.create({ ownerKind: "unowned", storageKey: "uploads/b.wav" });
  await store.update(flagged.id, { status: "completed", audio_cleanup_pending: true });

  const pending = await store.listByFlag("audio_cleanup_pending");

  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, flagged.id);
  assert.notEqual(pending[0].id, plain.id);
});

test("REGRESIJA: newJob() laukų TIPAI išgyvena Redis round-trip", async () => {
  // Bendra apsauga, ne tik konkretiems laukams: Redis hash'e viskas yra eilutė, tad
  // kiekvienas naujas boolean/number laukas privalo būti įrašytas į BOOLEAN_FIELDS
  // arba NUMBER_FIELDS. Be to `false` grįžta kaip "false" - TRUTHY - ir tyliai
  // sulaužo vėliavomis paremtą logiką.
  const { newJob } = require("../utils/jobStore/common");

  const job = newJob({ type: "transcription", storageKey: "uploads/a.wav" });
  job.status = "completed";
  job.deletion_pending = false;
  job.deletion_attempts = 0;
  job.attempt_count = 2;

  const round = deserialize(serialize(job));

  for (const [key, original] of Object.entries(job)) {
    if (original === null || original === undefined) continue;

    assert.equal(
      typeof round[key],
      typeof original,
      `laukas "${key}": tipas pakito ${typeof original} -> ${typeof round[key]}. ` +
        "Pridėkite jį į BOOLEAN_FIELDS arba NUMBER_FIELDS (redisStore.js)."
    );
  }

  assert.equal(round.audio_cleanup_pending, false);
  assert.equal(round.deletion_pending, false);
  assert.equal(round.deletion_attempts, 0);
  assert.equal(round.attempt_count, 2);
});

test("REGRESIJA: listByFlag negrąžina jobų su false vėliava", async () => {
  // Iki pataisos "false" buvo truthy, tad ši funkcija grąžindavo VISUS jobus, o
  // retryPendingAudioCleanups() tada trindavo dar apdorojamų jobų audio.
  const client = new FakeRedis();
  const store = createRedisStore(client);

  const active = await store.create({ ownerKind: "unowned", storageKey: "uploads/apdorojamas.wav" });
  await store.update(active.id, { status: "processing" });

  const flagged = await store.create({ ownerKind: "unowned", storageKey: "uploads/nepavyko.wav" });
  await store.update(flagged.id, { status: "completed", audio_cleanup_pending: true });

  const pending = await store.listByFlag("audio_cleanup_pending");

  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, flagged.id);
  assert.equal(pending[0].audio_cleanup_pending, true);
});

test("REGRESIJA: baigtas jobas be vėliavų gauna EXPIRE, ne PERSIST", async () => {
  // hasPendingCleanup() su "false" eilute buvo visada true, tad baigti jobai
  // Redis'e niekada neiškvėpdavo - retencija tyliai neveikė.
  const client = new FakeRedis();
  const calls = { expire: [], persist: [] };
  client.expire = async (key, ttl) => { calls.expire.push([key, ttl]); return 1; };
  client.persist = async (key) => { calls.persist.push(key); return 1; };

  const store = createRedisStore(client);

  const job = await store.create({ ownerKind: "unowned", storageKey: "uploads/a.wav" });
  await store.update(job.id, { status: "completed" });

  assert.equal(calls.expire.length, 1, "baigtam jobui turi būti nustatytas EXPIRE");
  assert.equal(calls.persist.length, 0);

  await store.update(job.id, { audio_cleanup_pending: true });
  assert.equal(calls.persist.length, 1, "pažymėtam jobui - PERSIST, kad neprarastume storageKey");
});
