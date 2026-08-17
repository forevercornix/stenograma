const { test } = require("node:test");
const assert = require("node:assert/strict");
const { skipWithoutRedis } = require("./helpers/redisGuard");

/**
 * #153: REZULTATO RIBA TIKRAME BullMQ WORKER KELYJE.
 *
 * KODĖL ATSKIRAS INTEGRACINIS TESTAS.
 *
 * `resultLimits` rinkinyje yra STATINIS sargas, tikrinantis, kad
 * `assertResultWithinLimits(result)` egzistuoja `workers/index.js` tekste. Jis
 * naudingas kaip mutacijos tripwire, bet praeitų ir su
 * `if (false) assertResultWithinLimits(result)`, ir jei patikra būtų PO
 * `jobStore.update(...)`.
 *
 * BullMQ kelias yra PRODUKCIJOS kelias, ir #153 blokuoja #155 (PostgreSQL) –
 * t. y. būtent šis kelias rašys į DB. #158/#159 pamoka: trys iš keturių radinių
 * atsirado tik su tikru Redis, o ne vienetiniuose testuose.
 *
 * ⚠️ Praleidžiamas be `REDIS_URL`; CI nustato `REQUIRE_REDIS=1`, tad ten
 * praleidimas tampa klaida.
 */

test(
  "#153 WORKER: per didelis rezultatas → job failed, RESULT_TOO_LARGE, result NEĮRAŠYTAS",
  { skip: skipWithoutRedis() },
  async (t) => {
    const jobStore = require("../utils/jobStore");
    const jobRunner = require("../queues/jobRunner");
    const { QUEUE_NAMES, createQueueConnection } = require("../queues/config");
    const { Queue } = require("bullmq");

    let worker;
    let queue;
    let queueConnection;

    t.after(async () => {
      const { shutdownWorker } = require("../workers");
      await shutdownWorker(worker, { force: true }).catch(() => {});
      await queue?.close().catch(() => {});
      await queueConnection?.quit().catch(() => {});
      await jobRunner.close().catch(() => {});
      await jobStore._resetForTests();
      delete process.env.MAX_RESULT_BYTES;
    });

    await jobStore.init();
    await jobRunner.init();
    assert.equal(jobRunner.getMode(), "bullmq", "testas prasmingas tik BullMQ režime");

    // Riba, kurią tikrai viršys žemiau grąžinamas rezultatas.
    process.env.MAX_RESULT_BYTES = "500";

    const job = await jobStore.create({ ownerKind: "unowned" });
    await jobRunner.enqueueProtocol(job.id, { transcript: "pakankamai ilgas testinis tekstas" });

    queueConnection = createQueueConnection();
    queue = new Queue(QUEUE_NAMES.PROTOCOL, { connection: queueConnection });

    /**
     * Processor'ius grąžina TEISINGĄ rezultatą – tik per didelį. Klaidos jis
     * nemeta: ribą turi pastebėti pats worker'is PRIEŠ rašydamas į store.
     */
    const { createWorker } = require("../workers");
    worker = createWorker(
      QUEUE_NAMES.PROTOCOL,
      async () => ({
        protocol: { pavadinimas: "Per didelis", turinys: "x".repeat(5000) },
        meta: {},
      }),
      { stalledInterval: 1000, lockDuration: 2000 }
    );

    let galutinis;
    for (let i = 0; i < 40; i++) {
      galutinis = await jobStore.system.get(job.id);
      if (galutinis?.status === "completed" || galutinis?.status === "failed") break;
      await new Promise((r) => setTimeout(r, 250));
    }

    assert.equal(galutinis.status, "failed", "per didelis rezultatas NEGALI būti completed");
    assert.equal(galutinis.error_code, "RESULT_TOO_LARGE", "domeninis kodas, ne internal_error");

    /**
     * ESMINĖ patikra: rezultato artefaktas NEĮRAŠYTAS.
     *
     * Statinis sargas to neįrodo – patikra galėtų būti PO `update`, ir tada
     * job'as būtų `failed`, bet per didelis rezultatas jau gulėtų store'e
     * (o po #155 – duomenų bazėje).
     */
    assert.equal(galutinis.result, null, "rezultatas neturi patekti į store");

    // Ir job metaduomenys lieka, kad priežastis būtų matoma.
    assert.ok(galutinis.error, "klaidos pranešimas išsaugotas");
  }
);

test(
  "#153 WORKER: normalaus dydžio rezultatas užbaigiamas įprastai (regresija)",
  { skip: skipWithoutRedis() },
  async (t) => {
    const jobStore = require("../utils/jobStore");
    const jobRunner = require("../queues/jobRunner");
    const { QUEUE_NAMES, createQueueConnection } = require("../queues/config");
    const { Queue } = require("bullmq");

    let worker;
    let queue;
    let queueConnection;

    t.after(async () => {
      const { shutdownWorker } = require("../workers");
      await shutdownWorker(worker, { force: true }).catch(() => {});
      await queue?.close().catch(() => {});
      await queueConnection?.quit().catch(() => {});
      await jobRunner.close().catch(() => {});
      await jobStore._resetForTests();
    });

    await jobStore.init();
    await jobRunner.init();

    const job = await jobStore.create({ ownerKind: "unowned" });
    await jobRunner.enqueueProtocol(job.id, { transcript: "pakankamai ilgas testinis tekstas" });

    queueConnection = createQueueConnection();
    queue = new Queue(QUEUE_NAMES.PROTOCOL, { connection: queueConnection });

    const { createWorker } = require("../workers");
    worker = createWorker(
      QUEUE_NAMES.PROTOCOL,
      async () => ({ protocol: { pavadinimas: "Normalus" }, meta: {} }),
      { stalledInterval: 1000, lockDuration: 2000 }
    );

    let galutinis;
    for (let i = 0; i < 40; i++) {
      galutinis = await jobStore.system.get(job.id);
      if (galutinis?.status === "completed" || galutinis?.status === "failed") break;
      await new Promise((r) => setTimeout(r, 250));
    }

    assert.equal(galutinis.status, "completed", "numatytos ribos neturi pertraukti normalaus darbo");
    assert.ok(galutinis.result, "rezultatas išsaugotas");
  }
);
