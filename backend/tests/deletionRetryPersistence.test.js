const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const jobStore = require("../utils/jobStore");

/**
 * ⚠️ TIKROSIOS FUNKCIJOS, įsimintos PRIEŠ bet kokį perėmimą.
 *
 * Paskutinis testas anksčiau išsaugodavo `jobStore.update` JAU PO `perimti()`,
 * tad `t.after` grąžindavo mock'ą atgal ir paliktų `jobStore` perimtą. Sargas
 * žemiau tai pagauna nepriklausomai nuo to, kiek testų bus pridėta.
 */
const TIKRAS_UPDATE = jobStore.update;
const TIKRAS_SYSTEM = jobStore.system;
const retry = require("../utils/deletionRetry");

/**
 * #196: nepavykę ištrynimo bandymai privalo būti apskaitomi net kritus saugyklai.
 *
 * ⚠️ ANKSČIAU `jobStore.update()` klaida buvo praryjama `.catch(() => {})`.
 *
 * Praryjamas buvo BŪTENT tas atnaujinimas, kuris didina bandymų skaitiklį ir
 * nustato backoff. Kadangi `update()` dažniausiai krinta per tą patį Redis
 * sutrikimą, kuris ir sukėlė ištrynimo nesėkmę, rezultatas buvo:
 *
 *   – `deletion_attempts` lieka 0;
 *   – `next_attempt_at` neatnaujinamas → backoff nėra;
 *   – `MAX_ATTEMPTS_BEFORE_ALERT` NIEKADA nepasiekiamas.
 *
 * GDPR ištrynimas nepavyksta tyliai, o operatorius apie tai nesužino.
 */

const { MAX_ATTEMPTS_BEFORE_ALERT } = retry;

/** Pakeičia `jobStore` metodus ir grąžina atstatymo funkciją. */
function perimti({ pending, audioPending = [], updateKrinta, onUpdate }) {
  const originalūs = {
    system: jobStore.system,
    update: jobStore.update,
  };

  jobStore.system = {
    ...originalūs.system,
    listPendingDeletions: async () => pending,
    listPendingAudioCleanups: async () => audioPending,
  };

  let updateKvietimai = 0;
  jobStore.update = async (id, patch) => {
    updateKvietimai += 1;
    if (updateKrinta) {
      const e = new Error("Redis neprieinamas");
      e.code = "ECONNREFUSED";
      throw e;
    }
    if (onUpdate) onUpdate(patch);
    Object.assign([...pending, ...audioPending].find((j) => j.id === id) || {}, patch);
    return patch;
  };

  return {
    atstatyti() {
      jobStore.system = originalūs.system;
      jobStore.update = originalūs.update;
    },
    get kvietimai() {
      return updateKvietimai;
    },
  };
}

/** `eraseJob` visada krinta — modeliuojam nuolat nepavykstantį ištrynimą. */
function perimtiErase(skaitiklis) {
  const kelias = require.resolve("../utils/jobErasure");
  const originalus = require.cache[kelias];

  require.cache[kelias] = {
    id: kelias,
    filename: kelias,
    loaded: true,
    exports: {
      eraseJob: async () => {
        if (skaitiklis) skaitiklis.n += 1;
        return { criticalFailure: true, errors: ["storage neprieinamas"] };
      },
    },
  };

  return () => {
    if (originalus) require.cache[kelias] = originalus;
    else delete require.cache[kelias];
  };
}

beforeEach(() => retry._resetForTests());

test("#196 ESKALACIJA: įspėjimas įvyksta NET kai jobStore.update krinta", async (t) => {
  /**
   * Pagrindinė garantija. Be atsarginio skaitiklio kiekvienas sweep'as
   * skaitytų `deletion_attempts = 0`, ir `attempts` visada būtų 1.
   */
  const job = { id: "job-esk", deletion_pending: true, deletion_attempts: 0 };
  const store = perimti({ pending: [job], updateKrinta: true });
  const atstatytiErase = perimtiErase();

  const klaidos = [];
  /**
   * ⚠️ Perimamas `console`, ne `createLogger()` objektas.
   *
   * `createLogger()` grąžina NAUJĄ objektą kiekvienam komponentui, o jo
   * uždarumoje esantis `_emit` rašo per `console.error`. Modulio eksporto
   * pakeitimas jau sukurto logerio nepaveiktų.
   */
  const originalError = console.error;
  console.error = (m) => klaidos.push(String(m));

  t.after(() => {
    store.atstatyti();
    atstatytiErase();
    console.error = originalError;
  });

  /**
   * ⚠️ LAIKAS STUMIAMAS, ne terminas trinamas.
   *
   * Ankstesnė versija darė `delete job.deletion_next_attempt_at` — tai
   * APEIDAVO backoff ir kartu paslėpdavo, kad atsarginis terminas neveikia.
   * Dabar sweep'ai vykdomi realiai praėjus atgalos laikui.
   */
  const tikrasDateNow = Date.now;
  let laikas = tikrasDateNow();
  Date.now = () => laikas;
  t.after(() => {
    Date.now = tikrasDateNow;
  });

  for (let i = 0; i < MAX_ATTEMPTS_BEFORE_ALERT; i += 1) {
    await retry.retryPendingDeletions();
    laikas += 60 * 60 * 1000; // valanda — daugiau nei bet koks backoff
  }

  const eskalacija = klaidos.filter((m) => /RANKINIO ĮSIKIŠIMO/.test(m));
  assert.ok(
    eskalacija.length > 0,
    `po ${MAX_ATTEMPTS_BEFORE_ALERT} sweep'ų eskalacija privalo įvykti; klaidos: ${klaidos.length}`
  );
});

