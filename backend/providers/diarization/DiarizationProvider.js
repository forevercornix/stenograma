/**
 * Diarizacija (kalbėtojų atskyrimas) yra ATSKIRAS architektūros komponentas nuo
 * transkribavimo - jį galima konfigūruoti nepriklausomai, kad Whisper (kuris pats
 * diarizacijos nemoka) galėtų būti naudojamas KARTU su, pvz., pyannote diarizacija.
 *
 * Kontraktas:
 *   diarize(audioBuffer, options) => Promise<{
 *     turns: [{ start: number, end: number, speaker: string }],
 *     provider: string,
 *   }>
 *
 * "turns" yra kalbėtojų laiko intervalai - jie vėliau sujungiami su transkripcijos
 * segmentais per utils/mergeDiarization.js (pagal laiko persidengimą), NE per
 * bendrą API kvietimą su transkribavimu.
 */
class DiarizationProvider {
  constructor(config = {}) {
    if (this.constructor === DiarizationProvider) {
      throw new Error("DiarizationProvider yra abstrakti klasė, naudokite konkretų providerį");
    }
    this.config = config;
  }

  // eslint-disable-next-line no-unused-vars
  async diarize(audioBuffer, options = {}) {
    throw new Error(`${this.constructor.name} turi implementuoti diarize()`);
  }

  get name() {
    return this.constructor.name;
  }
}

module.exports = DiarizationProvider;
