const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const {
  PHASE,
  TERMINAL,
  JobPhaseError,
  phasesForType,
  assertPhaseAllowedForType,
  assertValidProgress,
  assertProgressInvariant,
  startPhase,
  reportProgress,
  finish,
  initialState,
} = require("../utils/jobPhase");
const { STATUS, JOB_TYPES } = require("../utils/jobStore/common");

const T = JOB_TYPES.TRANSCRIPTION;
const P = JOB_TYPES.PROTOCOL;

/* ══════════════════════════════════════════════════════════════════════════
 * DU ATSKIRI GRAFAI
 * ══════════════════════════════════════════════════════════════════════════ */

test("#154 GRAFAI: transcription ir protocol turi SKIRTINGAS fazes", () => {
  /**
   * `queues/register.js` registruoja du nepriklausomus processor'ius, o
   * `generateProtocol()` kviečiamas TIK `protocolProcessor` viduje.
   * Transkripcijos job'as protokolo negeneruoja – bendro kelio nuo
   * `transcribing` iki `generating_protocol` neegzistuoja.
   */
  assert.deepEqual(phasesForType(T), ["validating", "transcribing", "diarizing", "merging"]);
  assert.deepEqual(phasesForType(P), ["validating", "generating_protocol"]);
});

test("#154 GRAFAI: nelegalios (type, phase) poros atmetamos", () => {
  /**
   * Tai INVARIANTAS, ne „šiuo metu nekviečiame". Be jo helperis būtų techniškai
   * teisingas, o modelis neteisingas – ir #155 jį persistintų.
   */
  const nelegalios = [
    [T, PHASE.GENERATING_PROTOCOL],
    [P, PHASE.TRANSCRIBING],
    [P, PHASE.DIARIZING],
    [P, PHASE.MERGING],
  ];

  for (const [type, phase] of nelegalios) {
    assert.throws(
      () => assertPhaseAllowedForType(type, phase),
      (e) => e instanceof JobPhaseError && e.code === "PHASE_NOT_ALLOWED_FOR_TYPE",
      `${type} + ${phase} turi būti atmesta`
    );
  }
});

test("#154 GRAFAI: nežinomas job tipas meta klaidą", () => {
  assert.throws(
    () => assertPhaseAllowedForType("isgalvotas", PHASE.VALIDATING),
    (e) => e.code === "UNKNOWN_JOB_TYPE"
  );
});

/* ══════════════════════════════════════════════════════════════════════════
 * PERĖJIMAI
 * ══════════════════════════════════════════════════════════════════════════ */

test("#154 SRAUTAS: transcription SU diarizacija", () => {
  let job = { type: T, ...initialState() };
  const kelias = [PHASE.VALIDATING, PHASE.TRANSCRIBING, PHASE.DIARIZING, PHASE.MERGING];

  for (const faze of kelias) {
    const patch = startPhase(job, faze);
    assert.equal(patch.phase, faze);
    assert.equal(patch.status, STATUS.PROCESSING);
    job = { ...job, ...patch };
  }

  const galas = finish(job, STATUS.COMPLETED);
  assert.equal(galas.phase, null);
});

test("#154 SRAUTAS: transcription BE diarizacijos baigiasi po transcribing", () => {
  /**
   * `DIARIZATION_PROVIDER=none` – praleidžiamos ABI fazės (`diarizing` ir
   * `merging`), nes `mergeDiarization()` neturi ko sujungti.
   */
  let job = { type: T, ...initialState() };
  job = { ...job, ...startPhase(job, PHASE.VALIDATING) };
  job = { ...job, ...startPhase(job, PHASE.TRANSCRIBING) };

  const galas = finish(job, STATUS.COMPLETED);
  assert.equal(galas.status, STATUS.COMPLETED);
  assert.equal(galas.phase, null);
});

