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

/**
 * Legalūs perėjimai kaip BRIAUNŲ sąrašas.
 *
 * `[from, to]`, kur `from === null` reiškia grafo pradžią.
 *
 * KODĖL ATSKIRAS NUO `phasesForType()`. Fazių AIBĖ nepasako, kokia tvarka jos
 * leidžiamos: `validating → diarizing → transcribing → merging` turi tas pačias
 * fazes kaip teisingas kelias, bet state machine jį atmeta. Dokumentacijos
 * sargas, lyginantis tik aibes, tokio nukrypimo nepastebėtų.
 *
 * Grąžinamas naujas masyvas – grafas lieka nepasiekiamas iš išorės.
 */
function transitionsForType(type) {
  const graph = GRAPHS[type];
  if (!graph) return [];

  const briaunos = [];
  for (const [from, toList] of Object.entries(graph)) {
    for (const to of toList) briaunos.push([from === "null" ? null : from, to]);
  }
  return briaunos;
}

/** Kurios fazės apskritai egzistuoja duotam tipui. */
function phasesForType(type) {
  const graph = GRAPHS[type];
  return graph ? Object.keys(graph).filter((k) => k !== "null") : [];
}

/**
 * ĮRAŠO KONSISTENCIJOS PATIKRA – vienas šaltinis visiems įėjimams.
 *
 * ⚠️ KODĖL BENDRA FUNKCIJA. Anksčiau `startPhase()`, `finish()` ir `restart()`
 * turėjo po dalinę tos pačios patikros kopiją, ir kiekviena peržiūra rasdavo
 * trūkstamą gabalą KITOJE funkcijoje:
 *
 *   `finish()`   – nežinomas statusas, tada `(type, phase)`, tada tipas `queued` šakoje;
 *   `restart()`  – nežinomas statusas;
 *   `startPhase()` – `status × phase` derinys.
 *
 * Rezultatas: `restart()` priimdavo įrašus, kuriuos abu kiti atmesdavo –
 * `queued + phase=transcribing` ir `protocol + phase=transcribing`. Atkurtas
 * įrašas su svetimo grafo faze per perpaleidimą tapdavo „švarus".
 *
 * Klausimas yra vienas: **ar šis įrašas nuoseklus?** Todėl ir atsakymas vienas.
 *
 * ⚠️ GRIEŽTUMAS PRIKLAUSO NUO TO, AR IŠVESTIS PRIKLAUSO NUO ŠALTINIO.
 *
 * Tai ne stiliaus pasirinkimas, o iš funkcijų prigimties išplaukiantis skirtumas:
 *
 *   `startPhase()`  – išvestis PRIKLAUSO nuo šaltinio (grafo briauna nuo
 *                     dabartinės fazės), tad šaltinis privalo būti galiojantis;
 *   `restart()`     – išvestis visada `processing/validating`, priklauso tik
 *                     nuo TIPO (fazė turi egzistuoti jo grafe);
 *   `finish()`      – išvestis visada `{status, phase:null, progress:null}`,
 *                     NEPRIKLAUSO nuo šaltinio VISAI.
 *
 * Todėl `finish()` šaltinio validacija neturi apsauginės vertės – ji negali
 * sukurti nekonsistentiškos būsenos, kad ir kas būtų įraše. Ji tik kuria
 * gedimo režimus.
 *
 * ⚠️ TAI IŠTAISO REALŲ DEFEKTĄ. `finish()` kviečiamas KLAIDOS APDOROJIME
 * (`jobRunner.js:291`). Sugadintam įrašui jis mesdavo, pirminė providerio
 * klaida dingdavo, o job'as likdavo `processing` AMŽINAI – blogiau nei būsena,
 * nuo kurios sargas saugojo.
 *
 * Principas: **terminalus perėjimas negali nepavykti dėl būsenos, iš kurios
 * bando išeiti.** Kitaip nebelieka kelio iš jokios sugadintos būsenos.
 *
 * ⚠️ LEGACY ĮRAŠAI. `processing + phase=null` (iš prieš #154) yra realybė
 * atkurtose kopijose. `finish()` juos priima savaime (šaltinio netikrina), tad
 * užstrigęs job'as visada turi kelią į terminalią būseną. `restart()` juos
 * atmeta – jo išvestis remiasi grafu, ir be žinomos dabartinės fazės
 * atstatymas nėra apibrėžtas; tokiam įrašui kelias yra `finish()`.
 *
 * @param {object} job
 * @param {{leistiniStatusai: string[], tikrintiSaltiniBusena?: boolean}} options
 */
