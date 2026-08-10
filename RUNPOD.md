# Stenograma diegimas RunPod'e

**Sąžiningumo pastaba:** šis dokumentas paremtas (a) RunPod vieša dokumentacija ir
(b) realia vartotojo diegimo sesija RunPod pod'e (transkribavimas su GPU realiai
veikė; pyannote diarizacija tuo metu grąžino 400 - žr. troubleshooting žemiau).
Ne kiekvienas žingsnis buvo pakartotas nepriklausomai - jei kas nesutampa su tuo,
ką matote, pirmiausia paleiskite `npm run doctor`.

## 0. Dažnos staigmenos (perskaityk PIRMA)

Realių diegimų metu šie dalykai dažniausiai suklaidina - jie visi **normalūs**, ne gedimai:

- **Node.js 22+ NĖRA iš anksto įdiegtas.** RunPod PyTorch/CUDA image'ai turi Python ir
  CUDA, bet ne Node. Įsidiekite rankiniu būdu PRIEŠ `setup.sh` (žr. 2b, žemiau):
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
  ```
- **GPU paketų diegimas gali kelias–keliolika minučių nerodyti JOKIO progreso.** `pip`
  atsisiunčia CUDA/Torch/pyannote (keli GB) tyliai - tai NĖRA strigimas. Palaukite; jei
  visai neramu, kitame terminale stebėkite `htop` ar tinklo aktyvumą.
- **Ilgoms operacijoms naudokite `tmux`** (RunPod image'uose jau būna; jei ne -
  `apt-get install -y tmux`). Jei SSH ryšys nutrūksta build'o metu be tmux, procesas
  žūva ir tenka pradėti iš naujo. Su tmux jis tęsiasi:
  ```bash
  tmux new -s stenograma      # paleisti sesiją
  # ... paleidžiate setup.sh / docker build ...
  # atsijungti nuo sesijos (procesas lieka veikti): Ctrl+B, tada D
  tmux attach -t stenograma   # grįžti vėliau
  ```
- **`setup.sh` pabaigoje išvardija likusius žingsnius** (HF token, Claude API raktas,
  `make demo`) - perskaitykite tą pabaigą, ten pasakyta, ko dar reikia.
- **Portų konfliktas su RunPod nginx.** RunPod'e numatyti portai (backend `3001`,
  pyannote `8001`) gali būti jau užimti proxy/nginx. Tada `make gpu` nepasileidžia -
  NE dėl HF/Claude/CUDA/faster-whisper, o dėl porto konflikto. Sprendimas - perrašykite
  portus (jie konfigūruojami):
  ```bash
  make gpu BACKEND_PORT=4001 PYANNOTE_PORT=9001
  ```
  Portai perduodami ir serveriams, ir jų tarpusavio sąsajai (`PYANNOTE_URL`)
  automatiškai. Nepamirškite atitinkamai atnaujinti RunPod "Expose HTTP Ports" ir,
  jei naudojate frontend'ą, jo `VITE_BACKEND_URL`.
- **`make verify` su nestandartiniu portu.** Jei backend'as ne ant 3001, nurodykite portą:
  ```bash
  make verify BACKEND_PORT=4001
  # arba su pilnu RunPod proxy URL:
  BACKEND=https://<POD_ID>-4001.proxy.runpod.net make verify
  ```
  ⚠️ **Ką `make verify` (smoke) patikrina ir ko NE.** Smoke naudoja trumpą sintetinį
  WAV, tad įrodo tik, kad grandinė VEIKIA (WAV → transkripcija → diarizacija →
  protokolas per tikrą HTTP). Jis **NEpatvirtina**: lietuviškos žmogaus kalbos kokybės
  su `large-v3`; kelių kalbėtojų diarizacijos tikslumo; ilgo (kelių valandų) failo
  stabilumo; realaus frontend įkėlimo; didelio failo RAM/disko naudojimo. Šiuos
  patikrinkite su tikru įrašu prieš produkcinį naudojimą.
- **Pyannote naudoja SAVO venv Python, ne sisteminį.** `make setup-gpu` diegia pyannote
  į izoliuotą `pyannote-server/.venv`, ir `make pyannote` paleidžia būtent
  `pyannote-server/.venv/bin/python`. Tad JEI reikia papildomo paketo pyannote'ui,
  diekite jį į TĄ venv, ne per sisteminį `pip`/`python3` (kitaip serveris jo nematys):
  ```bash
  pyannote-server/.venv/bin/python -m pip install <paketas>
  ```
- **`hf_transfer` RunPod'e praktiškai BŪTINAS.** Be jo pyannote/Whisper modelių
  atsisiuntimas iš Hugging Face RunPod'e dažnai **nutrūksta arba timeout'ina** (dideli
  failai + nestabilus tinklas), ir serveris nepasileidžia. Su `hf_transfer` (paralelinis,
  atsparesnis atsisiuntimas) - pavyksta. Įdiekite į venv IR įjunkite PRIEŠ pirmą
  paleidimą:
  ```bash
  pyannote-server/.venv/bin/python -m pip install hf_transfer
  export HF_HUB_ENABLE_HF_TRANSFER=1
  ```
  ⚠️ Kitose aplinkose (stabilus tinklas) be jo gali veikti - bet RunPod'e nerekomenduojama
  bandyti be jo, sutaupysite laiko.

## 1. Pod'o pasirinkimas

| Parametras | Rekomendacija | Kodėl |
|---|---|---|
| Image / Template | **RunPod PyTorch** (pvz. `runpod/pytorch:*-cuda12*`) arba bet koks CUDA 12 image su Ubuntu | Jau turi Python + CUDA tvarkykles; Node įsidiegsite patys (žr. 2) |
| GPU | RTX 3090 / 4090 (24GB) - su kaupu | `small` modeliui užtenka ~2GB VRAM, `large-v3` fp16 ~4-5GB; 24GB palieka vietos ir pyannote |
| VRAM | 12GB+ pilnai pakanka | Žr. aukščiau |
| Sistemos RAM | 16GB+ | Audio dekodavimas + Node + buferiai; daugiau nespartina |
| Container Disk | 20GB+ | OS + npm/pip paketai |
| **Volume** (network volume!) | 20-50GB, mount `/workspace` | **Modeliai ir projektas Volume'e IŠLIEKA sustabdžius pod'ą; container diskas - NE** |

## 2. Diegimas pod'e

Yra du keliai - **Docker** (rekomenduojama, izoliuota, viena komanda) arba
**native** (be Docker, kaip realioje sesijoje).

### 2a. Docker kelias (rekomenduojama)

```bash
cd /workspace                     # SVARBU: /workspace = volume = išlieka
git clone <jūsų-repo> stenograma  # arba įkelkite zip per RunPod file manager
cd stenograma

