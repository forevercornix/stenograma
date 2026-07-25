"""
Minimalus pyannote.audio diarizacijos HTTP serveris.

KODĖL TAI EGZISTUOJA: backend'o PyannoteDiarizationProvider.js tikisi ATSKIRAI
paleisto HTTP serverio (PYANNOTE_URL), bet iki šiol jokia jo realizacija nebuvo
pateikta - vartotojas turėjo pats jį parašyti, ir dėl nesutampančio lauko
pavadinimo / endpoint'o gaudavo 400 be aiškios priežasties. Šis failas pateikia
TIKSLIAI tą kontraktą, kurio tikisi providerio klasė:

  POST /diarize   (multipart/form-data)
    laukas "file"          - audio failas (privalomas)
    laukas "num_speakers"  - sveikas skaičius (neprivalomas)
  Atsakymas: {"turns": [{"start": <sek>, "end": <sek>, "speaker": "SPEAKER_00"}, ...]}

  GET /health  ->  {"status": "ok", "model_loaded": true|false}

Modelis įkeliamas VIENĄ kartą paleidžiant (ne kiekvienai užklausai), tad tinka
"server" profiliui su daug užklausų. Reikia HUGGINGFACE_TOKEN aplinkos kintamojo
(pyannote/speaker-diarization-3.1 yra gated modelis - reikia priimti sąlygas
huggingface.co ir sugeneruoti tokeną).
"""
import os
import tempfile
import subprocess
import shutil

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI(title="Stenograma pyannote diarization")

_pipeline = None
_load_error = None


def _get_pipeline():
    """Lazy-load pipeline vieną kartą. Grąžina (pipeline, error_str).

    TESTAVIMUI: jei modulio kintamasis _pipeline jau nustatytas (pvz. testas
    įdėjo mock pipeline), jis naudojamas - tad /diarize kontraktą galima
    testuoti BE gated modelio ir BE GPU (žr. test_diarize_integration.py).
    """
    global _pipeline, _load_error
    if _pipeline is not None or _load_error is not None:
        return _pipeline, _load_error
    try:
        import torch
        from pyannote.audio import Pipeline

        token = os.environ.get("HUGGINGFACE_TOKEN") or os.environ.get("HF_TOKEN")
        if not token:
            _load_error = (
                "Trūksta HUGGINGFACE_TOKEN. pyannote/speaker-diarization-3.1 yra gated - "
                "priimkite sąlygas https://hf.co/pyannote/speaker-diarization-3.1 ir "
                "sugeneruokite tokeną https://hf.co/settings/tokens"
            )
            return None, _load_error

        model_name = os.environ.get("PYANNOTE_MODEL", "pyannote/speaker-diarization-3.1")
        pipeline = Pipeline.from_pretrained(model_name, use_auth_token=token)

        # GPU jei prieinama (device=cuda) - kitaip CPU.
        if torch.cuda.is_available():
            pipeline.to(torch.device("cuda"))
        _pipeline = pipeline
    except Exception as e:  # noqa: BLE001 - norime bet kokią klaidą grąžinti kaip tekstą
        _load_error = f"{type(e).__name__}: {e}"
    return _pipeline, _load_error


@app.get("/health")
def health(probe: bool = False):
    """
    Health būsena su AIŠKIA priežastimi, jei modelis neįkeltas.

    Numatytai (probe=false) NEKRAUNA modelio priverstinai - grąžina esamą būseną
    greitai (tinka dažnam monitoringui). Su ?probe=true PABANDO įkelti modelį ir
    grąžina konkrečią klaidą, jei nepavyksta (tinka diagnostikai po deploy).

    HTTP statusas atspindi būseną: 200 kai modelis įkeltas (ar dar nebandyta be
    probe), 503 kai probe=true ir įkelti NEPAVYKO - kad monitoringas/healthcheck
    realiai matytų problemą, o ne visada "ok".
    """
    global _pipeline, _load_error

    if probe and _pipeline is None:
        _get_pipeline()  # pabando įkelti; užpildo _pipeline arba _load_error

    loaded = _pipeline is not None
    body = {"status": "ok" if loaded else "degraded", "model_loaded": loaded}

    if not loaded:
        if _load_error:
            body["reason"] = _load_error
        elif not (os.environ.get("HUGGINGFACE_TOKEN") or os.environ.get("HF_TOKEN")):
            # Dažniausia priežastis - trūkstamas tokenas - pranešama net BE probe,
            # nes tai galima nustatyti neįkeliant modelio.
            body["reason"] = (
                "Trūksta HUGGINGFACE_TOKEN aplinkos kintamojo. pyannote/speaker-diarization-3.1 "
                "yra gated modelis - priimkite sąlygas https://hf.co/pyannote/speaker-diarization-3.1 "
                "ir sugeneruokite tokeną https://hf.co/settings/tokens"
            )
        else:
            body["reason"] = (
                "Modelis dar neįkeltas (lazy-load vyksta pirmos /diarize užklausos metu). "
                "Norėdami patikrinti įkėlimą dabar, kvieskite /health?probe=true"
            )

    status_code = 200 if (loaded or not probe) else 503
    return JSONResponse(status_code=status_code, content=body)


