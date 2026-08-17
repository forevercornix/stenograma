const { STATUS, JOB_TYPES } = require("./jobStore/common");

/**
 * JOB FAZIŲ IR PROGRESO STATE MACHINE (#154).
 *
 * GRYNA FUNKCIJŲ BIBLIOTEKA. Ji priima sprendimus ir grąžina patch'us, bet
 * NEKVIEČIA store, nerašo į Redis ir nesikreipia į HTTP. Šalutinis poveikis
 * lieka kvietėjui.
 *
 * KODĖL CENTRALIZUOTA. Fazių ir progreso taisyklės kitaip išsibarstytų po
 * processor'ius, providerius, worker'ius ir maršrutus – ir kiekvienas
 * konstruotų savo `jobStore` patch'ą. Tada `status × phase` invariantas
 * galiotų tik ten, kur kas nors jį prisiminė. Writer deklaruoja ĮVYKĮ
 * (`startPhase`, `reportProgress`, `finish`), o ne patch'ą.
 *
 * ⚠️ DU ATSKIRI GRAFAI, NE VIENAS. `queues/register.js` registruoja du
 * nepriklausomus processor'ius, o `generateProtocol()` kviečiamas TIK
 * `protocolProcessor` viduje. Transkripcijos job'as protokolo negeneruoja –
 * bendro kelio nuo `transcribing` iki `generating_protocol` neegzistuoja.
 */

const PHASE = Object.freeze({
  VALIDATING: "validating",
  TRANSCRIBING: "transcribing",
  DIARIZING: "diarizing",
  MERGING: "merging",
  GENERATING_PROTOCOL: "generating_protocol",
});

/**
 * Leistini perėjimai KIEKVIENAM job tipui atskirai.
 *
 * `null` reiškia pradžią (job'as dar `queued`). Terminalūs perėjimai čia
 * neaprašomi – jie legalūs iš BET KURIOS fazės (žr. `finish()`).
 *
 * ⚠️ `merging` susieta su diarizacija: `transcriptionService.js` kviečia
 * `mergeDiarization(segments, turns)`, tad be diarizacijos nėra ko sujungti.
 * Išjungus `DIARIZATION_PROVIDER`, praleidžiamos ABI fazės – todėl
 * `transcribing` turi leistiną kelią ir į `diarizing`, ir tiesiai į pabaigą.
 */
const GRAPHS = Object.freeze({
  [JOB_TYPES.TRANSCRIPTION]: Object.freeze({
    [null]: Object.freeze([PHASE.VALIDATING]),
    [PHASE.VALIDATING]: Object.freeze([PHASE.TRANSCRIBING]),
    [PHASE.TRANSCRIBING]: Object.freeze([PHASE.DIARIZING]),
    [PHASE.DIARIZING]: Object.freeze([PHASE.MERGING]),
    [PHASE.MERGING]: Object.freeze([]),
  }),
  [JOB_TYPES.PROTOCOL]: Object.freeze({
    [null]: Object.freeze([PHASE.VALIDATING]),
    [PHASE.VALIDATING]: Object.freeze([PHASE.GENERATING_PROTOCOL]),
    [PHASE.GENERATING_PROTOCOL]: Object.freeze([]),
  }),
});

/** Kurios fazės apskritai egzistuoja duotam tipui. */
function phasesForType(type) {
  const graph = GRAPHS[type];
  return graph ? Object.keys(graph).filter((k) => k !== "null") : [];
}

class JobPhaseError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "JobPhaseError";
    this.code = code;
  }
}

/**
 * `(type, phase)` PORA – ne tik „šiuo metu nekviečiame".
 *
 * `type=protocol` su `phase=transcribing` yra neleistinas įrašas, ne
 * nepasitaikantis. Be šios patikros helperis būtų techniškai teisingas, o
 * modelis – neteisingas, ir #155 jį persistintų.
 */
function assertPhaseAllowedForType(type, phase) {
  if (phase == null) return;
  if (!GRAPHS[type]) {
    throw new JobPhaseError(`Nežinomas job tipas: ${String(type)}`, "UNKNOWN_JOB_TYPE");
  }
  if (!phasesForType(type).includes(phase)) {
    throw new JobPhaseError(
      `Fazė "${phase}" neleistina tipui "${type}". Leistinos: ${phasesForType(type).join(", ")}.`,
      "PHASE_NOT_ALLOWED_FOR_TYPE"
    );
  }
}

