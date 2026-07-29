const test = require("node:test");
const assert = require("node:assert/strict");

async function traceStep(label, action) {
  console.log(`[queueRecovery] START ${label}`);
  await action();
  console.log(`[queueRecovery] END ${label}`);
}

/**
 * RESTART RECOVERY integracinis testas su TIKRU Redis + BullMQ.
 *
 * ⚠️ PRALEIDŽIAMAS be REDIS_URL (kaip pyannote test_real_gpu.py be tokeno). Sandbox'e
 * Redis daemon nėra, tad šis testas ten nesivykdo - paleiskite jį su tikru Redis:
 *
 *   REDIS_URL=redis://localhost:6379 npm run test:redis
 *
 * SVARBU: šis failas paleidžiamas ATSKIRAI nuo pagrindinio `npm test` (žr.
 * .github/workflows/ci.yml ir package.json "test:redis") - REDIS_URL NEGALI būti
 * nustatytas visam `npm test`, nes route testai (jobs.route.test.js ir kt.) tikisi
 * INLINE vykdymo be worker'io; su realiu pasiekiamu Redis jie pereitų į BullMQ
 * režimą ir amžinai liktų "queued".
 *
 * Ką tikrina (1 etapo priėmimo kriterijus "restart neturi nutraukti darbo"):
 *   - jobas įdėtas į BullMQ eilę su REDIS_URL IŠLIEKA Redis'e net be worker'io;
 *   - kai worker'is paleidžiamas, jis pasiima laukiantį jobą ir jį užbaigia;
 *   - būsena teisingai atsispindi jobStore (queued -> completed).
 *
 * Tai imituoja "backend įdėjo jobą, tada nukrito/persileido, worker'is jį pabaigė".
 */

const HAS_REDIS = !!process.env.REDIS_URL;

test("restart recovery: jobas eilėje išlieka ir užbaigiamas worker'io po 'restarto'", { skip: !HAS_REDIS ? "reikia REDIS_URL su tikru Redis" : false }, async (t) => {
  const jobStore = require("../utils/jobStore");
  const jobRunner = require("../queues/jobRunner");
  const { QUEUE_NAMES, createQueueConnection } = require("../queues/config");
  const { Queue } = require("bullmq");

  let worker;
  let queue;
  // t.after() vykdomas VISADA (net jei assertion krenta) - kitaip nepavykus testui
  // liktų atviras BullMQ worker'is/Redis ryšys/kabantis Node procesas.
  t.after(async () => {
    // close(TRUE) - ta pati priežastis kaip antrame teste žemiau: graceful
    // close() laukia aktyvaus darbo/blokuojančių Redis komandų pabaigos.
    await traceStep("test1 worker.close(true)", () =>
      worker?.close(true).catch(() => {})
    );
    await traceStep("test1 queue.close()", () =>
      queue?.close().catch(() => {})
    );
    await traceStep("test1 jobRunner.close()", () =>
      jobRunner.close().catch(() => {})
    );
    await traceStep("test1 jobStore._resetForTests()", () =>
      jobStore._resetForTests()
    );
  });

  await jobStore.init();
  await jobRunner.init();
  assert.equal(jobRunner.getMode(), "bullmq");

  // Registruojam paprastą test processor'ių (protokolo generavimas mock).
  jobRunner.registerProcessor("protocol", async () => ({ protocol: { pavadinimas: "Test" }, meta: {} }));

  // 1. Sukuriam jobą ir įdedam į eilę - BET worker'io DAR NEPALEIDŽIAM.
  //    (imituoja: backend įdėjo, tada nukrito prieš apdorojimą)
  const job = await jobStore.create();
  await jobRunner.enqueueProtocol(job.id, { transcript: "pakankamai ilgas testinis tekstas" });

  // 2. Patikrinam, kad jobas TIKRAI laukia eilėje (Redis'e), ne dingęs.
  queue = new Queue(QUEUE_NAMES.PROTOCOL, { connection: createQueueConnection() });
  const waiting = await queue.getWaitingCount();
  assert.ok(waiting >= 1, "jobas turi laukti eilėje net be worker'io");

  // 3. "Restartas": dabar paleidžiam worker'į - jis turi pasiimti laukiantį jobą.
  const { createWorker } = require("../workers");
  worker = createWorker(
    QUEUE_NAMES.PROTOCOL,
    async () => ({ protocol: { pavadinimas: "Test" }, meta: {} }),
    {
      stalledInterval: 1000,
      lockDuration: 2000,
    }
  );

  // 4. Laukiam, kol jobas užbaigiamas (worker pasiima ir įvykdo).
  let finalStatus;
  for (let i = 0; i < 40; i++) {
    const j = await jobStore.get(job.id);
    finalStatus = j?.status;
    if (finalStatus === "completed" || finalStatus === "failed") break;
    await new Promise((r) => setTimeout(r, 250));
  }

  assert.equal(finalStatus, "completed", "worker turi užbaigti jobą, likusį eilėje po restarto");

  // Tiksli BullMQ jobo būsena (ne tik bendri eilės skaitikliai - jobId sutampa su
  // mūsų jobStore ID, žr. queues/protocolQueue.js `opts.jobId`), tad galime
  // patikrinti KONKRETŲ jobą, ne bendrą eilės waiting/active skaičių (kuris CI
  // aplinkoje, dalinantis Redis su kitais testais/bandymais, nebūtų saugus).
  const bullJob = await queue.getJob(job.id);
  const state = await bullJob?.getState();
  assert.equal(state, "completed", "BullMQ jobo būsena turi būti completed");
});