def _convert_to_wav(src_path):
    """
    Konvertuoja audio į 16kHz mono WAV per ffmpeg. Grąžina naujo failo kelią arba None,
    jei ffmpeg nėra arba konvertavimas nepavyko (tada kvietėjas naudos originalą).

    KODĖL: pyannote/torchaudio ilgą MP3 apdoroja nestabiliai (MPEG_LAYER_III warning'ų
    srautas, įstrigimas). 16kHz mono WAV - formatas, kurį pyannote mėgsta.

    LOGGING: nesėkmės NEtylios - įspėjam (ffmpeg nerastas, timeout, blogas failas,
    pilnas diskas), kad diegiantysis matytų, jog konvertavimas neįvyko ir naudojamas
    originalas (kuris ilgam MP3 gali strigti).
    """
    if not shutil.which("ffmpeg"):
        print("[pyannote] ⚠️  ffmpeg nerastas - MP3->WAV konvertavimas praleistas, "
              "naudojamas originalas (ilgas MP3 gali strigti). Įdiekite ffmpeg.", flush=True)
        return None
    out_path = src_path + ".conv.wav"
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", src_path, "-ar", "16000", "-ac", "1", out_path],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=int(os.environ.get("FFMPEG_TIMEOUT_SEC", "600")),
        )
        if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
            return out_path
        print("[pyannote] ⚠️  ffmpeg konvertavimas davė tuščią failą - naudojamas originalas.", flush=True)
    except subprocess.TimeoutExpired:
        print(f"[pyannote] ⚠️  ffmpeg konvertavimas viršijo laiko limitą "
              f"({os.environ.get('FFMPEG_TIMEOUT_SEC', '600')}s) - naudojamas originalas.", flush=True)
    except subprocess.CalledProcessError as e:
        err = (e.stderr or b"").decode("utf-8", "replace")[-300:] if e.stderr else ""
        print(f"[pyannote] ⚠️  ffmpeg konvertavimas nepavyko - naudojamas originalas. {err}", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"[pyannote] ⚠️  ffmpeg konvertavimo klaida ({type(e).__name__}) - naudojamas originalas.", flush=True)
    # Nesėkmės atveju - išvalom galimą dalinį failą
    if os.path.exists(out_path):
        try:
            os.unlink(out_path)
        except OSError:
            pass
    return None


@app.post("/diarize")
async def diarize(file: UploadFile = File(...), num_speakers: int = Form(None)):
    pipeline, err = _get_pipeline()
    if pipeline is None:
        # 503, ne 400 - problema serverio pusėje (modelis neįkeltas), ne kliento.
        raise HTTPException(status_code=503, detail=f"Pipeline neįkeltas: {err}")

    suffix = os.path.splitext(file.filename or "audio.wav")[1] or ".wav"
    tmp_path = None
    try:
        # CHUNKED kopijavimas (ne await file.read()), kad didelis (iki 500MB) audio
        # NEbūtų visas sukrautas į RAM prieš rašant į diską - antraip pyannote servisas
        # gautų ~failo dydžio RAM šuolį kiekvienai užklausai. Skaitome ir rašome po
        # 1MB gabalais, tad RAM naudojimas lieka pastovus nepriklausomai nuo failo dydžio.
        CHUNK_SIZE = 1024 * 1024  # 1MB
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp_path = tmp.name
            while True:
                chunk = await file.read(CHUNK_SIZE)
                if not chunk:
                    break
                tmp.write(chunk)

        kwargs = {}
        if num_speakers:
            kwargs["num_speakers"] = int(num_speakers)

        # AUTOMATINIS konvertavimas į WAV, jei įėjimas ne WAV. RASTA realiai (4 val. MP3):
        # ilgas MP3 pyannote/torchaudio kelyje sukelia begalinį MPEG_LAYER_III warning'ų
        # srautą ir įstrigimą. WAV (16kHz mono) veikia švariai. Konvertuojame per ffmpeg;
        # jei ffmpeg nėra ar konvertavimas krinta - bandome originalą (geriau bandyti nei
        # iškart klaida). Išjungiama PYANNOTE_AUTO_WAV=false.
        audio_path = tmp_path
        converted_path = None
        auto_wav = os.environ.get("PYANNOTE_AUTO_WAV", "true").lower() != "false"
        if auto_wav and suffix.lower() != ".wav":
            converted_path = _convert_to_wav(tmp_path)
            if converted_path:
                audio_path = converted_path

        try:
            diarization = pipeline(audio_path, **kwargs)
        finally:
            if converted_path and os.path.exists(converted_path):
                os.unlink(converted_path)

        turns = [
            {"start": float(turn.start), "end": float(turn.end), "speaker": str(speaker)}
            for turn, _, speaker in diarization.itertracks(yield_label=True)
        ]
        return JSONResponse({"turns": turns})
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Diarizacijos klaida: {type(e).__name__}: {e}")
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8001"))
    uvicorn.run(app, host="0.0.0.0", port=port)
