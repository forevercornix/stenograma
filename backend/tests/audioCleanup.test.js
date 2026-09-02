const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

process.env.NODE_ENV = "test";

/**
 * REGRESIJOS TESTAI: audio ištrynimo klaida NEGALI prarasti storageKey.
 *
 * Anksčiau abu valymo keliai darė taip:
 *
 *   await fileStorage.del(payload.storageKey).catch(() => {});
 *   await jobStore.system.update(jobId, { storageKey: null }).catch(() => {});
 *
 * Nepavykus `del()`, klaida buvo nutylima, bet raktas vis tiek dingdavo iš
 * jobStore - failas likdavo storage, o vėlesnis GDPR DELETE jo nebesurasdavo.
 * Tai paneigdavo pačią garantiją, dėl kurios storageKey buvo pradėtas saugoti.
 */

const ROOT = path.join(__dirname, "..");
const resolve = (relative) => require.resolve(path.join(ROOT, relative));

function loadReleaseAudio({ delThrows = null }) {
  const calls = { del: [], update: [] };

  const stubs = {
    "utils/fileStorage": {
      del: async (key) => {
        calls.del.push(key);
        if (delThrows) throw new Error(delThrows);
      },
    },
    "utils/jobStore": {
      /** #159: audio valymas yra sisteminis kelias – privilegijuotas namespace. */
      system: {
        /** #154: state machine metodai – dublis turi tą pačią formą kaip produkcija. */
        finish: async (id, status, extra = {}) => {
          calls.update.push({ id, patch: { status, ...extra } });
          return { id, status, ...extra };
        },
        restart: async (id, extra = {}) => {
          calls.update.push({ id, patch: { status: "processing", ...extra } });
          return { id, status: "processing", ...extra };
        },
        update: async (id, patch) => {
          calls.update.push({ id, patch });
          return { id, ...patch };
        },
        /**
         * ⚠️ PRIVALOMAS NUO #184 (7.5b). `_cleanupStorage()` dabar prieš trynimą
         * skaito AUTORITETINGĄ būseną: audio šalinamas tik tada, kai įrašas NĖRA
         * `completed` be rezultato (remontuotina būsena). Dublis be `get()`
         * kristų su `TypeError` - būtent taip šis testas ir pagavo pakeitimą.
         *
         * ⚠️ GRĄŽINAMAS `failed`, NE `null`. `null` (įrašo nebėra) barjerą irgi
         * praleistų, bet tada testas nieko nesakytų apie ĮPRASTĄ nesėkmės kelią -
         * o būtent jis privalo likti nepakitęs, kitaip audio failai kauptųsi
         * neribotai.
         */
        get: async (id) => ({ id, status: "failed", result: null }),
      },
    },
  };

  const injected = [];
  for (const [relative, exports] of Object.entries(stubs)) {
    const resolved = resolve(relative);
    injected.push(resolved);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
  }

  /**
   * ⚠️ ŠIS HELPERIS BARJERO NELIEČIA SĄMONINGAI. Jis tikrina GRYNĄ
   * `releaseAudio()` elgesį — būtent tą kelią, kurį GDPR ištrynimas naudoja be
   * barjero. Įtraukus `audioBarrier` čia, testas nustotų tikrinti tai, ką turi.
   */
  const cleanupPath = resolve("utils/audioCleanup");
  delete require.cache[cleanupPath];
  const { releaseAudio } = require(cleanupPath);

  return {
    releaseAudio,
    calls,
    restore: () => {
      for (const resolved of injected) delete require.cache[resolved];
      delete require.cache[cleanupPath];
    },
  };
}

test("sėkmingas trynimas: storageKey nulinamas", async () => {
  const { releaseAudio, calls, restore } = loadReleaseAudio({});

  try {
    const removed = await releaseAudio("job-1", "audio-key");

    assert.equal(removed, true);
    assert.deepEqual(
      calls.del,
      ["audio-key"],
      "#184 barjeras ĮPRASTO `failed` kelio neblokuoja - trynimas bandomas kaip anksčiau"
    );
    assert.deepEqual(calls.update, [
      { id: "job-1", patch: { storageKey: null, audio_cleanup_pending: false } },
    ]);
  } finally {
    restore();
  }
});

