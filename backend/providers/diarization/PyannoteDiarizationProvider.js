const DiarizationProvider = require("./DiarizationProvider");
const { fetchWithTimeout, timeoutForAudioBytes } = require("../../utils/httpClient");

/**
 * STATUS: interface implemented, integration not verified in this environment
 * (reikalauja atskirai paleisto lokalaus serverio - žr. žemiau).
 *
 * Lokalus pyannote.audio (per atskirai paleistą HTTP serverį, pvz. paprastą
 * FastAPI wrapperį aplink `pyannote/speaker-diarization-3.1` pipeline).
 * Nekeliauja jokių duomenų į išorę - naudinga jautriems įrašams (GDPR).
 *
 * Šis providerio klasė NEPALEIDŽIA modelio pati - tikisi PYANNOTE_URL serverio,
 * kuris priima multipart audio ir grąžina { turns: [{start,end,speaker}] }.
 */
class PyannoteDiarizationProvider extends DiarizationProvider {
  constructor(config = {}) {
    super(config);
    this.url = config.url || process.env.PYANNOTE_URL || "http://localhost:8001/diarize";
    // Multipart lauko pavadinimas konfigūruojamas, nes skirtingi pyannote HTTP
    // wrapper'iai (FastAPI UploadFile ir pan.) tikisi skirtingų pavadinimų
    // ("file", "audio", "audio_file") - nesutapimas duoda 400 be aiškios priežasties.
    this.fileField = config.fileField || process.env.PYANNOTE_FILE_FIELD || "file";
  }

  async diarize(audioBuffer, options = {}) {
    const FormData = require("form-data");
    const form = new FormData();
    form.append(this.fileField, audioBuffer, { filename: options.filename || "audio.wav" });
    if (options.numSpeakers) form.append("num_speakers", String(options.numSpeakers));

    // form.getBuffer() - native fetch (undici) nesuderinamas su Node form-data kaip
    // stream body (sugadina multipart boundary). Žr. FasterWhisperProvider.js paaiškinimą.
    // Proporcingas timeout: ilgo įrašo diarizacija (pyannote) trunka daug ilgiau nei
    // numatyti 90s. RASTA REALIAI (RunPod, 4 val.): fiksuotas 90s nutraukdavo laukimą,
    // nors pyannote realiai baigdavo. Dabar timeout skaičiuojamas iš audio dydžio.
    const timeoutMs = timeoutForAudioBytes(audioBuffer.length);
    const res = await fetchWithTimeout(this.url, {
      method: "POST",
      body: form.getBuffer(),
      headers: form.getHeaders(),
    }, timeoutMs);
    if (!res.ok) {
      // RASTA REALIAI DIEGIANT (vartotojo RunPod sesija): pyannote serveris grąžino
      // 400, bet klaidos KŪNAS nebuvo rodomas niekur - diagnostika buvo akla.
      // Dabar: statusas + atsakymo kūnas (apkarpytas) + endpoint'as + dažniausių
      // priežasčių sąrašas patenka į klaidą; pilnas kūnas - į serverio logą.
      const body = await res.text().catch(() => "(nepavyko perskaityti atsakymo kūno)");
      console.error(
        `[stenograma] Pyannote klaida: POST ${this.url} -> ${res.status}\n` +
          `  Atsakymo kūnas (pilnas): ${body}\n` +
          `  Išsiųsta: multipart laukas "${this.fileField}" (${audioBuffer.length} baitų, filename=${options.filename || "audio.wav"})` +
          (options.numSpeakers ? `, num_speakers=${options.numSpeakers}` : "")
      );
      throw new Error(
        `Pyannote serveris grąžino ${res.status} (POST ${this.url}). ` +
          `Atsakymas: ${body.slice(0, 300)}${body.length > 300 ? "..." : ""}. ` +
          `Dažniausios 400 priežastys: (1) serveris tikisi kito lauko pavadinimo nei "file" (pvz. "audio") - ` +
          `žr. PYANNOTE_FILE_FIELD env; (2) kitas endpoint kelias (pvz. /api/diarize vietoj /diarize) - žr. PYANNOTE_URL; ` +
          `(3) serveris tikisi JSON su URL, ne multipart failo; (4) trūksta autentifikacijos antraštės. ` +
          `Šio backend'o kontraktas: multipart POST su failu lauke "${this.fileField}", atsakymas {turns:[{start,end,speaker}]}.`
      );
    }
    const data = await res.json();

    return {
      turns: (data.turns || []).map((t) => ({ start: t.start, end: t.end, speaker: t.speaker })),
      provider: "pyannote-local",
    };
  }
}

module.exports = PyannoteDiarizationProvider;