test("#154 SRAUTAS: protocol job'as", () => {
  let job = { type: P, ...initialState() };
  job = { ...job, ...startPhase(job, PHASE.VALIDATING) };
  job = { ...job, ...startPhase(job, PHASE.GENERATING_PROTOCOL) };

  assert.equal(job.phase, PHASE.GENERATING_PROTOCOL);
  assert.equal(finish(job, STATUS.COMPLETED).phase, null);
});

test("#154 PERĖJIMAI: neleistinas perėjimas grafo viduje atmetamas", () => {
  const job = { type: T, phase: PHASE.VALIDATING };

  // validating → diarizing (praleista transcribing)
  assert.throws(
    () => startPhase(job, PHASE.DIARIZING),
    (e) => e.code === "ILLEGAL_TRANSITION"
  );

  // atgal
  assert.throws(
    () => startPhase({ type: T, phase: PHASE.MERGING }, PHASE.TRANSCRIBING),
    (e) => e.code === "ILLEGAL_TRANSITION"
  );
});

/* ══════════════════════════════════════════════════════════════════════════
 * ATOMIŠKUMAS IR PROGRESO INVARIANTAI
 * ══════════════════════════════════════════════════════════════════════════ */

test("#154 ATOMIŠKUMAS: fazės perėjimas vienu patch'u resetina progresą", () => {
  /**
   * Trys atskiri `update()` paliktų langą, kuriame skaitytojas matytų
   * `phase=diarizing, progress=4420/4420, progressKnown=true` – būtent tą
   * klaidingą būseną, kurią #154 šalina.
   */
  const job = {
    type: T,
    phase: PHASE.TRANSCRIBING,
    progress: { current: 4420, total: 4420 },
    progressKnown: true,
  };

  const patch = startPhase(job, PHASE.DIARIZING);

  assert.deepEqual(Object.keys(patch).sort(), ["phase", "progress", "progressKnown", "status"]);
  assert.equal(patch.progress, null, "progresas resetinamas TAME PAČIAME patch'e");
  assert.equal(patch.progressKnown, false);
});

test("#154 ATOMIŠKUMAS: fazė su žinomu progresu gauna VALIDŽIĄ pradinę būseną", () => {
  const job = { type: T, phase: PHASE.VALIDATING };
  const patch = startPhase(job, PHASE.TRANSCRIBING, { progress: { current: 0, total: 4420 } });

  assert.equal(patch.progressKnown, true);
  assert.deepEqual(patch.progress, { current: 0, total: 4420 });
});

test("#154 INVARIANTAS: progressKnown=true su progress=null NELEIDŽIAMA", () => {
  assert.throws(
    () => assertProgressInvariant({ progressKnown: true, progress: null }),
    (e) => e.code === "INVALID_PROGRESS"
  );
  assert.throws(
    () => assertProgressInvariant({ progressKnown: false, progress: { current: 1, total: 2 } }),
    (e) => e.code === "PROGRESS_INVARIANT"
  );
  assert.doesNotThrow(() => assertProgressInvariant({ progressKnown: false, progress: null }));
  assert.doesNotThrow(() =>
    assertProgressInvariant({ progressKnown: true, progress: { current: 1, total: 2 } })
  );
});

