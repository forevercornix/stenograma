const DiarizationProvider = require("./DiarizationProvider");
const { fetchWithRetry, fetchWithTimeout } = require("../../utils/httpClient");

/**
 * STATUS: interface implemented, integration not verified with a real API key
 * in this environment. Code follows AssemblyAI's public transcript+diarization contract.
 *
 * AssemblyAI transkribuoja IR diarizuoja viename kvietime (speaker_labels: true) -
 * čia naudojame tik kalbėtojų intervalus, tekstą atmetame, nes transkripciją šiuo
 * atveju atlieka kitas (galbūt geresnis lietuviams) tiekėjas, pvz. Whisper.
 *
 * Pastaba: tai reiškia dvigubą apmokėjimą (AssemblyAI sąskaita už transkribavimą,
 * kurio rezultatą išmetame) - naudokite tik jei jų diarizacijos kokybė aiškiai
 * pranoksta alternatyvas jūsų kalbai/scenarijui.
 *
 * Reikalauja ASSEMBLYAI_API_KEY.
 */
class AssemblyAIDiarizationProvider extends DiarizationProvider {
  constructor(config = {}) {
    super(config);
    this.apiKey = config.apiKey || process.env.ASSEMBLYAI_API_KEY;
    if (!this.apiKey) throw new Error("AssemblyAIDiarizationProvider: trūksta ASSEMBLYAI_API_KEY");
  }

  async diarize(audioBuffer, options = {}) {
    const uploadRes = await fetchWithRetry("https://api.assemblyai.com/v2/upload", {
      method: "POST",
      headers: { Authorization: this.apiKey },
      body: audioBuffer,
    });
    if (!uploadRes.ok) throw new Error(`AssemblyAI upload klaida (${uploadRes.status})`);
    const { upload_url } = await uploadRes.json();

    const submitRes = await fetchWithRetry("https://api.assemblyai.com/v2/transcript", {
      method: "POST",
      headers: { Authorization: this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        audio_url: upload_url,
        speaker_labels: true,
        language_code: options.language === "lt" ? "lt" : options.language || "lt",
      }),
    });
    if (!submitRes.ok) throw new Error(`AssemblyAI: nepavyko pateikti užduoties (${submitRes.status})`);
    const job = await submitRes.json();

    let status = job.status;
    let data = job;
    for (let i = 0; i < 60 && status !== "completed"; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const pollRes = await fetchWithTimeout(`https://api.assemblyai.com/v2/transcript/${job.id}`, {
        headers: { Authorization: this.apiKey },
      });
      data = await pollRes.json();
      status = data.status;
      if (status === "error") throw new Error(`AssemblyAI: ${data.error}`);
    }
    if (status !== "completed") throw new Error("AssemblyAI: laikas baigėsi laukiant rezultato");

    const turns = (data.utterances || []).map((u) => ({
      start: u.start / 1000,
      end: u.end / 1000,
      speaker: `Kalbėtojas ${u.speaker}`,
    }));

    return { turns, provider: "assemblyai-diarization" };
  }
}

module.exports = AssemblyAIDiarizationProvider;
