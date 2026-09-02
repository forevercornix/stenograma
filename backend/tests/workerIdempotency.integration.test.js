const { test } = require("node:test");
const assert = require("node:assert/strict");
const { skipWithoutRedis } = require("./helpers/redisGuard");

/**
 * WORKER'IO ĮĖJIMO KELIO IDEMPOTENTIŠKUMAS (#184, 7.5b).
 *
 * ⚠️ TAI NE HIPOTETINIS SCENARIJUS — TAI BUVO `main` ELGESYS.
 *
 * `finish(COMPLETED)` commit'inasi, procesas žūva PRIEŠ BullMQ patvirtinimą,
 * retry kviečia `jobStore.system.restart()` ant `completed` įrašo, o
 * `jobPhase.restart()` leidžia tik `QUEUED`/`PROCESSING` → `JobPhaseError` →
 * BullMQ failed → kartojama → dead-letter. Rezultatas visą tą laiką guli
 * saugykloje.
 *
 * ⚠️ KODĖL TIKRAS BullMQ, O NE VIENETINIS TESTAS.
 *
 * Idempotentiškumo patikra gyvena `createWorker()` processor'iaus VIDUJE, prieš
 * `restart()`. Ta funkcija nėra eksportuojama ir be tikros eilės nepasiekiama;
 * vienetinis testas galėtų patikrinti tik atkartotą sąlygos KOPIJĄ, o kopija
 * ilgainiui nuo originalo išsiskiria.
 *
 * ⚠️ IZOLIUOTA EILĖ — BŪTINA (ta pati pamoka kaip `resultLimitsWorker`).
 * CI'e visi Redis testai dalijasi vienu Redis; bendra eilė reikštų, kad šio
 * testo worker'is pasiima svetimą job'ą.
 *
 * Praleidžiamas be `REDIS_URL`; CI nustato `REQUIRE_REDIS=1`.
 */