/**
 * Progreso forma (#154, 3 punktas).
 *
 * `{current, total}` yra FAZEI LOKALŪS darbo vienetai. UI jų neinterpretuoja
 * kaip sekundžių ar segmentų – jis skaičiuoja tik santykį. Provideris, duodantis
 * vien procentą, naudoja `{current: 37, total: 100}`.
 */
function assertValidProgress(progress) {
  if (progress == null || typeof progress !== "object") {
    throw new JobPhaseError("progress privalo būti { current, total }.", "INVALID_PROGRESS");
  }
  const { current, total } = progress;
  if (!Number.isFinite(current) || !Number.isFinite(total)) {
    throw new JobPhaseError("progress.current ir progress.total privalo būti baigtiniai skaičiai.", "INVALID_PROGRESS");
  }
  if (total <= 0) {
    throw new JobPhaseError("progress.total privalo būti > 0 – kitaip santykis beprasmis.", "INVALID_PROGRESS");
  }
  if (current < 0 || current > total) {
    throw new JobPhaseError("progress.current privalo tenkinti 0 <= current <= total.", "INVALID_PROGRESS");
  }
}

/**
 * `progressKnown ↔ progress` invariantas (#154, 4 punktas).
 *
 * Būsena `progressKnown=true, progress=null` NELEIDŽIAMA: #155 persistintų
 * dviprasmišką kontraktą, o frontend'as turėtų spėlioti, ką reiškia „progresas
 * žinomas, bet jo nėra".
 */
function assertProgressInvariant({ progressKnown, progress }) {
  if (progressKnown === false && progress !== null) {
    throw new JobPhaseError("progressKnown=false reikalauja progress=null.", "PROGRESS_INVARIANT");
  }
  if (progressKnown === true) assertValidProgress(progress);
}

/**
 * Fazės pradžia – VIENAS atominis patch'as (#154, 9 punktas).
 *
 * Grąžinamas patch'as nustato `phase`, `progress` ir `progressKnown` KARTU.
 * Trys atskiri `update()` kvietimai paliktų langą, kuriame skaitytojas matytų
 * `phase=diarizing, progress=4420/4420` – būtent tą klaidingą būseną, kurią
 * #154 šalina.
 *
 * @param {object} job – dabartinis įrašas (`type`, `phase`)
 * @param {string} nextPhase
 * @param {{progress?: object|null}} [options] – jei nauja fazė progresą teikia
 */
function startPhase(job, nextPhase, options = {}) {
  const type = job.type;
  assertPhaseAllowedForType(type, nextPhase);

  /**
   * STATUS VALIDACIJA (#154, 1 punktas).
   *
   * Be jos helperis NEGALI atskirti `queued + phase=null` nuo
   * `completed + phase=null` – abu atrodo kaip „grafo pradžia", tad terminalų
   * job'ą būtų galima paleisti iš naujo:
   *
   *   startPhase({ status: "completed", phase: null }, "validating")   ← praeitų
   *
   * Taip pat atmetamas `processing + phase=null`: naujas writer'is tokio derinio
   * kurti negali. Legacy įrašams tai READ-compatibility klausimas, ne writer'io
   * kontraktas.
   */
  const status = job.status ?? null;

  if (TERMINAL.includes(status)) {
    throw new JobPhaseError(
      `Terminalaus job'o (${status}) fazės pradėti negalima – jis jau baigtas.`,
      "JOB_ALREADY_TERMINAL"
    );
  }
  if (status === STATUS.QUEUED && job.phase != null) {
    throw new JobPhaseError(
      `queued job'as negali turėti fazės (rasta: ${job.phase}).`,
      "INVALID_STATUS_PHASE"
    );
  }
  if (status === STATUS.PROCESSING && job.phase == null) {
    throw new JobPhaseError(
      "processing job'as be fazės – naujas writer'is tokio derinio kurti negali.",
      "INVALID_STATUS_PHASE"
    );
  }
  if (status !== null && status !== STATUS.QUEUED && status !== STATUS.PROCESSING) {
    throw new JobPhaseError(`Nežinomas statusas: ${String(status)}`, "INVALID_STATUS_PHASE");
  }

  const current = job.phase ?? null;
  const allowed = GRAPHS[type][current === null ? "null" : current];

  if (!allowed) {
    throw new JobPhaseError(
      `Fazė "${current}" nepriklauso tipo "${type}" grafui.`,
      "PHASE_NOT_ALLOWED_FOR_TYPE"
    );
  }
  if (!allowed.includes(nextPhase)) {
    throw new JobPhaseError(
      `Neleistinas perėjimas ${current} → ${nextPhase} tipui "${type}". ` +
        `Leistini: ${allowed.length ? allowed.join(", ") : "(nėra – tik terminalūs)"}.`,
      "ILLEGAL_TRANSITION"
    );
  }

  const hasProgress = Object.prototype.hasOwnProperty.call(options, "progress") && options.progress != null;
  if (hasProgress) assertValidProgress(options.progress);

  return {
    status: STATUS.PROCESSING,
    phase: nextPhase,
    progress: hasProgress ? options.progress : null,
    progressKnown: hasProgress,
  };
}

