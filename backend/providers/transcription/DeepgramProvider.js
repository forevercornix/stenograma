const TranscriptionProvider = require("./TranscriptionProvider");
const { fetchWithRetry } = require("../../utils/httpClient");

/**
 * STATUS: interface implemented, integration not verified with a real API key
 * in this environment. Code follows Deepgram's public /v1/listen contract.
 *
 * Deepgram (Nova-2 modelis) — vienas paprasčiausių REST API šioje grupėje,
 * geras diarizacijos + laiko žymių palaikymas "iš dėžutės".
 * Reikalauja DEEPGRAM_API_KEY.
 */
class DeepgramProvider extends TranscriptionProvider {
  constructor(config = {}) {
    super(config);
    this.apiKey = config.apiKey || process.env.DEEPGRAM_API_KEY;
    if (!this.apiKey) throw new Error("DeepgramProvider: trūksta DEEPGRAM_API_KEY");
  }

  async transcribe(audioBuffer, options = {}) {
    const params = new URLSearchParams({
      model: "nova-2",
      language: options.language === "lt" ? "lt" : options.language || "lt",
      diarize: String(!!options.diarize),
      punctuate: "true",
      utterances: "true",
    });

    const res = await fetchWithRetry(`https://api.deepgram.com/v1/listen?${params}`, {
      method: "POST",
      headers: {
        Authorization: `Token ${this.apiKey}`,
        "Content-Type": options.mimeType || "audio/mpeg",
      },
      body: audioBuffer,
    });

    if (!res.ok) throw new Error(`Deepgram API klaida (${res.status}): ${await res.text()}`);
    const data = await res.json();

    const utterances = data.results?.utterances || [];
    const segments = utterances.map((u) => ({
      start: u.start,
      end: u.end,
      text: u.transcript,
      speaker: u.speaker != null ? `Kalbėtojas ${u.speaker}` : null,
    }));

    const fullText =
      data.results?.channels?.[0]?.alternatives?.[0]?.transcript ||
      segments.map((s) => s.text).join(" ");

    return {
      text: fullText,
      segments,
      language: options.language || "lt",
      confidence: data.results?.channels?.[0]?.alternatives?.[0]?.confidence ?? null,
      diarization: !!options.diarize,
      provider: "deepgram",
    };
  }
}

module.exports = DeepgramProvider;