test(
  "#184 WORKER RETRY: jau `completed` job'as NEPERDIRBAMAS ir NEKRENTA `JobPhaseError`",
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

    const queueName = `test-idempotency-${process.pid}-${Date.now()}`;
    const job = await jobStore.create({ ownerKind: "unowned" });

    /**
     * ⚠️ BŪSENA PARUOŠIAMA PRIEŠ PALEIDŽIANT WORKER'Į.
     *
     * Būtent taip atrodo įrašas po dingusio ack'o: `completed` su galiojančiu
     * rezultatu, o eilėje tebekabo žinutė. Proceso žudyti nereikia — svarbi yra
     * BŪSENA, į kurią retry ateina, o ne būdas, kuriuo ji atsirado.
     */
    await jobStore.system.startPhase(job.id, "validating");
    const isipareigotas = { protocol: { pavadinimas: "Jau baigta" }, meta: {} };
    const uzbaigtas = await jobStore.system.finish(job.id, jobStore.STATUS.COMPLETED, {
      result: isipareigotas,
    });
    assert.equal(uzbaigtas.status, "completed", "prielaida: rezultatas ĮSIPAREIGOTAS");

    queueConnection = createQueueConnection();
    queue = new Queue(queueName, { connection: queueConnection });
    await queue.add("protocol", { jobId: job.id, payload: { transcript: "x" } }, { jobId: job.id });

    /**
     * ⚠️ PROCESSOR'IUS SKAIČIUOJA KVIETIMUS. Jei idempotentiškumo patikros
     * nebūtų, worker'is arba kristų ties `restart()`, arba perdirbtų darbą iš
     * naujo — abu matomi šiame skaitiklyje.
     */
    let processorKvietimu = 0;
    const { createWorker } = require("../workers");
    worker = createWorker(
      queueName,
      async () => {
        processorKvietimu += 1;
        return { protocol: { pavadinimas: "PERDIRBTA" }, meta: {} };
      },
      { stalledInterval: 1000, lockDuration: 2000 }
    );

    /** Laukiama, kol BullMQ žinutė bus apdorota (ne fiksuoto laiko `sleep`). */
    let bullmqBusena = null;
    for (let i = 0; i < 40; i++) {
      const b = await queue.getJob(job.id);
      const state = b ? await b.getState() : null;
      if (state === "completed" || state === "failed") {
        bullmqBusena = state;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    assert.equal(bullmqBusena, "completed", "⚠️ retry privalo baigtis SĖKME, ne dead-letter");
    assert.equal(processorKvietimu, 0, "⚠️ transkripcija/perdirbimas NEKARTOJAMAS");

    const galutinis = await jobStore.system.get(job.id);
    assert.equal(galutinis.status, "completed");
    assert.deepEqual(
      galutinis.result,
      isipareigotas,
      "⚠️ įsipareigotas rezultatas NEPERRAŠYTAS naujo vykdymo išvestimi"
    );
  }
);

test(
  "#184 WORKER: `completed` BE rezultato NEVIRSTA nauju vykdymu, ir audio LIEKA",
  { skip: skipWithoutRedis() },
  async (t) => {
    /**
     * ⚠️ AUDIO VALYMO BARJERAS — VIENINTELĖ VIETA, KUR JĮ GALIMA ĮRODYTI.
     *
     * Vien `jobs.status = 'completed'` nepakanka. Be rezultato tai remontuotina
     * būsena, ir šaltinio audio yra vienintelė medžiaga remontui: ištrynus jį,
     * darbo nebeįmanoma nei atkurti, nei pakartoti.
     */
    const jobStore = require("../utils/jobStore");
    const jobRunner = require("../queues/jobRunner");
    const fileStorage = require("../utils/fileStorage");
    const { createQueueConnection } = require("../queues/config");
    const { Queue } = require("bullmq");

    let worker;
    let queue;
    let queueConnection;
    let storageKey;

    t.after(async () => {
      const { shutdownWorker } = require("../workers");
      await shutdownWorker(worker, { force: true }).catch(() => {});
      await queue?.close().catch(() => {});
      await queueConnection?.quit().catch(() => {});
      await jobRunner.close().catch(() => {});
      if (storageKey) await fileStorage.del(storageKey).catch(() => {});
      await jobStore._resetForTests();
    });

    await jobStore.init();
    await jobRunner.init();

    const queueName = `test-barrier-${process.pid}-${Date.now()}`;
    const job = await jobStore.create({ ownerKind: "unowned" });

    storageKey = await fileStorage.put(Buffer.from("audio-baitai"), { ext: ".wav" });

    await jobStore.system.startPhase(job.id, "validating");
    await jobStore.system.finish(job.id, jobStore.STATUS.COMPLETED, { result: { a: 1 } });

    /** Rezultatas dingsta — nutrūkusi transakcija arba nepilnas atkūrimas. */
    await jobStore.update(
      { jobId: job.id, ownerKind: "unowned", ownerId: null },
      { result: null }
    );

    queueConnection = createQueueConnection();
    queue = new Queue(queueName, { connection: queueConnection });
    await queue.add(
      "transcription",
      { jobId: job.id, payload: { storageKey } },
      { jobId: job.id, attempts: 1 }
    );

    let processorKvietimu = 0;
    const { createWorker } = require("../workers");
    worker = createWorker(
      queueName,
      async () => {
        processorKvietimu += 1;
        return { text: "PERDIRBTA" };
      },
      { stalledInterval: 1000, lockDuration: 2000 }
    );

    let bullmqBusena = null;
    for (let i = 0; i < 40; i++) {
      const b = await queue.getJob(job.id);
      const state = b ? await b.getState() : null;
      if (state === "completed" || state === "failed") {
        bullmqBusena = state;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    assert.equal(bullmqBusena, "failed", "⚠️ remontuotina būsena NĖRA sėkmė");
    assert.equal(processorKvietimu, 0, "naujas vykdymas nepradėtas");

    /** ⚠️ ESMINĖ PATIKRA: šaltinio audio TEBĖRA. */
    const audio = await fileStorage.get(storageKey);
    assert.ok(audio && audio.length > 0, "⚠️ šaltinio audio privalo IŠLIKTI");
  }
);
