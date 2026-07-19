const MockDiarizationProvider = require("./MockDiarizationProvider");
const PyannoteDiarizationProvider = require("./PyannoteDiarizationProvider");
const PyannoteCloudDiarizationProvider = require("./PyannoteCloudDiarizationProvider");
const AssemblyAIDiarizationProvider = require("./AssemblyAIDiarizationProvider");

// "none" ir "inline" NĖRA klasės - tai specialūs režimai, tvarkomi routes/transcribe.js:
//   none   - diarizacija apskritai neatliekama.
//   inline - pasitikima tuo, ką (jei ką) grąžina pati TRANSCRIPTION_PROVIDER (Azure/
//            Google/Deepgram/Mock moka diarizuoti "iš karto" vienu API kvietimu).
// Bet koks kitas raktas žemiau - ATSKIRAS diarizacijos etapas, nepriklausomas nuo to,
// koks TRANSCRIPTION_PROVIDER pasirinktas (todėl Whisper transkripcija + pyannote
// diarizacija dabar yra galimas derinys).
const REGISTRY = {
  mock: MockDiarizationProvider,
  pyannote: PyannoteDiarizationProvider,
  "pyannote-cloud": PyannoteCloudDiarizationProvider,
  assemblyai: AssemblyAIDiarizationProvider,
};

const SPECIAL_MODES = ["none", "inline"];

/**
 *   DIARIZATION_PROVIDER=none            (numatyta - diarizacijos nėra)
 *   DIARIZATION_PROVIDER=inline          (naudoti TRANSCRIPTION_PROVIDER savo diarizaciją, jei moka)
 *   DIARIZATION_PROVIDER=pyannote        (atskiras lokalus etapas, nepriklauso nuo transkribavimo tiekėjo)
 *   DIARIZATION_PROVIDER=pyannote-cloud
 *   DIARIZATION_PROVIDER=assemblyai
 *   DIARIZATION_PROVIDER=mock            (testams/demo, be jokio rakto)
 *
 * Grąžina `null` "none"/"inline" atveju - kviečiantis kodas (routes/transcribe.js)
 * tuos du atvejus tvarko specialiai, nes jie nereikalauja atskiro API kvietimo.
 */
function getDiarizationProvider(nameOverride, config = {}) {
  const name = (nameOverride || process.env.DIARIZATION_PROVIDER || "none").toLowerCase();
  if (SPECIAL_MODES.includes(name)) return null;
  const ProviderClass = REGISTRY[name];
  if (!ProviderClass) {
    throw new Error(
      `Nežinomas DIARIZATION_PROVIDER: "${name}". Galimi: ${[...SPECIAL_MODES, ...Object.keys(REGISTRY)].join(", ")}`
    );
  }
  return new ProviderClass(config);
}

function isKnownDiarizationMode(name) {
  const n = (name || "").toLowerCase();
  return SPECIAL_MODES.includes(n) || n in REGISTRY;
}

module.exports = { getDiarizationProvider, isKnownDiarizationMode, REGISTRY, SPECIAL_MODES };