function assertConsistentJobRecord(job, { leistiniStatusai, tikrintiSaltiniBusena = true }) {
  const status = job && job.status !== undefined ? job.status : null;

  if (TERMINAL.includes(status)) {
    throw new JobPhaseError(
      `Job'as jau terminalus (${status}).`,
      "JOB_ALREADY_TERMINAL"
    );
  }

  if (!leistiniStatusai.includes(status)) {
    throw new JobPhaseError(
      `Nežinomas arba neleistinas šaltinio statusas "${String(status)}". ` +
        `Leistini: ${leistiniStatusai.join(", ")}.`,
      "UNKNOWN_SOURCE_STATUS"
    );
  }

  /**
   * ŠALTINIO BŪSENOS PATIKRA – praleidžiama, kai išvestis nuo jos nepriklauso.
   *
   * `finish()` ją praleidžia visiškai: jo išvestis vienoda bet kokiam šaltiniui,
   * tad nėra ko apsaugoti, o metimas paverstų sugadintą job'ą neišsprendžiamu.
   */
  if (!tikrintiSaltiniBusena) return status;

  /** Tipas: reikalingas, kai išvestis remiasi grafu. */
  if (!GRAPHS[job.type]) {
    throw new JobPhaseError(`Nežinomas job tipas: ${String(job.type)}`, "UNKNOWN_JOB_TYPE");
  }

  /** `status × phase` invariantas (#154, 1 punktas). */
  if (status === STATUS.PROCESSING) {
    if (job.phase == null) {
      throw new JobPhaseError(
        "processing job'as be fazės – nekonsistentiška būsena.",
        "INVALID_STATUS_PHASE"
      );
    }
    assertPhaseAllowedForType(job.type, job.phase);
  } else if (job.phase != null) {
    throw new JobPhaseError(
      `"${status}" job'as neturi turėti fazės (rasta: ${job.phase}).`,
      "INVALID_STATUS_PHASE"
    );
  }

  return status;
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
/**
 * Progreso invariantai MAŠININIU BŪDU SKAITOMA forma.
 *
 * KODĖL EKSPORTUOJAMA. Dokumentacijos sargas turi tikrinti, ar
 * `docs/job-lifecycle.md` mini visas galiojančias sąlygas. Pirmoji versija tai
 * darė parsindama `assertValidProgress()` ŠALTINĮ regex'u – tad priklausė nuo
 * sintaksės, ne nuo kontrakto: daugiaeilis `if (`, sąlygos iškėlimas į helperį
 * ar `&&` sujungimas būtų sulaužę parserį nepakeitę elgesio.
 *
 * Čia deklaruojamas KONTRAKTAS. `assertValidProgress()` jį vykdo, o testai
 * tikrina ir tai, kad abu neišsiskirtų.
 */
const PROGRESS_INVARIANTS = Object.freeze([
  Object.freeze({
    raiska: "Number.isFinite(current)",
    tikrinti: (p) => Number.isFinite(p.current),
    zinute: "progress.current privalo būti baigtinis skaičius.",
  }),
  Object.freeze({
    raiska: "Number.isFinite(total)",
    tikrinti: (p) => Number.isFinite(p.total),
    zinute: "progress.total privalo būti baigtinis skaičius.",
  }),
  Object.freeze({
    raiska: "total > 0",
    tikrinti: (p) => p.total > 0,
    zinute: "progress.total privalo būti > 0 – kitaip santykis beprasmis.",
  }),
  Object.freeze({
    raiska: "current >= 0",
    tikrinti: (p) => p.current >= 0,
    zinute: "progress.current privalo būti >= 0.",
  }),
  Object.freeze({
    raiska: "current <= total",
    tikrinti: (p) => p.current <= p.total,
    zinute: "progress.current privalo būti <= progress.total.",
  }),
]);

function assertValidProgress(progress) {
  if (progress == null || typeof progress !== "object") {
    throw new JobPhaseError("progress privalo būti { current, total }.", "INVALID_PROGRESS");
  }

  /**
   * ⚠️ VYKDOMI EKSPORTUOTI PREDIKATAI, ne jų kopija.
   *
   * Ankstesnė versija `PROGRESS_INVARIANTS` deklaravo, o čia tas pačias sąlygas
   * įgyvendino ANTRĄ kartą `if` sakiniais. Tai atkūrė būtent tą deklaracijos ir
   * vykdymo nuokrypį, kurį eksportas turėjo pašalinti: pakeitus runtime patikrą
   * į `current < -0.5`, sinchronizacijos testas vis tiek praeitų (jis ima po
   * VIENĄ pažeidžiančią reikšmę predikatui – `-1` atmetama, `5` priimama), o
   * `-0.3` būtų priimta, nors eksportuotas kontraktas ją draudžia.
   *
   * Dabar deklaracija YRA vykdymas – nuokrypis neįmanomas iš principo.
   */
  for (const { tikrinti, zinute } of PROGRESS_INVARIANTS) {
    if (!tikrinti(progress)) throw new JobPhaseError(zinute, "INVALID_PROGRESS");
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
  /**
   * Įrašo konsistencija – bendra patikra (žr. `assertConsistentJobRecord`).
   * Anksčiau čia buvo dalinė jos kopija.
   */
  const status = assertConsistentJobRecord(job, {
    leistiniStatusai: [STATUS.QUEUED, STATUS.PROCESSING],
  });

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

  /**
   * ⚠️ ĮRAŠO KONSISTENCIJA – ta pati patikra, bet be metimo.
   *
   * Anksčiau ši funkcija buvo KETVIRTAS įėjimas su sava daline patikra, tad
   * progresas būdavo rašomas ir į sugadintą įrašą (`protocol` su
   * `phase=transcribing`) – blogos būsenos įtvirtinimas, o ne ištaisymas.
   *
   * Skirtingai nei kiti trys, čia NEMETAMA: progreso kelias yra
   * fire-and-forget, ir viena bloga būsena neturi nutraukti darbo. Grąžinamas
   * `null` reiškia „įvykis atmestas" – tas pats, ką jau daro pavėlavęs įvykis.
   */
  try {
    assertConsistentJobRecord(job, { leistiniStatusai: [STATUS.PROCESSING] });
  } catch {
    return null;
  }

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
  /**
   * ⚠️ TA PATI patikra kaip `startPhase()` ir `restart()`.
   *
   * Anksčiau ši funkcija turėjo šešis nuoseklius patikrinimus, sukauptus per
   * penkis peržiūros raundus, o `restart()` – tik dalį jų.
   */
  const from = assertConsistentJobRecord(job, {
    leistiniStatusai: [STATUS.QUEUED, STATUS.PROCESSING],
    /**
     * Išvestis nepriklauso nuo šaltinio, tad jo validacija tik kurtų gedimo
     * režimus. Terminalus perėjimas negali nepavykti dėl būsenos, iš kurios
     * bando išeiti – kitaip sugadintas job'as tampa neišsprendžiamas.
     */
    tikrintiSaltiniBusena: false,
  });

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
  /**
   * ⚠️ ANKSČIAU ČIA BUVO SILPNIAUSIA PATIKRA.
   *
   * Tikrintas tik statusas, tad praeidavo `queued + phase=transcribing` ir
   * `protocol + phase=transcribing` – įrašai, kuriuos `finish()` ir
   * `startPhase()` atmesdavo. Atkurtas įrašas su svetimo grafo faze per
   * perpaleidimą tapdavo „švarus".
   */
  assertConsistentJobRecord(job, {
    // Išvestis (`validating`) remiasi TIPO grafu, tad šaltinis tikrinamas.
    leistiniStatusai: [STATUS.QUEUED, STATUS.PROCESSING],
  });

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
  transitionsForType,
  assertPhaseAllowedForType,
  assertValidProgress,
  assertProgressInvariant,
  PROGRESS_INVARIANTS,
  startPhase,
  restart,
  reportProgress,
  finish,
  initialState,
};
