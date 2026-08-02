"""
Persistentus faster-whisper transkribavimo HTTP serveris.

KODĖL TAI EGZISTUOJA: backend'o FasterWhisperProvider.js tikisi ATSKIRAI paleisto
HTTP serverio (FASTER_WHISPER_URL), bet iki šiol jokia jo realizacija nebuvo
pateikta - lygiai kaip anksčiau su pyannote. Šis failas pateikia tiksliai tą
kontraktą, kurio tikisi providerio klasė.

SKIRTUMAS nuo FasterWhisperEmbeddedProvider (embedded profilis): ten Node
spawn'ina NAUJĄ Python procesą kiekvienai užklausai, tad modelis kraunamas IŠ
NAUJO kaskart (ilgas starto laikas, pakartotinis VRAM užėmimas). ŠIS servisas
įkelia modelį VIENĄ kartą paleidžiant ir laiko jį atmintyje/VRAM tarp užklausų:
  - vienkartinis modelio įkėlimas (mažesnis latency);
  - kontroliuojamas VRAM (ne šuoliai kiekvienai užklausai);
  - aiškus concurrency limitas (semaforas);
  - lengvesnis horizontalus skalavimas (keli servisai už load balancer).
Tai simetriška pyannote-server architektūrai.

Kontraktas (atitinka FasterWhisperProvider.js):
  POST /transcribe   (multipart/form-data)
    file      - audio failas (privalomas)
    language  - ISO kalbos kodas (numatyta 'lt')
    diarize   - "true"/"false" (šis servisas diarizacijos NEDARO - žr. pyannote-server)
  → {text, segments: [{start, end, text}], language, avg_logprob}

  GET /health              → greita būsena (nekrauna modelio)
  GET /health?probe=true   → PRIVERSTINAI įkelia modelį; 503 jei nepavyksta

Modelis parenkamas per WHISPER_MODEL (numatyta 'small'), įrenginys per
WHISPER_DEVICE (cpu/cuda), tikslumas per WHISPER_COMPUTE_TYPE.
"""
import asyncio
import os
import tempfile

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
import json as _json
import queue as _queue
import threading as _threading

app = FastAPI(title="Stenograma faster-whisper transcription")

_model = None
_load_error = None

# Concurrency limitas: keli vienalaikiai transkribavimai dalintųsi ta pačia GPU/CPU.
# Semaforas riboja, kad neperkrautų VRAM/CPU (kiekvienas transcribe() naudoja modelį).
_MAX_CONCURRENCY = int(os.environ.get("WHISPER_MAX_CONCURRENCY", "2"))
# VIENAS bendras concurrency valdiklis ABIEM endpointams (/transcribe IR
# /transcribe-stream). BoundedSemaphore (ne paprastas) - kad per daug release()
# iškart mestų klaidą, ne tyliai padidintų limitą. Gaunamas per asyncio.to_thread
# abiejuose keliuose, tad bendras vienalaikių GPU transkribavimų skaičius NEViršija
# _MAX_CONCURRENCY (anksčiau du atskiri semaforai leido 2×N - defektas).
_gpu_semaphore = _threading.BoundedSemaphore(_MAX_CONCURRENCY)


def _get_model():
    """Lazy-load modelį VIENĄ kartą. Grąžina (model, error_str).

    TESTAVIMUI: jei _model jau nustatytas (testas įdėjo mock), jis naudojamas -
    tad /transcribe kontraktą galima testuoti be tikro modelio atsisiuntimo.
    """
    global _model, _load_error
    if _model is not None or _load_error is not None:
        return _model, _load_error
    try:
        from faster_whisper import WhisperModel

        model_name = os.environ.get("WHISPER_MODEL", "small")
        device = os.environ.get("WHISPER_DEVICE", "cpu")
        compute_type = os.environ.get("WHISPER_COMPUTE_TYPE", "int8" if device == "cpu" else "float16")
        _model = WhisperModel(model_name, device=device, compute_type=compute_type)
    except Exception as e:  # noqa: BLE001
        _load_error = f"{type(e).__name__}: {e}"
    return _model, _load_error