# Modelių cache į PERSISTENT volume, kad neatsisiųstų kaskart iš naujo:
export MODEL_CACHE_DIR=/workspace/models
export HUGGINGFACE_TOKEN=hf_...   # pyannote diarizacijai

make quickstart-runpod            # RunPod-specifinis: 1 viešas prievadas + nginx /api proxy
```

`make quickstart-runpod` naudoja `docker-compose.runpod.yml` (atskirą nuo lokalaus
scenarijaus): frontend eksponuojamas `0.0.0.0:5173` (RunPod proxy pasiekia), o
backend/pyannote lieka vidiniame Docker tinkle - frontend nginx `/api` proxy juos
pasiekia. **RunPod pod nustatymuose atidarykite tik `5173`.** Frontend adresas:
`https://<POD_ID>-5173.proxy.runpod.net`. Jokio CORS ir jokio `VITE_BACKEND_URL`
perbuildinimo (santykinis `/api`).

### 2b. Native kelias (be Docker)

```bash
cd /workspace
git clone <jūsų-repo> stenograma && cd stenograma

# Node 22+ (PyTorch image jo neturi):
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs

export HUGGINGFACE_TOKEN=hf_...
./setup.sh --gpu                  # įdiegia viską (+ pyannote venv) + paleidžia doctor
make gpu                          # pyannote + backend su GPU ir diarizacija
```

## 3. Konfigūracija (`backend/.env`)

