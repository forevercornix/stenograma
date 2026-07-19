const DiarizationProvider = require("./DiarizationProvider");
const { fetchWithRetry, fetchWithTimeout } = require("../../utils/httpClient");

/**
 * STATUS: interface implemented, integration not verified with a real API key
 * in this environment. Code follows pyannote.ai's documented async job contract.
 *
 * pyannote.ai — komercinė, TIK diarizacijai skirta API (be transkribavimo).
 * Naudinga tiksliai tam scenarijui, kurio buvo prašyta: transkribavimas per vieną
 * tiekėją (pvz. Whisper), diarizacija - per visiškai kitą.
 *
 * Reikalauja PYANNOTEAI_API_KEY. API yra asinchroninis (submit → poll → fetch),
 * čia - supaprastintas pavyzdys su polling serveryje (produkcijai geriau webhook).
 *
 * Ypač patikrinkite audio pateikimo formatą (šis pavyzdys tikisi viešai pasiekiamo
 * URL, kaip ir AzureSpeechProvider - jei audio tik lokalus failas, pirma įkelkite jį
 * į laikiną viešą saugyklą arba naudokite jų signed upload URL srautą).
 */
class PyannoteCloudDiarizationProvider extends DiarizationProvider {
  constructor(config = {}) {
    super(config);
    this.apiKey = config.apiKey || process.env.PYANNOTEAI_API_KEY;
    if (!this.apiKey) throw new Error("PyannoteCloudDiarizationProvider: trūksta PYANNOTEAI_API_KEY");
  }

  async diarize(audioBuffer, options = {}) {
    if (!options.audioUrl) {
      throw new Error(
        "PyannoteCloudDiarizationProvider reikalauja options.audioUrl (viešai pasiekiamo audio URL) - žr. komentarą faile."
      );
    }

    const submitRes = await fetchWithRetry("https://api.pyannote.ai/v1/diarize", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: options.audioUrl, numSpeakers: options.numSpeakers }),
    });
    if (!submitRes.ok) throw new Error(`pyannote.ai: nepavyko pateikti užduoties (${submitRes.status})`);
    const job = await submitRes.json();

    let status = job.status;
    let output = job.output;
    for (let i = 0; i < 30 && status !== "succeeded"; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const pollRes = await fetchWithTimeout(`https://api.pyannote.ai/v1/jobs/${job.jobId}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      const pollData = await pollRes.json();
      status = pollData.status;
      output = pollData.output;
      if (status === "failed") throw new Error("pyannote.ai: diarizacijos užduotis nepavyko");
    }
    if (status !== "succeeded") throw new Error("pyannote.ai: laikas baigėsi laukiant rezultato");

    const turns = (output?.diarization || []).map((seg) => ({
      start: seg.start,
      end: seg.end,
      speaker: `Kalbėtojas ${seg.speaker}`,
    }));

    return { turns, provider: "pyannote-cloud" };
  }
}

module.exports = PyannoteCloudDiarizationProvider;
