const TranscriptionProvider = require("./TranscriptionProvider");

/**
 * Veikia be jokio API rakto. Naudinga:
 * - lokaliai kūrimo metu (offline)
 * - automatiniams testams (deterministinis rezultatas)
 * - demo aplinkoje be tikro audio pipeline
 */
class MockTranscriptionProvider extends TranscriptionProvider {
  async transcribe(audioBuffer, options = {}) {
    const filename = options.filename || "įrašas.mp3";
    return {
      text:
        "Jonas: Labas, pradedam. Šiandien aptarsim biudžetą kitam ketvirčiui. " +
        "Petras: Manau, reikėtų padidinti rinkodaros biudžetą dvidešimčia procentų. " +
        "Asta: Sutinku, bet turime patvirtinti tai iki liepos penkioliktos. " +
        "Jonas: Gerai, Petrai, parengk pasiūlymą iki kitos savaitės.",
      segments: [
        { start: 0.0, end: 4.2, text: "Labas, pradedam. Šiandien aptarsim biudžetą kitam ketvirčiui.", speaker: "Jonas" },
        { start: 4.2, end: 9.8, text: "Manau, reikėtų padidinti rinkodaros biudžetą dvidešimčia procentų.", speaker: "Petras" },
        { start: 9.8, end: 14.5, text: "Sutinku, bet turime patvirtinti tai iki liepos penkioliktos.", speaker: "Asta" },
        { start: 14.5, end: 18.0, text: "Gerai, Petrai, parengk pasiūlymą iki kitos savaitės.", speaker: "Jonas" },
      ],
      language: options.language || "lt",
      confidence: 0.97,
      diarization: true,
      provider: "mock",
      _note: `Mock atsakymas failui "${filename}" — pakeiskite TRANSCRIPTION_PROVIDER į whisper/azure/google/deepgram realiam veikimui.`,
    };
  }
}

module.exports = MockTranscriptionProvider;