/**
 * Progreso įvykis (#154, 5–6 punktai).
 *
 * Grąžina patch'ą ARBA `null`, jei įvykį reikia IGNORUOTI. `null` nėra klaida –
 * pavėlavęs ar pasenęs įvykis yra normali BullMQ retry ir replay pasekmė.
 *
 * Atmetama, kai:
 *   – `event.phase` nesutampa su dabartine faze (PAVĖLAVĘS įvykis iš ankstesnės);
 *   – `current` mažesnis nei jau užfiksuotas TOJE PAČIOJE fazėje (monotoniškumas).
 *
 * ⚠️ Monotoniškumas yra `(jobId, phase)` savybė. Pakeitus fazę prasideda nauja
 * progreso epocha – `transcribing 4000/4000 → diarizing progress=null` NĖRA
 * kritimas nuo 100 %.
 *
 * ⚠️ Ši funkcija yra GRYNA. Redis kelyje jos nepakanka: tarp skaitymo ir rašymo
 * fazė gali pasikeisti (TOCTOU). Store sluoksnis privalo patikrą ir rašymą
 * atlikti atominiai – žr. #159 `ownerId` CAS analogą.
 */
function reportProgress(job, event) {
  if (!event || typeof event !== "object") return null;
  if (job.status !== STATUS.PROCESSING) return null;

  // Pavėlavęs įvykis iš ankstesnės fazės.
  if (event.phase !== job.phase) return null;

  assertValidProgress(event.progress);

  const seen = job.progress;

  /**
   * `total` STABILUS FAZĖS EPOCHOJE (#154).
   *
   * Vien `current` monotoniškumo NEPAKANKA: UI rodo `current / total`, tad
   *
   *   50/100 (50 %) → 60/200 (30 %)
   *
   * turėtų didėjantį `current`, bet procentas kristų nuo 50 iki 30. Kadangi
   * `{current, total}` yra FAZEI LOKALŪS darbo vienetai, jų bendras kiekis
   * fazės viduje nesikeičia – besikeičiantis `total` reiškia kontrakto klaidą,
   * ne pažangą.
   *
   * Įvykis atmetamas (grąžinamas `null`), o ne metama klaida: progreso
   * pranešimai ateina fire-and-forget keliu, ir vienas netvarkingas providerio
   * įvykis neturi nutraukti darbo.
   */
  if (seen && Number.isFinite(seen.total) && seen.total !== event.progress.total) return null;

  if (seen && Number.isFinite(seen.current) && event.progress.current < seen.current) return null;

  return { progress: event.progress, progressKnown: true };
}

/**
 * Terminalus perėjimas (#154, 10 punktas).
 *
 * Legalus iš BET KURIOS `processing` fazės. Vienu patch'u išvalo fazės būseną –
 * kitaip liktų `status=failed, phase=transcribing, progress=3900/4400`.
 *
 * ⚠️ Klaidos ir atšaukimo keliai PRIVALO eiti čia, o ne konstruoti neapdorotus
 * `jobStore` patch'us. Kitaip invariantas galiotų normaliame sraute, bet būtų
 * pažeidžiamas būtent klaidos metu – ten, kur diagnostika svarbiausia.
 */
const TERMINAL = Object.freeze([STATUS.COMPLETED, STATUS.FAILED, STATUS.CANCELLED]);

