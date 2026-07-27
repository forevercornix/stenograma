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
  };

  const { initializeWorkerOrFail } = require("../workers/index");
  await assert.rejects(() => initializeWorkerOrFail("Test worker"), /negali veikti be Redis/);

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
  };

  const { initializeWorkerOrFail } = require("../workers/index");
  await assert.doesNotReject(() => initializeWorkerOrFail("Test worker"));

  delete require.cache[jobStorePath];
  if (prevUrl === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = prevUrl;
});
