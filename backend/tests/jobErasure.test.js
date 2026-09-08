const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

process.env.NODE_ENV = "test";
delete process.env.PRIVACY_MODE;

/**
 * Vienetiniai utils/jobErasure.js testai su MOCK'ais.
 *
 * Maršrutų testai vykdomi inline/mock režimu, tad jie NEĮRODO svarbiausios šio
 * modulio dalies: kad pasirenkama teisinga BullMQ eilė, kad job.remove() tikrai
 * kviečiamas, kad storageKey randamas ir kad klaidos atveju NEGRĄŽINAMA
 * klaidinanti sėkmė. Čia moduliai pakeičiami per require.cache.
 */

const ROOT = path.join(__dirname, "..");
const resolve = (relative) => require.resolve(path.join(ROOT, relative));

function loadEraseJob({
  mode = "bullmq",
  transcriptionQueue = {},
  protocolQueue = {},
  fileStorage = {},
  jobStore = {},
  auditLog = {},
}) {
  const calls = {
    transcriptionRemove: [],
    protocolRemove: [],
    storageDel: [],
    jobRemove: [],
    jobUpdate: [],
    auditRemove: [],
    auditRecord: [],
    resultArtifactsDelete: [],
  };

  const stubs = {
    "queues/jobRunner": { getMode: () => mode },

    "queues/transcriptionQueue": {
      removeTranscriptionJob: async (id) => {
        calls.transcriptionRemove.push(id);
        if (transcriptionQueue.throws) throw new Error(transcriptionQueue.throws);
        return transcriptionQueue.data ?? null;
      },
    },

    "queues/protocolQueue": {
      removeProtocolJob: async (id) => {
        calls.protocolRemove.push(id);
        if (protocolQueue.throws) throw new Error(protocolQueue.throws);
        return protocolQueue.data ?? null;
      },
    },

    "utils/fileStorage": {
      /**
       * ⚠️ DUBLIS GRĄŽINA `boolean`, KAIP IR TIKRASIS `del()` (#250 radinys).
       *
       * Anksčiau jis negrąžindavo nieko, o `eraseJob` `storageRemoved` statė
       * besąlygiškai — tad neištikimas dublis dengė tai, kad kodas ignoruoja
       * `del()` rezultatą. `fileStorage.del()` grąžina `true` pašalinus ir
       * `false`, kai objekto nebuvo (be klaidos).
       */
      del: async (key) => {
        calls.storageDel.push(key);
        if (fileStorage.throws) throw new Error(fileStorage.throws);
        return fileStorage.rado !== false;
      },
    },

    "utils/jobStore": {
      JOB_TYPES: { TRANSCRIPTION: "transcription", PROTOCOL: "protocol" },
      /**
       * #159: `jobErasure` yra sisteminis kelias – jis valo artefaktus
       * nepriklausomai nuo savininko, tad naudoja privilegijuotą namespace'ą.
       * Dublis turi tą pačią formą, kitaip testas praeitų su sąsaja, kurios
       * produkcijoje nebėra.
       */
      system: {
        /**
         * ⚠️ #157 PR-5: `eraseJob` po nepavykusio CAS klausia, ar eilutė dar yra —
         * be šio metodo dublis kristų `TypeError`, ir testas įrodinėtų ne tą dalyką.
         */
        get: async (id) => {
          if (jobStore.getThrows) throw new Error(jobStore.getThrows);
          return jobStore.dingo ? null : { id };
        },
        remove: async (id) => {
          calls.jobRemove.push(id);
          if (jobStore.throws) throw new Error(jobStore.throws);
          return jobStore.removed ?? true;
        },
        update: async (id, patch) => {
          calls.jobUpdate.push({ id, patch });
          return { id, ...patch };
        },
        /**
         * ⚠️ REZULTATO ARTEFAKTAI (#157, PR-5). Dublis privalo turėti šį metodą dėl
         * TOS PAČIOS priežasties, kurią aiškina 7.4a komentaras žemiau: trūkstamas
         * metodas produkciniame kelyje yra KRITINĖ nesėkmė („nežinau, ar pašalinta"),
         * ir be jo visi šio failo testai kristų ne dėl savo dalyko.
         *
         * `null` grąžinamas eksplicitiškai, kai to prašo scenarijus — taip tikrinama
         * fasado fail-safe šaka, o ne dublio spraga.
         */
        deleteResultArtifacts: async (id) => {
          calls.resultArtifactsDelete.push(id);
          if (jobStore.resultArtifacts === null) return null;
          if (jobStore.resultArtifactsThrows) throw new Error(jobStore.resultArtifactsThrows);
          return jobStore.resultArtifacts ?? { pasalinti: [], jauNebuvo: [], nepavyko: [] };
        },
      },
    },

    /**
     * ⚠️ STUB'AS PRIVALO TURĖTI VISĄ NAUDOJAMĄ PAVIRŠIŲ (#155, 7.4a).
     *
     * Iki 7.4a čia buvo tik `removeBySubjectIdentifier`, nors
     * `writeDeletionReceipt()` kvietė ir `record()`. Trūkstamas metodas metė
     * `TypeError`, kurį NURYDAVO tuometinis `catch {}` aplink auditą - testai
     * atrodė žali, o ištrynimo kvito kelias realiai nebuvo vykdomas.
     *
     * Pašalinus tą `catch` (auditas dabar BLOKUOJANTIS), spraga tapo matoma.
     * `normalizeEvent` imamas iš TIKRO modulio, kad stub'as neturėtų savo,
     * ilgainiui išsiskiriančios, įvykio vardų kopijos.
     */
    "utils/auditLog": {
      normalizeEvent: require("../utils/auditLog").normalizeEvent,
      record: async (entry) => {
        calls.auditRecord.push(entry);
        return entry;
      },
      removeBySubjectIdentifier: async (id) => {
        calls.auditRemove.push(id);
        if (auditLog.throws) throw new Error(auditLog.throws);
        return auditLog.removed ?? 1;
      },
    },
  };

  const injected = [];
  for (const [relative, exports] of Object.entries(stubs)) {
    const resolved = resolve(relative);
    injected.push(resolved);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
  }

  const erasurePath = resolve("utils/jobErasure");
  delete require.cache[erasurePath];
  const { eraseJob, eraseOrphanedJobData } = require(erasurePath);

  const restore = () => {
    for (const resolved of injected) delete require.cache[resolved];
    delete require.cache[erasurePath];
  };

  return { eraseJob, eraseOrphanedJobData, calls, restore };
}