test("NEPAVYKĘS trynimas: storageKey LIEKA + jobas pažymimas pakartojimui", async () => {
  const { releaseAudio, calls, restore } = loadReleaseAudio({ delThrows: "EACCES" });

  try {
    const removed = await releaseAudio("job-1", "audio-key");

    assert.equal(removed, false);
    assert.deepEqual(calls.del, ["audio-key"]);

    // Raktas turi LIKTI, o jobas - būti pažymėtas pakartojimui. Vien rakto
    // palikimo neužtenka: be vėliavos nebaigto valymo niekas nepamatytų ir po
    // jobStore TTL nuoroda į failą dingtų.
    assert.equal(calls.update.length, 1);
    assert.equal(calls.update[0].patch.audio_cleanup_pending, true);
    assert.equal(calls.update[0].patch.storageKey, "audio-key");
    assert.ok(
      !calls.update.some((call) => call.patch.storageKey === null),
      "storageKey neturi būti nulinamas"
    );
  } finally {
    restore();
  }
});

test("be storageKey - jokių šalutinių veiksmų", async () => {
  const { releaseAudio, calls, restore } = loadReleaseAudio({});

  try {
    assert.equal(await releaseAudio("job-1", null), false);
    assert.deepEqual(calls.del, []);
    assert.deepEqual(calls.update, []);
  } finally {
    restore();
  }
});

/**
 * Tie patys du scenarijai per TIKRUS iškvietimo taškus - kad testas liktų
 * prasmingas net jei kas nors vėl įrašytų valymo logiką tiesiai į runner'į.
 */
test("inline runner: cleanup klaidos atveju storageKey lieka", async () => {
  const calls = { del: [], update: [] };

  const fileStoragePath = resolve("utils/fileStorage");
  const jobStorePath = resolve("utils/jobStore");
  const cleanupPath = resolve("utils/audioCleanup");
  /**
   * ⚠️ `audioBarrier` IRGI VALOMAS. Jis importuoja `jobStore` moduliui kraunantis,
   * tad likęs cache'e laikytų TIKRĄ saugyklą ir dublis liktų neįtakotas.
   */
  const barrierPath = resolve("utils/audioBarrier");
  const runnerPath = resolve("queues/jobRunner");

  const originals = {};
  for (const p of [fileStoragePath, jobStorePath, cleanupPath, barrierPath, runnerPath]) {
    originals[p] = require.cache[p];
    delete require.cache[p];
  }

  require.cache[fileStoragePath] = {
    id: fileStoragePath,
    filename: fileStoragePath,
    loaded: true,
    exports: {
      del: async (key) => {
        calls.del.push(key);
        throw new Error("storage down");
      },
    },
  };

  const jobs = new Map();
  require.cache[jobStorePath] = {
    id: jobStorePath,
    filename: jobStorePath,
    loaded: true,
    exports: {
      STATUS: { QUEUED: "queued", PROCESSING: "processing", COMPLETED: "completed", FAILED: "failed" },
      /** #159: runner ir worker yra sisteminiai keliai. */
      system: {
        /** #154: state machine metodai – dublis turi tą pačią formą kaip produkcija. */
        finish: async (id, status, extra = {}) => {
          calls.update.push({ id, patch: { status, ...extra } });
          return { id, status, ...extra };
        },
        restart: async (id, extra = {}) => {
          calls.update.push({ id, patch: { status: "processing", ...extra } });
          return { id, status: "processing", ...extra };
        },
        update: async (id, patch) => {
          calls.update.push({ id, patch });
          jobs.set(id, { ...(jobs.get(id) || { id }), ...patch });
          return jobs.get(id);
        },
        /**
         * ⚠️ PRIVALOMAS NUO #184 / Codex A grupės: `_atlaisvintiSaltini()` ir
         * inline `finally` dabar eina per `audioBarrier`, kuris skaito
         * AUTORITETINGĄ būseną. Dublis privalo turėti tą pačią formą kaip
         * produkcija.
         *
         * Grąžinama reali stebima būsena, ne konstanta — kitaip testas
         * netikrintų nieko apie kelią, kurį pats vykdo.
         */
        get: async (id) => jobs.get(id) || { id, status: "failed", result: null },
      },
    },
  };

  try {
    const jobRunner = require(runnerPath);
    jobRunner.registerProcessor("transcription", async () => ({ text: "ok" }));

    await jobRunner._runInline("transcription", "job-inline", { storageKey: "audio-key" });

    assert.deepEqual(calls.del, ["audio-key"]);
    assert.ok(
      !calls.update.some((call) => call.patch.storageKey === null),
      "nepavykus trynimui storageKey neturi būti nulinamas"
    );
    assert.ok(
      calls.update.some((call) => call.patch.audio_cleanup_pending === true),
      "jobas turi būti pažymėtas audio valymo pakartojimui"
    );
  } finally {
    for (const p of [fileStoragePath, jobStorePath, cleanupPath, barrierPath, runnerPath]) {
      delete require.cache[p];
      if (originals[p]) require.cache[p] = originals[p];
    }
  }
});

