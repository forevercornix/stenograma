const fileStorage = require("../utils/fileStorage");
const { transcribeAudio } = require("../services/transcriptionService");
const { generateProtocol } = require("../services/protocolService");
const jobStore = require("../utils/jobStore");
const { PHASE } = require("../utils/jobPhase");
const { createLogger } = require("../utils/logger");

const log = createLogger("processors");

/**
 * `startPhase` su konflikto POLITIKA (#184, 7.5b).
 *
 * ⚠️ KODĖL PIPELINE NENUTRAUKIAMAS.
 *
 * Versijos konfliktas čia reiškia, kad įrašą tarp skaitymo ir rašymo pakeitė
 * kažkas kitas – dažniausiai persidengiantis vykdymas po stalled recovery.
 * Fazės žyma yra STEBĖJIMO būsena; ji nesaugo rezultato. Rezultatą saugo
 * `finish()`, kuris tokioje situacijoje pats atsisako įsipareigoti. Nutraukus
 * pipeline čia, būtų mainoma tikra transkripcija į fazės kosmetiką.
 *
 * ⚠️ BET TYLA IRGI NETINKA. Iki 7.5b `onPhase` grąžinimas buvo ignoruojamas
 * visiškai (`await onPhase?.(…)` paslaugose), tad pralaimėtas perėjimas
 * nepalikdavo jokio pėdsako. `warn` yra minimumas, iš kurio persidengimą
 * apskritai galima pamatyti logu.
 *
 * ⚠️ AKLO RETRY NĖRA. Perėjimas nekartojamas: laimėtojas jau nustatė kitą fazę,
 * o kartojimas su tuo pačiu snapshot'u duotų tą patį atsakymą.
 */
async function pradetiFaze(jobId, phase, options) {
  const rezultatas = await jobStore.system.startPhase(jobId, phase, options);
  if (rezultatas === jobStore.CONCURRENCY_CONFLICT) {
    log.warn("Fazės perėjimas pralaimėjo versijos konfliktą – pipeline tęsiamas", {
      jobId,
      phase,
      stage: "phase_conflict",
    });
  }
  return rezultatas;
}

/**
 * Job processor'iai - bendras vykdymo kodas inline runner'iui IR BullMQ worker'iams.
 * Kad kodas nesidubliuotų, abu keliai (inline ir queue) naudoja būtent šias funkcijas.
 *
 * SVARBU (#2 storage): transkribavimo processor'ius gauna audio iš BENDRO STORAGE
 * pagal storageKey (ne lokalų /tmp kelią), tad ATSKIRAS worker procesas failą
 * pasiekia. Failas ištrinamas po apdorojimo.
 */

async function transcriptionProcessor(payload, jobId) {
  const {
    storageKey,
    filename,
    mimeType,
    language,
    diarize,
    audioUrl,
    numSpeakers,
    transcriptionProviderOverride,
    diarizationModeOverride,
    meetingId,
  } = payload;

  /**
   * FAZIŲ PRIJUNGIMAS (#154).
   *
   * `restart()` jau nustatė `validating` – tai apima payload'o tikrinimą ir
   * audio gavimą iš saugyklos. Tolesnes fazes deklaruoja servisas per
   * `onPhase`, o čia jos paverčiamos store perėjimais.
   *
   * ⚠️ AWAITED, ne fire-and-forget. Jei perėjimas neįsirašo, servisas TOLESNIO
   * darbo nepradeda: fazei X priklausantis darbas gali prasidėti tik po to, kai
   * fazę X priėmė state machine. Priešingu atveju atominė state machine būtų
   * dekoracija, kurią pipeline gali ignoruoti.
   */
  const onPhase = jobId
    ? (phase, options) => pradetiFaze(jobId, phase, options)
    : undefined;

  // Gauname audio iš bendro storage pagal raktą (veikia ir atskirame worker'yje).
  // SVARBU: failo ČIA NETRINAM. Jei transkripcija krenta ir BullMQ bando retry,
  // kitas bandymas vėl turi rasti audio. Trynimą atlieka worker/inline PO GALUTINIO
  // statuso (sėkmė ar išnaudoti bandymai) - žr. jobRunner._runInline ir workers/index.js.
  const buffer = await fileStorage.get(storageKey);

  // Progreso callback: rašo į jobStore, kad GET /api/transcribe-jobs/:id rodytų %.
  // Veikia tik jei transcription provider'is teikia progresą (SSE streaming) IR jobId
  // yra. Throttle: rašom tik pasikeitus procentui (progresas ateina jau "throttled"
  // iš whisper-server). NETESTUOTA su realiu GPU streaming'u - žr. RUNPOD.md.
  const onProgress = jobId
    ? (p) => {
        const percent = typeof p === "number" ? p : p && p.percent;
        if (percent == null) return;
        // fire-and-forget: progreso rašymas neturi blokuoti/nutraukti transkripcijos
        /**
         * BEST-EFFORT, priešingai nei `onPhase`. Progreso įvykis gali dingti ar
         * būti atmestas (pavėlavęs, kita fazė, regresija) – transkripcijos tai
         * nenutraukia.
         *
         * ⚠️ Perduodama IR fazė: be jos store negali atskirti pavėlavusio
         * įvykio iš ankstesnės fazės (#154).
         */
        Promise.resolve(
          jobStore.system.reportProgress(jobId, {
            phase: PHASE.TRANSCRIBING,
            progress: { current: percent, total: 100 },
          })
        ).catch(() => {});
      }
    : undefined;

  return await transcribeAudio({
    buffer,
    filename,
    mimeType,
    language: language || "lt",
    diarize: diarize === "true" || diarize === true,
    audioUrl,
    numSpeakers: numSpeakers ? parseInt(numSpeakers, 10) : undefined,
    transcriptionProviderOverride,
    diarizationModeOverride,
    meetingId,
    jobId,
    onProgress,
    onPhase,
  });
}

async function protocolProcessor(payload, jobId) {
  /**
   * Protokolo job'as turi TIK `validating → generating_protocol` (#154).
   * `transcribing`, `diarizing` ir `merging` jam state machine yra NELEGALIOS.
   *
   * ⚠️ Perėjimą kviečia SERVISAS, ne šis processor'ius – `generateProtocol()`
   * pradžioje atlieka penkias validacijas (transkripcijos ilgis, dalyviai,
   * tiekėjo ir prompt versijos vardai, LLM fabrikas), kurios semantiškai
   * priklauso `validating` fazei. Perėjus čia, UI rodytų „generuojamas
   * protokolas", kol dar vyksta validacija.
   */
  const onPhase = jobId
    ? (phase, options) => pradetiFaze(jobId, phase, options)
    : undefined;

  // Protokolo generavimas neturi failo - visas payload jau JSON.
  // jobId perduodamas TIK auditui (pseudonimizuotam subjectId), kad
  // DELETE /api/jobs/:id galėtų surasti ir pašalinti susijusius įrašus.
  return generateProtocol({ ...payload, jobId, onPhase });
}

module.exports = { transcriptionProcessor, protocolProcessor };