function completedJob(overrides = {}) {
  return { id: "job-1", type: "transcription", status: "completed", storageKey: null, ...overrides };
}

test("BullMQ: transkripcijos jobas šalinamas iš TRANSKRIPCIJOS eilės", async () => {
  const { eraseJob, calls, restore } = loadEraseJob({
    transcriptionQueue: { data: { payload: { storageKey: "audio-key" } } },
  });

  try {
    const outcome = await eraseJob(completedJob());

    assert.deepEqual(calls.transcriptionRemove, ["job-1"]);
    assert.deepEqual(calls.protocolRemove, [], "protokolo eilė neturi būti liečiama");
    assert.deepEqual(calls.storageDel, ["audio-key"]);
    assert.deepEqual(calls.jobRemove, ["job-1"]);
    assert.equal(outcome.queueJobRemoved, true);
    assert.equal(outcome.storageRemoved, true);
    assert.equal(outcome.jobRemoved, true);
    assert.equal(outcome.criticalFailure, false);
  } finally {
    restore();
  }
});

test("BullMQ: protokolo jobas šalinamas iš PROTOKOLO eilės", async () => {
  const { eraseJob, calls, restore } = loadEraseJob({
    protocolQueue: { data: { payload: {} } },
  });

  try {
    const outcome = await eraseJob(completedJob({ id: "job-2", type: "protocol" }));

    assert.deepEqual(calls.protocolRemove, ["job-2"]);
    assert.deepEqual(calls.transcriptionRemove, []);
    assert.equal(outcome.type, "protocol");
    assert.equal(outcome.criticalFailure, false);
  } finally {
    restore();
  }
});

test("audio objekto NEBUVO: `storageRemoved` lieka `false`, bet tai NE nesėkmė", async () => {
  /**
   * ⚠️ ŠI EILUTĖ SAUGO KVITO TIESĄ (#250).
   *
   * `del()` grąžina `false`, kai objekto nėra. Anksčiau `DATA_ERASED` vis tiek
   * rašė `storage=deleted` — auditas tvirtino veiksmą, kurio nebuvo.
   */
  const { eraseJob, calls, restore } = loadEraseJob({
    mode: "inline",
    fileStorage: { rado: false },
  });

  try {
    const outcome = await eraseJob(completedJob({ storageKey: "jau-nebuvo" }));

    assert.deepEqual(calls.storageDel, ["jau-nebuvo"], "bandymas ĮVYKO");
    assert.equal(outcome.storageRemoved, false, "bet nieko nepašalinta");
    assert.equal(outcome.criticalFailure, false, "ir tai nėra gedimas");
    assert.equal(outcome.jobRemoved, true, "job'as vis tiek pašalinamas");
  } finally {
    restore();
  }
});