test("#154 INVARIANTAI: deklaracija ir VYKDYMAS neišsiskiria", () => {
  /**
   * `PROGRESS_INVARIANTS` eksportuojamas dokumentacijos sargui. Bet deklaracija
   * be patikros tik PERKELTŲ problemą: sąrašas galėtų pasenti taip pat, kaip
   * anksčiau pasendavo dokumentas.
   *
   * Todėl kiekvienam invariantui parenkama reikšmė, kuri PAŽEIDŽIA būtent jį,
   * ir tikrinama, kad `assertValidProgress()` ją atmestų. Jei deklaracija liktų,
   * o kodas nustotų tikrinti, testas kris.
   */
  const { PROGRESS_INVARIANTS } = require("../utils/jobPhase");

  /** Reikšmė, pažeidžianti tik nurodytą invariantą. */
  const pažeidimai = {
    "Number.isFinite(current)": { current: NaN, total: 10 },
    "Number.isFinite(total)": { current: 1, total: Infinity },
    "total > 0": { current: 0, total: 0 },
    "current >= 0": { current: -1, total: 10 },
    "current <= total": { current: 11, total: 10 },
  };

  assert.equal(
    PROGRESS_INVARIANTS.length,
    Object.keys(pažeidimai).length,
    "kiekvienas deklaruotas invariantas turi turėti pažeidimo pavyzdį"
  );

  for (const { raiska, tikrinti } of PROGRESS_INVARIANTS) {
    const bloga = pažeidimai[raiska];
    assert.ok(bloga, `nėra pažeidimo pavyzdžio invariantui "${raiska}"`);

    // Deklaruotas predikatas šią reikšmę atmeta...
    assert.equal(tikrinti(bloga), false, `predikatas "${raiska}" turėjo atmesti`);

    // ...ir realus kodas taip pat.
    assert.throws(
      () => assertValidProgress(bloga),
      JobPhaseError,
      `assertValidProgress() nebetikrina "${raiska}"`
    );
  }

  /**
   * ⚠️ RIBINĖS REIKŠMĖS, ne tik po vieną pavyzdį.
   *
   * Vienos pažeidžiančios reikšmės predikatui nepakanka: pakeitus runtime
   * patikrą į `current < -0.5`, `-1` vis tiek būtų atmesta, `5` priimta, ir
   * testas praeitų – o `-0.3` būtų priimta, nors eksportuotas kontraktas ją
   * draudžia.
   *
   * Todėl tikrinamos reikšmės, esančios TIK PER PLAUKĄ už ribos.
   */
  const ribiniai = [
    { p: { current: -0.3, total: 10 }, kodel: "current tik truputį < 0" },
    { p: { current: -Number.EPSILON, total: 10 }, kodel: "current mažiausiai < 0" },
    { p: { current: 10.1, total: 10 }, kodel: "current tik truputį > total" },
    { p: { current: 1, total: -0.5 }, kodel: "total tik truputį < 0" },
  ];

  for (const { p, kodel } of ribiniai) {
    const pažeisti = PROGRESS_INVARIANTS.filter(({ tikrinti }) => !tikrinti(p));
    assert.ok(pažeisti.length > 0, `prielaida: ${kodel} pažeidžia kontraktą`);

    assert.throws(
      () => assertValidProgress(p),
      JobPhaseError,
      `${kodel}: kontraktas draudžia, bet assertValidProgress() priėmė`
    );
  }

  // Galiojanti reikšmė tenkina VISUS deklaruotus invariantus.
  const gera = { current: 5, total: 10 };
  for (const { raiska, tikrinti } of PROGRESS_INVARIANTS) {
    assert.equal(tikrinti(gera), true, `galiojanti reikšmė pažeidžia "${raiska}"`);
  }
  assert.doesNotThrow(() => assertValidProgress(gera));
});

test("#154 PROGRESAS: validacija – baigtiniai, total>0, 0<=current<=total", () => {
  const blogi = [
    null,
    {},
    { current: 1 },
    { current: NaN, total: 10 },
    { current: 1, total: Infinity },
    { current: 1, total: 0 },
    { current: -1, total: 10 },
    { current: 11, total: 10 },
  ];
  for (const p of blogi) {
    assert.throws(() => assertValidProgress(p), JobPhaseError, `turėjo kristi: ${JSON.stringify(p)}`);
  }

  // Procentinis šaltinis ir sekundžių šaltinis – abu validūs.
  assert.doesNotThrow(() => assertValidProgress({ current: 37, total: 100 }));
  assert.doesNotThrow(() => assertValidProgress({ current: 1872, total: 4420 }));
});

/* ══════════════════════════════════════════════════════════════════════════
 * MONOTONIŠKUMAS IR PAVĖLAVĘ ĮVYKIAI
 * ══════════════════════════════════════════════════════════════════════════ */