```bash
TRANSCRIPTION_PROVIDER=faster-whisper-embedded
FASTER_WHISPER_MODEL=large-v3          # arba /workspace/modeliai/... jei lokalus
FASTER_WHISPER_DEVICE=cuda
FASTER_WHISPER_COMPUTE_TYPE=float16    # GPU - float16, ne int8
FASTER_WHISPER_MAX_CONCURRENCY=1       # pirmam testui - žr. backend/README.md
MAX_UPLOAD_MB=500
LLM_PROVIDER=claude
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MAX_TOKENS=16000             # ilgiems (kelių val.) posėdžiams
CORS_ORIGIN=https://<POD_ID>-5173.proxy.runpod.net   # frontend'o proxy URL!
DIARIZATION_PROVIDER=none              # arba pyannote - žr. 6 skyrių
```

Modelis atsisiųs automatiškai iš HuggingFace pirmo naudojimo metu - laikykite
HF cache Volume'e, kad neatsisiuntinėtų kaskart: `export HF_HOME=/workspace/hf-cache`
(pridėkite į `~/.bashrc`).

## 4. Prievadai ir 100 sekundžių limitas

RunPod pod'o nustatymuose **Expose HTTP Ports**: `3001` (backend) ir `5173` (frontend).

⚠️ **KRITINIS apribojimas:** RunPod HTTP proxy (`https://<POD_ID>-<PORT>.proxy.runpod.net`)
turi **kietą ~100s limitą vienai užklausai**, nepriklausomą nuo backend nustatymų.
Todėl frontend'as pagal nutylėjimą naudoja **asinchroninį** `POST /api/transcribe-jobs`
+ polling (kiekvienas kvietimas trunka sekundes) - nieko papildomai konfigūruoti
nereikia. Sinchroninis `POST /api/transcribe` per šį proxy ilgiems failams NEVEIKS.
Alternatyva be limito: **Expose TCP Ports** (bet be automatinio HTTPS).

Frontend paleidimas su proxy:
```bash
cd frontend
# frontend/.env: VITE_BACKEND_URL=https://<POD_ID>-3001.proxy.runpod.net
npm run dev -- --host 0.0.0.0
```

### 4b. Vidinis backend↔servisų timeout (ilgi failai)

Atskiras dalykas nuo RunPod proxy limito aukščiau: backend'as, kviesdamas pyannote/Whisper
servisus per HTTP, turi savo timeout. **RASTA REALIAI (4 val. įrašas):** anksčiau jis buvo
fiksuotas 90s, todėl ilgo failo diarizacija/transkripcija nutrūkdavo su
`viršijo 90000ms limitą`, NORS pyannote realiai užbaigdavo darbą (`POST /diarize 200 OK`
matėsi jau PO klaidos). Dabar timeout **proporcingas audio trukmei** (nuo 5 min iki 90 min),
tad ilgi failai praeina be papildomos konfigūracijos.

Jei vis tiek reikia perrašyti (labai ilgi ar lėti failai):
```bash
# Bendras fiksuotas timeout (perrašo proporcingą skaičiavimą):
API_TIMEOUT_MS=3600000 make gpu BACKEND_PORT=4001 PYANNOTE_PORT=9001   # 60 min
# Arba proporcingo skaičiavimo ribos:
#   AUDIO_TIMEOUT_MAX_MS  - viršutinė riba (numatyta 90 min)
#   AUDIO_TIMEOUT_MS_PER_SEC - ms vienai audio sekundei (numatyta 4000)
```
⚠️ Ilgi MP3 pyannote'ui problematiški (žr. §0). Ilgus įrašus konvertuokite į WAV:
`ffmpeg -i input.mp3 -ar 16000 -ac 1 output.wav`.

### 4b-progress. SSE progresas ilgiems failams (EKSPERIMENTINIS)

Ilgo failo progresą (`progress` laukas) galima įjungti `WHISPER_STREAM_PROGRESS=true`.
Numatytai IŠJUNGTA. Prieš įjungiant produkcijoje - perskaitykite šias ribas.

