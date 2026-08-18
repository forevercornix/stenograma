const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { transcribeAudio } = require("../services/transcriptionService");
const { PHASE } = require("../utils/jobPhase");
const { fakeWavBuffer } = require("./helpers/fakeAudio");

/**
 * #154, 4 žingsnis: FAZĖS REALIAME SRAUTE.
 *
 * Ankstesni testai įrodė state machine ir store. Šie įrodo, kad pipeline ją
 * REALIAI kviečia – ir kad `onPhase` yra blokuojantis, o `onProgress` – ne.
 */

function mockProviders({ diarization = false } = {}) {
  process.env.TRANSCRIPTION_PROVIDER = "mock";
  process.env.DIARIZATION_PROVIDER = diarization ? "mock" : "none";
}

test("#154 SRAUTAS: transkripcija be diarizacijos deklaruoja TIK transcribing", async () => {
  mockProviders({ diarization: false });
  const fazes = [];

  await transcribeAudio({
    buffer: fakeWavBuffer(),
    filename: "testas.wav",
    jobId: "job-1",
    onPhase: async (phase) => fazes.push(phase),
  });

  assert.deepEqual(fazes, [PHASE.TRANSCRIBING], "diarizing ir merging praleidžiamos");
});

test("#154 SRAUTAS: su diarizacija fazės eina teisinga tvarka", async () => {
  mockProviders({ diarization: true });
  const fazes = [];

  await transcribeAudio({
    buffer: fakeWavBuffer(),
    filename: "testas.wav",
    jobId: "job-2",
    diarize: true,
    onPhase: async (phase) => fazes.push(phase),
  });

  assert.deepEqual(
    fazes,
    [PHASE.TRANSCRIBING, PHASE.DIARIZING, PHASE.MERGING],
    "merging seka PO diarizacijos – jis sujungia jos rezultatą"
  );
});

test("#154 BLOKUOJANTIS: fazės klaida SUSTABDO realų diarizacijos darbą", async () => {
  /**
   * ESMINIS invariantas: fazei X priklausantis darbas gali prasidėti TIK po to,
   * kai fazę X priėmė state machine.
   *
   * ⚠️ PIRMOJI ŠIO TESTO VERSIJA NIEKO NEĮRODĖ. Ji šnipinėjo
   * `providers/diarization`.`getDiarizationProvider`, bet
   * `transcriptionService` jį DESTRUKTŪRIZUOJA modulio viršuje – lokalus
   * reference'as nepasikeičia, ir šnipas niekada nesuveikia. Mutacija
   * („perėjimą perkelti PO providerio paėmimo") praeidavo.
   *
   * Dabar keičiamas pats REGISTRY įrašas, o tikrinamas REALUS šalutinis
   * poveikis: ar `diarize()` buvo iškviestas. Tai stipresnis invariantas nei
   * providerio paėmimas – ne tik objektas nepaimtas, bet darbas neprasidėjo.
   */
  mockProviders({ diarization: true });

  const registry = require("../providers/diarization").REGISTRY;
  const originalus = registry.mock;
  let diarizeKviesta = false;

  class SpyDiarizationProvider {
    constructor(...args) {
      this.inner = new originalus(...args);
      this.name = "mock";
    }
    async diarize(...args) {
      diarizeKviesta = true;
      return this.inner.diarize(...args);
    }
  }
  registry.mock = SpyDiarizationProvider;

  try {
    await assert.rejects(() =>
      transcribeAudio({
        buffer: fakeWavBuffer(),
        filename: "testas.wav",
        jobId: "job-3",
        diarize: true,
        onPhase: async (phase) => {
          if (phase === PHASE.DIARIZING) throw new Error("perėjimas neįsirašė");
        },
      })
    );

    assert.equal(diarizeKviesta, false, "diarizacijos DARBAS neturi prasidėti");
  } finally {
    registry.mock = originalus;
  }
});

