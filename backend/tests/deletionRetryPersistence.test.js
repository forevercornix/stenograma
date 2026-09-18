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
    /** `updateKrinta` gali būti ir funkcija: leidžia kristi TIK vienam jobId. */
    const krinta = typeof updateKrinta === "function" ? updateKrinta(id) : updateKrinta;
    if (krinta) {
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

test("#196 PERSISTENTINIS KELIAS: veikiant saugyklai skaitiklis ir terminas įrašomi", async (t) => {
  /**
   * ⚠️ PAVADINIMAS PATIKSLINTAS (#197 closure), ASSERTION'AI NEPALIESTI.
   *
   * Ankstesnis vardas žadėjo, kad tikrinamas atsarginio skaitiklio IŠVALYMAS -
   * bet testas paleidžiamas su veikiančiu `update`, tad fallback įrašo apskritai
   * nesukuria ir jo išvalymo patikrinti negali. Pats testas dengia realų dalyką:
   * tai VIENINTELIS sėkmingo persistinimo kelio testas, todėl jis lieka.
   *
   * Išvalymą įrodo atskiras testas žemiau (`REKONCILIACIJA`).
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

/* ══════════════════════════════════════════════════════════════════════════
 * #197 CLOSURE: keturios spragos, rastos mutacijų zondais
 *
 * Visos keturios buvo REALIZUOTOS kode ir NEĮRODYTOS testais: kiekvieną
 * elgesį pavyko pašalinti, o visa 1582 testų suitė liko žalia. Pagal #197
 * įrodymo standartą tai spraga, ne įrodyta garantija - egzistavimas nėra
 * įrodymas.
 * ══════════════════════════════════════════════════════════════════════════ */

test("#197 REKONCILIACIJA: pavykęs įrašymas IŠVALO atsarginę būseną", async (t) => {
  /**
   * ⚠️ TIKRINAMA PER ELGESĮ, NE PER VIDINĘ STRUKTŪRĄ.
   *
   * Testas, žiūrintis į privatų `Map`, lūžtų per refaktoringą ir garantijos
   * negintų. Todėl išvalymas matuojamas taip, kaip jį pamatytų sistema: jei
   * atsarginis įrašas liktų, jis PAKELTŲ kito bandymo numerį net tada, kai
   * persistintas skaitiklis jau atstatytas į 0.
   *
   * Neišvalyta būsena yra ne tik nutekėjimas - tai pasenusios retry būsenos
   * šaltinis, dėl kurio eskalacija ateitų per anksti.
   */
  const job = { id: "job-rec", deletion_pending: true, deletion_attempts: 0 };
  const atstatytiErase = perimtiErase();

  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};

  const tikrasDateNow = Date.now;
  let laikas = tikrasDateNow();
  Date.now = () => laikas;

  let store = perimti({ pending: [job], updateKrinta: true });

  t.after(() => {
    store.atstatyti();
    atstatytiErase();
    console.error = originalError;
    console.warn = originalWarn;
    Date.now = tikrasDateNow;
  });

  /** 1. Saugykla neveikia: atsarginis įrašas atsiranda. */
  await retry.retryPendingDeletions();

  /** 2. Saugykla atsigauna; praėjus backoff laikui bandymas persistinamas. */
  store.atstatyti();
  laikas += 60 * 60 * 1000;
  store = perimti({ pending: [job], updateKrinta: false });
  await retry.retryPendingDeletions();

  assert.ok(job.deletion_attempts >= 1, "atsigavus skaitiklis persistinamas");

  /**
   * 3. Persistinta būsena atstatoma į nulį - taip atrodo įrašas po
   *    reconciliacijos ar naujo ciklo. Jei atsarginė būsena būtų likusi
   *    atmintyje, kitas bandymas gautų PAKELTĄ numerį.
   */
  job.deletion_attempts = 0;
  delete job.deletion_next_attempt_at;
  laikas += 60 * 60 * 1000;

  await retry.retryPendingDeletions();

  assert.equal(
    job.deletion_attempts,
    1,
    "atsarginė būsena privalo būti išvalyta - kitaip bandymo numeris pakyla be pagrindo"
  );
});

test("#197 IZOLIACIJA: atsarginė būsena neteršia KITO jobo", async (t) => {
  /**
   * ⚠️ KRYŽMINĖ TARŠA VIENO JOBO TESTUOSE YRA NEMATOMA.
   *
   * Raktas be `jobId` (`${laukas}` vietoj `${jobId}:${laukas}`) praeina visus
   * esamus testus: jie naudoja po vieną jobą. Tada vieno jobo nesėkmė pakeltų
   * kito bandymų numerį ir priartintų svetimą eskalaciją.
   */
  const krintantis = { id: "job-a", deletion_pending: true, deletion_attempts: 0 };
  const sveikas = { id: "job-b", deletion_pending: true, deletion_attempts: 0 };

  const store = perimti({
    pending: [krintantis, sveikas],
    updateKrinta: (id) => id === "job-a",
  });
  const atstatytiErase = perimtiErase();

  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};

  t.after(() => {
    store.atstatyti();
    atstatytiErase();
    console.error = originalError;
    console.warn = originalWarn;
  });

  await retry.retryPendingDeletions();

  assert.equal(
    sveikas.deletion_attempts,
    1,
    "sveiko jobo skaitiklis negali pakilti dėl KITO jobo nesėkmės"
  );
});

test("#197 FORMULĖ: atsarginis terminas skaičiuojamas TA PAČIA formule", async (t) => {
  /**
   * ⚠️ ANTRA NEPRIKLAUSOMA FORMULĖ YRA SPRAGA, NET JEI SKAIČIAI SUTAMPA.
   *
   * Fallback su savo atgalos skaičiavimu praeina visus esamus testus - jie
   * stumia laiką valanda, o tai viršija bet kokį pagrįstą backoff. Trumpesnė
   * fallback atgala reikštų, kad būtent per outage'ą saugykla daužoma tankiau
   * nei numatyta.
   *
   * Riba imama iš AUTORITETINGO `_backoffMs()`, ne perrašoma teste - antraip
   * testas pats taptų trečia formule.
   */
  const { _backoffMs } = require("../utils/deletionRetry");
  const baze = 10 * 60 * 1000; // `DEFAULT_INTERVAL_MS`, kai kintamasis nenustatytas
  const laukiama = _backoffMs(1, baze);

  const job = { id: "job-form", deletion_pending: true, deletion_attempts: 0 };
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

  await retry.retryPendingDeletions();
  assert.equal(skaitiklis.n, 1, "pirmas bandymas įvyksta");

  /** Likus sekundei iki autoritetingos ribos - bandymo dar NĖRA. */
  laikas += laukiama - 1000;
  await retry.retryPendingDeletions();
  assert.equal(
    skaitiklis.n,
    1,
    `atsargos terminas privalo siekti ${laukiama} ms - trumpesnė fallback formulė daužytų saugyklą`
  );

  /** Peržengus ribą - bandymas leidžiamas. */
  laikas += 2000;
  await retry.retryPendingDeletions();
  assert.equal(skaitiklis.n, 2, "peržengus autoritetingą ribą bandymas atnaujinamas");
});

test("#197 LOGAS: persistencijos klaida neneša job duomenų ar viso patch'o", async (t) => {
  /**
   * ⚠️ TEIGIAMA PUSĖ BUVO PADENGTA, NEIGIAMA - NE.
   *
   * Esamas testas tikrina, kad loge YRA `jobId` ir klaidos kodas. Niekas
   * netikrino, ko ten NETURI būti: įdėjus visą `patch` (ar kitą arbitrary
   * payload) visa suitė liko žalia. Retry būsenos patch'as šiandien nėra
   * jautrus, bet logo turinys yra sąmoningas sprendimas, ne atsitiktinumas -
   * kitaip jis tyliai išaugs.
   */
  const job = { id: "job-payload", deletion_pending: true, deletion_attempts: 0 };
  const store = perimti({ pending: [job], updateKrinta: true });
  const atstatytiErase = perimtiErase();

  const klaidos = [];
  const originalError = console.error;
  console.error = (m) => klaidos.push(String(m));

  t.after(() => {
    store.atstatyti();
    atstatytiErase();
    console.error = originalError;
  });

  await retry.retryPendingDeletions();

  const apieĮrašymą = klaidos.filter((m) => /Nepavyko išsaugoti/.test(m));
  assert.ok(apieĮrašymą.length > 0, "įrašymo klaida privalo būti loguojama");

  const tekstas = apieĮrašymą[0];

  assert.match(tekstas, /job-payload/, "koreliacija privalo likti");
  assert.ok(
    !tekstas.includes("deletion_next_attempt_at"),
    "patch'o laukai neturi patekti į logą"
  );
  assert.ok(!tekstas.includes("{"), "serializuoto objekto loge būti negali");
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

test("#183 SWEEPER: `deletion_failed` žyma paliekama operatoriui", async () => {
  /**
   * ⚠️ DVI KARTOJIMO SISTEMOS NESUGYVENA.
   *
   * Šis sweeper'is automatiškai kartodavo tai, ką žymų mašina laiko operatoriaus
   * sprendimu. Jam pavykus, jobas dingdavo, o žyma likdavo `deletion_failed`
   * amžinai - ir be jokio `LIFECYCLE_DELETION` įrašo. Nuo tada, kai barjeras
   * lemia HTTP atsakymą, vartotojas gautų 503 dėl duomenų, kurių seniai nebėra.
   *
   * ⚠️ ĮRODYMAS - `attempted: 0` KARTU su `unresolved: 1`.
   *
   * Vien `attempted: 0` sutaptų su „jobas dar ne laiku" (`deferred`), tad
   * neatskirtų praleidimo nuo atidėjimo. Atskiras skaitiklis yra ir metrika,
   * kurią mato operatorius: tyliai praleistas ištrynimas taptų nematomas.
   */
  const tombstones = require("../utils/deletionTombstones");

  const job = { id: "job-neissprestas", deletion_pending: true, deletion_attempts: 0 };
  const perimta = perimti({ pending: [job] });

  await tombstones.mark(job.id, { reason: "user_request", actorKind: "user" });
  await tombstones.complete(job.id, tombstones.TOMBSTONE_STATUS.FAILED, {
    failureKind: "retryable",
  });

  try {
    const summary = await retry.retryPendingDeletions();

    assert.equal(summary.unresolved, 1, "žymėtas jobas priskaičiuojamas ATSKIRAI");
    assert.equal(summary.attempted, 0, "automatinio kartojimo nėra");
    assert.equal(summary.succeeded, 0);
    assert.equal(summary.deferred, 0, "tai ne atidėjimas - jobas jau laiku");
  } finally {
    perimta.atstatyti();
  }
});

test("#183 SWEEPER: be žymos ir su `deletion_pending` žyma kartojimas VEIKIA", async () => {
  /**
   * Priešinga pusė. Be jos „viskas praleidžiama" praeitų kaip sėkmė, o
   * sweeper'is būtų tyliai išjungtas visiems atvejams - įskaitant tuos, kur
   * žymos nebėra (ją pašalino retencija) arba ji dar `deletion_pending`.
   */
  const tombstones = require("../utils/deletionTombstones");

  const beZymos = { id: "job-be-zymos", deletion_pending: true, deletion_attempts: 0 };
  const suPending = { id: "job-pending", deletion_pending: true, deletion_attempts: 0 };
  const perimta = perimti({ pending: [beZymos, suPending] });

  await tombstones.mark(suPending.id, { reason: "user_request", actorKind: "user" });

  try {
    const summary = await retry.retryPendingDeletions();

    assert.equal(summary.unresolved, 0, "nė vienas neturi `deletion_failed` žymos");
    assert.equal(summary.attempted, 2, "abu bandomi kartoti");
  } finally {
    perimta.atstatyti();
  }
});
