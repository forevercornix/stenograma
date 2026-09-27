const { test } = require("node:test");
const assert = require("node:assert/strict");

const { skipWithoutRedis } = require("./helpers/redisGuard");
const { PavelavusioIsipareigojimoKlaida } = require("../utils/attemptRegistry");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * TVOROS ATMETIMAS SUSTABDO BullMQ GRANDINĘ (#415, D3).
 *
 * ⚠️ KODĖL ŠIS TESTAS GYVENA `redis`, O NE `postgres` RINKINYJE.
 *
 * Reikalavimas yra „procesorius antrą kartą NEPALEIDŽIAMAS", o tai gali įrodyti tik
 * tikras BullMQ: suskaičiuoti procesoriaus iškvietimus. Vienetinis testas pagal
 * `workerRetry.test.js` formą tikrintų šaltinio tekstą (§9.2 — ne elgsenos įrodymas).
 *
 * ⚠️ TVORA ČIA NESUKELIAMA TIKRA — IR TAI SĄMONINGA. Rinkinio su PostgreSQL IR Redis
 * repo neturi (`privacy, security, functional, redis, postgres, s3, postgresS3`), o
 * naujas `ci.yml` job'as būtų didesnis pakeitimas nei pats taisymas. Todėl `finish()`
 * pakeičiamas dubliu, metančiu TIKRĄ `PavelavusioIsipareigojimoKlaida` — tikrinamas
 * BŪTENT tiltas (`neatkartojama` → `UnrecoverableError`) ir BullMQ elgsena. Pati tvora
 * ir pakartojimas įrodyti `postgres` rinkinyje (`tvorosPakartojimas.integration`).
 *
 * ⚠️ KUO TAI SKIRIASI NUO `artifactUnrecoverable.integration` (#157, PR-4).
 *
 * Anas jau įrodė BENDRĄ tiltą: `finish()` klaida su `neatkartojama: true` sustabdo
 * BullMQ grandinę (`attemptsMade` lieka 1). To čia NEKARTOJAME. Naujas yra ŠIOS
 * KLAIDOS KLASĖS kelias nuo galo iki galo:
 *
 *   1. procesoriaus iškvietimų SKAIČIUS (anas matuoja `attemptsMade`, ne kvietimus);
 *   2. `error_code === "ATTEMPT_COMMIT_TOO_LATE"` — t. y. kad
 *      `PavelavusioIsipareigojimoKlaida` yra `NEATKARTOJAMOS` sąraše ir
 *      `_classifyError` išpakuoja `cause`. Be įrašo sąraše operatorius matytų
 *      `internal_error`, ir šaka produkcijoje neveiktų (D5).
 *
 * ⚠️ UNIKALUS EILĖS VARDAS — BŪTINA. Išmatuota `resultLimitsWorker.integration:23–35`:
 * bendras eilės vardas CI'e privertė vieno testo worker'į pasiimti KITO testo job'ą.
 */

test(
  "#415 D3: po tvoros atmetimo procesorius NEBEPALEIDŽIAMAS antrą kartą",
  { skip: skipWithoutRedis() },
  async (t) => {
    const jobStore = require("../utils/jobStore");
    const jobRunner = require("../queues/jobRunner");
    const { createQueueConnection } = require("../queues/config");
    const { Queue } = require("bullmq");

    let worker;
    let queue;
    let queueConnection;
    const tikrasisFinish = jobStore.system.finish;

    t.after(async () => {
      jobStore.system.finish = tikrasisFinish;
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

    /**
     * ⚠️ DUBLIS META TIKRĄ KLAIDOS KLASĘ, ne panašų objektą: tikrinama, kad BŪTENT
     * ji neša `neatkartojama` ir kad tiltas ją atpažįsta. Panašus dublis įrodytų
     * testo konstrukciją, ne produkcinę savybę.
     */
    jobStore.system.finish = async () => {
      throw new PavelavusioIsipareigojimoKlaida("bandymas-zondas", 3_600_000);
    };

    const queueName = `test-tvora-${process.pid}-${Date.now()}`;
    const job = await jobStore.create({ ownerKind: "unowned" });

    queueConnection = createQueueConnection();
    queue = new Queue(queueName, { connection: queueConnection });
    /**
     * ⚠️ `attempts: 2` — BE JO TESTAS PRAEITŲ TUŠČIAI (Codex P2). Numatytoji BullMQ
     * reikšmė leidžia VIENĄ bandymą, tad procesoriaus kvietimų liktų 1 ir be
     * `UnrecoverableError`, o `attemptsMade === 1` patvirtintų numatytąją reikšmę, ne
     * grandinės sustabdymą. Forma pagal `artifactUnrecoverable.integration:64`.
     */
    await queue.add(
      "protocol",
      { jobId: job.id, payload: { transcript: "tekstas" } },
      { jobId: job.id, attempts: 2, backoff: { type: "fixed", delay: 50 } }
    );

    let procesoriausKvietimu = 0;

    const { createWorker } = require("../workers");
    worker = createWorker(
      queueName,
      async () => {
        procesoriausKvietimu += 1;
        return { protocol: { pavadinimas: "P", turinys: "turinys" }, meta: {} };
      },
      { stalledInterval: 1000, lockDuration: 2000 }
    );

    let galutinis;
    for (let i = 0; i < 40; i++) {
      galutinis = await jobStore.system.get(job.id, { hydrate: true });
      if (galutinis?.status === "failed" || galutinis?.status === "completed") break;
      await new Promise((r) => setTimeout(r, 250));
    }

    assert.equal(galutinis?.status, "failed", "job'as privalo baigtis NUOLATINE nesėkme");

    /**
     * ⚠️ ŠIS SKAIČIUS IR YRA VISAS TESTO TURINYS. Be `neatkartojama` BullMQ kartotų
     * procesorių `QUEUE_MAX_ATTEMPTS` kartų — transkripcijos job'ui tai valandos.
     */
    assert.equal(procesoriausKvietimu, 1, "procesorius privalo būti paleistas TIKSLIAI vieną kartą");

    /** D5: operatorius mato „rašytojas per lėtas", ne `internal_error`. */
    assert.equal(
      galutinis.error_code,
      "ATTEMPT_COMMIT_TOO_LATE",
      "klasifikatoriaus šaka privalo išpakuoti `cause` iš `UnrecoverableError`"
    );

    /** ⚠️ Papildomai: BullMQ bandymai NEBUVO išnaudoti - grandinę sustabdė ne limitas. */
    const bullJob = await queue.getJob(job.id);
    assert.equal(bullJob.attemptsMade, 1, "grandinę sustabdė `UnrecoverableError`, ne bandymų limitas");
  }
);
