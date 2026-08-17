const TranscriptionProvider = require("./TranscriptionProvider");
const { fetchWithTimeout, timeoutForAudioBytes } = require("../../utils/httpClient");
const { createLogger } = require("../../utils/logger");
const {
  LIMIT_KIND,
  assertWithinLimit,
  assertTranscriptionWithinLimits,
} = require("../../utils/resultLimits");
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

  /**
   * Vieša sąsaja: paleidžia transkribavimą ir PATIKRINA rezultato ribas (#153).
   *
   * ⚠️ Patikra ČIA, o ne kiekvienoje šakoje atskirai. Anksčiau ji buvo tik
   * streaming kelyje, tad su `WHISPER_STREAM_PROGRESS=false` (numatyta!)
   * `MAX_TRANSCRIPT_BYTES` ir `MAX_SEGMENTS` neveikdavo visai. Ribos elgesys
   * negali priklausyti nuo transporto režimo pasirinkimo.
   */
  async transcribe(audioBuffer, options = {}) {
    const result = await this._transcribeAny(audioBuffer, options);
    assertTranscriptionWithinLimits(result);
    return result;
  }

  async _transcribeAny(audioBuffer, options = {}) {
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
        /**
         * RIBOS VIRŠIJIMAS PERDUODAMAS NEPAKEISTAS (#153).
         *
         * Apvyniojus jį į bendrą `Error`, prarandamas `kind`/`code`, ir
         * `jobRunner._classifyError()` job'ą pažymėtų `internal_error` –
         * operatorius nematytų, kad priežastis yra per didelis atsakymas, ne
         * serverio klaida. Fallback čia bet kokiu atveju netinka: didesnis
         * atsakymas per `/transcribe` netaptų mažesnis.
         */
        if (e && e.name === "ResultLimitError") throw e;

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
    /**
     * DVI INKREMENTINĖS RIBOS, MATUOJANČIOS SKIRTINGUS DALYKUS (#153).
     *
     * `STREAM_BUFFER_BYTES` – RAM apsauga: SSE parse buferio dydis IŠKART po
     * chunk'o pridėjimo, dar PRIEŠ pilnų įvykių išėmimą. Matavimas sąmoningai
     * konservatyvus – buferyje gali laikinai būti nebaigtas įvykis plius pilni
     * įvykiai iš to paties chunk'o. Tikrinti po išėmimo būtų grynesnė
     * semantika, bet silpnesnė apsauga: didelis chunk'as jau būtų sukauptas.
     *
     * ⚠️ TAI NĖRA PEAK-RAM HARD CAP. Chunk'as jau gautas, dekoduotas į JS
     * string'ą ir prijungtas prie `buffer`, ir TIK tada tikrinama. Riba
     * neleidžia parse buferiui augti TOLIAU, bet negarantuoja, kad proceso
     * atmintis niekada neviršys ribos dėl vieno patologinio chunk'o. Tai
     * ankstyviausias kontrolės taškas PO gauto chunk'o dekodavimo.
     *
     * Būtent čia atmintis auga nekontroliuojamai: patologinis `done` įvykis su
     * 50 000 segmentų vienu JSON būtų sukauptas visas prieš `JSON.parse`.
     *
     * `STREAM_TOTAL_BYTES` – transporto kvota: kaupiami baitai nuo ryšio
     * pradžios. NEsaugo atminties (pilni įvykiai iš buferio pašalinami iškart),
     * bet riboja begalinį srautą.
     *
     * ⚠️ Ankstesnė versija turėjo TIK kaupiamą skaitiklį ir vadino jį RAM
     * apsauga. Tai buvo neteisinga: siunčiant normalius `progress` įvykius
     * buferio maksimumas yra 0 baitų, o skaitiklis auga.
     */
    let streamTotal = 0;
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      /**
       * `byteLength`, BE fallback į `.length` (#153).
       *
       * `MAX_STREAM_TOTAL_BYTES` yra VIEŠAS env kontraktas, deklaruojantis
       * baitus. `fetch()` Web Stream duoda `Uint8Array`, tad `byteLength`
       * visada yra.
       *
       * ⚠️ Fallback `?? chunk.length` būtų panaikinęs pačią garantiją: jei
       * chunk'as kada nors būtų ne baitų tipo (pvz. string'as), `.length`
       * grąžintų SIMBOLIŲ skaičių, ir riba tyliai imtų reikšti ne baitus. Geriau
       * aiški klaida nei neteisingai interpretuotas kontraktas.
       */
      if (typeof chunk.byteLength !== "number") {
        throw new TypeError(
          "SSE srautas grąžino ne baitų tipo chunk'ą – MAX_STREAM_TOTAL_BYTES " +
            "kontraktas reikalauja baitų."
        );
      }
      streamTotal += chunk.byteLength;
      assertWithinLimit(LIMIT_KIND.STREAM_TOTAL_BYTES, streamTotal);

      buffer += decoder.decode(chunk, { stream: true });
      assertWithinLimit(LIMIT_KIND.STREAM_BUFFER_BYTES, Buffer.byteLength(buffer, "utf8"));
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
