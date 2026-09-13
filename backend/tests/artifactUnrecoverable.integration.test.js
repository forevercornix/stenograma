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

    /**
     * ⚠️ KLAIDA ĮTERPIAMA TIES `finish()`, O NE PER `Date` REZULTATE — IR PRIEŽASTIS
     * VERTA UŽRAŠYMO (išmatuota CI 34083676612).
     *
     * Pirmoji redakcija grąžino `Date` rezultate ir laukė struktūrinio atmetimo. Testas
     * krito su `completed`: `ArtifactStore` riba yra EXTERNAL kelyje, o worker'is
     * testuose eina per ATMINTIES saugyklą (šie testai `JOB_STORE_BACKEND`
     * nenurodo; iki #155 to neleido ir aktyvavimo barjeras). Inline kelias
     * `paruostiReiksme()` nekviečia, tad `Date`
     * ten priimamas — riba jo tiesiog nemato.
     *
     * ⚠️ §12.1 KOREKCIJA (#298): ANKSTESNĖ REDAKCIJA ŽADĖJO, KAD GRANDINĖ SU `Date`
     * TAPS PASIEKIAMA PR-7. NETAPS — IR NEBETURI.
     *
     * #298 parodė, kad `Date` atmetimas buvo ne riba, o NETEISINGAS MODELIS:
     * `kanonizuoti()` `toJSON` nekviesdavo, nors visos saugyklos serializuoja per
     * `JSON.stringify`, kuris kviečia. Ištaisius, `Date` tapatybė yra viena visuose
     * backend'uose, tad jis nebeatmetamas NIEKUR. Grandinė su `Date` neįmanoma iš
     * principo, ne dėl neprijungtos saugyklos.
     *
     * Struktūrinių atmetimų liko (NUL, neporinis surogatas, ciklinė nuoroda, `BigInt`,
     * nedeterministinis `toJSON`), bet jie gyvena EXTERNAL kelyje, o šio testo
     * worker'is per jį neina. Todėl čia tikrinama TA DALIS, kuri egzistuoja: ar
     * `neatkartojama` klaida iš `finish()` sustabdo BullMQ retry grandinę. Eilė,
     * worker'is ir pakartojimų semantika — TIKRI; sintetinė lieka tik klaidos kilmė.
     *
     * ⚠️ §12.1: ANKSTESNĖ REDAKCIJA SAKĖ „likutis eina su barjeru". BARJERAS
     * ATIDARYTAS (#155), IR LIKUTIS NEIŠNYKO. Jam reikia ne barjero, o šio testo
     * perrašymo prieš tikrą PostgreSQL + saugyklą worker'io kelyje — atskiras
     * darbas, ne atidarymo pasekmė. Žyma, kuri laukė įvykio, dabar laukia darbo.
     */
    const tikrasFinish = jobStore.system.finish;
    t.after(() => {
      jobStore.system.finish = tikrasFinish;
    });

    jobStore.system.finish = async (id, status, extra) => {
      if (id !== job.id) return tikrasFinish(id, status, extra);

      const { ArtifactStoreError } = require("../utils/artifactStore/validation");
      throw new ArtifactStoreError(
        "ArtifactStore: NUL simbolis nepalaikomas (struktūrinis atmetimas).",
        "ARTIFACT_VALUE_UNSUPPORTED",
        { neatkartojama: true }
      );
    };

    const { createWorker } = require("../workers");
    worker = createWorker(
      queueName,
      async () => {
        vykdymai += 1;
        return { protocol: { pavadinimas: "Struktūrinis" }, meta: {} };
      },
      { stalledInterval: 1000, lockDuration: 2000 }
    );

    let galutinis;
    for (let i = 0; i < 60; i++) {
      galutinis = await jobStore.system.get(job.id, { hydrate: true });
      if (galutinis?.status === "failed") break;
      await new Promise((r) => setTimeout(r, 250));
    }

    assert.equal(galutinis.status, "failed", "struktūrinis atmetimas negali baigtis `completed`");
    assert.equal(
      galutinis.error_code,
      "ARTIFACT_VALUE_UNSUPPORTED",
      "domeninis kodas, ne `internal_error` — operatoriui reikia matyti, KAS nutiko; " +
        "jis ateina per `cause`, tad vyniojimas privalo jį išsaugoti"
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