test("#196 MATOMUMAS: nepavykęs būsenos įrašymas patenka į logą", async (t) => {
  /**
   * Gedimas, dėl kurio neįvyksta įspėjimas, pats negali būti tylus.
   */
  const job = { id: "job-log", deletion_pending: true, deletion_attempts: 0 };
  const store = perimti({ pending: [job], updateKrinta: true });
  const atstatytiErase = perimtiErase();

  const klaidos = [];
  /**
   * ⚠️ Perimamas `console`, ne `createLogger()` objektas.
   *
   * `createLogger()` grąžina NAUJĄ objektą kiekvienam komponentui, o jo
   * uždarumoje esantis `_emit` rašo per `console.error`. Modulio eksporto
   * pakeitimas jau sukurto logerio nepaveiktų.
   */
  const originalError = console.error;
  console.error = (m) => klaidos.push(String(m));

  t.after(() => {
    store.atstatyti();
    atstatytiErase();
    console.error = originalError;
  });

  await retry.retryPendingDeletions();

  const apieĮrašymą = klaidos.filter((m) => /Nepavyko išsaugoti/.test(m));
  assert.ok(apieĮrašymą.length > 0, "update() klaida NEGALI būti praryjama");
  assert.match(apieĮrašymą[0], /job-log/, "logas turi nurodyti KURĮ job'ą");
  assert.match(apieĮrašymą[0], /ECONNREFUSED/, "ir kokia klaida");
});

test("#196 BACKOFF: kritus saugyklai pakartojimas ATIDEDAMAS, ne kartojamas", async (t) => {
  /**
   * ⚠️ PAGRINDINĖ GARANTIJA, kurios ankstesnė versija NEĮRODĖ.
   *
   * Kai `jobStore.update()` krinta, `next_attempt_at` neišsaugomas. Žiūrint tik
   * į persistintą lauką, `_isDue()` grąžintų `true` KIEKVIENO sweep'o metu —
   * neveikianti saugykla būtų daužoma be pertraukos būtent per outage'ą.
   *
   * Tikrinamas ELGESYS, ne apskaičiuota reikšmė: ar `eraseJob()` iš viso
   * kviečiamas.
   */
  const job = { id: "job-bo", deletion_pending: true, deletion_attempts: 0 };
  const store = perimti({ pending: [job], updateKrinta: true });
  const skaitiklis = { n: 0 };
  const atstatytiErase = perimtiErase(skaitiklis);

  const originalError = console.error;
  console.error = () => {};

  const tikrasDateNow = Date.now;
  let laikas = tikrasDateNow();
  Date.now = () => laikas;

  t.after(() => {
    store.atstatyti();
    atstatytiErase();
    console.error = originalError;
    Date.now = tikrasDateNow;
  });

  /** 1. Pirmas sweep'as — bandymas įvyksta, įrašymas krinta. */
  await retry.retryPendingDeletions();
  assert.equal(skaitiklis.n, 1, "pirmas bandymas privalo įvykti");

  /** 2. Iškart po jo — backoff dar galioja, tad bandymo NETURI būti. */
  await retry.retryPendingDeletions();
  assert.equal(
    skaitiklis.n,
    1,
    "iškart po nesėkmės pakartojimo NETURI būti - atsarginis terminas galioja"
  );

  /** 3. Praėjus atgalos laikui — bandymas vėl leidžiamas. */
  laikas += 60 * 60 * 1000;
  await retry.retryPendingDeletions();
  assert.equal(skaitiklis.n, 2, "praėjus backoff laikui bandymas atnaujinamas");
});

test("#196 ATSTATYMAS: pavykus įrašymui atsarginis skaitiklis išvalomas", async (t) => {
  /**
   * Atmintis neturi kauptis: kai saugykla atsigauna, autoritetu vėl tampa
   * persistintas laukas.
   */
  const job = { id: "job-clr", deletion_pending: true, deletion_attempts: 0 };
  const store = perimti({ pending: [job], updateKrinta: false });
  const atstatytiErase = perimtiErase();

  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = () => {};
  console.error = () => {};

  t.after(() => {
    store.atstatyti();
    atstatytiErase();
    console.warn = originalWarn;
    console.error = originalError;
  });

  await retry.retryPendingDeletions();

  assert.equal(job.deletion_attempts, 1, "sėkmingas įrašymas persistina skaitiklį");
  assert.ok(job.deletion_next_attempt_at, "ir backoff terminą");
});

