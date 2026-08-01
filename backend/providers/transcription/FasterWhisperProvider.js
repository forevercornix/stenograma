const TranscriptionProvider = require("./TranscriptionProvider");
const { fetchWithTimeout, timeoutForAudioBytes } = require("../../utils/httpClient");
const { createLogger } = require("../../utils/logger");
const log = createLogger("provider:faster-whisper");

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
    // SSE streaming kelias su progresu - TIK jei kviečiantysis pateikė onProgress IR
    // įjungtas WHISPER_STREAM_PROGRESS=true. Numatyta IŠJUNGTA, kad numatytas (realiai
    // patikrintas) kelias liktų nepakeistas. NETESTUOTA su realiu GPU - žr. RUNPOD.md.
    const streamEnabled = process.env.WHISPER_STREAM_PROGRESS === "true";
    if (streamEnabled && typeof options.onProgress === "function") {
      const progressState = { received: false };
      try {
        return await this._transcribeStream(audioBuffer, options, progressState);
      } catch (e) {
        // Fallback SAUGUS tik jei streaming'as krito ANKSTI (jokio progreso negauta) -
        // tada įprastas /transcribe nekartoja jau padaryto darbo. Jei streaming'as krito
        // ĮPUSĖJUS (progreso jau buvo), aklas fallback reikštų VISOS 4 val. transkripcijos
        // kartojimą iš naujo (dvigubas GPU darbas). Tokiu atveju NEkartojam - metam klaidą.
        if (progressState.received) {
          throw new Error(
            `Whisper streaming nutrūko įpusėjus (${e.message}). Nekartojam viso darbo - ` +
            `pakartokite užklausą arba išjunkite WHISPER_STREAM_PROGRESS.`
          );
        }
        log.warn(`Whisper streaming krito anksti (${e.message}), grįžtu į įprastą /transcribe.`);
      }
    }

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

  /**
   * SSE streaming variantas: kviečia /transcribe-stream, skaito progress/done event'us,
   * kviečia options.onProgress(percent) kiekvienam progresui. Grąžina tą patį formatą
   * kaip įprastas kelias. NETESTUOTA su realiu GPU.
   */
  async _transcribeStream(audioBuffer, options, progressState = {}) {
    const FormData = require("form-data");
    const form = new FormData();
    form.append("file", audioBuffer, { filename: options.filename || "audio.mp3" });
    form.append("language", options.language || "lt");
    form.append("diarize", String(!!options.diarize));

    const streamUrl = this.url.replace(/\/transcribe$/, "/transcribe-stream");
    const timeoutMs = timeoutForAudioBytes(audioBuffer.length);
    const res = await fetchWithTimeout(streamUrl, {
      method: "POST",
      body: form.getBuffer(),
      headers: form.getHeaders(),
    }, timeoutMs);
    if (!res.ok || !res.body) {
      throw new Error(`Streaming serveris grąžino klaidą (${res.status}).`);
    }

    let done = null;
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const evt = parseSseEvent(raw);
        if (!evt) continue;
        if (evt.event === "started") {
          // Serveris gavo semaforą ir PRADĖJO darbą - nuo šio momento fallback nebesaugus
          // (net prieš pirmą progresą), kad nekartotume transkripcijos iš naujo.
          progressState.received = true;
        } else if (evt.event === "progress" && evt.data) {
          progressState.received = true;
          try { options.onProgress(JSON.parse(evt.data)); } catch { /* ignoruojam blogą progresą */ }
        } else if (evt.event === "done" && evt.data) {
          done = JSON.parse(evt.data);
        } else if (evt.event === "error") {
          // Serveris ATSAKĖ su klaida (ne HTTP lygio problema) - fallback nebeprasmingas
          // (serveris veikia, tik ši užklausa nepavyko). Žymim, kad fallback draudžiamas.
          progressState.received = true;
          throw new Error(parseSseErrorMessage(evt.data));
        }
      }
    }
    if (!done) throw new Error("Streaming baigėsi be 'done' įvykio.");

    return {
      text: done.text,
      segments: (done.segments || []).map((s) => ({
        start: s.start,
        end: s.end,
        text: s.text,
        speaker: s.speaker || null,
      })),
      language: done.language || options.language || "lt",
      confidence: done.avg_logprob ?? null,
      diarization: !!options.diarize,
      provider: "faster-whisper-local",
    };
  }
}

function parseSseEvent(raw) {
  const lines = raw.split("\n");
  let event = "message";
  let data = "";
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  return { event, data };
}

function parseSseErrorMessage(data) {
  // Serveris siunčia error kaip JSON {"error":"..."} - ištraukiam žmogui skaitomą
  // žinutę, ne visą JSON eilutę (P3 pastaba).
  let message = "Whisper streaming klaida";
  if (!data) return message;
  try {
    const payload = JSON.parse(data);
    message = payload.error || message;
  } catch {
    message = data;
  }
  return message;
}

module.exports = FasterWhisperProvider;
