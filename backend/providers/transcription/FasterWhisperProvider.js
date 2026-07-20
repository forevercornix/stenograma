const TranscriptionProvider = require("./TranscriptionProvider");
const { fetchWithTimeout, timeoutForAudioBytes } = require("../../utils/httpClient");

/**
 * STATUS: interface implemented, integration not verified in this environment
 * (reikalauja atskirai paleisto lokalaus serverio - žr. žemiau).
 *
 * "SERVER" DIEGIMO PROFILIS - tinka bendram įmonės serveriui su daug vienalaikių
 * vartotojų ir/ar GPU, kur norima modelį laikyti įkeltą atmintyje TARP užklausų
 * (ne krauti iš naujo kiekvienai). Registruotas kaip "faster-whisper" arba
 * "faster-whisper-server" (žr. providers/transcription/index.js).
 *
 * Jei reikia priešingo - vieno vartotojo kompiuterio be jokio atskiro serviso/
 * prievado ("desktop" profilis) - žr. FasterWhisperEmbeddedProvider.js
 * ("faster-whisper-embedded"), kuris kviečia faster-whisper TIESIOGIAI per
 * trumpalaikį Python subprocess, be jokio ilgai gyvenančio HTTP serverio.
 *
 * Lokalus Faster-Whisper (be jokio išorinio API, be duomenų siuntimo į trečiąsias šalis).
 *
 * Šis providerio klasė NEPALEIDŽIA modelio pati — ji tikisi, kad atskirai veikia
 * lokalus HTTP serveris (pvz. https://github.com/fedirz/faster-whisper-server arba
 * paprastas Python/FastAPI wrapperis aplink faster-whisper biblioteką), pasiekiamas
 * per FASTER_WHISPER_URL (numatyta: http://localhost:8000/transcribe).
 *
 * Naudinga, kai:
 * - įrašai jautrūs (GDPR, verslo paslaptys) ir negali keliauti į išorinį API
 * - norima nulinės sąnaudos už minutę
 * - daug vartotojų dalinasi ta pačia GPU/modeliu (embedded profilis kiekvienam
 *   subprocess'ui krautų modelį iš naujo - server profilyje jis krautas VIENĄ kartą)
 */
class FasterWhisperProvider extends TranscriptionProvider {
  constructor(config = {}) {
    super(config);
    this.url = config.url || process.env.FASTER_WHISPER_URL || "http://localhost:8000/transcribe";
  }

  async transcribe(audioBuffer, options = {}) {
    const FormData = require("form-data");
    const form = new FormData();
    form.append("file", audioBuffer, { filename: options.filename || "audio.mp3" });
    form.append("language", options.language || "lt");
    form.append("diarize", String(!!options.diarize));

    // SVARBU: Node `form-data` paketas NESUDERINAMAS su native fetch (undici) kaip
    // stream body - undici tikisi web-standarto FormData ir sugadina multipart
    // boundary ("Expected boundary character" klaida serveryje). Sprendimas -
    // form.getBuffer() paverčia į Buffer, kurį undici priima su rankiniu
    // Content-Type (su boundary iš getHeaders()).
    // Proporcingas timeout ilgiems failams (žr. httpClient.timeoutForAudioBytes).
    const timeoutMs = timeoutForAudioBytes(audioBuffer.length);
    const res = await fetchWithTimeout(this.url, {
      method: "POST",
      body: form.getBuffer(),
      headers: form.getHeaders(),
    }, timeoutMs);
    if (!res.ok) {
      throw new Error(`Faster-Whisper lokalus serveris grąžino klaidą (${res.status}). Ar jis paleistas ties ${this.url}?`);
    }
    const data = await res.json();

    return {
      text: data.text,
      segments: (data.segments || []).map((s) => ({
        start: s.start,
        end: s.end,
        text: s.text,
        speaker: s.speaker || null,
      })),
      language: data.language || options.language || "lt",
      confidence: data.avg_logprob ?? null,
      diarization: !!options.diarize,
      provider: "faster-whisper-local",
    };
  }
}

module.exports = FasterWhisperProvider;