test("#154 MONOTONIŠKUMAS: mažėjantis progresas TOJE PAČIOJE fazėje ignoruojamas", () => {
  let job = {
    type: T,
    status: STATUS.PROCESSING,
    phase: PHASE.TRANSCRIBING,
    progress: null,
    progressKnown: false,
  };
  const matomi = [];

  for (const current of [1000, 2000, 1500, 3000]) {
    const patch = reportProgress(job, {
      phase: PHASE.TRANSCRIBING,
      progress: { current, total: 4420 },
    });
    if (patch) {
      job = { ...job, ...patch };
      matomi.push(patch.progress.current);
    }
  }

  assert.deepEqual(matomi, [1000, 2000, 3000], "1500 po 2000 turi būti ignoruotas");
});

test("#154 LATE EVENT: progresas iš ANKSTESNĖS fazės atmetamas", () => {
  /**
   * ESMINIS concurrency invariantas.
   *
   *   transcribing progress=4000
   *   → phase=diarizing
   *   → pavėlavęs transcribing progress=4200   ← NEGALI pakeisti būsenos
   */
  const job = {
    type: T,
    status: STATUS.PROCESSING,
    phase: PHASE.DIARIZING,
    progress: null,
    progressKnown: false,
  };

  const patch = reportProgress(job, {
    phase: PHASE.TRANSCRIBING,
    progress: { current: 4200, total: 4420 },
  });

  assert.equal(patch, null, "pavėlavęs įvykis grąžina null, o ne patch'ą");
});

test("#154 LATE EVENT: fazės pasikeitimas pradeda NAUJĄ progreso epochą", () => {
  /**
   * `transcribing 4000/4000 → diarizing progress=null` NĖRA kritimas nuo 100 %.
   * Tai nauja fazė su atskira semantika, tad monotoniškumas iš senos fazės
   * naujajai netaikomas.
   */
  let job = {
    type: T,
    status: STATUS.PROCESSING,
    phase: PHASE.TRANSCRIBING,
    progress: { current: 4000, total: 4000 },
    progressKnown: true,
  };

  job = { ...job, ...startPhase(job, PHASE.DIARIZING) };
  assert.equal(job.progress, null);

  // Naujoje fazėje mažas skaičius PRAEINA – jis nelyginamas su senos fazės 4000.
  const patch = reportProgress(job, { phase: PHASE.DIARIZING, progress: { current: 5, total: 100 } });
  assert.ok(patch, "nauja epocha – 5 nėra regresija");
  assert.equal(patch.progress.current, 5);
});

test("#154 LATE EVENT: ne-processing job'as progreso nepriima", () => {
  const job = { type: T, status: STATUS.COMPLETED, phase: null };
  assert.equal(reportProgress(job, { phase: PHASE.TRANSCRIBING, progress: { current: 1, total: 2 } }), null);
});

/* ══════════════════════════════════════════════════════════════════════════
 * TERMINALŪS PERĖJIMAI
 * ══════════════════════════════════════════════════════════════════════════ */

test("#154 TERMINALŪS: iš KIEKVIENOS fazės į kiekvieną terminalų statusą", () => {
  /**
   * Klaidos ir atšaukimo keliai privalo eiti per helperį. Kitaip invariantas
   * galiotų normaliame sraute, bet būtų pažeidžiamas būtent klaidos metu.
   */
  for (const type of [T, P]) {
    for (const phase of phasesForType(type)) {
      for (const status of TERMINAL) {
        const patch = finish(
          { type, status: STATUS.PROCESSING, phase, progress: { current: 3900, total: 4400 }, progressKnown: true },
          status
        );

        assert.equal(patch.status, status);
        assert.equal(patch.phase, null, `${type}/${phase} → ${status}: fazė turi būti išvalyta`);
        assert.equal(patch.progress, null);
        assert.equal(patch.progressKnown, false);
      }
    }
  }
});

test("#154 TERMINALŪS: papildomi laukai išsaugomi, bet invarianto nepakeičia", () => {
  // `status` PRIVALOMAS: `finish()` fail-closed'ina nežinomam šaltiniui.
  const patch = finish({ type: T, status: STATUS.PROCESSING, phase: PHASE.TRANSCRIBING }, STATUS.FAILED, {
    error: "kažkas nepavyko",
    error_code: "internal_error",
  });

  assert.equal(patch.error_code, "internal_error");
  assert.equal(patch.phase, null, "extra laukai negali perrašyti invarianto");
});

