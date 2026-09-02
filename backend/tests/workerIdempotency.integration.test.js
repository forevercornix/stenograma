const { test } = require("node:test");
const assert = require("node:assert/strict");
const { skipWithoutRedis } = require("./helpers/redisGuard");

/**
 * Žurnalo eilučių perėmimas. Logger'is rašo į `console`, tad perimamas kanalas.
 * ⚠️ Grąžinamos ŽALIOS eilutės: testinėje aplinkoje formatas yra žmogui
 * skaitomas (`ERROR [komponentas] žinutė {json}`), ne grynas JSON.
 */
function perimtiLogus() {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const kanalas of Object.keys(original)) {
    console[kanalas] = (...args) => {
      lines.push(args.join(" "));
      original[kanalas](...args);
    };
  }
  return { restore: () => Object.assign(console, original), lines: () => lines.slice() };
}

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

    /**
     * ⚠️ AUDIO ĮKELIAMAS SĄMONINGAI (Codex A grupė).
     *
     * Ši šaka atkuria kritimą PO `finish(COMPLETED)`, bet PRIEŠ
     * `_cleanupStorage()` — vadinasi audio beveik visada dar guli saugykloje.
     * Ankstesnė redakcija iš šakos grįždavo iškart, ir failas likdavo AMŽIAMS:
     * retencijos valytojas jo neliečia, kol raktą nurodo gyvas job'o įrašas.
     */
    storageKey = await fileStorage.put(Buffer.from("audio-baitai"), { ext: ".wav" });

    queueConnection = createQueueConnection();
    queue = new Queue(queueName, { connection: queueConnection });
    await queue.add("protocol", { jobId: job.id, payload: { transcript: "x", storageKey } }, { jobId: job.id });

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

    /**
     * ⚠️ IR AUDIO IŠVALYTAS. Idempotentiška sėkmė reiškia „darbas baigtas", tad
     * šaltinio failas nebereikalingas — bet kol grįžimas iš šakos vyko be
     * valymo, jis likdavo saugykloje be jokio vėlesnio kvietėjo.
     */
    await assert.rejects(
      () => fileStorage.get(storageKey),
      "šaltinio audio privalo būti pašalintas po idempotentiškos sėkmės"
    );
    storageKey = null;
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

