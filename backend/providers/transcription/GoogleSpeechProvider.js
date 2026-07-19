const TranscriptionProvider = require("./TranscriptionProvider");
const { fetchWithRetry } = require("../../utils/httpClient");

/**
 * STATUS: interface implemented, integration not verified with a real API key
 * in this environment. Code follows Speech-to-Text v1p1beta1 REST contract.
 *
 * Google Cloud Speech-to-Text v1p1beta1 — SINCHRONINIS `speech:recognize` endpoint'as
 * (ne batch/asinchroninis v2 API - tai tinka trumpiems <1 min įrašams; ilgesniems
 * reikėtų `speech:longrunningrecognize` arba v2 batch recognize su Cloud Storage URI).
 * Reikalauja GOOGLE_APPLICATION_CREDENTIALS (service account JSON) arba GOOGLE_API_KEY.
 * Palaiko diarizaciją (diarizationConfig).
 *
 * Rekomenduojama naudoti oficialų @google-cloud/speech SDK vietoj tiesioginio REST,
 * čia REST naudojamas dėl paprastumo/priklausomybių minimizavimo.
 */
class GoogleSpeechProvider extends TranscriptionProvider {
  constructor(config = {}) {
    super(config);
    this.apiKey = config.apiKey || process.env.GOOGLE_API_KEY;
    if (!this.apiKey) {
      throw new Error(
        "GoogleSpeechProvider: trūksta GOOGLE_API_KEY (arba pereikite prie @google-cloud/speech su service account)"
      );
    }
  }

  async transcribe(audioBuffer, options = {}) {
    const audioBase64 = audioBuffer.toString("base64");

    const res = await fetchWithRetry(
      `https://speech.googleapis.com/v1p1beta1/speech:recognize?key=${this.apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: {
            encoding: "ENCODING_UNSPECIFIED",
            languageCode: options.language === "lt" ? "lt-LT" : options.language || "lt-LT",
            enableAutomaticPunctuation: true,
            diarizationConfig: options.diarize
              ? { enableSpeakerDiarization: true, minSpeakerCount: 2, maxSpeakerCount: 8 }
              : undefined,
            enableWordTimeOffsets: true,
          },
          audio: { content: audioBase64 },
        }),
      }
    );

    if (!res.ok) throw new Error(`Google Speech API klaida (${res.status}): ${await res.text()}`);
    const data = await res.json();

    const segments = [];
    for (const result of data.results || []) {
      const alt = result.alternatives?.[0];
      if (!alt) continue;
      segments.push({
        start: alt.words?.[0]?.startTime ? parseFloat(alt.words[0].startTime) : 0,
        end: alt.words?.at(-1)?.endTime ? parseFloat(alt.words.at(-1).endTime) : 0,
        text: alt.transcript,
        speaker: alt.words?.[0]?.speakerTag ? `Kalbėtojas ${alt.words[0].speakerTag}` : null,
      });
    }

    return {
      text: segments.map((s) => s.text).join(" "),
      segments,
      language: options.language || "lt",
      confidence: data.results?.[0]?.alternatives?.[0]?.confidence ?? null,
      diarization: !!options.diarize,
      provider: "google-speech",
    };
  }
}

module.exports = GoogleSpeechProvider;