test("#154 TERMINALŪS: ne-terminalus statusas atmetamas", () => {
  assert.throws(
    () => finish({ type: T, status: STATUS.PROCESSING, phase: PHASE.TRANSCRIBING }, STATUS.PROCESSING),
    (e) => e.code === "NOT_TERMINAL"
  );
});

/* ══════════════════════════════════════════════════════════════════════════
 * GRYNUMAS
 * ══════════════════════════════════════════════════════════════════════════ */

test("#154 GRYNUMAS: helperis nekeičia įvesties ir neturi vidinės būsenos", () => {
  const job = Object.freeze({
    type: T,
    status: STATUS.PROCESSING,
    phase: PHASE.TRANSCRIBING,
    progress: Object.freeze({ current: 100, total: 200 }),
    progressKnown: true,
  });

  const a = reportProgress(job, { phase: PHASE.TRANSCRIBING, progress: { current: 150, total: 200 } });
  const b = reportProgress(job, { phase: PHASE.TRANSCRIBING, progress: { current: 150, total: 200 } });

  assert.deepEqual(a, b, "tas pats įėjimas – tas pats rezultatas");
  assert.equal(job.progress.current, 100, "įvestis nepakeista");
});

/* ══════════════════════════════════════════════════════════════════════════
 * STATUS × PHASE INVARIANTAS
 * ══════════════════════════════════════════════════════════════════════════ */

test("#154 STATUS: terminalaus job'o fazės pradėti NEGALIMA", () => {
  /**
   * Be `status` patikros helperis negali atskirti `queued + phase=null` nuo
   * `completed + phase=null` – abu atrodo kaip grafo pradžia. Tad terminalų
   * job'ą būtų galima „paleisti iš naujo", ir jis grįžtų į `processing`.
   */
  for (const status of TERMINAL) {
    assert.throws(
      () => startPhase({ type: T, status, phase: null }, PHASE.VALIDATING),
      (e) => e.code === "JOB_ALREADY_TERMINAL",
      `${status} → validating turi būti atmesta`
    );
  }
});

test("#154 STATUS: queued su faze ir processing be fazės atmetami", () => {
  assert.throws(
    () => startPhase({ type: T, status: STATUS.QUEUED, phase: PHASE.VALIDATING }, PHASE.TRANSCRIBING),
    (e) => e.code === "INVALID_STATUS_PHASE",
    "queued negali turėti fazės"
  );

  assert.throws(
    () => startPhase({ type: T, status: STATUS.PROCESSING, phase: null }, PHASE.TRANSCRIBING),
    (e) => e.code === "INVALID_STATUS_PHASE",
    "naujas writer'is negali kurti processing + phase=null"
  );
});

test("#154 STATUS: initialState() grąžina PILNĄ kontraktą su status", () => {
  assert.deepEqual(initialState(), {
    status: STATUS.QUEUED,
    phase: null,
    progress: null,
    progressKnown: false,
  });
});

test("#154 TERMINALŪS: queued → completed NELEIDŽIAMAS", () => {
  /**
   * `queued → failed` yra realus kelias: `routes/transcribeJobs.js` pažymi
   * job'ą `failed`, kai `enqueue` nepavyksta. `queued → cancelled` – vartotojas
   * atšaukia prieš pradžią.
   *
   * Bet nevykdytas darbas negali būti baigtas SĖKMINGAI.
   */
  const queued = { type: T, status: STATUS.QUEUED, phase: null };

  assert.throws(
    () => finish(queued, STATUS.COMPLETED),
    (e) => e.code === "ILLEGAL_TERMINAL_TRANSITION"
  );

  assert.doesNotThrow(() => finish(queued, STATUS.FAILED), "enqueue nepavyko – legalu");
  assert.doesNotThrow(() => finish(queued, STATUS.CANCELLED), "atšaukta prieš pradžią – legalu");
});