test(
  "#184-A ⚠️ `finishFailed` NEĮSIPAREIGOJUS terminalaus perėjimo — audio LIEKA",
  { skip: skipWithoutRedis() },
  async (t) => {
    /**
     * ⚠️ ŠĮ TESTĄ PADIKTAVO CODEX PERŽIŪRA.
     *
     * Matricoje buvau užrašiusi, kad `_handleFailure` `typeof uzbaigta ===
     * "symbol"` šaką dengia gretimas integracinis testas. NEDENGĖ: tas testas
     * pradeda nuo `completed` be rezultato, tad `finishFailed()` grąžina
     * TERMINALŲ JOB OBJEKTĄ, o failą išsaugo ATSKIRAS barjeras. Pašalinus
     * simbolio patikrą, testas būtų likęs žalias, o tikras dviejų CAS konfliktų
     * scenarijus vis tiek ištrintų `processing` job'o audio.
     *
     * ⚠️ KONFLIKTAS ĮVEDAMAS DETERMINISTIŠKAI, ne lenktynėmis: `finishFailed()`
     * pakeičiamas dubliu, grąžinančiu `CONCURRENCY_CONFLICT`. Tikros dvigubos
     * versijos lenktynės su BullMQ būtų tikimybinės — o tikrinama ne lenktynė,
     * o SPRENDIMAS, kurį worker'is priima gavęs tokią baigtį.
     *
     * ⚠️ BARJERAS ČIA NEPADEDA IR NETURI. Job'as lieka `processing`, o barjeras
     * ne-terminalį sąmoningai praleidžia (kitaip audio failai kauptųsi). Būtent
     * todėl sprendimas priimamas iš operacijos baigties, ne iš būsenos.
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
    const originalus = jobStore.system.finishFailed;

    t.after(async () => {
      jobStore.system.finishFailed = originalus;
      const { shutdownWorker } = require("../workers");
      await shutdownWorker(worker, { force: true }).catch(() => {});
      await queue?.close().catch(() => {});
      await queueConnection?.quit().catch(() => {});
      await jobRunner.close().catch(() => {});
      if (storageKey) await fileStorage.del(storageKey).catch(() => {});
      await jobStore._resetForTests();
    });

    const zurnalas = perimtiLogus();
    t.after(() => zurnalas.restore());

    await jobStore.init();
    await jobRunner.init();

    const queueName = `test-uncommitted-${process.pid}-${Date.now()}`;
    const job = await jobStore.create({ ownerKind: "unowned" });
    storageKey = await fileStorage.put(Buffer.from("audio-baitai"), { ext: ".wav" });

    /** Abu `finishFailed()` bandymai pralaimi versijos lenktynes. */
    let kviesta = 0;
    jobStore.system.finishFailed = async () => {
      kviesta += 1;
      return jobStore.CONCURRENCY_CONFLICT;
    };

    queueConnection = createQueueConnection();
    queue = new Queue(queueName, { connection: queueConnection });
    await queue.add(
      "transcription",
      { jobId: job.id, payload: { storageKey } },
      { jobId: job.id, attempts: 1 }
    );

    const { createWorker } = require("../workers");
    worker = createWorker(
      queueName,
      async () => {
        throw new Error("tiekėjo klaida");
      },
      { stalledInterval: 1000, lockDuration: 2000 }
    );

    /**
     * ⚠️ LAUKIAMA KLAUSYTOJO PABAIGOS, NE BullMQ BŪSENOS (Codex D3).
     *
     * BullMQ pažymi job'ą `failed` PRIEŠ tai, kai `worker.on("failed", async …)`
     * grąžintas Promise išsisprendžia. Pirmoji šio testo redakcija laukė tik
     * eilės būsenos ir `kviesta > 0` — nė vienas iš jų nereiškia, kad
     * `_handleFailure()` baigė darbą. Pašalinus simbolio patikrą, klausytojas
     * galėjo dar tik skaityti saugyklą, kol testas jau tikrino failą, ir
     * regresija praeitų.
     *
     * Laukiama DETERMINISTINIO pėdsako, kurį palieka pati ginama šaka:
     * `finish_not_committed`. Jo buvimas įrodo, kad klausytojas priėjo iki
     * sprendimo IR jį priėmė.
     */
    let sprendimoEilute = null;
    for (let i = 0; i < 60; i++) {
      sprendimoEilute = zurnalas.lines().find((l) => /finish_not_committed/.test(l));
      if (sprendimoEilute) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    const b = await queue.getJob(job.id);
    assert.equal(await b.getState(), "failed", "prielaida: bandymai išnaudoti");
    assert.ok(kviesta > 0, "prielaida: `finishFailed()` tikrai kviestas");
    assert.ok(sprendimoEilute, "⚠️ klausytojas privalo pasiekti sprendimo šaką ir ją užfiksuoti");

    /** ⚠️ ESMINĖ PATIKRA: perėjimas neįsipareigotas, tad šaltinis privalo likti. */
    const audio = await fileStorage.get(storageKey);
    assert.ok(audio && audio.length > 0, "⚠️ audio privalo IŠLIKTI - `FAILED` neįsipareigotas");
  }
);

test(
  "#184-A ⚠️ nesėkmės tvarkytojo ATMETIMAS gaudomas klausytojo riboje",
  { skip: skipWithoutRedis() },
  async (t) => {
    /**
     * ⚠️ ŠIS TESTAS EGZISTUOJA, NES MATRICOS EILUTĖ BUVO NEPAGRĮSTA (Codex D4).
     *
     * Užrašiau, kad `worker.on("failed")` `.catch(...)` dengia gretimas testas.
     * Nedengė: jis niekada nepriverčia `finishFailed()` ATMESTI ir nestebi nei
     * `unhandledRejection`, nei `failure_handler_error`. Ištrynus `.catch(...)`,
     * cituotas rinkinys būtų likęs žalias.
     *
     * ⚠️ KODĖL TAI SVARBU. `EventEmitter` grąžinto Promise nelaukia. Po A3
     * pataisos `finishFailed()` SĄMONINGAI permeta `UNKNOWN_SOURCE_STATUS`, tad
     * be gaudyklės tas atmetimas taptų neapdorotu — ir nuodingas job'as galėtų
     * nužudyti visą worker'io procesą kiekvieno retry metu.
     *
     * ⚠️ ATMETIMAS ĮVEDAMAS DUBLIU, ne sugadintu įrašu: `system.update()`
     * neapdoroto `status` rašymo neleidžia (#154 sargas), tad nežinomos būsenos
     * per fasadą sukurti neįmanoma. Tikrinama ne kaip būsena atsiranda, o kas
     * nutinka klausytojui, kai `finishFailed()` atmeta.
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
    const originalus = jobStore.system.finishFailed;

    const neapdoroti = [];
    const gaudytuvas = (e) => neapdoroti.push(e);
    process.on("unhandledRejection", gaudytuvas);

    const zurnalas = perimtiLogus();

    t.after(async () => {
      process.off("unhandledRejection", gaudytuvas);
      zurnalas.restore();
      jobStore.system.finishFailed = originalus;
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

    const queueName = `test-listener-reject-${process.pid}-${Date.now()}`;
    const job = await jobStore.create({ ownerKind: "unowned" });
    storageKey = await fileStorage.put(Buffer.from("audio-baitai"), { ext: ".wav" });

    const { JobPhaseError } = require("../utils/jobPhase");
    jobStore.system.finishFailed = async () => {
      throw new JobPhaseError("Nežinomas šaltinio statusas.", "UNKNOWN_SOURCE_STATUS");
    };

    queueConnection = createQueueConnection();
    queue = new Queue(queueName, { connection: queueConnection });
    await queue.add(
      "transcription",
      { jobId: job.id, payload: { storageKey } },
      { jobId: job.id, attempts: 1 }
    );

    const { createWorker } = require("../workers");
    worker = createWorker(
      queueName,
      async () => {
        throw new Error("tiekėjo klaida");
      },
      { stalledInterval: 1000, lockDuration: 2000 }
    );

    /** Deterministinis pėdsakas: klausytojas pagavo atmetimą ir jį užfiksavo. */
    let gaudyklesEilute = null;
    for (let i = 0; i < 60; i++) {
      gaudyklesEilute = zurnalas.lines().find((l) => /failure_handler_error/.test(l));
      if (gaudyklesEilute) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    assert.ok(gaudyklesEilute, "⚠️ atmetimas privalo būti pagautas ir užfiksuotas");
    assert.match(gaudyklesEilute, /UNKNOWN_SOURCE_STATUS/, "eilutėje privalo būti klaidos kodas");
    assert.deepEqual(neapdoroti, [], "⚠️ NEAPDOROTO atmetimo negali likti - jis žudo procesą");

    /** Audio šioje šakoje neliečiamas: nesėkmės tvarkymas nepavyko. */
    const audio = await fileStorage.get(storageKey);
    assert.ok(audio && audio.length > 0, "⚠️ audio privalo IŠLIKTI");
  }
);