test("inline režimas: storageKey imamas iš PATIES JOBO (eilės nėra)", async () => {
  // Regresija: anksčiau storageKey buvo gaunamas TIK iš BullMQ payload'o, tad
  // inline režime likęs audio failas apskritai nebuvo randamas.
  const { eraseJob, calls, restore } = loadEraseJob({ mode: "inline" });

  try {
    const outcome = await eraseJob(completedJob({ storageKey: "orphan-audio" }));

    assert.deepEqual(calls.transcriptionRemove, [], "inline režime eilės nėra");
    assert.deepEqual(calls.storageDel, ["orphan-audio"]);
    assert.equal(outcome.storageRemoved, true);
    assert.equal(outcome.jobRemoved, true);
  } finally {
    restore();
  }
});

test("eilės klaida: jobStore įrašas NEŠALINAMAS, pažymimas deletion_pending", async () => {
  const { eraseJob, calls, restore } = loadEraseJob({
    transcriptionQueue: { throws: "Redis connection lost" },
  });

  try {
    const outcome = await eraseJob(completedJob());

    assert.equal(outcome.criticalFailure, true);
    assert.equal(outcome.jobRemoved, false);
    assert.deepEqual(calls.jobRemove, [], "įrašas turi likti, kad DELETE būtų pakartojamas");
    assert.equal(calls.jobUpdate[0].patch.deletion_pending, true);
    assert.match(outcome.errors[0], /^queue:/);
  } finally {
    restore();
  }
});

test("storage klaida: jobStore įrašas NEŠALINAMAS", async () => {
  const { eraseJob, calls, restore } = loadEraseJob({
    transcriptionQueue: { data: { payload: { storageKey: "audio-key" } } },
    fileStorage: { throws: "EACCES" },
  });

  try {
    const outcome = await eraseJob(completedJob());

    assert.equal(outcome.criticalFailure, true);
    assert.equal(outcome.storageRemoved, false);
    assert.deepEqual(calls.jobRemove, []);
    assert.match(outcome.errors[0], /^storage:/);
  } finally {
    restore();
  }
});

test("jobStore klaida pažymima kaip kritinė", async () => {
  const { eraseJob, restore } = loadEraseJob({
    transcriptionQueue: { data: { payload: {} } },
    jobStore: { throws: "store offline" },
  });

  try {
    const outcome = await eraseJob(completedJob());

    assert.equal(outcome.criticalFailure, true);
    assert.equal(outcome.jobRemoved, false);
    assert.match(outcome.errors.at(-1), /^jobStore:/);
  } finally {
    restore();
  }
});

test("audito klaida YRA kritinė - 204 būtų netiesa, jei audito įrašai liko", async () => {
  // Pseudonimizuoti audito duomenys pagal BDAR vis tiek gali būti asmens
  // duomenys, tad "ištrinta" negali reikšti "beveik ištrinta". Visi žingsniai
  // idempotentiški, tad DELETE galima kartoti.
  const { eraseJob, calls, restore } = loadEraseJob({
    transcriptionQueue: { data: { payload: {} } },
    auditLog: { throws: "audit store offline" },
  });

  try {
    const outcome = await eraseJob(completedJob());

    assert.equal(outcome.criticalFailure, true);
    assert.equal(outcome.jobRemoved, false);
    assert.deepEqual(calls.jobRemove, [], "jobStore įrašas turi likti pakartojimui");
    assert.match(outcome.errors[0], /^audit:/);
  } finally {
    restore();
  }
});

test("LEGACY jobas be type - valomos ABI eilės", async () => {
  // Prieš `type` įvedimą sukurti (Redis'e išlikę) jobai lauko neturi. Aklai
  // priskyrus "transcription", protokolo jobas būtų valomas iš ne tos eilės.
  const { eraseJob, calls, restore } = loadEraseJob({
    transcriptionQueue: { data: null },
    protocolQueue: { data: { payload: {} } },
  });

  try {
    const job = completedJob();
    delete job.type;

    const outcome = await eraseJob(job);

    assert.deepEqual(calls.transcriptionRemove, ["job-1"]);
    assert.deepEqual(calls.protocolRemove, ["job-1"]);
    assert.equal(outcome.type, "legacy");
    assert.equal(outcome.queueJobRemoved, true);
    assert.equal(outcome.jobRemoved, true);
    assert.equal(outcome.criticalFailure, false);
  } finally {
    restore();
  }
});

