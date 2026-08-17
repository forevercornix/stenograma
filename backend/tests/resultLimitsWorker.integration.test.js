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
 *
 * ⚠️ IZOLIUOTA EILĖ – BŪTINA.
 *
 * Pirmoji versija naudojo bendrą `QUEUE_NAMES.PROTOCOL` ir nustatė
 * `MAX_RESULT_BYTES=500` per `process.env`. CI'e visi Redis testai dalijasi tuo
 * pačiu Redis, tad šio testo worker'is pasiėmė KITO testo (`stalled recovery`)
 * job'ą ir numarino jį su `RESULT_TOO_LARGE`. Lokaliai to nesimatė, nes testai
 * buvo paleisti po vieną.
 *
 * Todėl: (1) unikalus eilės pavadinimas kiekvienam paleidimui, (2) riba
 * NEkeičiama per env – processor'ius grąžina rezultatą, viršijantį NUMATYTĄ
 * 20 MB lubą. Taip testas nepaliečia nei kitų eilių, nei globalios
 * konfigūracijos.
 */

test(
  "#153 WORKER: per didelis rezultatas → job failed, RESULT_TOO_LARGE, result NEĮRAŠYTAS",
  { skip: skipWithoutRedis() },
  async (t) => {
    const jobStore = require("../utils/jobStore");
    const jobRunner = require("../queues/jobRunner");
    const { createQueueConnection } = require("../queues/config");
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
    assert.equal(jobRunner.getMode(), "bullmq", "testas prasmingas tik BullMQ režime");

    /** Unikali eilė – kad worker'is nepasiimtų kitų testų job'ų. */
    const queueName = `test-limits-${process.pid}-${Date.now()}`;

    const job = await jobStore.create({ ownerKind: "unowned" });

    queueConnection = createQueueConnection();
    queue = new Queue(queueName, { connection: queueConnection });
    await queue.add(
      "protocol",
      { jobId: job.id, payload: { transcript: "pakankamai ilgas testinis tekstas" } },
      { jobId: job.id }
    );

    /**
     * Processor'ius grąžina TEISINGĄ rezultatą – tik per didelį. Klaidos jis
     * nemeta: ribą turi pastebėti pats worker'is PRIEŠ rašydamas į store.
     */
    const { createWorker } = require("../workers");
    worker = createWorker(
      queueName,
      async () => ({
        /**
         * Viršija NUMATYTĄ 20 MB lubą – env nekeičiamas, tad kitiems testams
         * riba lieka normali.
         */
        protocol: { pavadinimas: "Per didelis", turinys: "x".repeat(25 * 1024 * 1024) },
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
    const { createQueueConnection } = require("../queues/config");
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

    /** Unikali eilė – ta pati priežastis kaip pirmame teste. */
    const queueName = `test-limits-ok-${process.pid}-${Date.now()}`;
    const job = await jobStore.create({ ownerKind: "unowned" });

    queueConnection = createQueueConnection();
    queue = new Queue(queueName, { connection: queueConnection });
    await queue.add(
      "protocol",
      { jobId: job.id, payload: { transcript: "pakankamai ilgas testinis tekstas" } },
      { jobId: job.id }
    );

    const { createWorker } = require("../workers");
    worker = createWorker(
      queueName,
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