test("worker cleanup: klaidos atveju storageKey lieka", async () => {
  const calls = { del: [], update: [] };

  const fileStoragePath = resolve("utils/fileStorage");
  const jobStorePath = resolve("utils/jobStore");
  const cleanupPath = resolve("utils/audioCleanup");
  /**
   * ⚠️ `audioBarrier` IRGI VALOMAS. Jis importuoja `jobStore` moduliui kraunantis,
   * tad likęs cache'e laikytų TIKRĄ saugyklą ir dublis liktų neįtakotas.
   */
  const barrierPath = resolve("utils/audioBarrier");
  const workersPath = resolve("workers/index");

  const originals = {};
  for (const p of [fileStoragePath, jobStorePath, cleanupPath, barrierPath, workersPath]) {
    originals[p] = require.cache[p];
    delete require.cache[p];
  }

  require.cache[fileStoragePath] = {
    id: fileStoragePath,
    filename: fileStoragePath,
    loaded: true,
    exports: {
      del: async (key) => {
        calls.del.push(key);
        throw new Error("storage down");
      },
    },
  };

  require.cache[jobStorePath] = {
    id: jobStorePath,
    filename: jobStorePath,
    loaded: true,
    exports: {
      STATUS: { COMPLETED: "completed", FAILED: "failed", PROCESSING: "processing" },
      /** #159: worker yra sisteminis kelias. */
      system: {
        /** #154: state machine metodai – dublis turi tą pačią formą kaip produkcija. */
        finish: async (id, status, extra = {}) => {
          calls.update.push({ id, patch: { status, ...extra } });
          return { id, status, ...extra };
        },
        restart: async (id, extra = {}) => {
          calls.update.push({ id, patch: { status: "processing", ...extra } });
          return { id, status: "processing", ...extra };
        },
        update: async (id, patch) => {
          calls.update.push({ id, patch });
          return { id, ...patch };
        },
        /** ⚠️ PRIVALOMAS NUO #184 — žr. pirmojo dublio komentarą. */
        get: async (id) => ({ id, status: "failed", result: null }),
      },
    },
  };

  try {
    const { _cleanupStorage } = require(workersPath);

    await _cleanupStorage({ storageKey: "audio-key" }, "job-worker");

    assert.deepEqual(calls.del, ["audio-key"]);
    assert.ok(
      !calls.update.some((call) => call.patch.storageKey === null),
      "worker'yje nepavykus trynimui storageKey neturi būti nulinamas"
    );
    assert.ok(
      calls.update.some((call) => call.patch.audio_cleanup_pending === true),
      "jobas turi būti pažymėtas audio valymo pakartojimui"
    );
  } finally {
    for (const p of [fileStoragePath, jobStorePath, cleanupPath, barrierPath, workersPath]) {
      delete require.cache[p];
      if (originals[p]) require.cache[p] = originals[p];
    }
  }
});

