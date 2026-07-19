const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

/**
 * BullMQ režimo testas su MOCK bullmq/ioredis.
 *
 * Tikras BullMQ reikalauja veikiančio Redis (sandbox'e nėra). Čia mock'iname
 * `bullmq` Queue, kad patikrintume: jobRunner BullMQ režime NEVYKDO darbo inline,
 * o teisingai kviečia queue.add(jobId, payload). Realus BullMQ + Redis srautas
 * (retry, restart recovery) tikrinamas atskiru integraciniu testu su tikru Redis
 * (žr. tests/queueRecovery.integration.test.js - skip be REDIS_URL).
 */

test("jobRunner BullMQ režime kviečia queue.add, nevykdo inline", async () => {
  // Mock'iname bullmq ir ioredis prieš įkeliant jobRunner.
  const added = { transcription: [], protocol: [] };

  class MockQueue {
    constructor(name) {
      this.name = name;
    }
    async add(jobName, data, opts) {
      if (this.name.includes("transcription")) added.transcription.push({ data, opts });
      else if (this.name.includes("protocol")) added.protocol.push({ data, opts });
      return { id: opts?.jobId || "mock-job" };
    }
    async close() {}
  }

  // Perimame require("bullmq") ir require("ioredis").
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "bullmq") return { Queue: MockQueue, Worker: class {} };
    if (request === "ioredis") return class MockRedis { constructor() {} };
    return origLoad.apply(this, arguments);
  };

  try {
    process.env.REDIS_URL = "redis://mock:6379";
    delete require.cache[require.resolve("../queues/jobRunner")];
    delete require.cache[require.resolve("../queues/config")];
    const jobRunner = require("../queues/jobRunner");

    await jobRunner.init();
    assert.equal(jobRunner.getMode(), "bullmq");

    await jobRunner.enqueueProtocol("job-1", { transcript: "tekstas" });
    await jobRunner.enqueueTranscription("job-2", { storageKey: "uploads/x.wav" });

    // Patikrinam, kad jobai ĮDĖTI į eiles (ne vykdyti inline).
    assert.equal(added.protocol.length, 1);
    assert.equal(added.protocol[0].data.jobId, "job-1");
    assert.equal(added.transcription.length, 1);
    assert.equal(added.transcription[0].data.jobId, "job-2");
    assert.equal(added.transcription[0].data.payload.storageKey, "uploads/x.wav");

    // KRITINIS: retry/backoff opcijos REALIAI perduodamos į queue.add (kad
    // DEFAULT_JOB_OPTIONS nebūtų vien deklaruotos, bet nepajungtos).
    assert.ok(added.transcription[0].opts.attempts >= 1, "attempts turi būti perduotas");
    assert.ok(added.transcription[0].opts.backoff, "backoff turi būti perduotas");
    assert.equal(added.transcription[0].opts.jobId, "job-2", "jobId idempotentiškumui");

    await jobRunner.close();
  } finally {
    Module._load = origLoad;
    delete process.env.REDIS_URL;
    // Atstatom švarų jobRunner kitiems testams.
    delete require.cache[require.resolve("../queues/jobRunner")];
    delete require.cache[require.resolve("../queues/config")];
  }
});

test("jobRunner BullMQ režime, REDIS_REQUIRED=true, init klysta jei bullmq neveikia", async () => {
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === "bullmq") throw new Error("bullmq nepasiekiamas");
    return origLoad.apply(this, arguments);
  };
  try {
    process.env.REDIS_URL = "redis://mock:6379";
    process.env.REDIS_REQUIRED = "true";
    delete require.cache[require.resolve("../queues/jobRunner")];
    const jobRunner = require("../queues/jobRunner");
    await assert.rejects(() => jobRunner.init(), /REDIS_REQUIRED/);
  } finally {
    Module._load = origLoad;
    delete process.env.REDIS_URL;
    delete process.env.REDIS_REQUIRED;
    delete require.cache[require.resolve("../queues/jobRunner")];
  }
});
