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
from fastapi.responses import JSONResponse

app = FastAPI(title="Stenograma faster-whisper transcription")

_model = None
_load_error = None

# Concurrency limitas: keli vienalaikiai transkribavimai dalintųsi ta pačia GPU/CPU.
# Semaforas riboja, kad neperkrautų VRAM/CPU (kiekvienas transcribe() naudoja modelį).
_MAX_CONCURRENCY = int(os.environ.get("WHISPER_MAX_CONCURRENCY", "2"))
_semaphore = asyncio.Semaphore(_MAX_CONCURRENCY)


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


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: str = Form("lt"),
    diarize: str = Form("false"),  # priimamas suderinamumui, bet šis servisas nediariziuoja
):
    model, err = _get_model()
    if model is None:
        # 503 - serverio pusės problema (modelis neįkeltas), ne kliento klaida.
        raise HTTPException(status_code=503, detail=f"Modelis neįkeltas: {err}")

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

        # Semaforas: ribojam vienalaikius transkribavimus (VRAM/CPU apsauga).
        async with _semaphore:
            # faster-whisper yra sinchroninis - paleidžiam thread pool'e, kad
            # neblokuotų event loop (kiti /health ar užklausos vis tiek atsakomos).
            result = await asyncio.to_thread(_run_transcription, model, tmp_path, language)
        return JSONResponse(result)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Transkribavimo klaida: {type(e).__name__}: {e}")
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)


def _run_transcription(model, audio_path, language):
    """Sinchroninis transkribavimas (kviečiamas iš thread pool). Grąžina dict,
    atitinkantį FasterWhisperProvider.js laukiamą formatą."""
    lang = None if not language or language == "auto" else language
    segments_iter, info = model.transcribe(audio_path, language=lang)

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