test("žinomas tipas NEliečia kitos eilės", async () => {
  const { eraseJob, calls, restore } = loadEraseJob({
    transcriptionQueue: { data: { payload: {} } },
  });

  try {
    await eraseJob(completedJob({ type: "transcription" }));

    assert.deepEqual(calls.protocolRemove, []);
  } finally {
    restore();
  }
});

test("deletion_pending atnaujinimo klaida patenka į errors", async () => {
  const { eraseJob, restore } = loadEraseJob({
    transcriptionQueue: { throws: "Redis connection lost" },
  });

  try {
    // jobStore.update stub'as nemeta, tad papildomai perrašom jį per outcome
    // patikrą: svarbiausia, kad queue klaida jau pažymėta kritine.
    const outcome = await eraseJob(completedJob());

    assert.equal(outcome.criticalFailure, true);
    assert.ok(outcome.errors.some((error) => error.startsWith("queue:")));
  } finally {
    restore();
  }
});

test("pakartotinis ištrynimas idempotentiškas (eilėje ir store jau tuščia)", async () => {
  const { eraseJob, restore } = loadEraseJob({
    transcriptionQueue: { data: null },
    jobStore: { removed: false },
  });

  try {
    const outcome = await eraseJob(completedJob());

    assert.equal(outcome.queueJobRemoved, false);
    assert.equal(outcome.jobRemoved, false);
    assert.equal(outcome.storageRemoved, false);
    assert.equal(outcome.criticalFailure, false);
    assert.deepEqual(outcome.errors, []);
  } finally {
    restore();
  }
});

test("tipas imamas iš JOBO, ne iš iškvietimo konteksto", async () => {
  const { eraseJob, calls, restore } = loadEraseJob({
    protocolQueue: { data: { payload: {} } },
  });

  try {
    await eraseJob(completedJob({ type: "protocol" }));

    assert.deepEqual(calls.protocolRemove, ["job-1"]);
    assert.deepEqual(calls.transcriptionRemove, []);
  } finally {
    restore();
  }
});

test("`already absent` NĖRA likutis: `source_audio` skaitomas kaip pašalintas", async () => {
  /**
   * ⚠️ CODEX RADINYS (#288): `storageRemoved: false` reiškia DVI skirtingas
   * būsenas, ir jų suplakimas melagingą kvitą pakeičia melagingu likučiu.
   *
   * `lifecycleService` `COVERED_CATEGORIES` skaito „ar artefakto nebėra", tad
   * objekto, kurio jau nebuvo, negalima rodyti kaip `remaining`.
   */
  const { eraseJob, restore } = loadEraseJob({ mode: "inline", fileStorage: { rado: false } });

  try {
    const outcome = await eraseJob(completedJob({ storageKey: "jau-nebuvo" }));

    assert.equal(outcome.storageRemoved, false, "nieko nepašalinta");
    assert.equal(outcome.storageAlreadyAbsent, true, "bet objekto ir NEBUVO");
  } finally {
    restore();
  }

  /** KONTROLĖ: realiai pašalinus abi vėliavos yra priešingos. */
  const antras = loadEraseJob({ mode: "inline" });
  try {
    const outcome = await antras.eraseJob(completedJob({ storageKey: "buvo" }));

    assert.equal(outcome.storageRemoved, true);
    assert.equal(outcome.storageAlreadyAbsent, false);
  } finally {
    antras.restore();
  }
});