@app.get("/health")
def health(probe: bool = False):
    """Health būsena. Su ?probe=true priverstinai įkelia modelį ir grąžina 503,
    jei nepavyksta - kad healthcheck realiai matytų problemą (kaip pyannote-server)."""
    global _model, _load_error

    if probe and _model is None:
        _get_model()

    loaded = _model is not None
    body = {"status": "ok" if loaded else ("degraded" if probe else "ok"), "model_loaded": loaded}
    if not loaded and _load_error:
        body["reason"] = _load_error
    elif not loaded and not probe:
        body["reason"] = "Modelis dar neįkeltas (lazy-load pirmos /transcribe užklausos metu). Patikrinimui: /health?probe=true"

    status_code = 200 if (loaded or not probe) else 503
    return JSONResponse(status_code=status_code, content=body)


def _safe_error_detail(exc, context):
    """
    Klaidos pranešimas KLIENTUI - be vidinių detalių.

    `f"{type(e).__name__}: {e}"` atiduodavo pilną išimties tekstą, o jame būna
    failų kelių (`/tmp/stenograma-…`), modelio pavadinimų ir bibliotekų vidinių
    detalių. Backend'e tam turim `utils/sanitizeError.js`; Python servisuose ta
    pati taisyklė nebuvo taikoma, nors jie priima tas pačias užklausas.

    Pilnas tekstas VISADA logguojamas serveryje - diagnostika nenukenčia, tik
    persikelia ten, kur jai vieta.
    """
    print(f"[{context}] {type(exc).__name__}: {exc}", flush=True)
    return f"{context} nepavyko. Detalės serverio loguose."


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: str = Form("lt"),
    diarize: str = Form("false"),  # priimamas suderinamumui, bet šis servisas nediariziuoja
):
    model, err = _get_model()
    if model is None:
        # 503 - serverio pusės problema (modelis neįkeltas), ne kliento klaida.
        print(f"[whisper] Modelis neįkeltas: {err}", flush=True)
        raise HTTPException(status_code=503, detail="Modelis neįkeltas. Detalės serverio loguose.")

    suffix = os.path.splitext(file.filename or "audio.wav")[1] or ".wav"
    tmp_path = None
    try:
        # CHUNKED kopijavimas (kaip pyannote-server) - didelis audio nesukraunamas
        # visas į RAM.
        CHUNK_SIZE = 1024 * 1024
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp_path = tmp.name
            while True:
                chunk = await file.read(CHUNK_SIZE)
                if not chunk:
                    break
                tmp.write(chunk)

        # Bendras GPU semaforas (tas pats kaip /transcribe-stream). Gaunam per
        # to_thread su timeout, kad neblokuotų event loop ir nekabintų amžinai.
        wait_sec = int(os.environ.get("STREAM_QUEUE_WAIT_SEC", "300"))
        acquired = await asyncio.to_thread(_gpu_semaphore.acquire, True, wait_sec)
        if not acquired:
            raise HTTPException(status_code=503, detail="Serveris užimtas (concurrency limitas). Bandykite vėliau.")
        try:
            # faster-whisper yra sinchroninis - paleidžiam thread pool'e, kad
            # neblokuotų event loop (kiti /health ar užklausos vis tiek atsakomos).
            result = await asyncio.to_thread(_run_transcription, model, tmp_path, language)
        finally:
            _gpu_semaphore.release()
        return JSONResponse(result)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=_safe_error_detail(e, "Transkribavimas"))
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)