function finish(job, status, extra = {}) {
  if (!TERMINAL.includes(status)) {
    throw new JobPhaseError(
      `finish() priima tik terminalų statusą: ${TERMINAL.join(", ")}. Gauta: ${String(status)}.`,
      "NOT_TERMINAL"
    );
  }

  /**
   * IŠ KOKIŲ BŪSENŲ galima baigti (#154, 10 punktas).
   *
   *   processing → completed | failed | cancelled   (visos trys)
   *   queued     → failed | cancelled               (NE completed)
   *
   * `queued → failed` yra REALUS kelias: `routes/transcribeJobs.js` pažymi
   * job'ą `failed`, kai `enqueue` nepavyksta – darbas niekada neprasidėjo.
   * `queued → cancelled` – vartotojas atšaukia prieš pradžią.
   *
   * `queued → completed` neturi atsirasti niekada: darbas, kuris nebuvo
   * vykdomas, negali būti sėkmingai baigtas. Be šios patikros tokia būsena
   * atsirastų tyliai.
   */
  const from = job && job.status !== undefined ? job.status : null;

  if (TERMINAL.includes(from)) {
    throw new JobPhaseError(
      `Job'as jau terminalus (${from}) – pakartotinis finish() neleidžiamas.`,
      "JOB_ALREADY_TERMINAL"
    );
  }
  if (from === STATUS.QUEUED && status === STATUS.COMPLETED) {
    throw new JobPhaseError(
      "queued → completed neleidžiamas: nevykdytas darbas negali būti baigtas sėkmingai.",
      "ILLEGAL_TERMINAL_TRANSITION"
    );
  }

  return { ...extra, status, phase: null, progress: null, progressKnown: false };
}

/**
 * DARBO (PER)PALEIDIMAS – grąžina job'ą į grafo pradžią.
 *
 * KODĖL ATSKIRA OPERACIJA. BullMQ retry po nepavykusio bandymo paleidžia
 * processor'ių iš naujo, o job'as tuo metu gali būti bet kurioje fazėje
 * (`processing/transcribing`, jei worker'is krito vykdymo metu). Grįžimas
 * `transcribing → validating` grafe NELEGALUS, ir teisingai – tai nėra
 * normalus pažangos perėjimas.
 *
 * Perpaleidimas yra kita operacija: darbas pradedamas iš naujo, tad fazė ir
 * progresas resetinami. Modeliuoti tai kaip įprastą perėjimą reikštų atverti
 * grafą atgaliniams šuoliams apskritai.
 *
 * Legalus iš `queued` ir `processing`; iš terminalaus – ne.
 */
function restart(job) {
  const status = job.status ?? null;

  if (TERMINAL.includes(status)) {
    throw new JobPhaseError(
      `Terminalaus job'o (${status}) perpaleisti negalima.`,
      "JOB_ALREADY_TERMINAL"
    );
  }
  if (status !== null && status !== STATUS.QUEUED && status !== STATUS.PROCESSING) {
    throw new JobPhaseError(`Nežinomas statusas: ${String(status)}`, "INVALID_STATUS_PHASE");
  }

  assertPhaseAllowedForType(job.type, PHASE.VALIDATING);

  return {
    status: STATUS.PROCESSING,
    phase: PHASE.VALIDATING,
    progress: null,
    progressKnown: false,
  };
}

/**
 * PILNA pradinė būsena.
 *
 * Įtraukiamas ir `status`, kad kvietėjas gautų būseną, atitinkančią #154
 * kontraktą, o ne fragmentą, kurį reikia papildyti rankomis. Be `status`
 * `startPhase()` negalėtų atskirti pradžios nuo terminalaus job'o.
 */
function initialState() {
  return { status: STATUS.QUEUED, phase: null, progress: null, progressKnown: false };
}

/**
 * `GRAPHS` SĄMONINGAI NEEKSPORTUOJAMAS.
 *
 * Viešas API yra `phasesForType()` ir perėjimų funkcijos. Atidavus patį grafą
 * kvietėjas galėtų juo remtis arba (nors ir užšaldytas) kurti lygiagrečią
 * logiką – ir state machine nustotų būti vienintelis autoritetas.
 */
module.exports = {
  PHASE,
  TERMINAL,
  JobPhaseError,
  phasesForType,
  assertPhaseAllowedForType,
  assertValidProgress,
  assertProgressInvariant,
  startPhase,
  restart,
  reportProgress,
  finish,
  initialState,
};