test("#154 TERMINALŪS: pakartotinis finish() atmetamas", () => {
  assert.throws(
    () => finish({ type: T, status: STATUS.COMPLETED, phase: null }, STATUS.FAILED),
    (e) => e.code === "JOB_ALREADY_TERMINAL"
  );
});

/* ══════════════════════════════════════════════════════════════════════════
 * STABILUS `total` FAZĖS EPOCHOJE
 * ══════════════════════════════════════════════════════════════════════════ */

test("#154 TOTAL: pasikeitęs total toje pačioje fazėje atmetamas", () => {
  /**
   * Vien `current` monotoniškumo nepakanka: UI rodo `current / total`, tad
   *
   *   50/100 (50 %) → 60/200 (30 %)
   *
   * turėtų didėjantį `current`, bet procentas KRISTŲ nuo 50 iki 30.
   */
  const job = {
    type: T,
    status: STATUS.PROCESSING,
    phase: PHASE.TRANSCRIBING,
    progress: { current: 50, total: 100 },
    progressKnown: true,
  };

  assert.equal(
    reportProgress(job, { phase: PHASE.TRANSCRIBING, progress: { current: 60, total: 200 } }),
    null,
    "kitas total – kontrakto klaida, ne pažanga"
  );

  const geras = reportProgress(job, {
    phase: PHASE.TRANSCRIBING,
    progress: { current: 60, total: 100 },
  });
  assert.ok(geras, "tas pats total ir didesnis current – priimama");
  assert.equal(geras.progress.current, 60);
});

test("#154 TOTAL: NAUJOJE fazėje total gali būti kitas", () => {
  /**
   * Stabilumas galioja EPOCHOJE, ne visam job'ui. Diarizacija matuojama kitais
   * vienetais nei transkripcija – tai ne klaida.
   */
  let job = {
    type: T,
    status: STATUS.PROCESSING,
    phase: PHASE.TRANSCRIBING,
    progress: { current: 100, total: 100 },
    progressKnown: true,
  };

  job = { ...job, ...startPhase(job, PHASE.DIARIZING) };

  const patch = reportProgress(job, {
    phase: PHASE.DIARIZING,
    progress: { current: 3, total: 42 },
  });
  assert.ok(patch, "nauja epocha – kitas total leistinas");
  assert.equal(patch.progress.total, 42);
});

/* ══════════════════════════════════════════════════════════════════════════
 * GRAFO NEKINTAMUMAS
 * ══════════════════════════════════════════════════════════════════════════ */

test("#154 GRAFAS: neeksportuojamas ir nemodifikuojamas iš išorės", () => {
  /**
   * `Object.freeze()` yra sekliai, tad anksčiau perėjimų masyvus buvo galima
   * papildyti runtime (`GRAPHS.transcription.transcribing.push(...)`) ir
   * pakeisti state machine. Dabar masyvai užšaldyti, o pats grafas viešai
   * neeksportuojamas – vienintelis autoritetas yra šio modulio funkcijos.
   */
  const jobPhase = require("../utils/jobPhase");
  assert.equal(jobPhase.GRAPHS, undefined, "grafas neturi būti viešas");

  // Vienintelis kelias sužinoti fazes – per funkciją, kuri grąžina naują masyvą.
  const a = phasesForType(T);
  a.push("isgalvota");
  assert.equal(phasesForType(T).includes("isgalvota"), false, "grąžinamas masyvas nekeičia grafo");
});