@app.post("/transcribe-stream")
async def transcribe_stream(
    file: UploadFile = File(...),
    language: str = Form("lt"),
    diarize: str = Form("false"),
):
    """
    SSE (Server-Sent Events) variantas su PROGRESU. Siunčia:
      event: progress  data: {"percent": 0-100, "processedSec": float, "totalSec": float}
      event: done      data: {<pilnas rezultatas kaip /transcribe>}
      event: error     data: {"error": "..."}
    Skirtas ilgiems failams, kad backend galėtų rodyti progresą. Įprastas /transcribe
    lieka nepakeistas (suderinamumui). NETESTUOTA su realiu GPU - žr. RUNPOD.md.
    """
    model, err = _get_model()
    if model is None:
        print(f"[whisper] Modelis neįkeltas: {err}", flush=True)
        raise HTTPException(status_code=503, detail="Modelis neįkeltas. Detalės serverio loguose.")

    suffix = os.path.splitext(file.filename or "audio.wav")[1] or ".wav"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    tmp_path = tmp.name
    CHUNK_SIZE = 1024 * 1024
    while True:
        chunk = await file.read(CHUNK_SIZE)
        if not chunk:
            break
        tmp.write(chunk)
    tmp.close()

    async def event_gen():
        q: "_queue.Queue" = _queue.Queue(maxsize=100)
        stop = _threading.Event()  # kliento disconnect signalas worker'iui

        def worker():
            _run_stream_worker(
                model=model,
                audio_path=tmp_path,
                language=language,
                q=q,
                stop=stop,
                semaphore=_gpu_semaphore,
            )

        t = _threading.Thread(target=worker, daemon=True)
        t.start()

        try:
            while True:
                evt = await asyncio.to_thread(q.get)
                if evt[0] == "__end__":
                    break
                name, payload = evt
                yield f"event: {name}\ndata: {_json.dumps(payload)}\n\n"
        except asyncio.CancelledError:
            stop.set()  # klientas atsijungė - worker'is nutrauks (tarp segmentų) ir susivalys pats
            raise
        finally:
            stop.set()
            # NEtriname temp failo čia - tai daro worker'is finally bloke, kai TIKRAI
            # baigia (net jei tai užtrunka ilgiau nei klientas laukia). Nedarome ir
            # t.join() - neblokuojam atsakymo uždarymo; daemon thread'as susitvarko pats.

    return StreamingResponse(event_gen(), media_type="text/event-stream")


def _safe_put(q, item, stop, per_try=0.5):
    """Neblokuojantis put su stop patikra: jei queue pilna (klientas nebeskaito),
    tikrina stop ir kartoja, kol pavyksta arba gaunamas stop. Grąžina True jei įdėjo,
    False jei stop suveikė (klientas dingo). Išsprendžia amžino blocking q.put problemą."""
    while True:
        try:
            q.put(item, timeout=per_try)
            return True
        except _queue.Full:
            if stop.is_set():
                return False
            continue


def _cleanup_temp(path):
    if path and os.path.exists(path):
        try:
            os.unlink(path)
        except OSError:
            pass


def _run_stream_worker(model, audio_path, language, q, stop, semaphore,
                       stream_fn=None, cleanup_fn=None):
    """
    SSE worker'io ciklas kaip TESTUOJAMA modulio funkcija (ne closure kopija).

    Ir realus /transcribe-stream worker, IR integraciniai testai kviečia BŪTENT ŠITĄ
    funkciją - tad testas negali "nueiti į šoną" nuo realaus kodo (jei ciklas pasikeis,
    testas pamatys). stream_fn/cleanup_fn injektuojami testams (numatytai - realios).

    Elgesys: gauna semaforą (timeout); 'started'; iteruoja segmentus tikrindamas stop
    TARP jų (cooperative cancel); _safe_put False -> nutraukia; klaidą -> error event;
    finally atlaisvina semaforą, siunčia end, valo temp.
    """
    stream_fn = stream_fn or _stream_transcription
    cleanup_fn = cleanup_fn or _cleanup_temp

    wait_sec = int(os.environ.get("STREAM_QUEUE_WAIT_SEC", "300"))
    if not semaphore.acquire(timeout=wait_sec):
        _safe_put(q, ("error", {"error": "Serveris užimtas (concurrency limitas). Bandykite vėliau."}), stop)
        _safe_put(q, ("__end__", None), stop)
        cleanup_fn(audio_path)
        return
    try:
        _safe_put(q, ("started", {}), stop)
        for evt in stream_fn(model, audio_path, language):
            if stop.is_set():
                break
            if not _safe_put(q, evt, stop):
                break
    except Exception as e:  # noqa: BLE001
        _safe_put(q, ("error", {"error": f"{type(e).__name__}: {e}"}), stop)
    finally:
        semaphore.release()
        _safe_put(q, ("__end__", None), stop)
        cleanup_fn(audio_path)