test("#184-A ⚠️ inline: NEĮSIPAREIGOJUS terminalaus perėjimo audio NEŠALINAMAS", async () => {
  /**
   * ⚠️ ŠĮ SCENARIJŲ ATKŪRĖ CODEX, NE TESTAS.
   *
   * Kai inline `finish(COMPLETED)` grąžina konflikto simbolį, o po jo einantis
   * `finishFailed()` pralaimi ABU savo bandymus, įrašas lieka `processing`. Bet
   * `finally` barjerą kviesdavo besąlygiškai, o barjeras ne-terminalį SĄMONINGAI
   * praleidžia (kitaip audio failai kauptųsi) — tad šaltinis būdavo ištrinamas,
   * paliekant AKTYVŲ job'ą be įvesties.
   *
   * ⚠️ BARJERAS ČIA NEPADEDA IR NETURI PADĖTI. Klausimas ne „ar būsena leidžia
   * šalinti", o „ar būsena apskritai pasikeitė". Todėl sprendimas priimamas iš
   * OPERACIJOS BAIGTIES — ir tai tikrinama atskirai.
   */
  const calls = { del: [], update: [] };

  const fileStoragePath = resolve("utils/fileStorage");
  const jobStorePath = resolve("utils/jobStore");
  const cleanupPath = resolve("utils/audioCleanup");
  const barrierPath = resolve("utils/audioBarrier");
  const runnerPath = resolve("queues/jobRunner");

  const originals = {};
  for (const p of [fileStoragePath, jobStorePath, cleanupPath, barrierPath, runnerPath]) {
    originals[p] = require.cache[p];
    delete require.cache[p];
  }

  const KONFLIKTAS = Symbol("jobStore.CONCURRENCY_CONFLICT");

  require.cache[fileStoragePath] = {
    id: fileStoragePath,
    filename: fileStoragePath,
    loaded: true,
    exports: {
      del: async (key) => {
        calls.del.push(key);
        return true;
      },
    },
  };

  require.cache[jobStorePath] = {
    id: jobStorePath,
    filename: jobStorePath,
    loaded: true,
    exports: {
      STATUS: { QUEUED: "queued", PROCESSING: "processing", COMPLETED: "completed", FAILED: "failed" },
      CONCURRENCY_CONFLICT: KONFLIKTAS,
      system: {
        /** ABI operacijos pralaimi CAS - įrašas lieka `processing`. */
        finish: async () => KONFLIKTAS,
        finishFailed: async () => KONFLIKTAS,
        restart: async (id) => ({ id, status: "processing" }),
        update: async (id, patch) => {
          calls.update.push({ id, patch });
          return { id, ...patch };
        },
        get: async (id) => ({ id, status: "processing", result: null }),
      },
    },
  };

  try {
    const jobRunner = require(runnerPath);
    jobRunner.registerProcessor("transcription", async () => ({ text: "ok" }));

    await jobRunner._runInline("transcription", "job-inline", { storageKey: "audio-key" });

    assert.deepEqual(
      calls.del,
      [],
      "⚠️ audio NEGALI būti šalinamas, kol terminalus perėjimas neįsipareigotas"
    );
  } finally {
    for (const p of [fileStoragePath, jobStorePath, cleanupPath, barrierPath, runnerPath]) {
      delete require.cache[p];
      if (originals[p]) require.cache[p] = originals[p];
    }
  }
});

