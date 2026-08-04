const MockDiarizationProvider = require("./MockDiarizationProvider");
const PyannoteDiarizationProvider = require("./PyannoteDiarizationProvider");
const PyannoteCloudDiarizationProvider = require("./PyannoteCloudDiarizationProvider");
const AssemblyAIDiarizationProvider = require("./AssemblyAIDiarizationProvider");
const { assertRawAudioProviderAllowed } = require("../../utils/privacyConfig");
const { assertProviderAllowed } = require("../../utils/providerGovernance");

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

  // FAIL-CLOSED (GDPR #5): startup validacija mato tik .env, o čia ateina ir
  // UŽKLAUSOS override. Ta pati taisyklė, tas pats predikatas - žr.
  // utils/privacyConfig.js assertRawAudioProviderAllowed().
  assertRawAudioProviderAllowed("diarization", name);
  if (SPECIAL_MODES.includes(name)) return null;
  if (!Object.prototype.hasOwnProperty.call(REGISTRY, name)) {
    throw new Error(
      `Nežinomas DIARIZATION_PROVIDER: "${name}". Galimi: ${[...SPECIAL_MODES, ...Object.keys(REGISTRY)].join(", ")}`
    );
  }

  /**
   * VALDYSENA tikrinama PO registro patikros.
   *
   * Tvarka svarbi diagnostikai: rašybos klaida („clade") turi duoti
   * „nežinomas tiekėjas", ne „nėra valdysenos įrašo". Antrasis pranešimas
   * siųstų operatorių taisyti valdysenos failo, nors problema – įvestyje.
   */
  assertProviderAllowed("diarization", name);

  const ProviderClass = REGISTRY[name];
  if (typeof ProviderClass !== "function") {
    throw new Error(`Nekorektiška diarizacijos tiekėjo registracija: "${name}" nėra konstruktorius.`);
  }

  return new ProviderClass(config);
}

function isKnownDiarizationMode(name) {
  const n = (name || "").toLowerCase();
  return SPECIAL_MODES.includes(n) || Object.prototype.hasOwnProperty.call(REGISTRY, n);
}

module.exports = { getDiarizationProvider, isKnownDiarizationMode, REGISTRY, SPECIAL_MODES };
