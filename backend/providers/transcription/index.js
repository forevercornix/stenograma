const MockTranscriptionProvider = require("./MockTranscriptionProvider");
const WhisperProvider = require("./WhisperProvider");
const FasterWhisperProvider = require("./FasterWhisperProvider");
const FasterWhisperEmbeddedProvider = require("./FasterWhisperEmbeddedProvider");
const AzureSpeechProvider = require("./AzureSpeechProvider");
const GoogleSpeechProvider = require("./GoogleSpeechProvider");
const DeepgramProvider = require("./DeepgramProvider");
const { assertRawAudioProviderAllowed } = require("../../utils/privacyConfig");
const { assertProviderAllowed } = require("../../utils/providerGovernance");

// "faster-whisper" PALIKTAS kaip atgalinio suderinamumo alias'as - jis visada
// reiškė HTTP-serverio (server) profilį. "faster-whisper-server" yra tas pats,
// tik aiškesnis pavadinimas, kai abu profiliai naudojami greta (žr. DEPLOYMENT_
// CHECKLIST.md / backend README "Du diegimo profiliai").
const REGISTRY = {
  mock: MockTranscriptionProvider,
  whisper: WhisperProvider,
  "faster-whisper": FasterWhisperProvider, // = "faster-whisper-server", alias atgaliniam suderinamumui
  "faster-whisper-server": FasterWhisperProvider,
  "faster-whisper-embedded": FasterWhisperEmbeddedProvider,
  azure: AzureSpeechProvider,
  google: GoogleSpeechProvider,
  deepgram: DeepgramProvider,
};

/**
 * Vienintelė vieta, kurią reikia keisti norint pakeisti transkribavimo tiekėją.
 * Valdoma per aplinkos kintamąjį TRANSCRIPTION_PROVIDER arba explicit config.
 *
 *   TRANSCRIPTION_PROVIDER=whisper node server.js
 *   TRANSCRIPTION_PROVIDER=deepgram node server.js
 *   TRANSCRIPTION_PROVIDER=faster-whisper-embedded node server.js   (desktop profilis - be atskiro serverio)
 *   TRANSCRIPTION_PROVIDER=faster-whisper-server node server.js    (bendras serveris - atskiras HTTP servisas)
 *   TRANSCRIPTION_PROVIDER=mock node server.js   (numatytoji, veikia be raktų)
 *
 * Provideris SLEPIA vykdymo būdą nuo likusios sistemos (routes/transcribe.js) -
 * abu "faster-whisper-*" variantai implementuoja tą patį TranscriptionProvider
 * kontraktą, tad likusiam kodui nesvarbu, kuris iš jų aktyvus.
 */

function getTranscriptionProvider(nameOverride, config = {}) {
  const name = (nameOverride || process.env.TRANSCRIPTION_PROVIDER || "mock").toLowerCase();

  // FAIL-CLOSED (GDPR #5): startup validacija mato tik .env, o čia ateina ir
  // UŽKLAUSOS override. Ta pati taisyklė, tas pats predikatas - žr.
  // utils/privacyConfig.js assertRawAudioProviderAllowed().
  assertRawAudioProviderAllowed("transcription", name);
  if (!Object.prototype.hasOwnProperty.call(REGISTRY, name)) {
    throw new Error(
      `Nežinomas TRANSCRIPTION_PROVIDER: "${name}". Galimi: ${Object.keys(REGISTRY).join(", ")}`
    );
  }

  /**
   * VALDYSENA tikrinama PO registro patikros.
   *
   * Tvarka svarbi diagnostikai: rašybos klaida („clade") turi duoti
   * „nežinomas tiekėjas", ne „nėra valdysenos įrašo". Antrasis pranešimas
   * siųstų operatorių taisyti valdysenos failo, nors problema – įvestyje.
   */
  assertProviderAllowed("transcription", name);

  const ProviderClass = REGISTRY[name];
  if (typeof ProviderClass !== "function") {
    throw new Error(`Nekorektiška transkribavimo tiekėjo registracija: "${name}" nėra konstruktorius.`);
  }

  return new ProviderClass(config);
}

module.exports = { getTranscriptionProvider, REGISTRY };