**Sąžininga testavimo riba.** Tikras HTTP atsijungimas SSE srauto viduryje automatiniuose
testuose NĖRA padengtas. FastAPI `TestClient` SSE atsakymą perskaito sinchroniškai, todėl
juo patikimai neimituojamas realus kliento ar tarpinio proxy ryšio nutrūkimas vykstant
transkripcijai. Unit lygmenyje patikrinta, kad gavus `stop` signalą: `_safe_put()`
neužstringa pilnoje queue, grąžina `False`, worker'io ciklas gali cooperative būdu baigti
darbą, o temp failas paliekamas worker'iui ir neištrinamas, kol jis dar naudojamas. Tai
patvirtina vidinę cancellation logiką, bet NEĮRODO visos realios HTTP grandinės elgesio.
Tikras mid-stream disconnect per naršyklę → Node backend → RunPod proxy → Python SSE
serverį lieka RunPod integraciniam testui.

**Kodėl RunPod testas čia prasmingas (ne formalumas).** Atsijungimas priklauso nuo visos
grandinės. Proxy gali: kurį laiką laikyti nutrūkusį ryšį atvirą; buferizuoti SSE; apie
disconnect pranešti tik po timeout; nutraukti Node ryšį, bet ne iš karto Python ryšį.
Realiame teste reikia patikrinti, ar atsijungimas iš tikrųjų sukelia Python generatoriaus
`asyncio.CancelledError` ir todėl nustato `stop.set()`.

**Cooperative cancellation.** `faster-whisper` cancellation yra cooperative: vykdymas
sustabdomas tik TARP sugeneruojamų segmentų. Jau vykdomo modelio segmento hard
cancellation NEpalaikomas (reikėtų atskiro proceso modelio).



RASTA realiai testuojant (4 val. lietuviškas įrašas su prastesniu Teams garsu):

- **Per daug kalbėtojų? Naudokite `numSpeakers`.** Be šio parametro pyannote linkęs
  PER DAUG skaidyti (4 val. teste rado 18 "kalbėtojų", nors realiai buvo mažiau) - tas
  pats žmogus su svyruojančiu garsu priskiriamas naujam ID. Jei žinote realų skaičių:
  ```bash
  curl ... -F "audio=@failas.wav" -F "diarize=true" -F "numSpeakers=8"
  ```
- **Halucinacijos tyloje filtruojamos automatiškai.** Whisper tyliose vietose "prasimano"
  YouTube-titrų tekstą; backend'as juos pašalina automatiškai (segmentai be kalbėtojo su
  žinomais šablonais). Išjungti: `FILTER_HALLUCINATIONS=false`. Papildomi šablonai:
  `HALLUCINATION_EXTRA_PATTERNS="frazė1,frazė2"`. Idealesnis sprendimas ateičiai -
  faster-whisper `vad_filter` (šalina priežastį).
- **Laukas `audio` arba `file`.** Įkeliant failą priimami abu lauko pavadinimai
  (`-F "audio=@..."` ir `-F "file=@..."`) - anksčiau tik `audio`.

## 5. Patikrinimas

```bash
cd backend && npm run doctor           # pilna diagnostika (CUDA, modelis, raktai)
curl localhost:3001/api/health/deep    # komponentų pasiekiamumas per API
```

## 6. Pyannote diarizacija (jei reikia)

Šis backend'as pyannote NEPALEIDŽIA pats - tikisi atskiro HTTP serviso
(`PYANNOTE_URL`), kuris priima `multipart POST` su failu ir grąžina
`{turns:[{start,end,speaker}]}`. **Realioje sesijoje čia gauta 400** - dabar
backend'as loguoja PILNĄ pyannote atsakymo kūną (žr. backend terminalą), tad
priežastis matysis. Dažniausios:

1. **Kitas lauko pavadinimas** - jūsų serveris tikisi `audio`, ne `file`
   → nustatykite `PYANNOTE_FILE_FIELD=audio`
2. **Kitas endpoint kelias** → pilnas kelias per `PYANNOTE_URL` (pvz.
   `http://localhost:8001/api/diarize`)
3. Serveris tikisi JSON su audio URL, ne multipart failo → reikia kito
   wrapper'io arba adapterio pakeitimo