test("#154 BLOKUOJANTIS: kai perėjimas PAVYKSTA, diarizacija realiai vyksta", async () => {
  /**
   * Priešinga pusė – kad ankstesnis testas neįrodinėtų vien to, jog
   * diarizacija apskritai nevyksta (pvz. dėl netinkamos konfigūracijos).
   */
  mockProviders({ diarization: true });

  const registry = require("../providers/diarization").REGISTRY;
  const originalus = registry.mock;
  let diarizeKviesta = false;

  class SpyDiarizationProvider {
    constructor(...args) {
      this.inner = new originalus(...args);
      this.name = "mock";
    }
    async diarize(...args) {
      diarizeKviesta = true;
      return this.inner.diarize(...args);
    }
  }
  registry.mock = SpyDiarizationProvider;

  try {
    await transcribeAudio({
      buffer: fakeWavBuffer(),
      filename: "testas.wav",
      jobId: "job-3b",
      diarize: true,
      onPhase: async () => {},
    });

    assert.equal(diarizeKviesta, true, "prielaida: su veikiančiu onPhase diarizacija vyksta");
  } finally {
    registry.mock = originalus;
  }
});

test("#154 BEST-EFFORT: progreso klaida darbo NENUTRAUKIA", async () => {
  /**
   * `onProgress` ir `onPhase` semantiškai NELYGIAVERČIAI. Progreso įvykis gali
   * dingti – rezultatas nuo to nenukenčia.
   */
  mockProviders({ diarization: false });

  const rezultatas = await transcribeAudio({
    buffer: fakeWavBuffer(),
    filename: "testas.wav",
    jobId: "job-4",
    onPhase: async () => {},
    onProgress: () => {
      throw new Error("progreso rašymas nepavyko");
    },
  });

  assert.ok(rezultatas.text, "transkripcija baigta nepaisant progreso klaidos");
});

test("#154 SRAUTAS: be jobId fazės neprivalomos (sinchroninis /api/transcribe)", async () => {
  /**
   * Sinchroninis kelias job'o neturi, tad `onPhase` neperduodamas. Servisas
   * turi veikti be jo – `?.()` grandinė.
   */
  mockProviders({ diarization: false });

  const rezultatas = await transcribeAudio({
    buffer: fakeWavBuffer(),
    filename: "testas.wav",
  });

  assert.ok(rezultatas.text);
});

test("#154 KLAIDA: fazės pažeidimas gauna SAVO kodą, ne internal_error", () => {
  /**
   * Nelegalus perėjimas produkcijoje reiškia state corruption arba
   * programavimo klaidą – ne laikiną tiekėjo gedimą. Be atskiros
   * klasifikatoriaus šakos tai virstų `internal_error` ir taptų neatskiriama
   * nuo bet kokios kitos vidinės klaidos, nors reikalauja kitokio tyrimo.
   */
  const { _classifyError } = require("../queues/jobRunner");
  const { JobPhaseError } = require("../utils/jobPhase");

  const kodai = [
    "ILLEGAL_TRANSITION",
    "PHASE_NOT_ALLOWED_FOR_TYPE",
    "JOB_ALREADY_TERMINAL",
    "INVALID_STATUS_PHASE",
  ];

  for (const code of kodai) {
    const { errorCode } = _classifyError(new JobPhaseError("testinė žinutė", code), "job");
    assert.equal(errorCode, code, `${code} turi išlikti, ne tapti internal_error`);
  }
});