test("stalled recovery: worker'iui nukritus vykdymo metu, jobas grąžinamas ir pabaigiamas kito worker'io", { skip: !HAS_REDIS ? "reikia REDIS_URL su tikru Redis" : false }, async (t) => {
  const jobStore = require("../utils/jobStore");
  const jobRunner = require("../queues/jobRunner");
  const { QUEUE_NAMES, createQueueConnection } = require("../queues/config");
  const { Queue, Worker } = require("bullmq");

  let dyingWorker;
  let recoveryWorker;
  let queue;
  t.after(async () => {
    // dyingWorker jau uždarytas (force) žemiau vykdymo metu, bet catch'inam bet
    // kokiu atveju - jei testas krito ANKSČIAU nei tas žingsnis, jis dar veiktų.
    await traceStep("test2 dyingWorker.close(true)", () =>
      dyingWorker?.close(true).catch(() => {})
    );
    // close(TRUE) - BŪTINA. Be `true` tai graceful uždarymas, kuris LAUKIA
    // aktyvaus darbo pabaigos (BullMQ: "force - use if you do not want to wait
    // for current jobs to be processed"). Po stalled scenarijaus worker'is lieka
    // būsenoje, kurioje graceful close() kabo neribotai - realiame CI stebėta
    // ~8 min. kabantis job'as būtent čia.
    await traceStep("test2 recoveryWorker.close(true)", () =>
      recoveryWorker?.close(true).catch(() => {})
    );
    await traceStep("test2 queue.close()", () =>
      queue?.close().catch(() => {})
    );
    await traceStep("test2 jobRunner.close()", () =>
      jobRunner.close().catch(() => {})
    );
    await traceStep("test2 jobStore._resetForTests()", () =>
      jobStore._resetForTests()
    );
 });

  console.log("[queueRecovery] test2 jobStore.init START");
  await jobStore.init();
  console.log("[queueRecovery] test2 jobStore.init END");

  console.log("[queueRecovery] test2 jobRunner.init START");
  await jobRunner.init();
  console.log("[queueRecovery] test2 jobRunner.init END");

  console.log("[queueRecovery] test2 jobStore.create START");
  const job = await jobStore.create();
  console.log("[queueRecovery] test2 jobStore.create END");

  console.log("[queueRecovery] test2 enqueueProtocol START");
  await jobRunner.enqueueProtocol(job.id, { transcript: "pakankamai ilgas tekstas stalled testui" });
  console.log("[queueRecovery] test2 enqueueProtocol END");

  // Queue instancija galutinei patikrai (konkretaus jobo būsena po užbaigimo).
  console.log("[queueRecovery] test2 Queue create START");
  queue = new Queue(QUEUE_NAMES.PROTOCOL, { connection: createQueueConnection() });
  console.log("[queueRecovery] test2 Queue create END");

  // 1. Pirmas worker'is PASIIMA jobą ir "užstringa" (imituojam kritimą vykdymo
  //    metu - processor'ius niekada neužbaigia, tada worker uždaromas be graceful).
  let firstWorkerGotJob = false;
  console.log("[queueRecovery] test2 dyingWorker create START");
  dyingWorker = new Worker(
    QUEUE_NAMES.PROTOCOL,
    async () => {
      firstWorkerGotJob = true;
      // "Kabo" amžinai - imituoja worker'į, nukritusį darbo VIDURYJE. Naudojam
      // niekada neišsipildantį Promise, o NE setTimeout: efektas tas pats
      // (processor'ius niekada nebaigia), bet be nereikalingo 100s laikmačio,
      // kuris papildomai laikytų event loop'ą gyvą.
      await new Promise(() => {});
    },
    {
      connection: createQueueConnection(),
      // Trumpas lock/stalled testui, kad nereikėtų laukti 30s.
      lockDuration: 2000,
      stalledInterval: 1000,
      skipLockRenewal: true,
    }
  );
  console.log("[queueRecovery] test2 dyingWorker create END");

  // Palaukiam, kol pirmas worker'is pasiima jobą.
  console.log("[queueRecovery] test2 wait firstWorkerGotJob START");
  for (let i = 0; i < 20 && !firstWorkerGotJob; i++) await new Promise((r) => setTimeout(r, 200));
  console.log(`[queueRecovery] test2 wait firstWorkerGotJob END value=${firstWorkerGotJob}`);
  assert.ok(firstWorkerGotJob, "pirmas worker'is turi pasiimti jobą");

  // 2. "Sustabdom" pirmą worker'į vykdymo metu (force close - imituoja kritimą).
  console.log("[queueRecovery] explicit dyingWorker.disconnect() START");
  await dyingWorker.disconnect();
  console.log("[queueRecovery] explicit dyingWorker.disconnect() END");

  // 3. Paleidžiam ANTRĄ worker'į (imituoja restartą). Jis turi pasiimti STALLED jobą
  //    (BullMQ po lockDuration+stalledInterval grąžina jį į eilę) ir užbaigti.
  const { createWorker } = require("../workers");
  recoveryWorker = createWorker(
    QUEUE_NAMES.PROTOCOL,
    async () => {
      console.log("[queueRecovery] recovery worker GOT JOB");
      return {
        protocol: { pavadinimas: "Recovered" },
        meta: {},
      };
    },
    {
      stalledInterval: 1000,
      lockDuration: 2000,
      maxStalledCount: 2,
    }
  );
  console.log("[queueRecovery] recovery worker CREATED");
  console.log("[queueRecovery] recovery worker OPTIONS", {
    lockDuration: recoveryWorker.opts.lockDuration,
    stalledInterval: recoveryWorker.opts.stalledInterval,
    maxStalledCount: recoveryWorker.opts.maxStalledCount,
    skipStalledCheck: recoveryWorker.opts.skipStalledCheck,
  });

  recoveryWorker.on("active", (activeJob) => {
    console.log(`[queueRecovery] recovery worker ACTIVE job=${activeJob?.id}`);
  });

  recoveryWorker.on("stalled", (stalledJobId) => {
    console.log(`[queueRecovery] recovery worker STALLED job=${stalledJobId}`);
  });

  recoveryWorker.on("completed", (completedJob) => {
    console.log(`[queueRecovery] recovery worker COMPLETED job=${completedJob?.id}`);
  });

  recoveryWorker.on("failed", (failedJob, err) => {
    console.error(
      `[queueRecovery] recovery worker FAILED job=${failedJob?.id}`,
      err
    );
  });

  recoveryWorker.on("error", (err) => {
    console.error("[queueRecovery] recovery worker ERROR", err);
  });

  let finalJob;
  for (let i = 0; i < 60; i++) {
    const j = await jobStore.get(job.id);
    const bullJob = await queue.getJob(job.id);
    const bullState = bullJob ? await bullJob.getState() : "missing";
    const redis = await queue.client;
    const lockKey = `${queue.toKey(job.id)}:lock`;
    const lockTtl = await redis.pttl(lockKey);
    const stalledCheckKey = queue.toKey("stalled-check");
    const stalledCheckTtl = await redis.pttl(stalledCheckKey);

    if (i % 4 === 0) {
      console.log(
        `[queueRecovery] poll ${i}: jobStore=${j?.status}, bullMQ=${bullState}, ` +
        `lockTtl=${lockTtl}ms, stalledCheckTtl=${stalledCheckTtl}ms`
      );
    }

    finalJob = j;
    if (j?.status === "completed" || j?.status === "failed") break;
    await new Promise((r) => setTimeout(r, 500));
  }

  // GRIEŽTAS reikalavimas: testo pavadinimas ir priėmimo kriterijus ("jobas
  // grąžinamas ir PABAIGIAMAS kito worker'io") reiškia SĖKMĘ, ne bet kokį galutinį
  // statusą. Anksčiau assertion priimdavo IR "failed" - tai reiškė, kad testas
  // liktų žalias net jei stalled recovery apskritai neveiktų ir jobas visada
  // baigtųsi failed. Dabar reikalaujame tiksliai "completed".
  assert.equal(
    finalJob?.status,
    "completed",
    `stalled jobas turi būti SĖKMINGAI užbaigtas recovery worker'io, bet buvo: ${finalJob?.status}`
  );

  // Rezultatas turi būti TIKRAI iš antro (recovery) worker'io, ne likutis nuo
  // pirmo bandymo - antras worker'is grąžina skirtingą pavadinimą ("Recovered"),
  // tad tai patvirtina, kad būtent JIS pabaigė darbą. Šis patikrinimas savaime
  // jau įrodo recovery faktą - PASTABA: sąmoningai NETIKRINAME attempt_count
  // konkrečios skaitinės reikšmės. BullMQ stalled recovery naudoja atskirą
  // stalled/maxStalledCount mechanizmą, ne tą patį counter'į kaip processor'iaus
  // klaidos attempts retry - job.attemptsMade po stalled requeue nebūtinai == 1
  // prieš antrą bandymą (priklauso nuo BullMQ vidinės realizacijos/versijos),
  // tad griežta attempt_count >= 2 asercija būtų netikslus, potencialiai trapus
  // (flaky) BullMQ vidinės detalės testavimas, ne recovery FAKTO patikrinimas.
  assert.equal(
    finalJob?.result?.protocol?.pavadinimas,
    "Recovered",
    "rezultatas turi būti sugeneruotas ANTRO (recovery) worker'io, ne pirmo"
  );

  // Tiksli BullMQ jobo būsena PAGAL JO ID (ne bendri eilės waiting/active
  // skaitikliai - tie nesaugūs, jei CI Redis dalinamasi su kitais lygiagrečiais
  // testais/ankstesnio nepavykusio bandymo likučiais). jobId sutampa su mūsų
  // jobStore ID (žr. queues/protocolQueue.js `opts.jobId`), tad queue.getJob()
  // randa būtent ŠĮ jobą.
  const bullJob = await queue.getJob(job.id);
  const state = await bullJob?.getState();
  assert.equal(state, "completed", "BullMQ jobo būsena turi būti completed (ne likęs waiting/active)");

  // PASTABA dėl audio/storage patikros: šis testas naudoja PROTOKOLO jobą (be
  // storageKey/audio failo), tad "audio neištrintas prieš retry" čia netikrinama -
  // tai tikrinama transkripcijos processor'iaus lygmenyje (žr. queues/processors.js
  // komentarą: audio trinamas TIK po galutinio statuso, `workers/index.js`
  // `_cleanupStorage` kviečiamas tik COMPLETED arba išnaudotų bandymų FAILED atveju).
  // Realiam patikrinimui su audio reikėtų atskiro testo su transcriptionProcessor
  // + fileStorage mock, ne šio (protocol) scenarijaus.
});