test("#157 PR-5: rezultato artefaktų šalinimo klaida yra KRITINĖ — DB įrašas LIEKA", async () => {
  /**
   * ⚠️ ĮRODYMAS #157 DoD PUNKTUI: „`ArtifactStore.delete()` meta klaidą →
   * `criticalFailure: true` → DB metaduomenys NEPAŠALINAMI, kad retry turėtų
   * autoritetingą informaciją, ką reikia ištrinti".
   *
   * Tvarka čia yra garantijos dalis, ne stilius. Pašalinus job'o eilutę, `job_results`
   * dingtų per `ON DELETE CASCADE`, o su ja — ir adresai; `deletionRetry` grįžtų prie
   * job'o, pažymėto ištrynimui, ir nebeturėtų ko trinti. Objektas su transkripcija
   * liktų saugykloje be nė vienos rodyklės.
   */
  const { eraseJob, calls, restore } = loadEraseJob({
    mode: "inline",
    jobStore: {
      resultArtifacts: {
        pasalinti: ["results/job-1/a.json"],
        jauNebuvo: [],
        nepavyko: [{ storageKey: "results/job-1/b.json", priezastis: "EACCES" }],
      },
    },
  });

  try {
    const outcome = await eraseJob(completedJob({ storageKey: null }));

    assert.equal(outcome.criticalFailure, true, "dalinis gedimas negali būti sėkmė");
    assert.deepEqual(calls.jobRemove, [], "job'o eilutė privalo LIKTI — kitaip adresai dingsta");
    assert.ok(
      outcome.errors.some((e) => e.includes("results/job-1/b.json")),
      `klaidoje privalo būti KONKRETUS adresas: ${outcome.errors.join("; ")}`
    );
    assert.deepEqual(calls.auditRecord, [], "kvitas apie ištrynimą nerašomas");
  } finally {
    restore();
  }
});

test("#157 PR-5: saugykla be `deleteResultArtifacts()` yra KRITINĖ nesėkmė, ne no-op", async () => {
  /**
   * ⚠️ `null` = „NEŽINAU, AR PAŠALINTA". Fasadas jį grąžina, kai backend'as metodo
   * neturi. Tyli šaka čia reikštų „ištrinta" be objekto pašalinimo — tiksliai tas
   * melas, kurį #157 riba draudžia.
   */
  const { eraseJob, calls, restore } = loadEraseJob({
    mode: "inline",
    jobStore: { resultArtifacts: null },
  });

  try {
    const outcome = await eraseJob(completedJob({ storageKey: null }));

    assert.equal(outcome.criticalFailure, true);
    assert.deepEqual(calls.jobRemove, [], "nežinant, ar objektai pašalinti, įrašas neliečiamas");
  } finally {
    restore();
  }
});

test('#157 PR-5: sėkmės atveju kvitas skiria PAŠALINTA nuo JAU NEBUVO', async () => {
  /**
   * Ta pati trijų būsenų taisyklė kaip audio kelyje (#250): kvitas, sujungiantis abu,
   * tvirtintų veiksmą, kurio nebuvo. `results=` eilutė kvite yra ATSKIRA nuo `storage=`,
   * nes po #157 tai du skirtingi artefaktų tipai skirtingose vietose.
   */
  const { eraseJob, calls, restore } = loadEraseJob({
    mode: "inline",
    jobStore: {
      resultArtifacts: { pasalinti: ["a"], jauNebuvo: ["b", "c"], nepavyko: [] },
    },
  });

  try {
    const outcome = await eraseJob(completedJob({ storageKey: null }));

    assert.equal(outcome.criticalFailure, false);
    assert.equal(outcome.resultArtifactsRemoved, 1);
    assert.equal(outcome.resultArtifactsAlreadyAbsent, 2);

    const kvitas = calls.auditRecord.find((e) => e.details && e.details.includes("results="));
    assert.ok(kvitas, "kvite privalo būti `results=` eilutė");
    assert.match(kvitas.details, /results=1\/2/, kvitas.details);
  } finally {
    restore();
  }
});

test("#157 PR-5: rezultato artefaktų šalinimas patenka į `anythingRemoved` — kvitas IŠRAŠOMAS", async () => {
  /**
   * ⚠️ REIKŠMĖ, RAŠOMA Į SUVESTINĘ, KURIOS NIEKAS NESKAITO (Codex, #304).
   *
   * Jei rezultato objekto pašalinimas buvo VIENINTELIS fizinis veiksmas, `DATA_ERASED`
   * kvito nebūtų — ištrynimas įvyktų be pėdsako. Būtent tokia yra external rezultato
   * situacija: eilės nėra, audio nėra, audito įrašų nėra.
   */
  const { eraseJob, calls, restore } = loadEraseJob({
    mode: "inline",
    jobStore: {
      removed: false,
      resultArtifacts: { pasalinti: ["results/j/a.json"], jauNebuvo: [], nepavyko: [] },
    },
    auditLog: { removed: 0 },
  });

  try {
    const outcome = await eraseJob(completedJob({ storageKey: null }));

    assert.equal(outcome.resultArtifactsRemoved, 1);
    assert.ok(
      calls.auditRecord.some((e) => e.details && e.details.includes("results=1/0")),
      `kvitas privalo būti išrašytas: ${JSON.stringify(calls.auditRecord)}`
    );
  } finally {
    restore();
  }
});

