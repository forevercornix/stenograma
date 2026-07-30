/**
 * TIEKĖJŲ PRIVATUMO MATRICA (GDPR issue #7).
 *
 * Vienas duomenų šaltinis atsakymui į klausimą "ar šis tiekėjas išsiunčia mano
 * duomenis iš mašinos, ir kokius". Naudojama trijose vietose:
 *
 *   1) utils/startupChecks.js - įspėjimas paleidžiant, kai pasirinktas išorinis tiekėjas;
 *   2) GET /api/health - diagnostikoje (be paslapčių);
 *   3) tests/providerPrivacy.test.js - testas KRENTA, jei registre atsiranda naujas
 *      tiekėjas, neaprašytas čia arba README lentelėje. Taip matrica negali pasenti.
 *
 * SĄMONINGAI NEteigiama, kad kuris nors išorinis tiekėjas yra "GDPR compliant" -
 * tai priklauso nuo jūsų sutarties su tiekėju, pasirinkto regiono ir subtiekėjų,
 * ne nuo šio kodo.
 */

const LOCAL = "local";
const EXTERNAL = "external";
const DEPENDS = "depends";

/** Duomenų kategorijos, kurios gali išeiti iš mašinos. */
const DATA = {
  AUDIO: "audio",
  TRANSCRIPT: "transcript",
  NONE: "none",
};

const TRANSCRIPTION = {
  mock: {
    processing: LOCAL,
    dataSent: DATA.NONE,
    vendor: null,
    notes: "Fiksuotas pavyzdinis atsakymas. Įrašas net nenuskaitomas.",
  },
  "faster-whisper-embedded": {
    processing: LOCAL,
    dataSent: DATA.NONE,
    vendor: null,
    notes: "Python subprocesas toje pačioje mašinoje. Modelis atsisiunčiamas vieną kartą.",
  },
  "faster-whisper-server": {
    processing: LOCAL,
    dataSent: DATA.NONE,
    vendor: null,
    notes: "Atskiras HTTP servisas; laikykite tame pačiame tinkle/hoste.",
  },
  "faster-whisper": {
    processing: LOCAL,
    dataSent: DATA.NONE,
    vendor: null,
    notes: "Alias'as faster-whisper-server (atgalinis suderinamumas).",
  },
  whisper: {
    processing: EXTERNAL,
    dataSent: DATA.AUDIO,
    vendor: "OpenAI",
    notes: "Visas garso failas įkeliamas į OpenAI API.",
  },
  azure: {
    processing: EXTERNAL,
    dataSent: DATA.AUDIO,
    vendor: "Microsoft Azure",
    notes: "Regionas priklauso nuo AZURE_SPEECH_REGION.",
  },
  google: {
    processing: EXTERNAL,
    dataSent: DATA.AUDIO,
    vendor: "Google Cloud",
    notes: "Regionas ir duomenų rezidencija priklauso nuo projekto konfigūracijos.",
  },
  deepgram: {
    processing: EXTERNAL,
    dataSent: DATA.AUDIO,
    vendor: "Deepgram",
    notes: "Garsas siunčiamas į Deepgram API.",
  },
};

const DIARIZATION = {
  none: {
    processing: LOCAL,
    dataSent: DATA.NONE,
    vendor: null,
    notes: "Diarizacija neatliekama.",
  },
  inline: {
    processing: DEPENDS,
    dataSent: DATA.NONE,
    vendor: null,
    notes:
      "Atskiro kvietimo nėra - naudojama tai, ką grąžino TRANSCRIPTION_PROVIDER. " +
      "Privatumo poveikis TOKS PAT kaip pasirinkto transkribavimo tiekėjo.",
  },
  mock: {
    processing: LOCAL,
    dataSent: DATA.NONE,
    vendor: null,
    notes: "Deterministiniai intervalai testams/demo.",
  },
  pyannote: {
    processing: LOCAL,
    dataSent: DATA.NONE,
    vendor: null,
    notes: "Lokalus FastAPI servisas; modelis gated (HUGGINGFACE_TOKEN).",
  },
  "pyannote-cloud": {
    processing: EXTERNAL,
    dataSent: DATA.AUDIO,
    vendor: "pyannote.ai",
    notes: "Garsas siunčiamas į pyannote.ai API.",
  },
  assemblyai: {
    processing: EXTERNAL,
    dataSent: DATA.AUDIO,
    vendor: "AssemblyAI",
    notes: "Garsas siunčiamas į AssemblyAI API.",
  },
};