/** `releaseAudio` visada krinta; skaičiuojam kvietimus. */
function perimtiReleaseAudio(skaitiklis) {
  const kelias = require.resolve("../utils/audioCleanup");
  const originalus = require.cache[kelias];

  require.cache[kelias] = {
    id: kelias,
    filename: kelias,
    loaded: true,
    exports: {
      releaseAudio: async () => {
        if (skaitiklis) skaitiklis.n += 1;
        return false; // nepavyko
      },
    },
  };

  return () => {
    if (originalus) require.cache[kelias] = originalus;
    else delete require.cache[kelias];
  };
}

test("#196 AUDIO: ta pati garantija galioja audio valymo keliui", async (t) => {
  /**
   * ⚠️ `_bandymųSkaičius()` ir `_išsaugotiBandymą()` naudojami ABIEM keliams,
   * bet pirmoji testų versija tikrino tik ištrynimą (`listPendingAudioCleanups`
   * grąžindavo tuščią aibę). Nemaža pakeisto produkcinio kodo šaka liko be
   * failure-path įrodymo.
   */
  const job = {
    id: "job-audio",
    audio_cleanup_pending: true,
    audio_cleanup_attempts: 0,
    storageKey: "audio/job-audio.wav",
  };
  const store = perimti({ pending: [], audioPending: [job], updateKrinta: true });
  const skaitiklis = { n: 0 };
  const atstatytiAudio = perimtiReleaseAudio(skaitiklis);

  const klaidos = [];
  const originalError = console.error;
  console.error = (m) => klaidos.push(String(m));

  const tikrasDateNow = Date.now;
  let laikas = tikrasDateNow();
  Date.now = () => laikas;

  t.after(() => {
    store.atstatyti();
    atstatytiAudio();
    console.error = originalError;
    Date.now = tikrasDateNow;
  });

  for (let i = 0; i < MAX_ATTEMPTS_BEFORE_ALERT; i += 1) {
    await retry.retryPendingAudioCleanups();
    laikas += 60 * 60 * 1000;
  }

  assert.equal(skaitiklis.n, MAX_ATTEMPTS_BEFORE_ALERT, "kiekvienas sweep'as bando");

  const apieĮrašymą = klaidos.filter((m) => /audio_cleanup_attempts/.test(m));
  assert.ok(apieĮrašymą.length > 0, "įrašymo klaida NEGALI būti praryjama");

  const numeriai = apieĮrašymą
    .map((m) => (/audio_cleanup_attempts=(\d+)/.exec(m) || [])[1])
    .filter(Boolean)
    .map(Number);
  assert.ok(
    numeriai[numeriai.length - 1] >= MAX_ATTEMPTS_BEFORE_ALERT,
    `skaitiklis turi pasiekti ribą net be persistencijos: ${numeriai}`
  );
});

test("#196 AUDIO: be `storageKey` bandymas NESKAIČIUOJAMAS", async (t) => {
  /**
   * Pasenusi vėliava be `storageKey` reiškia, kad trinti nėra ko — jokio
   * bandymo nebuvo. Skaitiklio didinimas čia klaidingai artintų eskalaciją.
   *
   * Testas užrakina norimą semantiką: helperis kviečiamas vėliavai nuimti, bet
   * `audio_cleanup_attempts` į patch'ą NEPATENKA.
   */
  const job = { id: "job-nokey", audio_cleanup_pending: true, audio_cleanup_attempts: 0 };
  const patchai = [];

  /**
   * ⚠️ ANTRAS OVERRIDE PERDUODAMAS `perimti()`, ne uždedamas ant viršaus.
   *
   * Ankstesnė versija darė `originalUpdate = jobStore.update` JAU PO
   * `perimti()`, tad išsaugodavo MOCK'Ą, ne tikrą funkciją. `t.after` tada
   * grąžindavo mock'ą atgal, ir `jobStore.update` liktų perimtas po testo —
   * order-dependent elgesys, kai atsiras kitas testas šiame faile.
   */
  const store = perimti({
    pending: [],
    audioPending: [job],
    updateKrinta: false,
    onUpdate: (patch) => patchai.push(patch),
  });

  t.after(() => store.atstatyti());

  await retry.retryPendingAudioCleanups();

  assert.equal(patchai.length, 1, "vėliava nuimama vienu atnaujinimu");
  assert.equal(patchai[0].audio_cleanup_pending, false);
  assert.equal(
    "audio_cleanup_attempts" in patchai[0],
    false,
    "jokio trynimo nebuvo - bandymas NESKAIČIUOJAMAS"
  );
});

test("#196 IZOLIACIJA: po visų testų `jobStore` NEPALIKTAS perimtas", () => {
  /**
   * Paleidžiama PASKUTINĖ (node:test vykdo iš eilės faile).
   *
   * Nešvarus cleanup neduoda kritimo tame teste, kuris jį sukėlė — jis
   * pasireiškia KITAME, ir tik tam tikra tvarka. Todėl tikrinama eksplicitiškai.
   */
  assert.equal(jobStore.update, TIKRAS_UPDATE, "`update` privalo būti atkurtas");
  assert.equal(jobStore.system, TIKRAS_SYSTEM, "`system` privalo būti atkurtas");
});
