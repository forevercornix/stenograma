# Whisper transkribavimo serveris (persistentus)

Minimalus FastAPI serveris, teikiantis kalbos transkribavimą per `faster-whisper`.
Backend'o `FasterWhisperProvider` kviečia jį per HTTP (`FASTER_WHISPER_URL`).

## Embedded vs. server (kodėl du variantai)

Yra du būdai naudoti faster-whisper:

**Embedded** (`FasterWhisperEmbeddedProvider`, `TRANSCRIPTION_PROVIDER=faster-whisper-embedded`):
Node spawn'ina naują Python procesą KIEKVIENAI užklausai. Modelis kraunamas iš
naujo kaskart. Paprasta (nereikia atskiro serviso/prievado), tinka vieno vartotojo
desktop scenarijui. Trūkumas: ilgas starto laikas ir pakartotinis VRAM užėmimas
kiekvienai užklausai.

**Server** (šis servisas, `TRANSCRIPTION_PROVIDER=faster-whisper-server`):
Modelis įkeliamas VIENĄ kartą paleidžiant ir laikomas atmintyje/VRAM tarp užklausų.
Privalumai: mažesnis latency, kontroliuojamas VRAM, aiškus concurrency limitas
(semaforas), lengvesnis horizontalus skalavimas. Tinka bendram serveriui su daug
vienalaikių vartotojų. Simetriška pyannote-server architektūrai.

## Kontraktas

```
POST /transcribe   (multipart/form-data)
  file      - audio failas (privalomas)
  language  - ISO kalbos kodas (numatyta 'lt'; 'auto' = automatinis nustatymas)
  diarize   - "true"/"false" (šis servisas diarizacijos NEDARO - žr. pyannote-server)
→ {text, segments: [{start, end, text}], language, avg_logprob}

GET /health              → greita būsena (nekrauna modelio)
GET /health?probe=true   → PRIVERSTINAI įkelia modelį; 503 jei nepavyksta
```

## Paleidimas lokaliai

```bash
pip install -r requirements.txt   # arba requirements-cpu.lock.txt determinizmui
export WHISPER_MODEL=small WHISPER_DEVICE=cpu
python server.py                  # klausosi :8000
```

Backend'e: `TRANSCRIPTION_PROVIDER=faster-whisper-server FASTER_WHISPER_URL=http://localhost:8000/transcribe`.

## Docker

CPU: `docker build -t whisper . && docker run -p 8000:8000 whisper`
GPU: `Dockerfile.gpu` (CUDA + GPU torch). Paprasčiausia - `docker-compose.server.yml`
iš projekto šaknies (persistentūs Whisper + pyannote GPU stacke).

## Konfigūracija

| Env | Numatyta | Aprašymas |
|---|---|---|
| `WHISPER_MODEL` | `small` | tiny/base/small/medium/large-v3 (tiny haliucinuoja lietuviškai) |
| `WHISPER_DEVICE` | `cpu` | cpu / cuda |
| `WHISPER_COMPUTE_TYPE` | `int8` (cpu) / `float16` (gpu) | tikslumas/greitis |
| `WHISPER_MAX_CONCURRENCY` | `2` | vienalaikių transkribavimų limitas (VRAM/CPU apsauga) |
| `PORT` | `8000` | |

## Testai

```bash
pip install fastapi python-multipart pytest
pytest test_server.py test_transcribe_integration.py -v
```
- `test_server.py` - `/health` diagnostika, `/transcribe` klaidų kelias be modelio.
- `test_transcribe_integration.py` - MOCK modelis, `{text, segments}` kontraktas
  end-to-end. **Būtent toks testas būtų pagavęs "serverio nėra" problemą** (provideris
  egzistavo, realizacijos nebuvo). Vykdomi CI'e (be sunkaus modelio atsisiuntimo).

## Statusas

Failų įkėlimas naudoja **chunked kopijavimą** (1MB gabalais) - didelis audio
nesukraunamas visas į RAM. `/health` diagnostika ir `/transcribe` kontraktas
realiai išbandyti (FastAPI TestClient + pilna backend→whisper-server HTTP grandinė
su mock modeliu). Tikras faster-whisper modelis su GPU (`device=cuda`) - **nebuvo
išbandytas šioje aplinkoje** (reikia GPU); patikrinkite pirmo paleidimo metu.