test("#184-A ⚠️ barjero paieškos gedimas PAŽYMI valymo pakartojimą", async () => {
  /**
   * ⚠️ BARJERAS ĮVEDĖ NAUJĄ GEDIMO TAŠKĄ PRIEŠ `releaseAudio()` (Codex D2).
   *
   * Būtent `releaseAudio()` nepavykus uždeda `audio_cleanup_pending`, ir
   * `retryPendingAudioCleanups()` ieško TIK tos vėliavos. Vadinasi trumpalaikis
   * saugyklos trikdis barjero skaityme paliktų audio be jokio vėlesnio
   * kvietėjo — nei ištrintą, nei pažymėtą pakartojimui. Tyli nutekėjimo forma:
   * jokio simptomo, jokios eilutės, o failas lieka amžiams.
   *
   * Elgesys fail-closed IR fail-visible: netrinam (negalim įrodyti, kad galima),
   * bet pažymim, kad valymas dar skolingas.
   */
  const calls = { del: [], update: [] };

  const fileStoragePath = resolve("utils/fileStorage");
  const jobStorePath = resolve("utils/jobStore");
  const cleanupPath = resolve("utils/audioCleanup");
  const barrierPath = resolve("utils/audioBarrier");

  const originals = {};
  for (const p of [fileStoragePath, jobStorePath, cleanupPath, barrierPath]) {
    originals[p] = require.cache[p];
    delete require.cache[p];
  }

  require.cache[fileStoragePath] = {
    id: fileStoragePath,
    filename: fileStoragePath,
    loaded: true,
    exports: {
      del: async (key) => {
        calls.del.push(key);
        return true;
      },
    },
  };

  require.cache[jobStorePath] = {
    id: jobStorePath,
    filename: jobStorePath,
    loaded: true,
    exports: {
      STATUS: { QUEUED: "queued", PROCESSING: "processing", COMPLETED: "completed", FAILED: "failed" },
      system: {
        /** Trumpalaikis trikdis BŪTENT barjero skaityme. */
        get: async () => {
          throw new Error("ECONNRESET");
        },
        update: async (id, patch) => {
          calls.update.push({ id, patch });
          return { id, ...patch };
        },
      },
    },
  };

  try {
    const { salintiAudioSuBarjeru } = require(barrierPath);
    const leista = await salintiAudioSuBarjeru("job-x", { storageKey: "audio-key" });

    assert.equal(leista, false, "paieškai kritus valymas NELEIDŽIAMAS");
    assert.deepEqual(calls.del, [], "⚠️ netrinam, kol negalim įrodyti, kad galima");
    assert.ok(
      calls.update.some((c) => c.patch.audio_cleanup_pending === true),
      "⚠️ BET pažymim pakartojimui - kitaip `retryPendingAudioCleanups()` failo niekada nepamatys"
    );
  } finally {
    for (const p of [fileStoragePath, jobStorePath, cleanupPath, barrierPath]) {
      delete require.cache[p];
      if (originals[p]) require.cache[p] = originals[p];
    }
  }
});

