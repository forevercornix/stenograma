const DiarizationProvider = require("./DiarizationProvider");

/**
 * STATUS: implemented and verified (works with no API key, used by automated tests).
 *
 * Deterministiniai kalbėtojų intervalai - naudinga testams ir demo be jokio rakto.
 * Laiko žymos sąmoningai sutampa su MockTranscriptionProvider segmentais, kad
 * merge (utils/mergeDiarization.js) rezultatą būtų lengva patikrinti.
 */
class MockDiarizationProvider extends DiarizationProvider {
  async diarize(audioBuffer, options = {}) {
    return {
      turns: [
        { start: 0.0, end: 4.2, speaker: "Kalbėtojas A" },
        { start: 4.2, end: 9.8, speaker: "Kalbėtojas B" },
        { start: 9.8, end: 14.5, speaker: "Kalbėtojas C" },
        { start: 14.5, end: 18.0, speaker: "Kalbėtojas A" },
      ],
      provider: "mock-diarization",
    };
  }
}

module.exports = MockDiarizationProvider;
