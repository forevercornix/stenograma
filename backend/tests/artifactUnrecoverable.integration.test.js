const { test } = require("node:test");
const assert = require("node:assert/strict");
const { skipWithoutRedis } = require("./helpers/redisGuard");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * STRUKTŪRINIS ATMETIMAS SUSTABDO RETRY GRANDINĘ (#157, PR-4 DoD).
 *
 * ⚠️ TAI NE NAUJAS RADINYS, O ANKSČIAU PALIKTO ŽENKLO UŽDARYMAS.
 *
 * PR-2 nustatė, kad struktūrinis atmetimas (`Date` rezultate, NUL, neporinis
 * surogatas) privalo būti `neatkartojama`, ir tai buvo užrašyta kaip `UNVERIFIED`:
 * ženklas GAMINAMAS, bet niekas jo neskaito. PR-4 DoD reikalauja elgesio — nulis
 * BullMQ pakartojimų — ir būtent jį tikrina šis testas.
 *
 * ⚠️ MATUOJAMAS ELGESYS, NE LAUKO BUVIMAS. „`neatkartojama === true`" praeitų ir tada,
 * kai niekas jo nepaiso; klausimas yra, ar job'as baigiasi po VIENO vykdymo.
 *
 * ⚠️ IZOLIUOTA EILĖ — BŪTINA (#153 pamoka): CI'e visi Redis testai dalijasi tuo pačiu
 * serveriu, tad bendra eilė reikštų, kad šis worker'is pasiima svetimą job'ą.
 */

test(
  "#157 WORKER: struktūrinis atmetimas → failed po VIENO vykdymo, be pakartojimų",
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

    const queueName = `test-neatkartojama-${process.pid}-${Date.now()}`;
    const job = await jobStore.create({ ownerKind: "unowned" });

    queueConnection = createQueueConnection();
    queue = new Queue(queueName, { connection: queueConnection });

    /**
     * ⚠️ TRYS BANDYMAI SU TRUMPU BACKOFF: be vyniojimo BullMQ pakartotų, ir
     * `attemptsMade` pasiektų 3. Su vyniojimu privalo likti 1.
     */
    await queue.add(
      "protocol",
      { jobId: job.id, payload: { transcript: "pakankamai ilgas testinis tekstas" } },
      { jobId: job.id, attempts: 3, backoff: { type: "fixed", delay: 50 } }
    );

    let vykdymai = 0;

    const { createWorker } = require("../workers");
    worker = createWorker(
      queueName,
      async () => {
        vykdymai += 1;
        /**
         * ⚠️ REZULTATAS SU `Date` — struktūrinis atmetimas ties `ArtifactStore` riba.
         *
         * `kanonizuoti()` perrenka tik NUOSAVUS raktus, o `JSON.stringify` kviečia
         * PROTOTIPE esantį `toJSON`, tad `Date` skirtinguose backend'uose duotų
         * skirtingą kanoninę eilutę (#157 D1). Pakartojimas to nepakeis.
         */
        return { protocol: { pavadinimas: "Data", sukurta: new Date(0) }, meta: {} };
      },
      { stalledInterval: 1000, lockDuration: 2000 }
    );

    let galutinis;
    for (let i = 0; i < 60; i++) {
      galutinis = await jobStore.system.get(job.id, { hydrate: true });
      if (galutinis?.status === "completed" || galutinis?.status === "failed") break;
      await new Promise((r) => setTimeout(r, 250));
    }

    assert.equal(galutinis.status, "failed", "struktūrinis atmetimas negali baigtis `completed`");
    assert.equal(
      galutinis.error_code,
      "ARTIFACT_VALUE_UNSUPPORTED",
      "domeninis kodas, ne `internal_error` — operatoriui reikia matyti, KAS nutiko"
    );

    /** ⚠️ ESMINĖ PATIKRA: vykdymų LYGIAI vienas, ne trys. */
    assert.equal(vykdymai, 1, `laukta vieno vykdymo, buvo ${vykdymai} — retry grandinė nesustojo`);

    const bullJob = await queue.getJob(job.id);
    if (bullJob) {
      assert.equal(
        bullJob.attemptsMade,
        1,
        `BullMQ attemptsMade privalo likti 1, buvo ${bullJob.attemptsMade}`
      );
    }
  }
);

test(
  "KONTROLĖ: paprasta (atkartojama) klaida VIS DAR kartojama",
  { skip: skipWithoutRedis() },
  async (t) => {
    /**
     * Be jos ankstesnis testas būtų tenkinamas ir worker'io, kuris NIEKADA nekartoja —
     * tada „retry sustabdytas" reikštų neveikiantį mechanizmą, ne sargą.
     */
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

    const queueName = `test-atkartojama-${process.pid}-${Date.now()}`;
    const job = await jobStore.create({ ownerKind: "unowned" });

    queueConnection = createQueueConnection();
    queue = new Queue(queueName, { connection: queueConnection });
    await queue.add(
      "protocol",
      { jobId: job.id, payload: { transcript: "pakankamai ilgas testinis tekstas" } },
      { jobId: job.id, attempts: 2, backoff: { type: "fixed", delay: 50 } }
    );

    let vykdymai = 0;
    const { createWorker } = require("../workers");
    worker = createWorker(
      queueName,
      async () => {
        vykdymai += 1;
        throw new Error("laikinas tiekėjo gedimas");
      },
      { stalledInterval: 1000, lockDuration: 2000 }
    );

    for (let i = 0; i < 60; i++) {
      const busena = await jobStore.system.get(job.id, { hydrate: false });
      if (busena?.status === "failed" && vykdymai >= 2) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    assert.equal(vykdymai, 2, `atkartojama klaida privalo būti pakartota, buvo ${vykdymai}`);
  }
);