test("#157 PR-5: našlaitis su VIENINTELIU external rezultatu nėra „nerastas\"", async () => {
  /**
   * ⚠️ `found` be `resultArtifactsRemoved` reikštų 404 apie job'ą, kurio transkripciją
   * ką tik pašalinom (Codex, #304).
   */
  const { eraseOrphanedJobData, restore } = loadEraseJob({
    mode: "inline",
    jobStore: {
      resultArtifacts: { pasalinti: ["results/j/a.json"], jauNebuvo: [], nepavyko: [] },
    },
    auditLog: { removed: 0 },
  });

  try {
    const outcome = await eraseOrphanedJobData("job-1", { scope: "system" });

    assert.equal(outcome.resultArtifactsRemoved, 1);
    assert.equal(outcome.found, true, "artefaktas rastas ir pašalintas — tai NE 404");
  } finally {
    restore();
  }
});

test("#157 PR-5: NEBAIGTAS ištrynimas palieka `deletion_pending` — kad būtų kas pakartos", async () => {
  /**
   * ⚠️ FAIL-CLOSED BE PABAIGOS YRA TA PATI KLASĖ KAIP 4b `pending` EILUTĖS.
   *
   * `deletionRetry` kandidatus randa per `listPendingDeletions()`, t. y. per
   * `deletion_pending` vėliavą. Be jos būsena „eilutė liko, ištrynimas nebaigtas" būtų
   * aklavietė: kvietėjas matytų „nebaigta", o iš naujo nebandytų niekas.
   */
  const { eraseJob, calls, restore } = loadEraseJob({
    mode: "inline",
    jobStore: {
      removed: false,
      resultArtifacts: { pasalinti: ["a"], jauNebuvo: [], nepavyko: [], matyti: [{ storageType: "fs", storageKey: "a" }] },
    },
  });

  try {
    const outcome = await eraseJob(completedJob({ storageKey: null }));

    assert.equal(outcome.jobRemoved, false, "eilutė nepašalinta");
    assert.equal(outcome.criticalFailure, true, "tai NE sėkmė");
    assert.ok(
      calls.jobUpdate.some((u) => u.patch && u.patch.deletion_pending === true),
      `privalo likti \`deletion_pending\`: ${JSON.stringify(calls.jobUpdate)}`
    );
    assert.ok(
      outcome.errors.some((e) => e.includes("BARJERO")),
      "klasifikacija privalo nurodyti, kad pasikartojimas yra barjero problema"
    );
  } finally {
    restore();
  }
});

test("#157 PR-5: po-CAS SKAITYMO klaida nėra „job'o nebėra“", async () => {
  /**
   * ⚠️ NEIGIAMAS REZULTATAS IŠ ĮRODYMO, KURIS JO NENUSTATO (Codex, #304).
   *
   * `.catch(() => null)` laikiną DB gedimą paversdavo išvada „eilutės nebėra, vadinasi
   * pavyko": `criticalFailure` likdavo `false`, kvitas būdavo išrašomas, o žyma
   * finalizuojama — po ištrynimo, kurio niekas nepatvirtino.
   */
  const { eraseJob, calls, restore } = loadEraseJob({
    mode: "inline",
    jobStore: {
      removed: false,
      getThrows: "laikinas DB gedimas",
      resultArtifacts: {
        pasalinti: ["a"],
        jauNebuvo: [],
        nepavyko: [],
        matyti: [{ storageType: "fs", storageKey: "a" }],
      },
    },
  });

  try {
    const outcome = await eraseJob(completedJob({ storageKey: null }));

    assert.equal(outcome.criticalFailure, true, "nežinoma būsena negali būti sėkmė");
    assert.ok(
      outcome.errors.some((e) => e.includes("NEŽINOMA")),
      `klaida privalo pasakyti, kad būsena nežinoma: ${outcome.errors.join("; ")}`
    );
    assert.deepEqual(calls.auditRecord, [], "kvitas NEIŠRAŠOMAS");
  } finally {
    restore();
  }
});