const LLM = {
  mock: {
    processing: LOCAL,
    dataSent: DATA.NONE,
    vendor: null,
    notes: "Regex heuristikos vietoje modelio. Transkripcija neišeina iš proceso.",
  },
  claude: {
    processing: EXTERNAL,
    dataSent: DATA.TRANSCRIPT,
    vendor: "Anthropic",
    notes: "Siunčiamas transkripcijos TEKSTAS (ne garsas) protokolui.",
  },
  gpt: {
    processing: EXTERNAL,
    dataSent: DATA.TRANSCRIPT,
    vendor: "OpenAI",
    notes: "Siunčiamas transkripcijos TEKSTAS (ne garsas).",
  },
  gemini: {
    processing: EXTERNAL,
    dataSent: DATA.TRANSCRIPT,
    vendor: "Google",
    notes: "Siunčiamas transkripcijos TEKSTAS (ne garsas).",
  },
};

const MATRIX = { transcription: TRANSCRIPTION, diarization: DIARIZATION, llm: LLM };

function _lookup(kind, name) {
  const table = MATRIX[kind];
  if (!table) return null;
  return table[String(name || "").toLowerCase()] || null;
}

/**
 * Ar konkretus tiekėjas išsiunčia duomenis už mašinos ribų?
 * Nežinomam tiekėjui grąžinam `true` (fail-safe: geriau įspėti be reikalo).
 */
function isExternal(kind, name) {
  const entry = _lookup(kind, name);
  if (!entry) return true;
  return entry.processing === EXTERNAL;
}

/**
 * Efektyvi konfigūracijos privatumo santrauka - be jokių paslapčių.
 * `diarization: inline` privatumo poveikis paimamas iš transkribavimo tiekėjo.
 */
function describeSelection(env = process.env) {
  const transcription = (env.TRANSCRIPTION_PROVIDER || "mock").toLowerCase();
  const diarization = (env.DIARIZATION_PROVIDER || "none").toLowerCase();
  const llm = (env.LLM_PROVIDER || "mock").toLowerCase();

  const selection = [
    { kind: "transcription", name: transcription, ..._lookup("transcription", transcription) },
    { kind: "diarization", name: diarization, ..._lookup("diarization", diarization) },
    { kind: "llm", name: llm, ..._lookup("llm", llm) },
  ];

  const external = selection.filter((item) => {
    if (item.kind === "diarization" && item.processing === DEPENDS) {
      // inline: paveda transkribavimo tiekėjui, atskirai nesiskaito.
      return false;
    }
    return item.processing === EXTERNAL || item.processing === undefined;
  });

  return {
    providers: selection.map((item) => ({
      kind: item.kind,
      name: item.name,
      processing: item.processing || "unknown",
      dataSent: item.dataSent || "unknown",
      vendor: item.vendor || null,
    })),
    externalProviders: external.map((item) => ({
      kind: item.kind,
      name: item.name,
      vendor: item.vendor || null,
      dataSent: item.dataSent || "unknown",
    })),
    anyExternal: external.length > 0,
  };
}

module.exports = {
  MATRIX,
  TRANSCRIPTION,
  DIARIZATION,
  LLM,
  LOCAL,
  EXTERNAL,
  DEPENDS,
  DATA,
  isExternal,
  describeSelection,
};