4. Trūksta HuggingFace tokeno PAČIAME pyannote serveryje (pyannote modeliai
   yra „gated" - reikalauja sutikimo HF ir `HF_TOKEN`)

## 7. Pod'o stabdymas neprarandant duomenų

- **Stop** - GPU/CPU nuoma sustoja, **Volume (`/workspace`) išlieka**, container
  diskas su viskuo, kas ne Volume'e - IŠTRINAMAS paleidus iš naujo.
- **Terminate** - ištrinama VISKAS, įskaitant Volume (nebent network volume).
- Praktinė taisyklė: projektas, modeliai, HF cache - visada `/workspace`.
- `.env` su raktais taip pat `/workspace` viduje (projekto kataloge) - išliks.

## 8. Persistent model cache (svarbu, kad nesiųstų GB kaskart)

Modeliai (Whisper + pyannote, keli GB) atsisiunčiami pirmo naudojimo metu. Kad
NEATSISIŲSTŲ iš naujo kiekvieno pod'o perkūrimo metu, nukreipkite cache į
**network volume** per `MODEL_CACHE_DIR`:

```bash
export MODEL_CACHE_DIR=/workspace/models   # network volume kelias
```

`docker-compose.gpu.yml` naudoja `${MODEL_CACHE_DIR:-stenograma-models}:/models` -
tad su nustatytu `MODEL_CACHE_DIR` cache atsiduria Volume'e ir išlieka. Be jo
naudojamas įvardytas Docker volume, kuris išlieka tik toje pačioje mašinoje (NE
tarp RunPod podų perkūrimo). Native kelyje tą patį daro `export HF_HOME=/workspace/hf-cache`.

## 9. Hugging Face tokeno pre-validacija (prieš ilgą build'ą)

pyannote modelis „gated" - reikia (a) galiojančio tokeno, (b) priimtų modelio
sąlygų. Verta tai patikrinti PRIEŠ 5-10 min trunkantį Docker build'ą, kad
nelauktumėte veltui:

```bash
# Greita patikra, ar tokenas galioja IR turi prieigą prie gated modelio:
curl -fsSL -H "Authorization: Bearer $HUGGINGFACE_TOKEN" \
  https://huggingface.co/api/models/pyannote/speaker-diarization-3.1 \
  >/dev/null && echo "✅ Tokenas galioja ir turi prieigą" \
  || echo "❌ Tokenas negalioja ARBA nepriimtos sąlygos: https://hf.co/pyannote/speaker-diarization-3.1"
```

Jei matote ❌, priimkite sąlygas https://hf.co/pyannote/speaker-diarization-3.1
ir sugeneruokite tokeną https://hf.co/settings/tokens. `pyannote` serverio
`/health?probe=true` taip pat parodo aiškią priežastį, jei modelis neįsikelia.

## 10. RunPod template šablonas (kopijuoti į pod nustatymus)

⚠️  **STATUSAS: šis šablonas NEBUVO sukurtas kaip oficialus RunPod template šioje
aplinkoje** - tai reikšmių rinkinys, kurį suvedate į RunPod pod kūrimo formą.
Reikšmes pritaikykite pagal savo repo/GPU.

| RunPod laukas | Reikšmė |
|---|---|
| Container Image | `runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04` (ar naujesnis CUDA 12) |
| Container Disk | 25 GB |
| Volume Disk | 50 GB, mount path `/workspace` |
| Expose HTTP Ports | `3001,5173` |
| Environment: `MODEL_CACHE_DIR` | `/workspace/models` |
| Environment: `HUGGINGFACE_TOKEN` | `hf_...` (secret) |
| Environment: `ANTHROPIC_API_KEY` | `sk-ant-...` (secret) |
| Environment: `HF_HOME` | `/workspace/hf-cache` |
| Docker Command / Start | žr. žemiau |

Start komanda (jei norite automatinio paleidimo; kitaip - rankiniu būdu per web terminalą):
```bash
bash -c "cd /workspace/stenograma && export MODEL_CACHE_DIR=/workspace/models && make quickstart-gpu"
```

Vartotojo procesas su tokiu template: pasirinkti šabloną → įrašyti 2-3 secretus
(`HUGGINGFACE_TOKEN`, `ANTHROPIC_API_KEY`) → paleisti podą → atidaryti frontend
proxy nuorodą (`https://<POD_ID>-5173.proxy.runpod.net`).