test("#154 TERMINALŪS: nežinomas šaltinio statusas atmetamas (fail-closed)", () => {
  /**
   * Atkurtas legacy įrašas arba būsimos schemos versija gali turėti `status`,
   * kurio šis kodas neatpažįsta. Ankstesnė versija tikrino tik jau terminalius
   * ir `queued → completed`, tad `null` ar nežinoma reikšmė TAPDAVO
   * `completed`, apeidama draudimą.
   *
   * Spėti terminalaus perėjimo atveju negalima: nežinomas statusas reiškia,
   * kad nežinome, ar perėjimas legalus.
   */
  for (const nezinomas of [null, undefined, "isgalvotas", "", 0]) {
    for (const status of TERMINAL) {
      assert.throws(
        () => finish({ type: T, status: nezinomas }, status),
        (e) => e.code === "UNKNOWN_SOURCE_STATUS",
        `${JSON.stringify(nezinomas)} → ${status} turi būti atmestas`
      );
    }
  }

  // Žinomi šaltiniai su KONSISTENTIŠKA būsena veikia.
  assert.doesNotThrow(() =>
    finish({ type: T, status: STATUS.PROCESSING, phase: PHASE.VALIDATING }, STATUS.COMPLETED)
  );
  assert.doesNotThrow(() => finish({ type: T, status: STATUS.QUEUED, phase: null }, STATUS.FAILED));
});

test("#154 RESTART: nežinomas šaltinio statusas atmetamas (fail-closed)", () => {
  /**
   * `finish()` jau fail-closed'ino, bet `restart()` ne: `job.status ?? null`
   * paversdavo trūkstamą lauką `null` ir LEISDAVO operaciją. Atkurtas legacy
   * įrašas be `status` tyliai virsdavo `processing/validating`, nors
   * dokumentas teigia, kad perpaleidimas legalus tik iš `queued` ir
   * `processing`.
   */
  const { restart } = require("../utils/jobPhase");

  for (const nezinomas of [null, undefined, "isgalvotas", "", 0]) {
    assert.throws(
      () => restart({ type: T, status: nezinomas }),
      (e) => e.code === "UNKNOWN_SOURCE_STATUS",
      `${JSON.stringify(nezinomas)} turi būti atmestas`
    );
  }

  assert.doesNotThrow(() => restart({ type: T, status: STATUS.QUEUED }));
  assert.doesNotThrow(() => restart({ type: T, status: STATUS.PROCESSING, phase: PHASE.MERGING }));
});

test("#154 TERMINALŪS: tikrinama PILNA šaltinio būsena, ne tik status", () => {
  /**
   * Statuso allowlist viena nepakanka: įrašas su atpažintu `processing`, bet
   * nežinomu tipu, trūkstama faze ar SVETIMO grafo faze būdavo priimamas, ir
   * `finish()` jį paversdavo iš pažiūros galiojančiu `completed`.
   *
   * `restoreService` validuoja įrašus tik pagal ID, tad nepalaikoma persistinta
   * fazės ir tipo būsena gali pasiekti šią funkciją.
   */
  const blogi = [
    [{ type: P, status: STATUS.PROCESSING, phase: PHASE.TRANSCRIBING }, "PHASE_NOT_ALLOWED_FOR_TYPE"],
    [{ type: T, status: STATUS.PROCESSING, phase: PHASE.GENERATING_PROTOCOL }, "PHASE_NOT_ALLOWED_FOR_TYPE"],
    [{ type: "isgalvotas", status: STATUS.PROCESSING, phase: PHASE.VALIDATING }, "UNKNOWN_JOB_TYPE"],
    [{ type: T, status: STATUS.PROCESSING, phase: null }, "INVALID_STATUS_PHASE"],
    [{ type: T, status: STATUS.QUEUED, phase: PHASE.VALIDATING }, "INVALID_STATUS_PHASE"],
  ];

  for (const [job, kodas] of blogi) {
    for (const status of TERMINAL) {
      assert.throws(
        () => finish(job, status),
        (e) => e.code === kodas,
        `${job.type}/${job.status}/${job.phase} → ${status}: laukta ${kodas}`
      );
    }
  }

  // Konsistentiškos būsenos praeina.
  assert.doesNotThrow(() =>
    finish({ type: T, status: STATUS.PROCESSING, phase: PHASE.MERGING }, STATUS.COMPLETED)
  );
  assert.doesNotThrow(() => finish({ type: T, status: STATUS.QUEUED, phase: null }, STATUS.FAILED));
});