test("#154 KLAIDA: fazės pranešimuose NĖRA vidinės informacijos", () => {
  /**
   * `_classifyError()` grąžina `JobPhaseError.message` NESANITIZUOTĄ – kitaip
   * nei `internal_error` šaka, kuri eina per `sanitizeServerError()`. Tai
   * sąmoninga: fazių pavadinimai operatoriui reikalingi.
   *
   * ⚠️ BET KLASIFIKATORIUS TO NEUŽTIKRINA – jis pasitiki `JobPhaseError`.
   * Todėl garantija užrakinama ČIA: tikrinami VISI realūs pranešimai, ne
   * dirbtinis tekstas. Jei kas nors į pranešimą įdės kelią, raktą ar
   * transkripcijos fragmentą, testas kris.
   */
  const jobPhase = require("../utils/jobPhase");
  const { _classifyError } = require("../queues/jobRunner");

  /**
   * Kvietimai, kurie realiai meta `JobPhaseError`.
   *
   * ⚠️ SĄRAŠAS RANKINIS. Atsiradus naujam metimo keliui jis čia automatiškai
   * nepateks, ir testas apie tai nepraneš. Išsamumo garantijos nėra — yra tik
   * dabartinių kelių padengimas. Pridedant naują `JobPhaseError` metimą,
   * pridėkite ir eilutę čia.
   */
  const metantys = [
    () => jobPhase.startPhase({ type: "protocol", status: "queued", phase: null }, "transcribing"),
    () => jobPhase.startPhase({ type: "transcription", status: "completed", phase: null }, "validating"),
    () => jobPhase.startPhase({ type: "transcription", status: "processing", phase: "merging" }, "transcribing"),
    () => jobPhase.startPhase({ type: "transcription", status: "queued", phase: "validating" }, "transcribing"),
    () => jobPhase.assertValidProgress({ current: 5, total: 0 }),
    () => jobPhase.assertValidProgress({ current: 11, total: 10 }),
    () => jobPhase.assertProgressInvariant({ progressKnown: false, progress: { current: 1, total: 2 } }),
    () => jobPhase.finish({ type: "transcription", status: "queued" }, "completed"),
    () => jobPhase.finish({ type: "transcription", status: "completed" }, "failed"),
    () => jobPhase.restart({ type: "transcription", status: "cancelled" }),
  ];

  /** Ženklai, kad į pranešimą pateko vidinė informacija. */
  const draudžiama = [
    /\/(?:home|tmp|var|usr|data)\//,   // failų sistemos keliai
    /[A-Za-z]:\\/,                     // Windows keliai
    /sk-[A-Za-z0-9]/,                  // API raktai
    /node_modules/,
    /at [A-Za-z_$][\w$]*\s*\(/,         // stack trace fragmentai
    /\bpassword\b|\bsecret\b|\btoken\b/i,
  ];

  let tikrinta = 0;
  for (const fn of metantys) {
    let err;
    try {
      fn();
      assert.fail("prielaida: kvietimas turėjo mesti JobPhaseError");
    } catch (e) {
      err = e;
    }
    assert.equal(err.name, "JobPhaseError", "prielaida: tai fazės klaida");

    const { message } = _classifyError(err, "job");
    for (const šablonas of draudžiama) {
      assert.equal(
        šablonas.test(message),
        false,
        `pranešime rasta vidinė informacija (${šablonas}): ${message}`
      );
    }
    tikrinta += 1;
  }

  assert.equal(tikrinta, metantys.length, "visi IŠVARDYTI keliai patikrinti");
});

/* ══════════════════════════════════════════════════════════════════════════
 * PROCESSOR → STORE: tikras progreso kelias
 * ══════════════════════════════════════════════════════════════════════════ */

test("#154 PROCESSOR: progreso įvykis pasiekia store su FAZE ir {current,total}", async (t) => {
  /**
   * ⚠️ ANKSTESNI TESTAI ŠIO KELIO NEDENGĖ. Jie kviečia `transcribeAudio()`
   * tiesiogiai ir taip apeina `transcriptionProcessor()`, kuriame gyvena visas
   * naujas adapteris:
   *
   *   provider percent  →  { phase, progress: { current, total } }
   *
   * Be šio testo mutacija `phase: TRANSCRIBING → DIARIZING` liktų nepastebėta,
   * o būtent šis adapteris ištaiso #153 metu rastą backend/frontend formos
   * neatitikimą (backend rašė skaičių, frontend laukė objekto).
   *
   * Tikrinama GALUTINĖ STORE BŪSENA, ne mock kvietimo argumentai.
   */
  const jobStore = require("../utils/jobStore");
  const fileStorage = require("../utils/fileStorage");
  const { REGISTRY } = require("../providers/transcription");
  const { OWNER_KIND } = require("../utils/jobStore/common");
  const { registerTestProvider } = require("../utils/providerGovernance");

  /**
   * Tiekėjų valdysena (#22.2) reikalauja įrašo KIEKVIENAM provideriui – kitaip
   * fabrika jį atmeta dar prieš kvietimą. `registerTestProvider()` grąžina
   * atstatymo funkciją, kurią BŪTINA prijungti prie `t.after` (žr. #154
   * `redactionEnforcement` pamoką: be jos valdysena nutekėtų į kitus testus).
   */
  const restoreGovernance = registerTestProvider("transcription", "progreso-testas", {
    approval: "not_required",
  });

  REGISTRY["progreso-testas"] = class {
    constructor() {
      this.name = "progreso-testas";
    }
    async transcribe(buffer, options) {
      // Provideris teikia PROCENTĄ – kaip realus whisper-server SSE.
      await options.onProgress?.({ percent: 42 });
      return { text: "labas", segments: [], language: "lt" };
    }
  };

  t.after(async () => {
    delete REGISTRY["progreso-testas"];
    restoreGovernance();
    await jobStore._resetForTests();
  });

  process.env.TRANSCRIPTION_PROVIDER = "progreso-testas";
  process.env.DIARIZATION_PROVIDER = "none";
  await jobStore.init();

  const job = await jobStore.create({
    type: jobStore.JOB_TYPES.TRANSCRIPTION,
    ownerKind: OWNER_KIND.UNOWNED,
    ownerId: null,
  });

  // `validating` – kaip tai daro jobRunner/worker prieš processor'ių.
  await jobStore.system.restart(job.id);

  const storageKey = await fileStorage.put(fakeWavBuffer(), { ext: ".wav" });
  const { transcriptionProcessor } = require("../queues/processors");

  await transcriptionProcessor({ storageKey, filename: "testas.wav" }, job.id);

  const po = await jobStore.system.get(job.id);

  assert.equal(po.phase, PHASE.TRANSCRIBING, "fazė nustatyta per onPhase");
  assert.deepEqual(
    po.progress,
    { current: 42, total: 100 },
    "procentas paverstas {current,total} forma, kurios laukia frontend'as"
  );
  assert.equal(po.progressKnown, true);
});

test("#154 PROCESSOR: protokolo job'as pereina į generating_protocol", async (t) => {
  const jobStore = require("../utils/jobStore");
  const { OWNER_KIND } = require("../utils/jobStore/common");

  t.after(async () => {
    await jobStore._resetForTests();
  });

  process.env.LLM_PROVIDER = "mock";
  await jobStore.init();

  const job = await jobStore.create({
    type: jobStore.JOB_TYPES.PROTOCOL,
    ownerKind: OWNER_KIND.UNOWNED,
    ownerId: null,
  });
  await jobStore.system.restart(job.id);

  const { protocolProcessor } = require("../queues/processors");
  await protocolProcessor({ transcript: "Jonas: Aptariame biudzeta." }, job.id);

  const po = await jobStore.system.get(job.id);
  assert.equal(po.phase, PHASE.GENERATING_PROTOCOL);
});

/* ══════════════════════════════════════════════════════════════════════════
 * PROCESSOR → STORE: tikras progreso kelias
 * ══════════════════════════════════════════════════════════════════════════ */

test("#154 PROTOKOLAS: fazė pradedama TIK po validacijos", async () => {
  /**
   * `generateProtocol()` pradžioje atlieka penkias patikras (transkripcijos
   * ilgis, dalyvių formatas, tiekėjo ir prompt versijos vardai, LLM fabrikas).
   * Jos semantiškai priklauso `validating` fazei.
   *
   * Perėjus į `generating_protocol` PRIEŠ jas, UI rodytų „generuojamas
   * protokolas", kol dar vyksta validacija, o 400 klaida ateitų iš fazės,
   * kuri niekada neprasidėjo.
   */
  const { generateProtocol } = require("../services/protocolService");
  const fazes = [];

  // Per trumpa transkripcija – validacija turi kristi PRIEŠ fazės perėjimą.
  await assert.rejects(() =>
    generateProtocol({
      transcript: "trumpa",
      onPhase: async (phase) => fazes.push(phase),
    })
  );

  assert.deepEqual(fazes, [], "validacijos klaida NETURI palikti fazės perėjimo");
});

test("#154 PROTOKOLAS: praėjus validacijai fazė pradedama", async () => {
  process.env.LLM_PROVIDER = "mock";
  const { generateProtocol } = require("../services/protocolService");
  const fazes = [];

  await generateProtocol({
    transcript: "Jonas: Pradedame posėdį. Aptariame biudžetą ir terminus.",
    onPhase: async (phase) => fazes.push(phase),
  });

  assert.deepEqual(fazes, [PHASE.GENERATING_PROTOCOL], "tik viena fazė, po validacijos");
});