def _stream_transcription(model, audio_path, language):
    """Generatorius: yield'ina ('progress', {...}) segmentuojant ir ('done', {rezultatas}).
    Progresas skaičiuojamas iš seg.end / bendros audio trukmės (info.duration)."""
    lang = None if not language or language == "auto" else language
    use_vad = os.environ.get("WHISPER_VAD_FILTER", "true").lower() != "false"
    kwargs = {"language": lang}
    if use_vad:
        kwargs["vad_filter"] = True
    segments_iter, info = model.transcribe(audio_path, **kwargs)
    total = float(getattr(info, "duration", 0) or 0)

    segments = []
    text_parts = []
    logprob_sum = 0.0
    logprob_count = 0
    last_pct = -1
    for seg in segments_iter:
        t = seg.text.strip()
        segments.append({"start": float(seg.start), "end": float(seg.end), "text": t})
        text_parts.append(t)
        if getattr(seg, "avg_logprob", None) is not None:
            logprob_sum += seg.avg_logprob
            logprob_count += 1
        if total > 0:
            pct = min(99, int((float(seg.end) / total) * 100))
            if pct != last_pct:  # siunčiam tik pasikeitus (mažiau triukšmo)
                last_pct = pct
                yield ("progress", {"percent": pct, "processedSec": float(seg.end), "totalSec": total})

    yield ("done", {
        "text": " ".join(text_parts),
        "segments": segments,
        "language": info.language,
        "avg_logprob": (logprob_sum / logprob_count) if logprob_count else None,
    })


def _run_transcription(model, audio_path, language):
    """Sinchroninis transkribavimas (kviečiamas iš thread pool). Grąžina dict,
    atitinkantį FasterWhisperProvider.js laukiamą formatą."""
    lang = None if not language or language == "auto" else language

    # VAD (voice activity detection) filtras: praleidžia tylą, kur Whisper "prasimano"
    # tekstą (YouTube-titrų halucinacijos). RASTA realiai (4 val. įrašas): be VAD ~37%
    # segmentų buvo halucinacijos tyliose vietose. VAD šalina PRIEŽASTĮ (ne pasekmę kaip
    # backend'o post-filtras). Numatyta įjungta; išjungiama WHISPER_VAD_FILTER=false.
    use_vad = os.environ.get("WHISPER_VAD_FILTER", "true").lower() != "false"
    transcribe_kwargs = {"language": lang}
    if use_vad:
        transcribe_kwargs["vad_filter"] = True
    segments_iter, info = model.transcribe(audio_path, **transcribe_kwargs)

    segments = []
    text_parts = []
    logprob_sum = 0.0
    logprob_count = 0
    for seg in segments_iter:
        t = seg.text.strip()
        segments.append({"start": float(seg.start), "end": float(seg.end), "text": t})
        text_parts.append(t)
        if getattr(seg, "avg_logprob", None) is not None:
            logprob_sum += seg.avg_logprob
            logprob_count += 1

    return {
        "text": " ".join(text_parts),
        "segments": segments,
        "language": info.language,
        "avg_logprob": (logprob_sum / logprob_count) if logprob_count else None,
    }


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
