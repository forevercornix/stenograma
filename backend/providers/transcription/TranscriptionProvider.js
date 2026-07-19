/**
 * Bazinė sąsaja visiems transkribavimo tiekėjams.
 * Kiekvienas konkretus provideris privalo implementuoti transcribe().
 *
 * Grąžinamas vienodas kontraktas nepriklausomai nuo tiekėjo:
 * {
 *   text: string,                // pilnas tekstas
 *   segments: [{                 // laiko žymos (jei tiekėjas palaiko)
 *     start: number,             // sekundėmis
 *     end: number,
 *     text: string,
 *     speaker: string | null     // užpildoma TIK jei šis providerio moka diarizuoti
 *                                // "iš karto" (Azure/Google/Deepgram/Mock) IR buvo
 *                                // paprašyta per options.diarize=true ("inline" režimas).
 *                                // Whisper/FasterWhisper visada grąžina null - jiems
 *                                // diarizacija atliekama ATSKIRAI per
 *                                // providers/diarization/* + utils/mergeDiarization.js.
 *   }],
 *   language: string,
 *   confidence: number | null,   // 0..1, jei tiekėjas grąžina
 *   diarization: boolean,        // ar segmentuose jau yra kalbėtojų info
 *   provider: string,
 * }
 *
 * Diarizacija YRA ATSKIRAS architektūros komponentas (žr. providers/diarization/) -
 * options.diarize čia tik nurodo, ar PRAŠYTI šio konkretaus tiekėjo jo PAČIO
 * diarizacijos (jei jis tokią turi). Sprendimas, ar naudoti "inline" (šio tiekėjo)
 * ar atskirą DIARIZATION_PROVIDER, priimamas routes/transcribe.js lygyje, ne čia.
 */
class TranscriptionProvider {
  constructor(config = {}) {
    if (this.constructor === TranscriptionProvider) {
      throw new Error("TranscriptionProvider yra abstrakti klasė, naudokite konkretų providerį");
    }
    this.config = config;
  }

  /**
   * @param {Buffer|Readable} audioBuffer - garso failo turinys
   * @param {object} options - { language, diarize, filename, mimeType }
   * @returns {Promise<object>} standartinis rezultato kontraktas (žr. viršų)
   */
  // eslint-disable-next-line no-unused-vars
  async transcribe(audioBuffer, options = {}) {
    throw new Error(`${this.constructor.name} turi implementuoti transcribe()`);
  }

  get name() {
    return this.constructor.name;
  }
}

module.exports = TranscriptionProvider;
