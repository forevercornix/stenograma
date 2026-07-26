const test = require("node:test");
const assert = require("node:assert/strict");

process.env.JOB_TTL_MINUTES = "1"; // trumpas TTL testui - skaitomas modulio įkėlimo metu

const jobStore = require("../utils/jobStore");

test("jobStore backend: be REDIS_URL naudojamas in-memory", async () => {
  await jobStore.init();
  assert.equal(jobStore.getBackend(), "memory");
});

test("create: naujas jobas turi visus production laukus", async () => {
  const job = await jobStore.create();
  assert.equal(job.status, jobStore.STATUS.QUEUED);
  assert.equal(job.attempt_count, 0);
  assert.ok(job.created_at);
  assert.equal(job.started_at, null);
  assert.equal(job.completed_at, null);
  assert.equal(job.error_code, null);
});

test("update: PROCESSING nustato started_at automatiškai", async () => {
  const job = await jobStore.create();
  const updated = await jobStore.update(job.id, { status: jobStore.STATUS.PROCESSING, attempt_count: 1 });
  assert.equal(updated.status, jobStore.STATUS.PROCESSING);
  assert.ok(updated.started_at, "started_at turi būti nustatytas");
  assert.equal(updated.attempt_count, 1);
});

test("update: COMPLETED nustato completed_at automatiškai", async () => {
  const job = await jobStore.create();
  const updated = await jobStore.update(job.id, { status: jobStore.STATUS.COMPLETED, result: { protocol: {} } });
  assert.ok(updated.completed_at, "completed_at turi būti nustatytas");
});

test("update: FAILED su error_code, ir error <-> error_message sinchronizuojami", async () => {
  const job = await jobStore.create();
  const updated = await jobStore.update(job.id, {
    status: jobStore.STATUS.FAILED,
    error: "kažkas nutiko",
    error_code: "internal_error",
  });
  assert.equal(updated.error, "kažkas nutiko");
  assert.equal(updated.error_message, "kažkas nutiko"); // sinchronizuota
  assert.equal(updated.error_code, "internal_error");
  assert.ok(updated.completed_at);
});

test("sweepExpired: nešalina QUEUED/PROCESSING jobų, kad ir kokie seni", async () => {
  const job = await jobStore.create();
  await jobStore.update(job.id, { status: jobStore.STATUS.PROCESSING });
  const farFuture = Date.now() + 999 * 60 * 1000;
  await jobStore.sweepExpired(farFuture);
  // Tikrinam KONKRETŲ jobą (ne bendrą removed skaičių - kiti testai dalinasi ta
  // pačia in-memory saugykla): PROCESSING jobas turi IŠLIKTI, kad ir koks senas.
  assert.ok(await jobStore.get(job.id), "PROCESSING jobas neturi būti pašalintas");
});

test("sweepExpired: pašalina COMPLETED jobą po TTL, bet ne prieš tai", async () => {
  const job = await jobStore.create();
  await jobStore.update(job.id, { status: jobStore.STATUS.COMPLETED, result: { protocol: {} } });

  const beforeTtl = Date.now() + 30 * 1000; // 30s < 1 min TTL
  await jobStore.sweepExpired(beforeTtl);
  assert.ok(await jobStore.get(job.id), "prieš TTL jobas dar turi būti");

  const afterTtl = Date.now() + 2 * 60 * 1000; // 2 min > 1 min TTL
  await jobStore.sweepExpired(afterTtl);
  assert.equal(await jobStore.get(job.id), null, "po TTL jobas turi būti pašalintas");
});

test("sweepExpired: pašalina CANCELLED jobą po TTL", async () => {
  const job = await jobStore.create();
  await jobStore.update(job.id, { status: jobStore.STATUS.CANCELLED });
  const afterTtl = Date.now() + 2 * 60 * 1000;
  await jobStore.sweepExpired(afterTtl);
  assert.equal(await jobStore.get(job.id), null, "CANCELLED jobas po TTL turi būti pašalintas");
});

test("TIKRA race: create() laukia neužbaigto Redis init (ne memory), kol connect() lėtas", async (t) => {
  // Reviewer pastaba: ankstesni testai netikrino tikros race (init jau buvo užbaigtas).
  // Čia injektuojam mock Redis su KONTROLIUOJAMU connect() - kol jis "kabo", pradedam
  // create(). Tikrinam, kad create NElaukia memory, o laukia Redis init pabaigos.
  await jobStore._resetForTests();
  process.env.REDIS_URL = "redis://mock:6379";

  // t.after: cleanup įvyksta NET jei assert kristų (kitaip REDIS_URL/mock factory/
  // initPromise nutekėtų į kitus testus).
  t.after(async () => {
    await jobStore._resetForTests();
    delete process.env.REDIS_URL;
  });

  let releaseConnect;
  const connectGate = new Promise((resolve) => { releaseConnect = resolve; });

  // Mock ioredis: connect() laukia gate; kiti metodai - minimalus in-memory imitatorius,
  // kad createRedisStore veiktų (testo esmė - connect() timing, ne pilnas Redis).
  function MockRedis() {
    const hashes = new Map();
    const zsets = new Map();
    return {
      connect: () => connectGate, // KABO kol releaseConnect()
      ping: async () => "PONG",
      hset: async (k, obj) => { hashes.set(k, { ...(hashes.get(k) || {}), ...obj }); return 1; },
      hgetall: async (k) => hashes.get(k) || {},
      exists: async (k) => (hashes.has(k) ? 1 : 0),
      expire: async () => 1,
      zadd: async (k, score, member) => {
        const z = zsets.get(k) || new Map(); z.set(member, score); zsets.set(k, z); return 1;
      },
      zcard: async (k) => (zsets.get(k)?.size || 0),
      zrangebyscore: async () => [],
      zrem: async (k, member) => { zsets.get(k)?.delete(member); return 1; },
      on: () => {},
      quit: async () => {},
    };
  }
  jobStore._setRedisFactoryForTests(MockRedis);

  // Pradedam init (kabo ties connect) ir IŠ KARTO create - create turi laukti init.
  const initPromise = jobStore.init();
  const createPromise = jobStore.create();

  // Duodam event loop'ui pasisukti - jei create nelauktų init, jis jau būtų pabaigęs
  // su memory store. Tikrinam, kad jis DAR nebaigė (laukia gate).
  let createDone = false;
  createPromise.then(() => { createDone = true; }).catch(() => {});
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(createDone, false, "create() turi LAUKTI init (ne baigti su memory)");

  // Atleidžiam connect - init baigiasi, create pagaliau vykdomas per Redis store.
  releaseConnect();
  await initPromise;
  await createPromise;
  assert.equal(createDone, true, "atleidus connect, create() užbaigiamas");
  assert.equal(jobStore.getBackend(), "redis", "store turi būti Redis (ne memory)");
  // cleanup - per t.after (atsparus assert kritimui)
});

test("init() lygiagrečiai grąžina TĄ PATĮ store (initPromise dalinimasis)", async () => {
  await jobStore._resetForTests();
  delete process.env.REDIS_URL;
  const [s1, s2, s3] = await Promise.all([jobStore.init(), jobStore.init(), jobStore.init()]);
  assert.equal(s1, s2);
  assert.equal(s2, s3);
});
