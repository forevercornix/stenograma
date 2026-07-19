# Pyannote diarizacijos serveris

Minimalus FastAPI serveris, teikiantis kalbėtojų atskyrimą (diarizaciją) per
`pyannote.audio`. Backend'o `PyannoteDiarizationProvider` kviečia šį serverį per
HTTP (`PYANNOTE_URL`).

## Kodėl atskiras servisas

`pyannote.audio` yra Python biblioteka su sunkiu modeliu, kurį verta įkelti VIENĄ
kartą ir laikyti atmintyje (ypač GPU), ne krauti kiekvienai užklausai. Backend'as
(Node) su juo bendrauja per paprastą HTTP kontraktą, tad diarizacijos servisas
gali būti perkraunamas/skalė nepriklausomai.

## Kontraktas

```
POST /diarize   (multipart/form-data)
  file          - audio failas (privalomas)
  num_speakers  - sveikas skaičius (neprivalomas)
→ {"turns": [{"start": <sek>, "end": <sek>, "speaker": "SPEAKER_00"}, ...]}

GET /health              → greita būsena (nekrauna modelio)
GET /health?probe=true   → PRIVERSTINAI bando įkelti modelį; 503 jei nepavyksta
```

## HUGGINGFACE_TOKEN (būtinas)

`pyannote/speaker-diarization-3.1` yra „gated" modelis:

1. Priimkite sąlygas: https://hf.co/pyannote/speaker-diarization-3.1
2. Sugeneruokite tokeną: https://hf.co/settings/tokens
3. Nustatykite `HUGGINGFACE_TOKEN=hf_...` aplinkoje (arba `.env`).

Be tokeno `/health` grąžins `status: degraded` su aiškia priežastimi (ne tuščią
`model_loaded: false`), o `/diarize` grąžins 503.

## Paleidimas lokaliai (be Docker)

```bash
pip install -r requirements.txt
pip install torch --index-url https://download.pytorch.org/whl/cpu   # arba cu124 GPU
export HUGGINGFACE_TOKEN=hf_...
python server.py    # klausosi :8001
```

## Paleidimas per Docker

CPU: `docker build -t pyannote . && docker run -p 8001:8001 -e HUGGINGFACE_TOKEN=hf_... pyannote`

GPU: naudokite `Dockerfile.gpu` (CUDA image + GPU torch) ir `--gpus all`. Paprasčiausia -
per `docker-compose.gpu.yml` iš projekto šaknies (`make docker-gpu`).

## Testai

Du lygiai (kaip rekomenduojama gated modeliui):

**1. Kontrakto testai (mock pipeline) - visada, be tokeno/GPU:**
```bash
pip install fastapi python-multipart pytest
pytest test_server.py test_diarize_integration.py -v
```
- `test_server.py` - `/health` diagnostika, `/diarize` klaidų kelias be tokeno.
- `test_diarize_integration.py` - realiai paleidžia serverį su MOCK pipeline,
  įkelia audio per `/diarize` ir validuoja `{turns:[...]}` kontraktą end-to-end.
  **Būtent toks testas būtų anksčiau pagavęs pagrindinę problemą** (provideris
  egzistavo, serverio nebuvo). Šie testai vykdomi CI'e.

**2. Realaus modelio testas - pasirenkamas, su tokenu:**
```bash
export HUGGINGFACE_TOKEN=hf_...
pip install -r requirements.txt   # pilnas pyannote.audio + torch
pytest test_real_gpu.py -v -s
```
Atsisiunčia tikrą modelį ir realiai diarizuoja. Be `HUGGINGFACE_TOKEN`
automatiškai praleidžiamas.

## Priklausomybių versijos

`requirements.txt` naudoja minimalias (`>=`) versijas - patogu vystymui, bet
produkcijai/RunPod naudokite užfiksuotus lock failus deterministiniam diegimui:
`requirements-cpu.lock.txt` arba `requirements-gpu.lock.txt` (torch įdiegiamas
atskirai su tinkamu `--index-url` - žr. failų komentarus). Docker image'ai jau
naudoja lock failus.

## Statusas

Failų įkėlimas naudoja **chunked kopijavimą** (1MB gabalais), ne `await file.read()` -
tad didelis (iki 500MB) audio nesukraunamas visas į RAM, o RAM naudojimas lieka
pastovus nepriklausomai nuo failo dydžio.


HTTP kontraktas ir `/health` diagnostika - realiai išbandyti (FastAPI TestClient,
žr. `test_server.py`). Tikras diarizavimas su realiu `pyannote.audio` modeliu ir
GPU - **nebuvo išbandytas šioje aplinkoje** (reikia gated modelio ir GPU);
patikrinkite pirmo paleidimo metu savo mašinoje.