test("#184-A ⚠️ barjeras reikalauja TERMINALAUS statuso, ne tik „ne remontuotino\"", () => {
  /**
   * ⚠️ NUMATYTOJI REIKŠMĖ APVERSTA (Codex E2).
   *
   * Anksčiau predikatas leido VISKĄ, išskyrus `completed` be rezultato. Iš to
   * sekė, kad kiekvienas kvietėjas privalėjo ATSKIRAI tikrinti, ar terminalus
   * perėjimas apskritai įvyko. Per šį PR ta patikra buvo pamiršta keturiose
   * vietose iš keturių bent po kartą — worker'io nesėkmėje, inline `finally`, ir
   * abiejose autorizacijos ankstyvo grįžimo šakose.
   *
   * Vietoj penktos kvietėjo patikros apversta pati numatytoji reikšmė: valymas
   * leidžiamas TIK terminaliai būsenai. Garantija nebepriklauso nuo to, ar visi
   * kvietėjai prisiminė — įskaitant tuos, kurių dar nėra.
   */
  const { arGalimaSalintiAudio } = require("../utils/audioBarrier");

  for (const status of ["queued", "processing"]) {
    assert.equal(
      arGalimaSalintiAudio({ status, result: null }),
      false,
      `⚠️ \`${status}\` yra AKTYVUS darbas - jo įvesties naikinti negalima`
    );
  }

  assert.equal(arGalimaSalintiAudio({ status: "completed", result: null }), false, "remontuotina");
  assert.equal(arGalimaSalintiAudio({ status: "completed", result: { a: 1 } }), true);
  assert.equal(arGalimaSalintiAudio({ status: "failed", result: null }), true);
  assert.equal(arGalimaSalintiAudio({ status: "cancelled", result: null }), true);

  /**
   * ⚠️ ĮRAŠO NĖRA → ŠALINAM. TTL ar ištrynimas reiškia, kad nuorodos nebeliko;
   * nepašalinus failas liktų diske amžiams, nes retencija ieško per gyvus
   * job'ų įrašus. Per griežta sąlyga čia būtų nutekėjimas, ne apsauga.
   */
  assert.equal(arGalimaSalintiAudio(null), true, "įrašo nėra - failas privalo dingti");
});

test("#184-A ⚠️ techninis valymo pakartojimas eina PER barjerą", () => {
  /**
   * ⚠️ MANO PATAISA BUVO SUKŪRUSI KELIĄ APLINK SAVE (Codex E1).
   *
   * Barjerui nepavykus perskaityti būsenos, jis pažymi `audio_cleanup_pending`,
   * kad valymas nedingtų. Bet `retryPendingAudioCleanups()` tą vėliavą apdorodavo
   * TIESIOGINIU `releaseAudio()` — be patikros. Rezultatas buvo tiksliai
   * atvirkštinis nei norėta: kitas sweep'as negrįžtamai ištrindavo būtent tą
   * audio, kurį barjeras saugojo.
   *
   * ⚠️ GDPR IŠTRYNIMAS LIEKA BE BARJERO, ir tai tikrinama kartu: skiriasi ne
   * mechanizmas, o teisė. Techninis valymas yra patogumas, ištrynimas — pareiga.
   */
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs
    .readFileSync(path.join(__dirname, "..", "utils", "deletionRetry.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  const i = src.indexOf("async function retryPendingAudioCleanups");
  const j = src.indexOf("async function retryPendingDeletions");
  assert.ok(i >= 0 && j >= 0, "prielaida: abi funkcijos egzistuoja");

  const techninis = i < j ? src.slice(i, j) : src.slice(i);

  assert.match(techninis, /salintiAudioSuBarjeru\(/, "techninis pakartojimas privalo eiti per barjerą");
  assert.equal(
    /releaseAudio\(/.test(techninis),
    false,
    "⚠️ tiesioginis releaseAudio() techniniame kelyje apeina barjerą"
  );

  /**
   * ⚠️ GDPR KELIAS TIKRINAMAS TEN, KUR JIS REALIAI YRA.
   *
   * Pirmoji šio testo redakcija tikrino, ar `retryPendingDeletions()` kviečia
   * `releaseAudio()`. NEKVIEČIA: ji kviečia `jobErasure.eraseJob()`, o tas
   * šalina failą tiesiogiai per `fileStorage.del()`. Testas krito ir taip
   * atskleidė, kad gretimas komentaras teigė neteisybę — abu ištaisyti.
   */
  const erasure = fs
    .readFileSync(path.join(__dirname, "..", "utils", "jobErasure.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(
    erasure,
    /fileStorage\.del\(/,
    "⚠️ GDPR ištrynimas privalo likti BE barjero - ten audio dingsta nepriklausomai nuo būsenos"
  );
  assert.equal(
    /salintiAudioSuBarjeru|arGalimaSalintiAudio/.test(erasure),
    false,
    "⚠️ barjeras NEGALI patekti į ištrynimo kelią"
  );
});
