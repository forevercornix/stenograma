const TranscriptionProvider = require("./TranscriptionProvider");
const { fetchWithRetry } = require("../../utils/httpClient");

/**
 * STATUS: interface implemented, integration not verified with a real API key
 * in this environment. Code follows OpenAI's public audio transcriptions contract.
 *
 * OpenAI Whisper API (whisper-1 arba gpt-4o-transcribe).
 * Reikalauja OPENAI_API_KEY aplinkos kintamojo.
 *
 * Pastaba: Whisper API pati NEPALAIKO diarizacijos (kalbėtojų atskyrimo).
 * Jei reikia diarizacijos, naudokite AzureSpeechProvider, GoogleSpeechProvider,
 * DeepgramProvider arba (kartu su Whisper) atskirą DIARIZATION_PROVIDER
 * (pyannote/pyannote-cloud/assemblyai) - žr. providers/diarization/.
 */
class WhisperProvider extends TranscriptionProvider {
  constructor(config = {}) {
    super(config);
    this.apiKey = config.apiKey || process.env.OPENAI_API_KEY;
    this.model = config.model || "whisper-1";
    if (!this.apiKey) {
      throw new Error("WhisperProvider: trūksta OPENAI_API_KEY");
    }
  }

  async transcribe(audioBuffer, options = {}) {
    const FormData = require("form-data");
    const form = new FormData();
    form.append("file", audioBuffer, {
      filename: options.filename || "audio.mp3",
      contentType: options.mimeType || "audio/mpeg",
    });
    form.append("model", this.model);
    form.append("response_format", "verbose_json");
    if (options.language) form.append("language", options.language);

    const res = await fetchWithRetry("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, ...form.getHeaders() },
      // form.getBuffer() - native fetch (undici) nesuderinamas su Node form-data
      // kaip stream body. Žr. FasterWhisperProvider.js paaiškinimą.
      body: form.getBuffer(),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Whisper API klaida (${res.status}): ${errText}`);
    }

    const data = await res.json();
    const segments = (data.segments || []).map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text.trim(),
      speaker: null, // whisper-1 diarizacijos nepalaiko
    }));

    return {
      text: data.text,
      segments,
      language: data.language || options.language || "lt",
      confidence: null,
      diarization: false,
      provider: "whisper",
    };
  }
}

module.exports = WhisperProvider;
