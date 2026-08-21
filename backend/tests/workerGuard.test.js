const test = require("node:test");
const assert = require("node:assert/strict");

// Regresinis testas P1/P2 pataisymui: worker'is NETURI startuoti, jei jobStore
// fallback'ino į memory (Redis neprieinamas). initializeWorkerOrFail iškelta į
// testuojamą funkciją (ne tik require.main bloke).

test("initializeWorkerOrFail meta klaidą be REDIS_URL", async () => {
  delete require.cache[require.resolve("../workers/index")];
  const prevUrl = process.env.REDIS_URL;
  delete process.env.REDIS_URL;
  const { initializeWorkerOrFail } = require("../workers/index");
  await assert.rejects(() => initializeWorkerOrFail("Test worker"), /REDIS_URL/);
  if (prevUrl !== undefined) process.env.REDIS_URL = prevUrl;
});

test("initializeWorkerOrFail meta klaidą, jei jobStore fallback'ino į memory", async () => {
  // REDIS_URL yra, bet jobStore backend = memory (Redis connect nepavyko). Worker turi
  // atsisakyti - kitaip klausytų BullMQ eilės su memory store ir nematytų backend jobų.
  const prevUrl = process.env.REDIS_URL;
  process.env.REDIS_URL = "redis://mock:6379";

  // Mock jobStore, kuris "pasako", kad backend = memory (fallback).
  delete require.cache[require.resolve("../workers/index")];
  const jobStorePath = require.resolve("../utils/jobStore");
  const realJobStore = require("../utils/jobStore");
  require.cache[jobStorePath].exports = {
    ...realJobStore,
    init: async () => {},
    getBackend: () => "memory", // simuliuojam fallback
    hasQueueBackend: () => false,
  };

  const { initializeWorkerOrFail } = require("../workers/index");
  await assert.rejects(() => initializeWorkerOrFail("Test worker"), /negali veikti be BENDROS/);

  // atkuriam
  delete require.cache[jobStorePath];
  if (prevUrl === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = prevUrl;
});

test("initializeWorkerOrFail praeina, kai jobStore backend = redis", async () => {
  const prevUrl = process.env.REDIS_URL;
  process.env.REDIS_URL = "redis://mock:6379";

  delete require.cache[require.resolve("../workers/index")];
  const jobStorePath = require.resolve("../utils/jobStore");
  const realJobStore = require("../utils/jobStore");
  require.cache[jobStorePath].exports = {
    ...realJobStore,
    init: async () => {},
    getBackend: () => "redis", // Redis pavyko
    hasQueueBackend: () => true,
  };

  const { initializeWorkerOrFail } = require("../workers/index");
  await assert.doesNotReject(() => initializeWorkerOrFail("Test worker"));

  delete require.cache[jobStorePath];
  if (prevUrl === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = prevUrl;
});

test("initializeWorkerOrFail praeina su PostgreSQL metaduomenimis + Redis eile", async () => {
  /**
   * ⚠️ #155, 7.2a. Anksčiau čia buvo `getBackend() !== "redis"`, tad atidarius
   * aktyvavimo barjerą su nustatytais IR `DATABASE_URL`, IR `REDIS_URL` HTTP
   * procesas dėtų job'us į BullMQ (`hasQueueBackend()` → `true`), o KIEKVIENAS
   * atskiras worker'is kristų starte: vartotojo darbas liktų eilėje amžinai,
   * be nė vieno vykdytojo.
   */
  const prevUrl = process.env.REDIS_URL;
  process.env.REDIS_URL = "redis://mock:6379";

  delete require.cache[require.resolve("../workers/index")];
  const jobStorePath = require.resolve("../utils/jobStore");
  const realJobStore = require("../utils/jobStore");
  require.cache[jobStorePath].exports = {
    ...realJobStore,
    init: async () => {},
    getBackend: () => "postgres",
    hasQueueBackend: () => true,
  };

  const { initializeWorkerOrFail } = require("../workers/index");
  await assert.doesNotReject(() => initializeWorkerOrFail("Test worker"));

  delete require.cache[jobStorePath];
  if (prevUrl === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = prevUrl;
});
