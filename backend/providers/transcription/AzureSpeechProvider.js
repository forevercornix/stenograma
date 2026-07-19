const TranscriptionProvider = require("./TranscriptionProvider");
const { fetchWithRetry, fetchWithTimeout } = require("../../utils/httpClient");

/**
 * STATUS: interface implemented, integration not verified with a real API key
 * in this environment. Code follows Azure Batch Transcription v3.1 REST contract.
 *
 * Azure AI Speech — Batch transcription API.
 * Reikalauja AZURE_SPEECH_KEY ir AZURE_SPEECH_REGION.
 * Palaiko diarizaciją (diarizationEnabled: true).
 *
 * PASTABA: Azure Batch Transcription yra asinchroninis (submit → poll → fetch),
 * todėl šis metodas apytiksliai atkartoja srautą, bet realiam naudojimui
 * rekomenduojama naudoti eilę (queue) vietoj sinchroninio laukimo serveryje.
 */
class AzureSpeechProvider extends TranscriptionProvider {
  constructor(config = {}) {
    super(config);
    this.key = config.apiKey || process.env.AZURE_SPEECH_KEY;
    this.region = config.region || process.env.AZURE_SPEECH_REGION;
    if (!this.key || !this.region) {
      throw new Error("AzureSpeechProvider: trūksta AZURE_SPEECH_KEY arba AZURE_SPEECH_REGION");
    }
    this.endpoint = `https://${this.region}.api.cognitive.microsoft.com/speechtotext/v3.1/transcriptions`;
  }

  async transcribe(audioBuffer, options = {}) {
    // 1) Įkeliame audio (paprastumo dėlei tikimasi, kad audioUrl jau pasiekiamas
    //    per viešą/laikiną URL - produkcijoje: įkelti į Azure Blob Storage pirma)
    if (!options.audioUrl) {
      throw new Error(
        "AzureSpeechProvider reikalauja options.audioUrl (viešai pasiekiamo audio URL, pvz. iš Blob Storage)."
      );
    }

    const submitRes = await fetchWithRetry(this.endpoint, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": this.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contentUrls: [options.audioUrl],
        locale: options.language === "lt" ? "lt-LT" : options.language || "lt-LT",
        displayName: options.filename || "stenograma-job",
        properties: {
          diarizationEnabled: !!options.diarize,
          wordLevelTimestampsEnabled: true,
        },
      }),
    });
    if (!submitRes.ok) throw new Error(`Azure Speech: nepavyko sukurti transkripcijos užduoties (${submitRes.status})`);
    const job = await submitRes.json();

    // 2) Poll (supaprastintas pavyzdys - produkcijoje naudoti webhook/queue).
    //    Kiekvienas poll kvietimas turi savo timeout, bet NE automatinį retry -
    //    tai jau yra kartotinis kvietimas per paties poll ciklo logiką.
    const jobUrl = job.self;
    let status = "Running";
    let filesUrl = null;
    for (let i = 0; i < 30 && status !== "Succeeded"; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const pollRes = await fetchWithTimeout(jobUrl, { headers: { "Ocp-Apim-Subscription-Key": this.key } });
      const pollData = await pollRes.json();
      status = pollData.status;
      if (status === "Succeeded") filesUrl = pollData.links.files;
      if (status === "Failed") throw new Error("Azure Speech: transkripcijos užduotis nepavyko");
    }
    if (!filesUrl) throw new Error("Azure Speech: laikas baigėsi laukiant rezultato");

    const filesRes = await fetchWithTimeout(filesUrl, { headers: { "Ocp-Apim-Subscription-Key": this.key } });
    const files = await filesRes.json();
    const resultFile = files.values.find((f) => f.kind === "Transcription");
    const resultRes = await fetchWithTimeout(resultFile.links.contentUrl);
    const result = await resultRes.json();

    const segments = (result.recognizedPhrases || []).map((p) => ({
      start: p.offsetInTicks / 10000000,
      end: (p.offsetInTicks + p.durationInTicks) / 10000000,
      text: p.nBest?.[0]?.display || "",
      speaker: p.speaker ? `Kalbėtojas ${p.speaker}` : null,
    }));

    return {
      text: segments.map((s) => s.text).join(" "),
      segments,
      language: options.language || "lt",
      confidence: result.recognizedPhrases?.[0]?.nBest?.[0]?.confidence ?? null,
      diarization: !!options.diarize,
      provider: "azure-speech",
    };
  }
}

module.exports = AzureSpeechProvider;
