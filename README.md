# Stenograma

**Status:** Portfolio reference implementation — `v1.2.0` (ne production-ready)

| Komponentas | Statusas | Pagrindas |
|---|---|---|
| Backend (Node/API) | Testuota | 558 testai (privatumo / saugumo / funkciniai rinkiniai) per CI |
| Privatumo ir saugumo garantijos | Testuota + mutacijomis patikrinta | [`docs/security-test-matrix.md`](docs/security-test-matrix.md) |
| Frontend (Vite/React) | Testuota | Vitest, ESLint, build per CI |
| E2E srautas | Testuota | Playwright + Chromium per CI |
| CPU Docker image'ai | Testuota | `docker compose build` + `/api/health` per CI |
| GPU Docker image'ai | Build-testuota | `Publish images (GHCR)` workflow |
| Pilnas GPU srautas | Testuota realiai | RunPod: Whisper + pyannote, ~4 val. įrašas iki protokolo |
| Whisper / pyannote kontraktai | Mock lygiu | Kontrakto testai su mock modeliu / pipeline |
| Redis / worker persistencija | Testuota realiai | Integraciniai testai su tikru Redis (`REQUIRE_REDIS=1` CI'e) |
| PII redakcija | Dalinai pseudonimizuoja | Vardai paliekami, adresai neaptinkami — žr. matricos „Ko neapima" |

**Susitikimų protokolų generatorius: garsas → transkripcija → struktūruotas protokolas.**

Stenograma paverčia susitikimo garso įrašą (arba jau turimą transkripciją) į tvarkingą,
redaguojamą protokolą — su darbotvarke, aptartais klausimais, nutarimais ir veiksmų
sąrašu su atsakingais asmenimis bei terminais.

Projektas suprojektuotas kaip **provider architektūra**: transkribavimo ir LLM tiekėjai
keičiami per konfigūraciją (`.env`), o ne kodo perrašymą. **Visa AI logika vykdoma
backend'e** — frontend'as tiesiogiai nesikreipia į LLM API.

---

## Reference implementation vs. Adapter examples

Šiame projekte yra 7 transkribavimo, 5 diarizacijos ir 4 LLM tiekėjų adapteriai. Tai
**sąmoningas architektūros pasirinkimas parodyti provider-pattern plotį**, NE bandymas
apsimesti, kad visi 16 yra production-ready. Kad tai būtų aišku iš pirmo žvilgsnio:

**🟢 Reference implementation — realiai paleista ir patikrinta šioje aplinkoje:**
- `MockTranscriptionProvider`, `MockLLMProvider`, `MockDiarizationProvider` — automatiniais testais.
- `ClaudeProvider` — su realiu `ANTHROPIC_API_KEY`.
- `FasterWhisperEmbeddedProvider` — su vartotojo pateiktu tikru `faster-whisper` modeliu, per pilną HTTP srautą.

**⚪ Adapter examples — kodas parašytas pagal tiekėjo viešą API kontraktą, bet NETESTUOTA su realiu raktu:**
Azure Speech, Google Speech, Deepgram, OpenAI Whisper, GPT, Gemini, AssemblyAI,
pyannote.ai, faster-whisper (server profilis). Šie parodo, KAIP naują tiekėją
pridėti prie architektūros (žr. `providers/*/index.js` factory pattern), bet prieš
naudojant produkcijoje kiekvieną reikia patikrinti su realiu raktu atskirai.

Jei jums reikia tik vieno konkretaus tiekėjo (pvz. tik Claude + Whisper) - likusius
galite tiesiog ignoruoti arba ištrinti iš `providers/` katalogo, architektūra to
nereikalauja visų vienu metu.

---

## Statusas: kaip skaityti likusią šio README dalį

Šis projektas yra architektūrinės demonstracijos stadijoje. Kad README neklaidintų, kiekvienas
komponentas žemiau pažymėtas viena iš trijų kategorijų:

- ✅ **Implemented** — parašyta, paleista šioje aplinkoje ir automatiniais testais patikrinta, kad veikia.
- 🧪 **Mocked** — realiai veikia be jokio API rakto, bet grąžina supaprastintą (ne tikro LLM/ASR) rezultatą pagal heuristikas.
- ⚙️ **Interface only** — kodas parašytas pagal tiekėjo oficialų API kontraktą, bet **nebuvo testuotas su realiu apmokamu raktu**. Patikrinkite prieš diegdami produkcijoje.

---

## Sistemos reikalavimai

| Komponentas | Minimalu | Rekomenduojama | Pastabos |
|---|---|---|---|
| **RAM** | 8 GB | 16 GB | Mock/demo veikia ir su mažiau; GPU stackas (Whisper+pyannote) imlesnis |
| **CPU** | 4 branduoliai | 8 branduoliai | CPU transkripcija (`small` modelis) veikia, bet lėčiau nei GPU |
| **GPU** | nebūtina | RTX 3060+ (12 GB VRAM) | Tik GPU transkripcijai/diarizacijai. `small` modeliui užtenka ~2 GB VRAM, `large-v3` fp16 ~4–5 GB |
| **Diskas** | 10 GB | 30 GB | Demo/CPU ~10 GB; GPU Docker image'ai (CUDA/Torch/pyannote) realiai 25–30 GB |
| **Node.js** | 20 | 20 LTS | Backend + frontend |
| **Python** | 3.10 | 3.11 | pyannote/whisper servisai (jei naudojami) |

Priklauso nuo profilio: **demo/mock** – veikia beveik bet kur (net be GPU, be Docker,
`make demo`). **CPU transkripcija** – 8 GB RAM pakanka. **GPU stackas su diarizacija**
– rekomenduojama 16 GB RAM + NVIDIA GPU + `nvidia-container-toolkit` (patikrina
`make preflight-gpu`). RunPod/cloud detalės – [`RUNPOD.md`](RUNPOD.md).

## Architektūra

```
┌──────────────────┐      HTTPS       ┌───────────────────────┐
│                   │ ───────────────▶│   Backend (Express)   │
│   React frontend   │                 │                       │
│  (redaguojamas     │◀─────────────── │  /api/transcribe      │
│   protokolas,       │      JSON       │  /api/generate        │
│   /api/health       │                 │  /api/audit (⚠ auth) │
│   statuso indikat.) │                 └──────────┬────────────┘
└──────────────────┘                                │
              ┌──────────────────┬─────────────────┼────────────────────┐
              │                  │                  │                    │
       TranscriptionProvider DiarizationProvider LLMProvider      JSON Schema +
              │            (NEPRIKLAUSOMAS!)        │              audit log +
    ┌────┬────┼────┬─────┐   ┌────┬────┬────┬─────┐ ┌────┼────┬─────┐  repair retry
    │    │    │    │     │   │    │    │    │     │ │    │    │     │
 Whisper FW Azure Google Deep- none inline mock pyan- Claude GPT Gemini Mock
 🧪intf  ⚙️  ⚙️    ⚙️    gram  ✅   ✅    ✅  note/  ✅    ⚙️   ⚙️    ✅
                        ⚙️              cloud/
                                        assembly
                                        ⚙️
```

Transkribavimas ir diarizacija (kalbėtojų atskyrimas) yra **du nepriklausomi komponentai**
su atskirais env kintamaisiais (`TRANSCRIPTION_PROVIDER`, `DIARIZATION_PROVIDER`) — todėl
derinys "Whisper transkripcija + pyannote diarizacija" dabar galimas, nors Whisper pats
diarizuoti nemoka. Detalės: [`backend/README.md`](backend/README.md#diarizacija--nepriklausomas-komponentas-nuo-transkribavimo).

API raktai gyvena **tik backend'e** (`process.env`). Frontend'as backend'o adresą
tikrina per `GET /api/health` ir aiškiai parodo, ar jis pasiekiamas — jei ne, protokolo
generuoti negalima (jokio "tylaus" grįžimo prie tiesioginio LLM kvietimo iš naršyklės nėra).

### Duomenų srautas

Kelias nuo garso įrašo iki galutinio protokolo (Mermaid - renderinasi GitHub'e):

```mermaid
flowchart TD
    User(["Vartotojas: audio įrašas ar tekstas"]) --> FE[React frontend]
    FE -->|"POST /api/transcribe-jobs<br/>(async, polling)"| BE[Backend / Express]
    BE --> T{{TranscriptionProvider}}
    T -->|"faster-whisper / Whisper API / ..."| TR["Transkripcija: tekstas + segmentai"]
    TR --> D{{"DiarizationProvider<br/>nepriklausomas"}}
    D -->|"pyannote / none"| DR["Kalbėtojų atskyrimas: turns"]
    DR --> MERGE[Sujungta transkripcija su kalbėtojais]
    MERGE -->|"POST /api/jobs"| L{{LLMProvider}}
    L -->|"Claude / GPT / Gemini / mock"| PROTO["JSON protokolas<br/>+ schema validacija + repair retry"]
    PROTO --> FE2["Frontend: redaguojami laukai"]
    FE2 --> EXPORT["Eksportas: DOCX / CSV / TXT"]
    EXPORT --> Done([Galutinis protokolas])

    style User fill:#e1f5ff
    style Done fill:#e1ffe1
    style T fill:#fff4e1
    style D fill:#fff4e1
    style L fill:#fff4e1
```

Pastaba: transkribavimas ir diarizacija vyksta **lygiagrečiai to paties audio atžvilgiu**,
tada sujungiami (kalbėtojo etiketė priskiriama kiekvienam teksto segmentui pagal laiką).
Async job'ai (`/api/transcribe-jobs`, `/api/jobs`) būtini, nes 4 val. įrašo apdorojimas
gerokai viršija HTTP proxy timeout'us (pvz. RunPod 100s).

---

## Greitas startas

**Linux/macOS/RunPod - viena komanda** (realiai patikrinta švarioje aplinkoje):
```bash
./setup.sh          # mock/CPU: backend+frontend+faster-whisper priklausomybės, .env, diagnostika
./setup.sh --gpu    # + GPU: tikrina nvidia-smi/CUDA, paruošia pyannote diarizaciją (venv, CUDA Torch)
make demo           # ĮSITIKINTI, kad viskas veikia: pilnas srautas per sekundes (mock, be raktų)
```
`make demo` paleidžia backend'ą, atlieka visą srautą ir parodo:
```
✔ Upload — audio priimtas
✔ Transcription — "Jonas: Labas, pradedam…"
✔ LLM — užklausa priimta
✔ Protocol generated — struktūrizuotas protokolas paruoštas
System ready.
```
Numatytoji konfigūracija (`./setup.sh` be argumentų) - **demo (mock) režimas,
veikia iš karto be jokių API raktų**; ji apima backend, frontend ir faster-whisper
transkripciją, bet **NE pyannote diarizaciją** (tam reikia `--gpu`, kuris paruošia
atskirą pyannote venv su GPU Torch ir patikrina `HUGGINGFACE_TOKEN`). Realiam AI žr.
`backend/.env` komentarus. **Windows** - žr. diegimo skyrių žemiau (žingsniai
rankiniai, realiai patikrinti). **RunPod/GPU** - žr. [`RUNPOD.md`](RUNPOD.md).
Diagnostika bet kada: `cd backend && npm run doctor`.

## Kasdienis paleidimas (aplinka jau paruošta)

Kai `setup.sh` jau paleistas ir modeliai atsisiųsti (pvz. grįžote prie to paties
RunPod pod'o), darbo pradžiai NEreikia iš naujo diegti - tik paleisti servisus:

**GPU su diarizacija (pilnas realaus darbo režimas):**
```bash
make gpu                                   # paleidžia pyannote + backend (API) kartu
# jei portai užimti (pvz. RunPod nginx ant 3001/8001):
make gpu BACKEND_PORT=4001 PYANNOTE_PORT=9001
```
`make gpu` paleidžia **backend API + pyannote** ir laiko juos veikiančius (stabdyti -
`Ctrl+C`). Reikia `HUGGINGFACE_TOKEN` (pyannote modeliui). Pirmą kartą po pod'o
paleidimo modeliai kraunami į VRAM - kelios sekundės.

**Frontend (naršyklė) - jei reikia, paleidžiamas ATSKIRAI** (`make gpu` jo neįjungia):
```bash
cd frontend && npm run dev                 # http://localhost:5173 (ar RunPod proxy URL)
```
Jei backend'as ne ant 3001, frontend'ui nurodykite jį per `frontend/.env`
(`VITE_BACKEND_URL`) arba naudokite nginx `/api` proxy (žr. RUNPOD.md).

**Patikrinti, kad viskas gyva:**
```bash
make status                                # health būsena
make verify BACKEND_PORT=4001              # pilnas end-to-end smoke prieš veikiantį stacką
```

**Sustabdyti:** `Ctrl+C` (jei `make gpu` fronte). Docker atveju - `make down`.

## Komponentų statusas

**Realaus 4 val. lietuviško posėdžio įrašo testas** atskleidė ir ištaisė realų
trūkumą: `tiny` modelis praktiškai netinka lietuvių kalbai (haliucinuoja), `small`
jau duoda naudotiną tekstą; be to, protokolo pilnumo balas klaidingai rodė 80%
vietoj tikrų 60%, kai LLM grąžindavo `["Nenurodyta"]` vietoj tuščio masyvo -
abi problemos ištaisytos (`meeting_v3` promptas + `completeness()` logika), su
regresijos testais. Detalus aprašymas - žr.
[`backend/README.md`](backend/README.md#realaus-audio-testas-tikras-4-val-posėdžio-įrašas).

**Video failai (.mp4/.webm su vaizdo IR garso takeliu) veikia** - realiai
patikrinta su tikru `faster-whisper` modeliu ir `ffmpeg` sugeneruotais testiniais
failais (H.264+AAC ir VP8+Opus). Biblioteka automatiškai ištraukia audio takelį,
vaizdas ignoruojamas. Detalus paaiškinimas ir apribojimai (kiti tiekėjai
nepatikrinti, dydžio vs. trukmės klausimas) - žr.
[`backend/README.md`](backend/README.md#video-failai-mp4webm-su-vaizdo-ir-garso-takeliu---realiai-patikrinta).

| Komponentas | Statusas | Pastaba |
|---|---|---|
| Frontend UI (redagavimas, TXT/CSV/Word eksportas, live įrašymas per Web Speech API) | ✅ | Veikia savarankiškai, bet protokolo generavimui reikalauja veikiančio backend'o |
| Backend serveris + visi endpoint'ai | ✅ | Paleista ir patikrinta automatiniais testais (žr. „Testai" žemiau) |
| `MockTranscriptionProvider` | 🧪 | Grąžina fiksuotą pavyzdinį (diarizuotą) rezultatą, nepriklausomai nuo įkelto failo turinio |
| `MockLLMProvider` | 🧪 | Ištraukia pavadinimą/datą/dalyvius/veiksmus iš REALIOS jūsų transkripcijos paprastomis regex heuristikomis — nėra tikras LLM, bet reaguoja į įvestį |
| `ClaudeProvider` | ✅ | Veikia su `ANTHROPIC_API_KEY`, patikrinta |
| `WhisperProvider` (OpenAI) | ⚙️ | Kodas funkcionalus, netestuota su realiu raktu |
| `DeepgramProvider` | ⚙️ | Kodas funkcionalus, netestuota su realiu raktu |
| `GPTProvider`, `GeminiProvider` | ⚙️ | Kodas pagal viešą API kontraktą, netestuota su realiu raktu |
| `AzureSpeechProvider`, `GoogleSpeechProvider` | ⚙️ | Dokumentuota sąsaja, reikalauja patikrinimo prieš diegiant |
| `FasterWhisperProvider` (lokalus, "server" profilis) | ⚙️ | Reikalauja atskirai paleisto lokalaus serverio |
| `FasterWhisperEmbeddedProvider` (lokalus, "desktop" profilis) | ✅ | Realiai patikrinta su `tiny` IR `small` modeliais, įskaitant TIKRĄ 4 val. lietuvišką posėdžio įrašą (ne tik sintetinį TTS balsą) - visas HTTP srautas `/api/transcribe` → provideris → Python subprocess → `faster-whisper`. `tiny` pasirodė netinkamas lietuvių kalbai, `small` - naudotinas. Žr. `backend/README.md` „Realaus audio testas" ir „Faster-Whisper: du diegimo profiliai" |
| `MockDiarizationProvider` | ✅ | Deterministiniai intervalai, patikrinti su merge logika (`tests/mergeDiarization.test.js`) |
| `PyannoteDiarizationProvider` (lokalus) | ⚙️ | Reikalauja atskirai paleisto lokalaus serverio; veikia su bet kokiu `TRANSCRIPTION_PROVIDER`, įskaitant Whisper |
| `PyannoteCloudDiarizationProvider`, `AssemblyAIDiarizationProvider` | ⚙️ | Kodas pagal viešą API kontraktą, netestuota su realiu raktu |
| JSON Schema validacija + repair retry | ✅ | Testuota (žr. `tests/protocolSchema.test.js`) |
| Transcript grounding check (leksinis persidengimas) veiksmų atžvilgiu | 🧪 Implementuota (leksinis) | `utils/groundingCheck.js` - leksinis persidengimas, ne semantinis fact-checking. Žr. Roadmap dėl embedding-based versijos |
| Tikras OOXML `.docx` eksportas | ✅ Implementuota | `docx` npm paketas, generuojamas naršyklėje (`Packer.toBlob`). Patikrinta - `file` komanda patvirtina tikrą "Microsoft Word 2007+" formatą, ne HTML. Trūksta: įmonės logotipo/šablono (žr. Roadmap) |

---

## Saugumo numatytosios reikšmės (svarbu prieš viešą diegimą)

Ankstesnės versijos turėjo keletą MVP-lygio saugumo spragų, kurios dabar ištaisytos:

| Rizika | Sprendimas |
|---|---|
| **⚠️ Docker prievadai + dev-by-default = viešas neautentifikuotas API** (žr. „Docker" skyrių žemiau) | `docker-compose.yml` prievadai susieti su `127.0.0.1`, ne `0.0.0.0` - numatytai pasiekiami TIK lokaliai |
| API raktas frontend'e | Pašalinta — frontend'as **neturi jokio** tiesioginio LLM kvietimo, tik kviečia backend'ą |
| Hardcoded `BACKEND_URL` kode | Skaitomas iš `VITE_BACKEND_URL` (`import.meta.env`) - deployment metu keičiamas `.env`, ne kodas |
| `/api/audit` viešai atviras | `middleware/auditAuth.js` — reikalauja `AUDIT_API_KEY` header'io; produkcijoje (`NODE_ENV=production`) be jo uždarytas |
| `/api/generate`, `/api/transcribe` be autentifikacijos | `middleware/apiKeyAuth.js` — reikalauja `API_KEY`; produkcijoje be jo endpoint'ai uždaryti (503). **Tai bendras raktas, ne per-user auth** - žr. „Autentifikacija ir viešas diegimas" backend README |
| Frontend negali saugiai naudoti `API_KEY` | `VITE_API_KEY` NEBŪTINA - jei naudojama, raktas matomas viešame JS bundle'e. Tinka TIK vidiniam/lokaliam tinklui. Viešam deploy'ui reikalingas reverse proxy arba pilna auth sistema - žr. backend README |
| `/api/health` viešai rodo tiekėjų/modelių pavadinimus | Produkcijoje pagal nutylėjimą grąžina tik `{status:"ok"}` (`HEALTH_DETAILS`) |
| Nėra rate limiting brangiems endpoint'ams | `express-rate-limit` - numatyta 20 užklausų / 15 min vienam IP (`RATE_LIMIT_MAX_REQUESTS`) |
| Ilgas susitikimas + sinchroninis `/api/generate` = ilgas HTTP laukimas | `POST /api/jobs` + `GET /api/jobs/:id` - asinchroninis variantas, žr. backend README |
| Visas audio failas skaitomas į RAM prieš siunčiant tiekėjui | Iš dalies sumažinta (`multer.diskStorage` upload metu), bet `fs.readFile` prieš API kvietimą vis tiek pilnai perskaito failą - sąžiningai dokumentuotas MVP limitas, ne tikras streaming |
| CORS `*` pagal nutylėjimą | Numatyta `http://localhost:5173`; `*` reikalauja sąmoningo pasirinkimo (spėja įspėjimu konsolėje) |
| Laisvas tiekėjo perjungimas per užklausą | `llmProviderOverride` / `provider` laukai veikia tik su `ALLOW_PROVIDER_OVERRIDE=true` (numatyta — išjungta), ir tik pagal whitelist |
| 200 MB audio į RAM (`multer.memoryStorage`) | Pakeista į `multer.diskStorage` (streamina į laikiną failą, ne atmintį) + numatytas limitas sumažintas iki 50 MB (`MAX_UPLOAD_MB`) |
| Bet koks failas priimamas kaip "audio" | `fileFilter` tikrina MIME tipą IR/ARBA plėtinį prieš whitelist (mp3/wav/m4a/mp4/webm/ogg/aac/flac, įskaitant `video/mp4`/`video/webm` - žr. žemiau) |
| Pavojingas `LLM_PROVIDER=claude` numatytoje `.env.example` | Pakeista į `LLM_PROVIDER=mock` — be rakto backend'as dabar veikia iš karto, o ne kris pirmoje užklausoje |
| Kabantys API kvietimai be timeout | Visi išoriniai kvietimai per `utils/httpClient.js` — `AbortController` timeout (`API_TIMEOUT_MS`, numatyta 90s) + vienas automatinis pakartojimas 5xx/tinklo klaidoms |
| Prompt injection per transkripciją | `prompts/meeting_v2.js` (numatyta versija) eksplicitiškai nurodo modeliui, kad transkripcija yra DUOMENYS, ne instrukcijos |
| `docker compose up` demo neveikdavo iš karto (`NODE_ENV=production` + tuščias `API_KEY` = 503) | `docker-compose.yml` numatyta `NODE_ENV=development`; produkcijai reikia sąmoningo perjungimo (žr. komentarą faile) |
| Failo validacija tik pagal pavadinimą/MIME (apeinama pervadinus) | `utils/audioMagicBytes.js` - papildoma failo TURINIO (magic bytes) patikra. Sąžiningai NE antivirusinis skenavimas |
| Klaidos pranešime atskleidžia per daug (raktai, endpoint'ai) | `utils/sanitizeError.js` - tikros (500) vidinės klaidos niekada nepasiekia kliento pilnu tekstu; pilnas tekstas visada logguojamas serveryje |
| Nėra jokio "ar veiksmas tikrai buvo transkripcijoje" patikrinimo | `utils/groundingCheck.js` - leksinio persidengimo heuristika, pažymi žemo pasitikėjimo veiksmus frontend'e. Sąžiningai NE semantinis/embedding tikrinimas |
| Async jobai (`/api/jobs`) niekada nešalinami iš atminties | `utils/jobStore.js` TTL - COMPLETED/FAILED jobai automatiškai išvalomi po `JOB_TTL_MINUTES` (numatyta 60 min) |
| Docker nebuvo CI testuojamas | CI dabar turi atskirą `docker` job'ą: `docker compose build` + realus konteinerio paleidimas ir `/api/health` smoke testas |

**Praktinis veiksmų planas, kaip šias rizikas mažinti pagal jūsų diegimo scenarijų
(lokalus / vidinis / viešas) - žr. [`DEPLOYMENT_CHECKLIST.md`](DEPLOYMENT_CHECKLIST.md).**

---

## Testai ir CI

```bash
cd backend
npm install
npm test        # 558 testai (privatumas + saugumas + funkciniai), mock provideriai, be raktų
npm run check   # node --check kiekvienam .js failui
```

Testų aprėptis (backend):
- `tests/protocolSchema.test.js` — JSON schema validacija (privalomi laukai, tipai, repair prompt).
- `tests/prompt.snapshot.test.js` — meeting prompt šablono snapshot testas (apsaugo nuo netyčinių pakeitimų).
- `tests/mergeDiarization.test.js` — laiko persidengimu paremtos diarizacijos sujungimo logikos unit testai.
- `tests/generate.route.test.js` — `/api/generate` per HTTP (supertest), įskaitant provider override atmetimą.
- `tests/transcribe.route.test.js` — `/api/transcribe` per HTTP, įskaitant validaciją ir override atmetimą.
- `tests/diarization.route.test.js` — `none`/`inline`/atskiro tiekėjo (`mock`) diarizacijos režimai per HTTP.
- `tests/providerOverride.route.test.js` — `ALLOW_PROVIDER_OVERRIDE=true` scenarijai (whitelist patikra).
- `tests/jobStore.test.js` + `tests/jobStoreRedis.test.js` — job store (async, in-memory + Redis su fake klientu).

Naršyklinis E2E (`frontend/e2e/`, Playwright): pilnas srautas įklijuoti tekstą →
generuoti protokolą → eksportuoti DOCX (mock provideriai). Paleidimas: `npm run test:e2e`
(reikia `npx playwright install chromium`).

GitHub Actions (`.github/workflows/ci.yml`) kiekvienam push/PR paleidžia: `npm ci` →
`node --check` → `npm test` → smoke test → whisper/pyannote kontrakto testai → E2E
(Playwright su tikra Chromium).

### Ką realiai patikrina CI vs. kas tikrinta rankiniu būdu

Svarbu neklaidinti: **žalias CI ženklas NEreiškia, kad GPU kelias patikrintas.**
GitHub standartinis runner'is GPU neturi, o `test_real_gpu.py` be `HUGGINGFACE_TOKEN`
praleidžiamas. Tikslus atskyrimas:

**✅ CI verified (automatiškai, kiekvienam push):**
- backend: `node:test` testai (mock tiekėjai; įsk. jobStore, jobRunner/BullMQ unit
  testai su fake Redis, fileStorage)
- **TIKRAS Redis/BullMQ restart + stalled recovery** (`tests/queueRecovery.integration.test.js`)
  **ir worker heartbeat → `/api/ready` grandinė** (`tests/heartbeatReadiness.integration.test.js`)
  - CI paleidžia tikrą `redis:7-alpine` servisą ir šiuos DU failus vykdo ATSKIRU
  žingsniu (`npm run test:redis`) su `REDIS_URL` - TIK jiems, ne visam `npm test`
  (route testai kitame žingsnyje lieka be `REDIS_URL`, kad neprarastų inline
  vykdymo prielaidos). Testai VYKDOMI (ne `skip`) kiekvienam push/PR - pirmasis su
  griežtu assertion (reikalauja TIKSLIAI sėkmingo `completed` statuso konkrečiam
  BullMQ jobui pagal ID, ne bet kokio galutinio statuso ar bendrų eilės
  skaitiklių), antrasis patvirtina, kad worker'io per TIKRĄ Redis rašytas
  heartbeat raktas realiai matomas `/api/ready` route'e, o jam dingus - readiness
  teisingai krenta į 503 (žr. `backend/README.md`)
- frontend: 24 Vitest testai + `vite build`
- pyannote: `/health` diagnostika + `/diarize` kontraktas su mock pipeline (9 testai)
- whisper-server: `/health` + `/transcribe` kontraktas su mock modeliu (8 testai)
- **naršyklinis E2E (Playwright, Chromium): (a) įklijuoti tekstą → protokolas → DOCX; (b) pilnas audio upload → polling → protokolas → DOCX**
- bazinis (CPU) `docker compose build` + backend konteinerio `/api/health` smoke

**🔧 Manually verified (šioje ar ankstesnėse sesijose, be GPU):**
- faster-whisper transkripcija su tikru `small` modeliu, tikras 4 val. lietuviškas įrašas (CPU)
- pilna backend→whisper-server HTTP grandinė su mock modeliu (undici form-data bug'as rastas ir ištaisytas)
- `smoke-gpu.sh` end-to-end (WAV → transkripcija → protokolas) su tikru modeliu (CPU)
- `configure.sh` visi režimai + sugeneruoto `.env` realus paleidimas
- `preflight-gpu.sh` / `support-bundle.sh` (maskavimas, HF prieigos šaka su netikru tokenu)

**❌ NOT verified (reikia GPU/Docker aplinkos - patikrinkite savo mašinoje):**
- CUDA image build (`Dockerfile.whisper.gpu`, `pyannote-server/Dockerfile.gpu`, `whisper-server/Dockerfile.gpu`)
- reali GPU transkripcija (`device=cuda`) embedded IR server profiliuose
- realaus pyannote modelio įkėlimas ir diarizacija
- pilnas GPU end-to-end per `docker compose ... gpu.yml` (2026-07: `docker-compose.gpu.yml`
  papildytas trūkstamais `transcription-worker`/`protocol-worker` servisais -
  anksčiau backend nustatydavo `REDIS_URL` be jokio serviso, kuris apdorotų BullMQ
  eilę, tad async jobai liktų amžinai "queued"; dabar ištaisyta (du atskiri,
  nepriklausomai skaluojami worker servisai, ne vienas bendras), bet pats GPU
  srautas su realiu GPU vis tiek nebuvo perleistas per šią konkrečią konfigūraciją)
- Docker GPU passthrough patikra realioje GPU mašinoje
- **E2E su tikra naršykle paleidžiamas per CI** (Playwright + Chromium, `e2e` job'as kiekvienam push/PR); lokalioje kūrimo aplinkoje Chromium atsisiuntimas buvo blokuotas, todėl ten testas tikrinamas tik struktūriškai (`playwright test --list`)

### Architektūros trade-off'ai (sąmoningi MVP apribojimai)

Šis projektas yra apgalvotas **portfolio MVP**, ne production-ready enterprise
sistema. Keli sąmoningi architektūriniai sprendimai, kuriuos vertėtų žinoti prieš
platesnį diegimą:

- **Job'ai: inline, persistent state, arba tikra BullMQ eilė** (`queues/`, `workers/`).
  Be `REDIS_URL` - darbas vykdomas HTTP procese (inline; tinka dev/desktop, bet
  backend restartas nutraukia vykdomą jobą). Su `REDIS_URL` - **tikra BullMQ eilė**:
  HTTP endpoint'as TIK įdeda jobą ir grąžina 202, darbą vykdo ATSKIRAS worker
  procesas. Atskiros eilės (`queues/transcriptionQueue.js`, `protocolQueue.js`) ir
  worker'iai (`workers/transcriptionWorker.js`, `protocolWorker.js`) - galima skalauti
  nepriklausomai (transkripcija imlesnė GPU nei LLM). Tai duoda: restart recovery,
  retry+backoff, stalled job recovery, kelis worker'ius (atominis job reservation),
  bendrą audio storage (worker pasiekia failą pagal raktą, ne lokalų /tmp; failas
  trinamas po galutinio statuso, ne tarp retry). **Terminijos tikslumas:** po visų
  bandymų (`attempts`) išnaudojimo jobas lieka pažymėtas `failed` BullMQ eilėje ir
  laikomas ilgiau diagnostikai (`removeOnFail.age`) - tai NĖRA atskira "dead-letter
  queue" (izoliuota eilė), tik `failed` būsenos retencija. Detaliau -
  [`backend/README.md`](backend/README.md#redisbullmq-architektūra-su-redis_url).
  Kas dar liko 2 etapui: PostgreSQL rezultatams, MinIO/S3 vietoj Docker volume.
- **Job progresas nerodomas ilgiems failams (žinomas apribojimas).** Job'o būsena
  yra `queued`/`processing`/`completed`/`failed`, bet **be tarpinio progreso procento** -
  `progress` laukas visada `null`, kol staiga tampa `completed`. Ilgiems įrašams
  (pvz. kelių valandų) tai reiškia, kad vartotojas nemato „kiek liko". Infrastruktūra
  jau paruošta (job `progress` laukas, frontend `formatTranscribeProgress`, servisas
  priima `onProgress`), bet **niekas jo neužpildo**: whisper-server gauna segmentus
  srautu (`for seg in segments_iter`, turi `seg.end` + bendrą trukmę, tad %
  APSKAIČIUOJAMAS), tačiau backend kviečia whisper-server vienu HTTP POST ir laukia
  VISO rezultato - nėra streaming'o (SSE/chunked), kuris perduotų progresą į jobStore.
  Pilnas sprendimas (atskiras darbas): whisper-server streaming atsakymas su progresu →
  backend rašo į jobStore → frontend polling jį parodo. Diarizacija (pyannote) progreso
  neteikia iš principo (dirba „viską iškart"), tad progresas dengtų tik transkripciją.
- **Transkribavimas: embedded ARBA server.** `faster-whisper-embedded` (numatyta):
  Node spawn'ina Python procesą kiekvienai užklausai, modelis kraunamas iš naujo -
  paprasta, tinka desktop scenarijui. `faster-whisper-server` (persistentus
  `whisper-server/`): modelis įkeltas VIENĄ kartą, laikomas VRAM tarp užklausų -
  mažesnis latency, kontroliuojamas VRAM, aiškus concurrency limitas, lengviau
  skalauti. Server profilis simetriškas pyannote architektūrai; `docker-compose.server.yml`
  paleidžia abu persistentus servisus. Pasirenkama per `TRANSCRIPTION_PROVIDER`.
- **Frontend backend adresas:** numatytai frontend'as naudoja **santykinį `/api`**,
  kurį nginx proxy'ina į backendą (žr. `frontend/nginx.conf`). Tad tas pats frontend
  image tinka **bet kuriam domenui** (localhost, RunPod proxy, serveris) be
  perbuildinimo, ir **nėra CORS**. Absoliutus `VITE_BACKEND_URL` reikalingas tik jei
  frontend ir backend skirtinguose hostuose BE proxy (retas atvejis).
- **`VITE_API_KEY` patenka į naršyklės bundle** - tinka tik lokaliam/uždaram
  naudojimui. Viešam diegimui reikėtų session/OAuth ar server-side proxy, pridedančio
  raktą. Dokumentuota `.env.example`.
- **Naršyklinis E2E testas (Playwright)** dengia pagrindinį srautą: įklijuoti
  tekstą → generuoti protokolą → eksportuoti DOCX (mock provideriai, be raktų/GPU).
  Vykdomas CI'e su tikra Chromium naršykle. Ką dar būtų verta pridėti: failo upload
  + transkribavimo polling per naršyklę (dabar E2E dengia teksto įklijavimo kelią).

Šie punktai nėra klaidos - tai normalūs MVP vs enterprise trade-off'ai. Jie čia
išvardyti, kad README neklaidintų dėl production-readiness.

## Greitas paleidimas

### Backend (privalomas)

```bash
cd backend
cp .env.example .env
npm install
npm start
```

Numatytieji nustatymai (`TRANSCRIPTION_PROVIDER=mock`, `LLM_PROVIDER=mock`) veikia iškart,
be jokių API raktų.

Realiam tiekėjui — pakeiskite `.env`:

```bash
TRANSCRIPTION_PROVIDER=whisper
LLM_PROVIDER=claude
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

### Frontend

Pilnas Vite + React projektas (`frontend/`), ne pavienis failas:

```bash
cd frontend
cp .env.example .env    # VITE_BACKEND_URL=http://localhost:3001
npm install
npm run dev              # http://localhost:5173
```

Adresas skaitomas iš `VITE_BACKEND_URL` (`import.meta.env`) - **jokio hardcoded URL
kode**, deployment metu tereikia pakeisti `.env` (arba build-time kintamąjį), ne kodą.

Jei backend nepasiekiamas, sąsaja tai aiškiai parodo ir generavimo mygtukas išjungiamas —
jokio "demo" kelio per tiesioginį LLM kvietimą iš naršyklės nebėra.

---

## API

| Endpoint | Metodas | Aprašymas | Apsauga |
|---|---|---|---|
| `/api/health` | GET | Aktyvūs tiekėjai (produkcijoje detalės paslėptos pagal nutylėjimą - žr. `HEALTH_DETAILS`) | — |
| `/api/transcribe` | POST (multipart) | Audio failas → transkripcija (SINCHRONINIS - žr. `/api/transcribe-jobs` HTTP proxy su trumpu timeout atveju, pvz. RunPod) | `API_KEY`, rate limit, failo dydžio/formato validacija, provider override tik su `ALLOW_PROVIDER_OVERRIDE` |
| `/api/transcribe-jobs` | POST (multipart) | Asinchroninis `/api/transcribe` - grąžina `jobId` iš karto (202). Frontend'as naudoja ŠĮ pagal nutylėjimą. | `API_KEY`, rate limit |
| `/api/transcribe-jobs/:id` | GET | Transkribavimo jobo statuso/rezultato apklausa | `API_KEY`, rate limit |
| `/api/generate` | POST (JSON) | Transkripcija → struktūruotas protokolas (SINCHRONINIS - žr. `/api/jobs` ilgiems susitikimams) | `API_KEY`, rate limit, provider/prompt override tik su `ALLOW_PROVIDER_OVERRIDE` |
| `/api/jobs` | POST (JSON) | Asinchroninis `/api/generate` - grąžina `jobId` iš karto (202) | `API_KEY`, rate limit |
| `/api/jobs/:id` | GET | Joba statuso/rezultato apklausa (polling) | `API_KEY`, rate limit |
| `/api/transcribe-jobs/:id` | DELETE | GDPR ištrynimas: jobas, rezultatas, eilės įrašas, audio, auditas (tik terminalinės būsenos, kitaip 409; dalinis nepavykimas -> 503) | `API_KEY`, rate limit |
| `/api/jobs/:id` | DELETE | GDPR ištrynimas protokolo jobui (analogiškai) | `API_KEY`, rate limit |
| `/api/exports` | POST (JSON) | Protokolo eksportas (`txt`/`csv`/`docx`). Generuojama SERVERYJE, kad eksportas patektų į audito žurnalą | `API_KEY`, rate limit |
| `/api/audit` | GET | Audit log įrašai | `x-audit-key` header (arba uždaryta produkcijoje) |

Pilna dokumentacija: [`backend/README.md`](backend/README.md).

---

## Technologijos

**Frontend:** React + Vite, Tailwind (core utility klasės), Web Speech API, PapaParse (CSV eksportui), lucide-react.
**Backend:** Node.js 20+, Express, Multer (diskStorage), express-rate-limit.
**Testai:** backend — `node:test` (built-in) + Supertest (558 testai, plius 11 integracinių su tikru Redis); frontend —
Vitest (24 testų: 19 grynoms `src/utils.js` funkcijoms + 5 komponento/integracijos
testai `App.jsx` su React Testing Library ir mocked `fetch` - backend health
statusas, generavimo srautas, klaidų rodymas). **Sąžiningai:** komponento testai
apima tik dalį elgsenos (health status, paste→generate srautas, klaidos) - NĖRA
padengta: audio upload srautas, protokolo redagavimas po generavimo, eksportai
(.docx/.csv/.txt), diarizacijos pasirinkimas, live įrašymas. Nėra ir Playwright/
Cypress E2E testo (naršyklė → upload → transcribe → generate → edit → export) -
tai aiškiai kitas žingsnis, ne baigtas darbas.
**Konteinerizacija:** Docker (backend + frontend/nginx), `docker-compose.yml` (build + smoke testas praeina per CI - žr. skyrių „Docker").
**CI:** GitHub Actions.
**Architektūros šablonas:** Strategy/Provider pattern LLM ir transkribavimo tiekėjams, config-driven factory.

---

## Roadmap

**Milestone 1 – Reliable processing pipeline ✅** (persistent job orchestration,
BullMQ workers, Redis-backed state, dedicated Whisper service, browser E2E, protocol
generation pipeline, Docker deployment, health/readiness checks). Pilnas sąrašas –
[`CHANGELOG.md`](CHANGELOG.md). Kitas: **Milestone 2 – sauga ir duomenų valdymas**
(OIDC auth, multi-tenancy, PostgreSQL, MinIO/S3, retention, audit).

- [x] ~~"Desktop" transkribavimo profilis be atskiro serverio~~ → `faster-whisper-embedded` providerio lygmeniu implementuotas (žr. `backend/README.md`). **Sąžiningai:** tai NĖRA supakuota desktop programa (Electron/Tauri .exe/.dmg) - tai vis dar Node backend'as + React frontend'as, tiesiog transkribavimo providerio viduje nebėra HTTP serviso, kurį reikėtų paleisti atskirai. Pilnas "Stenograma Desktop" paketavimas (viena instaliuojama programa be `npm start`/`docker compose`) - kitas žingsnis, jei to reikia.
- [x] ~~Automatinis fact-checking~~ → leksinis grounding check implementuotas (`utils/groundingCheck.js`). Liko: **semantinis** fact-checking (embedding similarity arba antras LLM validacijos žingsnis) - dabartinė heuristika nepagauna perfrazuotų (bet teisingų) teiginių.
- [x] ~~Tikras OOXML `.docx` eksportas~~ → implementuota (`docx` npm paketas, generuojama naršyklėje). Liko: įmonės logotipas/šablonas/spalvos, jei reikia firminio stiliaus - dabar naudojamas bendras neutralus formatavimas.
- [x] ~~Local transcription concurrency control~~ → `utils/concurrencyLimiter.js` semaforas ribojantis vienalaikius `faster-whisper-embedded` subprocess'us (`FASTER_WHISPER_MAX_CONCURRENCY`), patikrinta laiko matavimo testu.
- [x] ~~Nereikalinga `node-fetch` priklausomybė~~ → pašalinta, naudojamas Node 22 native `fetch` (projektas jau reikalauja Node 22+).
- [x] ~~Bent vienas frontend komponento/integracijos testas~~ → `frontend/src/App.test.jsx` (React Testing Library + mocked fetch): backend health statusas, generavimo srautas, klaidų rodymas. Liko neišbandyta: audio upload srautas, protokolo redagavimas, eksportai, diarizacijos pasirinkimas, live įrašymas.
- [ ] PDF eksportas.
- [ ] Realios įrašo TRUKMĖS (ne tik failo dydžio) tikrinimas prieš apdorojimą (`ffprobe` ar panaši biblioteka) - žr. paaiškinimą `backend/README.md` "Faster-Whisper" skyriuje.
- [x] ~~Playwright/Cypress E2E testas (naršyklė → audio upload → transcribe → generate → edit → export)~~ → **Milestone 1**: Playwright E2E (`frontend/e2e/`) dengia įklijuoto teksto IR pilno audio upload → polling → protokolas → DOCX srautus + klaidų kelius. Vykdomi CI'e su Chromium. Liko: redagavimo srautas, diarizacijos pasirinkimas naršyklėje.
- [ ] Audit log perkėlimas iš atminties į SQLite/Postgres (su retention politika, PII redagavimu, paieška, eksportu). *(Milestone 2)*
- [x] ~~Tikra job queue vietoj in-memory saugyklos~~ → **Milestone 1**: BullMQ eilė su atskirais worker procesais (`workers/transcriptionWorker.js`, `protocolWorker.js`), retry+backoff, `failed` būsenos retencija po visų bandymų (ne atskira dead-letter eilė - žr. terminijos pastabą aukščiau), stalled recovery, atominis job reservation; Redis-backed persistentus state su fallback į in-memory. Liko (Milestone 2): PostgreSQL ilgalaikiams rezultatams.
- [ ] Tikras audio streaming tiekėjui (šiuo metu visas failas skaitomas į RAM prieš siunčiant - žr. backend README).
- [ ] Antivirusinis audio failų skenavimas (šiuo metu tik magic-bytes signature patikra, ne pilnas turinio skenavimas).
- [ ] Realių `Azure`/`Google`/`GPT`/`Gemini`/`Whisper`/`Deepgram`/`pyannote-cloud`/`AssemblyAI` tiekėjų testavimas su mokamais raktais.
- [x] ~~`faster-whisper-embedded`: patikrinti su realia (ne TTS) žmogaus kalba, lietuvių kalba~~ → patikrinta su tikru 4 val. lietuvišku posėdžio įrašu, `tiny` ir `small` modeliais (žr. `backend/README.md` "Realaus audio testas"). Liko: `medium`/`large-v3` modeliai, GPU (`device=cuda`), pilnas ilgas (>1 val.) įrašas ištisai, keli kalbėtojai/diarizacija su realiu įrašu.
- [ ] Per-user autentifikacija (sesijos/OAuth) vietoj bendro `API_KEY`, jei diegiama kaip viešas SaaS su realiais vartotojais.

---

## Docker

```bash
cp backend/.env.example backend/.env   # užpildykite pagal poreikį
docker compose up --build
```

Paleidžia backend'ą (`127.0.0.1:3001`) ir frontend'ą (nginx, `127.0.0.1:5173`) kartu,
prieinamus TIK iš jūsų mašinos. `docker-compose.yml` perduoda visus reikiamus env
kintamuosius abiem servisams (žr. failą - `VITE_*` kintamieji frontend'ui perduodami
kaip **build args**, nes Vite juos įkompiliuoja į bundle'ą build metu, ne skaito runtime).

**⚠️ Du dalykai, kuriuos verta žinoti PRIEŠ keičiant numatytus nustatymus:**

1. **Prievadai sąmoningai susieti su `127.0.0.1`, ne `0.0.0.0`.** Jei pakeisite
   į paprastą `"3001:3001"` (Docker numatytai sietų su `0.0.0.0`) ir paleisite
   šį compose bet kokioje mašinoje su viešu IP - kartu su numatytu
   `NODE_ENV=development` (= be `API_KEY` autentifikacijos) bet kas internete
   galėtų nemokamai naudoti `/api/generate` su jūsų realiu LLM raktu. Tai
   TIKSLIAI atitinka šio README "greito paleidimo" kelią, todėl tai nėra
   egzotiškas kraštutinis atvejis - tai numatytas scenarijus, jei prievadai
   būtų atviri.
2. **`VITE_API_KEY` kaip Docker build arg papildomai nutekėtų per image layers.**
   Be jau paminėto rizikos (raktas matomas JS bundle'e naršyklėje - žr.
   backend README "Autentifikacija ir viešas diegimas"), Docker build ARGs
   išlieka atsekami per `docker history --no-trunc <image>` net PO build'o.
   Jei naudojate `VITE_API_KEY`, laikykite tai vidinio/lokalaus naudojimo
   priemone, o ne viešo image publikavimo (Docker Hub ir pan.) praktika.

**Sąžiningai:** `Dockerfile`/`docker-compose.yml` parašyti pagal standartinius
Node/nginx multi-stage build šablonus. **Šioje sandbox aplinkoje NEBUVO build-testuoti**
(nėra Docker daemon), bet CI (`.github/workflows/ci.yml`, `docker` job'as) kiekvienam
push/PR realiai paleidžia `docker compose build` + backend konteinerį + `/api/health`
smoke testą per GitHub Actions runner'į (kuris Docker turi). Jei matote žalią CI
varnelę prie šio commit'o - Docker setup'as realiai veikia, ne tik sintaksiškai validus.

### Pilnas stackas su GPU ir lokalia diarizacija

Bazinis `docker compose up` paleidžia tik backend+frontend su **mock** tiekėjais
(veikia iš karto be raktų). Realiam darbui su lokalia transkripcija (`faster-whisper`)
ir diarizacija (`pyannote`) yra atskiras GPU override:

```bash
# .env faile nustatykite HUGGINGFACE_TOKEN (pyannote gated modeliui)
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up --build
# arba trumpiau:
make docker-gpu
```

Tai prideda/keičia lyginant su baziniu compose: (1) backend statomas
iš `backend/Dockerfile.whisper.gpu` (CUDA bazinis image + Node + Python + GPU CUDA
bibliotekos, tad `FASTER_WHISPER_DEVICE=cuda` REALIAI veikia konteineryje) -
backend'as PATS transkribuoja/diarizuoja SINCHRONINIAM keliui (`/api/transcribe`,
`/api/generate`), tad jam irgi reikia GPU/pyannote prieigos; (2) pridedamas
`pyannote` diarizacijos servisas iš `pyannote-server/Dockerfile.gpu` (CUDA image +
GPU torch - `torch.cuda.is_available()` bus `True`); (3) pridedamas `redis`
(persistentus job store) IR DU ATSKIRI worker servisai - `transcription-worker`
(GPU) ir `protocol-worker` (be GPU, tik LLM kvietimas) - kurie apdoroja BullMQ
eilės jobus ASINCHRONINIAM keliui (`/api/transcribe-jobs`, `/api/jobs`); (4) GPU
rezervavimas `backend`, `transcription-worker` ir `pyannote` servisams per
`deploy.resources` (`protocol-worker` GPU negauna - nereikia).

**Reikia:** NVIDIA GPU + draiveriai + `nvidia-container-toolkit` host mašinoje, ir
`HUGGINGFACE_TOKEN` (pyannote modelis „gated"). Yra ir CPU variantai
(`Dockerfile.whisper`, `pyannote-server/Dockerfile`) - jie naudojami, jei GPU nėra,
bet dideliems įrašams bus lėti.

### CPU stackas (realus faster-whisper, ne mock)

`make quickstart-cpu` naudoja `docker-compose.cpu.yml` override, kuris įjungia
**realią** lokalią CPU transkripciją (`faster-whisper-embedded`). Be šio override
bazinis compose paleistų `mock` - tad `quickstart-cpu` ir `quickstart` būtų tapatūs.

### Paruošti Docker image'ai (GHCR) - greitesnis diegimas

Numatytai `make quickstart-*` stato image'us lokaliai (CUDA/Torch/pyannote/Whisper -
gali užtrukti). Su publikuotais image'ais galima traukti vietoj statymo:

```bash
export REGISTRY=ghcr.io/jusu-vardas   # jūsų GHCR namespace
make quickstart-gpu                    # traukia REGISTRY image'us (pull), NE stato
# arba priverstinis lokalus build bet kada:
BUILD=1 make quickstart-gpu
```

Logika: **be `REGISTRY`** image vardas yra lokalus (`stenograma-backend:gpu`) ir
quickstart stato lokaliai - jokio bandymo jungtis prie netikro registry. **Su
`REGISTRY`** image tampa `$REGISTRY/stenograma-backend:gpu` ir quickstart traukia
per `docker compose pull`.

⚠️ **STATUSAS: publikavimo workflow ĮJUNGTAS, bet image'ai dar nepublikuoti jūsų
repo.** Publikuoti (vienkartinis veiksmas):

```bash
git tag v1.0.0 && git push --tags   # paleidžia .github/workflows/publish-images.yml
# arba rankiniu būdu: GitHub repo > Actions > "Publish images (GHCR)" > Run workflow
```

Prieš pirmą kartą: repo Settings > Actions > Workflow permissions = "Read and write".
Publikuojami PENKI image'ai: `backend` (GPU), `backend-base` (lengvas, be Python/
CUDA - naudoja `protocol-worker`), `whisper` (GPU), `pyannote` (GPU), `frontend`.
Po to vartotojai naudoja `export REGISTRY=ghcr.io/jusu-vardas && make quickstart-gpu`
ir traukia paruoštus image'us vietoj 15-30 min lokalaus build'o.

⚠️ **Release pilnumo rizika:** matricos `fail-fast: false` reiškia, kad DALIS
image'ų gali sėkmingai publikuotis, o kitas (pvz. `backend-base`) - ne. Tokiu
atveju `git tag`/release egzistuotų, bet `protocol-worker` su `REGISTRY` nustatytu
kintamuoju bandytų traukti neegzistuojantį image'ą (404) - vietoj to reikėtų
priverstinio lokalaus build'o (`BUILD=1 make quickstart-gpu`). **Prieš pasitikint
publikuotu release'u, patikrinkite, kad VISI 5 matricos job'ai (GitHub Actions >
"Publish images (GHCR)" workflow paleidimas) yra žali** - šiuo metu tam nėra
atskiro automatinio manifest/completeness patikrinimo job'o.

### Build'o spartinimas (jau įdiegta)

Net statant lokaliai, keli optimizavimai mažina build laiką:
- **BuildKit cache mounts** - pip/npm cache išlieka tarp build'ų (pakartotiniai
  build'ai nesisiunčia tų pačių paketų). `quickstart.sh` įjungia `DOCKER_BUILDKIT=1`.
- **`.dockerignore` visuose servisuose** - `.venv`, `node_modules`, `__pycache__`,
  testai nesiunčiami į build context (mažesnis kontekstas = greitesnis build).
- **Sluoksnių tvarka** - priklausomybės (`package.json`/`requirements.txt`) kopijuojamos
  ATSKIRAI ir prieš kodą, tad kodo pakeitimas nepriverčia iš naujo diegti priklausomybių.
- **Modelio pre-download (optional)** - `whisper-server/Dockerfile.gpu` su
  `--build-arg PREDOWNLOAD_MODEL=1` "įkepa" modelį į image (greitesnis pirmas
  paleidimas, didesnis image). Be jo modelis atsisiunčiamas pirmo paleidimo metu -
  quickstart aiškiai įspėja apie šį laukimą (kad neatrodytų kaip strigimas).

### Profilių izoliacija (svarbu)

Kiekvienas quickstart profilis turi savo compose override, kuris **priverstinai**
nustato esminius kintamuosius - kad profiliai NEPRIKLAUSYTŲ nuo likusio
`backend/.env` (pvz. jei anksčiau per `make configure` pasirinkote GPU+claude, o
paskui paleidžiate `make quickstart` demo):

| Profilis | Override | Priverstinai nustato |
|---|---|---|
| `quickstart` (demo) | `docker-compose.demo.yml` | `TRANSCRIPTION_PROVIDER=mock`, `LLM_PROVIDER=mock`, `DIARIZATION_PROVIDER=none` |
| `quickstart-cpu` | `docker-compose.cpu.yml` | `faster-whisper-embedded`, `device=cpu`, `DIARIZATION_PROVIDER=none` |
| `quickstart-gpu` | `docker-compose.gpu.yml` | `device=cuda`, `DIARIZATION_PROVIDER=pyannote`, pyannote servisas |

Raktai (API_KEY, ANTHROPIC_API_KEY, HUGGINGFACE_TOKEN) visada imami iš
`backend/.env`/shell - profiliai perrašo tik režimo kintamuosius, ne paslaptis.
GPU profilyje **`HUGGINGFACE_TOKEN` privalomas** (preflight `--require-hf` sustabdo
be jo, nes pyannote be tokeno tampa unhealthy ir visas stackas nepasileidžia).

**Patogumas:** kad tokeno nereikėtų eksportuoti kas terminalo sesiją, įrašykite jį
į **šakninį `.env`** (`cp .env.example .env`, tada `HUGGINGFACE_TOKEN=hf_...`).
Tą patį failą automatiškai skaito ir Docker Compose, ir `preflight-gpu.sh` (saugiai -
tik reikšmės ištraukimas, ne `source`). Šakninis `.env` yra `.gitignore` - jokios
paslaptys nepateks į Git.

### Pull vs. build (greitis)

Numatytai `make quickstart-*` bando **traukti** paruoštus image'us (`docker compose
pull`), tada kelia - greita, jei image'ai publikuoti GHCR. Jei registry image'ų
nėra, Compose pastato lokaliai iš `build:` sekcijos. Priverstinis lokalus build:
`BUILD=1 make quickstart-gpu` (arba `make docker-gpu-build`).

**Užfiksuotos priklausomybių versijos:** deterministiniam diegimui (svarbu RunPod
ir kitose ilgaamžėse aplinkose) yra lock failai su konkrečiomis versijomis:
`backend/scripts/requirements-{cpu,gpu}.lock.txt` ir
`pyannote-server/requirements-{cpu,gpu}.lock.txt`. Docker image'ai jau juos naudoja.
faster-whisper stack'o versijos realiai patikrintos (vartotojo sesija); pyannote
versijos - rekomenduojamas suderinamas rinkinys (žr. failų komentarus dėl statuso).

**Sąžiningai:** GPU Dockerfile'ai (CUDA baziniai image'ai, `torch --index-url .../cu124`,
`nvidia-cublas-cu12`) parašyti pagal standartines faster-whisper/pyannote GPU diegimo
instrukcijas ir **realiai build-testuoti per GitHub Actions** (`Publish images (GHCR)`
workflow - image'ai sėkmingai sukuriami ir publikuojami). Veikimas su tikru GPU
patikrintas per RunPod: Whisper + pyannote apdorojo ~4 val. įrašą iki protokolo.

Pyannote serverio `/health` logika ir `/diarize` kontraktas - realiai išbandyti per FastAPI TestClient
(`pyannote-server/test_server.py`, 3 testai praeina).

## Paleidimo scenarijai (Makefile)

Kad nereikėtų prisiminti ilgų komandų, yra `Makefile` su įvardytais scenarijais.
`make` arba `make help` parodo visą sąrašą. Patogus galutinis rinkinys:

**Vieno mygtuko UX (Docker):**

| Komanda | Ką daro |
|---|---|
| `make quickstart` | Demo/mock stackas viena komanda (build → laukia health → smoke → rodo URL) |
| `make quickstart-cpu` | Lokalus Whisper CPU stackas viena komanda |
| `make quickstart-gpu` | Whisper GPU + pyannote (tikrina Docker GPU passthrough prieš statymą) |
| `make configure` | Interaktyviai sugeneruoja `backend/.env` (režimas + LLM pasirinkimas) |

**Diegimas be Docker:** `make setup` / `make setup-gpu` / `make dev` / `make cpu` /
`make gpu-transcription` / `make pyannote` / `make gpu`.

**Diagnostika ir priežiūra:**

| Komanda | Ką daro |
|---|---|
| `make doctor` | Node, Python, CUDA, ffmpeg, modeliai, diskas, RAM |
| `make status` | Konteinerių ir health būsena |
| `make logs` | Svarbiausi visų servisų logai |
| `make verify` / `make smoke-gpu` | End-to-end: WAV → transkripcija → protokolas per tikrą HTTP |
| `make warmup` | Modelių įkėlimas į cache/VRAM (pirmas realus failas nebus lėtas) |
| `make update` | Nauji Docker image'ai ir saugus restartas |
| `make support-bundle` | Diagnostikos paketas (viskas į vieną failą, slapti duomenys užmaskuoti) |

`make gpu` (be Docker) paleidžia **abu** servisus - pyannote :8001 + backend su
`DIARIZATION_PROVIDER=pyannote`. Docker alternatyva (izoliuota, tikri GPU image'ai):
`make quickstart-gpu`.

**smoke-gpu / verify realiai patikrintas** (CPU režimu su tikru faster-whisper
modeliu): WAV → transkripcija → protokolas per tikrą HTTP API praėjo. Docker/GPU
keliai (`quickstart-*`) - logika parašyta ir sintaksiškai patikrinta, bet pilnas
Docker srautas nebuvo vykdytas šioje aplinkoje (nėra Docker daemon nei GPU).

## Diegimo topologijos

Sistema palaiko keturias tipines konfigūracijas. Visos naudoja tą patį kodą -
skiriasi tik `.env` ir paleidimo būdas.

**1. Lokaliai, demo (be jokių raktų):**
```
[Naršyklė] → [Frontend :5173] → [Backend :3001]
                                    ├─ mock transkripcija
                                    └─ mock LLM
```
`make dev`. Nieko papildomo nereikia. Tinka pademonstruoti sąsają darbdaviui.

**2. Lokaliai, realus darbas (jautrūs įrašai niekur neišeina):**
```
[Naršyklė] → [Frontend] → [Backend] ─ spawn ─→ [Python faster-whisper]  (lokaliai, CPU/GPU)
                              │
                              ├─ HTTP → [pyannote serveris :8001]  (lokaliai, diarizacija)
                              └─ HTTPS → [Claude API]  (TIK protokolo tekstas, ne audio)
```
`make gpu` + atskirai paleistas pyannote serveris. Audio ir transkripcija lieka
jūsų mašinoje; į išorę keliauja tik galutinės transkripcijos tekstas protokolui.

**3. Docker (viena mašina, visas stackas):**
```
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up
   ├─ backend               (Node + Python + faster-whisper, GPU - sinchroniniai endpoint'ai)
   ├─ transcription-worker  (Node + Python + faster-whisper, GPU - async eilė)
   ├─ protocol-worker       (Node, LLM API kvietimas - async eilė, be GPU)
   ├─ pyannote              (FastAPI + pyannote.audio, GPU)
   ├─ redis                 (BullMQ eilė + job store)
   └─ frontend              (nginx)
```
`make docker-gpu`. Viskas viename `docker compose`, modelių cache bendrame volume.

**4. RunPod / nuomojamas GPU serveris:**
```
[Naršyklė] → RunPod HTTP proxy → [Frontend :5173 (0.0.0.0)]
                                        │ nginx /api proxy (vidinis Docker tinklas)
                                        ├→ [backend :3001]  (NEeksponuotas viešai)
                                        └→ [pyannote :8001] (NEeksponuotas viešai)
```
RunPod'ui yra **atskiras** `docker-compose.runpod.yml` (aiškiai atskirtas nuo
lokalaus Docker scenarijaus, kad nesimaišytų):

```bash
export MODEL_CACHE_DIR=/workspace/models   # persistent volume
export HUGGINGFACE_TOKEN=hf_...
make quickstart-runpod
```

Skirtumai nuo lokalaus `quickstart-gpu`: (1) frontend eksponuojamas `0.0.0.0:5173`
(RunPod proxy pasiekia; lokaliai būtų `127.0.0.1`); (2) **vienas viešas prievadas** -
backend ir pyannote pasiekiami tik vidiniu Docker tinklu per nginx `/api` proxy;
(3) RunPod pod nustatymuose atidarykite tik `5173`. Dėl RunPod HTTP proxy kieto 100s
limito **būtina** async `/api/transcribe-jobs` kelias (frontend tai daro
automatiškai). Pilnas žingsnis po žingsnio - žr. [`RUNPOD.md`](RUNPOD.md).

### Deployment diagrama (C4-style, GPU Docker stackas)

Pilno GPU stacko konteineriai ir jų ryšiai (Mermaid - renderinasi GitHub'e):

```mermaid
flowchart TB
    subgraph host["Host mašina (NVIDIA GPU + nvidia-container-toolkit)"]
        subgraph compose["docker compose (-f docker-compose.yml -f docker-compose.gpu.yml)"]
            FE["frontend<br/>nginx :5173"]
            BE["backend<br/>Node + Python :3001 (GPU)<br/>SINCHRONINIAI /api/transcribe,<br/>/api/generate (frontend'as naudoja ŠĮ) +<br/>ASINCHRONINIAI /api/jobs (API klientams,<br/>frontend'as NENAUDOJA - žr. pastabą žemiau)"]
            TWRK["transcription-worker<br/>Node + Python (GPU)<br/>faster-whisper embedded<br/>(ATSKIRAS procesas/konteineris)"]
            PWRK["protocol-worker<br/>Node (be GPU)<br/>LLM/protokolo generavimas<br/>(ATSKIRAS procesas/konteineris)"]
            RD[("redis<br/>BullMQ eilės + job store<br/>AOF persistencija")]
            PY["pyannote<br/>FastAPI :8001<br/>pyannote.audio (GPU)"]
            VOL[("stenograma-models<br/>volume: /models<br/>(MODEL_CACHE_DIR)")]
            STOR[("stenograma-storage<br/>volume: /storage<br/>(bendras audio backend↔transcription-worker)")]
        end
        GPU["NVIDIA GPU"]
    end
    Browser([Naršyklė]) -->|"HTTP :5173"| FE
    FE -->|"proxy /api → :3001"| BE
    BE -->|"SINCHRONINIS: HTTP :8001 /diarize<br/>(diarize=true)"| PY
    BE -->|"ASINCHRONINIS: queue.add() (202 iškart)"| RD
    RD -->|"transcription-worker paima<br/>transkripcijos jobą"| TWRK
    RD -->|"protocol-worker paima<br/>protokolo jobą"| PWRK
    TWRK -->|"HTTP :8001 /diarize<br/>(laukia service_healthy)"| PY
    PWRK -.->|"HTTPS: tik protokolo tekstas"| Claude["Claude API<br/>(išorinis)"]
    BE -.->|"HTTPS (sinchroninis /api/generate)"| Claude
    BE --> GPU
    TWRK --> GPU
    PY --> GPU
    BE --- VOL
    TWRK --- VOL
    PY --- VOL
    BE --- STOR
    TWRK --- STOR

    style Browser fill:#e1f5ff
    style Claude fill:#ffe1e1
    style GPU fill:#e1ffe1
    style VOL fill:#f0f0f0
    style STOR fill:#f0f0f0
    style RD fill:#ffe8cc
```

Svarbu srautui - DVI ATSKIROS DUOMENŲ TAKAI, priklausomai nuo naudojamo endpoint'o:

- **Sinchroninis** (`POST /api/transcribe`, `POST /api/generate`): backend'as PATS
  atlieka transkripciją/diarizaciją/LLM kvietimą TIESIOGIAI savo procese (todėl
  jam reikia GPU ir pyannote prieigos). Klientas laiko atvirą HTTP ryšį, kol darbas
  baigsis - tinka trumpiems įrašams, bet ilgesniems gali užtrukti ar timeout'inti.
- **Asinchroninis** (`POST /api/transcribe-jobs`, `POST /api/jobs`): backend'as TIK
  priima užklausą, įrašo audio į bendrą storage (transkripcijai) ir įdeda jobą į
  BullMQ eilę (Redis), grąžina 202 IŠ KARTO. Realų darbą atlieka ATSKIRI
  `transcription-worker`/`protocol-worker` konteineriai - tai reiškia, kad ŠIUO
  KELIU backend'o restartas nenutraukia vykdomo darbo (žr. `backend/README.md`
  "Ką TIKRAI reiškia 'restartas nenutraukia darbo'" dėl tikslaus scope - tai
  negalioja sinchroniniam keliui).

**⚠️ TIKSLINIMAS (anksčiau čia buvo klaidingas teiginys):** frontend'as PAGAL
NUTYLĖJIMĄ naudoja `/api/transcribe-jobs` TIK transkripcijai
(`handleAutoTranscribe`) - tai realiai patikrinta ir dokumentuota (žr.
`backend/README.md` istoriją: RunPod HTTP proxy kietas 100s limitas privertė tai
padaryti privalomu). **BET protokolo generavimui frontend'as VISADA naudoja
SINCHRONINĮ `/api/generate`** (`App.jsx` `handleGenerate` → `generateProtocol()`),
**NIEKADA** `/api/jobs` - patikrinta: jokios nuorodos į `/api/jobs` fronte
nėra. Tai reiškia, kad tas pats RunPod 100s proxy limitas, kuris privertė
padaryti transkripciją asinchronine, **TEORIŠKAI GALI PALIESTI IR PROTOKOLO
GENERAVIMĄ** - itin ilgo (pvz. 4 val.) susitikimo transkripcijos siuntimas
Claude API per `/api/generate` gali užtrukti ilgiau nei 100s per RunPod proxy,
nors backend'as (ir dabar - `protocol-worker`) turi VISIŠKAI VEIKIANČIĄ
asinchroninę alternatyvą (`/api/jobs`), kurios frontend'as tiesiog nenaudoja.
**Tai NĖRA šios sesijos sukurta problema** - tai pre-egzistuojanti architektūrinė
spraga, kurią ši Docker/CI peržiūra atskleidė netiesiogiai (tikrinant, kaip
realiai naudojamas `protocol-worker`). Rekomenduojamas taisymas: pridėti
`transcribeAudioJob`-analogišką `generateProtocolJob()` funkciją
`stenogramaApi.js`, naudojančią `/api/jobs` + polling, ir perjungti
`handleGenerate` ją naudoti - simetriškai su `handleAutoTranscribe`.

`transcription-worker` ir `protocol-worker` yra ATSKIRI compose servisai (ne
vienas bendras `worker`), tad skaluojami NEPRIKLAUSOMAI
(`--scale transcription-worker=N`, `--scale protocol-worker=N`); GPU rezervuotas
TIK `backend`, `transcription-worker` ir `pyannote` - `protocol-worker` (grynas
LLM API kvietimas) GPU negauna. `transcription-worker` laukia `pyannote`
`service_healthy` (modelis realiai įkeltas) prieš startuodamas; audio ir
transkripcija lieka konteineriuose, į išorę (Claude API) keliauja **tik**
galutinės transkripcijos tekstas protokolui, ne garsas. Modelių cache bendrame
volume — RunPod'e nukreipkite į persistent volume per `MODEL_CACHE_DIR`, kad
keli GB nesiųstų kaskart.

---

## Licencija

MIT — žr. [`LICENSE`](LICENSE).

## Privatumas ir GDPR kontrolės

Stenograma apdoroja posėdžių įrašus, transkripcijas, kalbėtojų informaciją, vardus,
kontaktus ir kitus asmens ar konfidencialius duomenis. Sistemoje yra techninės
priemonės, mažinančios nereikalingą duomenų atskleidimą.

**Sąžiningai:** šios priemonės padeda diegti sistemą privatumą gerbiančiai, bet
**savaime NEUŽTIKRINA atitikties BDAR**. Teisinį pagrindą, saugojimo terminus,
prieigos valdymą ir organizacines procedūras apibrėžia sistemą eksploatuojanti
organizacija. Pseudonimizuoti duomenys pagal BDAR **vis dar yra asmens duomenys**.

### Privatumą tausojantis auditas

Audito įvykiai saugo pseudonimizuotą subjekto identifikatorių (HMAC-SHA256), ne
patį jobo/susitikimo ID. Laisvo teksto laukai (klaidų pranešimai) prieš įrašymą
praeina redakcijos grandinę: autentifikacijos duomenys, el. paštai, telefonai,
asmens kodai, IP adresai, URL keliai ir failų keliai pakeičiami žymomis.

Redakcijos grandinė apima ir **URL prisijungimo duomenis bet kokioje schemoje**
(`redis://naudotojas:slaptas@host`, `postgres://…`, `amqp://…`) – tai rasta
realiai: neveikiančio Redis klaidos pranešimas su pilnu connection string
patekdavo į serverio logą.

Kontroliuojami laukai (`llmProvider`, `llmModel`, `promptVersion`,
`transcriptionProvider`, `diarizationProvider`) **nepraeina PII heuristikų** – jiems
taikomas tik simbolių allowlist. Tai sąmoningas sprendimas: bendras telefono
šablonas `claude-3-5-sonnet-20241022` paversdavo `claude-3-5-sonnet-[PHONE_REDACTED]`
ir sunaikindavo būtent tuos duomenis, dėl kurių auditas egzistuoja.

Į auditą **nepatenka**: įkeltas garsas, transkripcijos, promptai, failų vardai,
API raktai, pilni klaidų objektai.

```env
# Audito subjectId pseudonimizacijos druska. Produkcijoje BŪTINA nustatyti savo -
# antraip naudojama repozitorijoje esanti numatytoji reikšmė ir spėjamiems
# identifikatoriams pseudonimizacija tampa atsukama.
# reikšmę sugeneruokite: openssl rand -hex 32
AUDIT_ID_SALT=
```

### Audito retencija

```env
AUDIT_RETENTION_DAYS=30    # numatyta: 30
AUDIT_MAX_ENTRIES=5000     # kieta atminties riba
```

Pasenę įrašai šalinami tiek rašant naują įvykį, tiek skaitant `GET /api/audit`.

**Apribojimas – tai NĖRA production-grade audit trail.** Žurnalas yra
backend'o atmintyje, tad: dingsta po restarto; nesidalija tarp replikų; neturi
DB transakcijų, tamper-resistance, prieigos žurnalo ar tikro retention
scheduler'io. Retencija realiai reiškia „iki restarto arba iki N dienų, kas
ateina pirmiau". Ilgalaikei atitikčiai reikia SQLite/PostgreSQL saugyklos –
žr. Roadmap (Milestone 2).

### Privatumo režimas

```env
PRIVACY_MODE=true
```

Įjungus:

- nauji audito įrašai nerašomi;
- atmintyje sukaupti įrašai išvalomi (tiek rašant, tiek skaitant, tiek proceso starte);
- serverio klaidų logai papildomai sanitizuojami (`utils/sanitizeError.js`);
- transkribavimas ir protokolų generavimas veikia įprastai.

### Tiekėjų privatumo matrica

Kiekvienas tiekėjas klasifikuotas: **lokalus** (duomenys neišeina iš mašinos) ar
**išorinis** (siunčiama trečiajai šaliai), ir kokie duomenys siunčiami. Šaltinis
kode – [`backend/utils/providerPrivacy.js`](backend/utils/providerPrivacy.js);
`tests/providerPrivacy.test.js` **krenta**, jei registre atsiranda tiekėjas,
neaprašytas nei čia, nei toje lentelėje – taip ji negali pasenti.

**Transkribavimas** (`TRANSCRIPTION_PROVIDER`):

| Tiekėjas | Apdorojimas | Ką siunčia | Kam | Pastabos |
|---|---|---|---|---|
| `mock` | 🟢 lokalus | – | – | Fiksuotas pavyzdys; įrašas net nenuskaitomas |
| `faster-whisper-embedded` | 🟢 lokalus | – | – | Python subprocesas toje pačioje mašinoje |
| `faster-whisper-server` | 🟢 lokalus | – | – | Atskiras HTTP servisas; laikykite savo tinkle |
| `faster-whisper` | 🟢 lokalus | – | – | Alias `faster-whisper-server` |
| `whisper` | 🔴 išorinis | **garso įrašas** | OpenAI | Visas failas įkeliamas į API |
| `azure` | 🔴 išorinis | **garso įrašas** | Microsoft Azure | Regionas – `AZURE_SPEECH_REGION` |
| `google` | 🔴 išorinis | **garso įrašas** | Google Cloud | Regionas – projekto konfigūracija |
| `deepgram` | 🔴 išorinis | **garso įrašas** | Deepgram | – |

**Diarizacija** (`DIARIZATION_PROVIDER`):

| Tiekėjas | Apdorojimas | Ką siunčia | Kam | Pastabos |
|---|---|---|---|---|
| `none` | 🟢 lokalus | – | – | Diarizacija neatliekama |
| `inline` | 🟡 priklauso | – | – | Atskiro kvietimo nėra; poveikis **toks pat kaip transkribavimo tiekėjo** |
| `mock` | 🟢 lokalus | – | – | Deterministiniai intervalai testams |
| `pyannote` | 🟢 lokalus | – | – | Lokalus FastAPI; modelis gated (`HUGGINGFACE_TOKEN`) |
| `pyannote-cloud` | 🔴 išorinis | **garso įrašas** | pyannote.ai | – |
| `assemblyai` | 🔴 išorinis | **garso įrašas** | AssemblyAI | – |

**Protokolo generavimas** (`LLM_PROVIDER`):

| Tiekėjas | Apdorojimas | Ką siunčia | Kam | Pastabos |
|---|---|---|---|---|
| `mock` | 🟢 lokalus | – | – | Regex heuristikos, ne modelis |
| `claude` | 🔴 išorinis | **transkripcijos tekstas** | Anthropic | Garsas NEsiunčiamas |
| `gpt` | 🔴 išorinis | **transkripcijos tekstas** | OpenAI | Garsas NEsiunčiamas |
| `gemini` | 🔴 išorinis | **transkripcijos tekstas** | Google | Garsas NEsiunčiamas |

**Paleidimo įspėjimai.** Pasirinkus išorinį tiekėją, `utils/startupChecks.js`
išveda įspėjimą su tiekėju, duomenų kategorija ir gavėju. Tas pats matoma
diagnostikoje – `GET /api/health` grąžina `privacy.externalProviders`.

**Ko šis projektas NETVIRTINA.** Nė vienas išorinis tiekėjas nėra „GDPR
compliant" dėl to, kad palaikomas šiame kode. Teisinis pagrindas, duomenų
tvarkymo sutartis, subtiekėjai ir duomenų rezidencija priklauso nuo **jūsų**
sutarties su tiekėju bei pasirinkto regiono, ir yra **deployment-specific** –
tas pats `LLM_PROVIDER=claude` skirtingose organizacijose gali būti ir teisėtas,
ir ne. Šis projektas tik parodo, kas kur siunčiama.

**Pilnai lokali konfigūracija** (nieko neišeina iš mašinos):

```env
PRIVACY_PROFILE=local_only
TRANSCRIPTION_PROVIDER=faster-whisper-embedded
DIARIZATION_PROVIDER=pyannote      # arba none
LLM_PROVIDER=mock
```

Pastaba dėl `LLM_PROVIDER=mock`: lokalaus LLM tiekėjo (pvz. Ollama/llama.cpp)
šiame projekte **kol kas nėra**, tad pilnai lokalus režimas protokolą sudaro
heuristikomis, ne modeliu. Tai sąmoningas apribojimas, ne paslėptas.

### Privatumo konfigūracija ir startup validacija

| Kintamasis | Numatyta | Ką daro |
|---|---|---|
| `PRIVACY_PROFILE` | `standard` | `local_only` – uždraudžia visus išorinius tiekėjus |
| `ALLOW_EXTERNAL_PROVIDERS` | `true` | `false` – tas pats be viso profilio |
| `PRIVACY_MODE` | `false` | `true` – išjungia audito žurnalą (**atskira** nuostata) |
| `PERSISTENT_STORAGE` | išvedama iš `REDIS_URL` | `false` – jobų būsena/rezultatai tik atmintyje (audio – laikinai diske) |
| `REQUIRE_REDACTION_BEFORE_EXTERNAL` | `false` | `true` – į išorinį **LLM** tiekėją tik redaguotas payload'as (`redact()` iš issue #4) |
| `EXPORT_ALLOW_ORIGINAL` | `true` | `false` – DOCX/CSV/TXT tik iš redaguoto protokolo |
| `AUDIT_RETENTION_DAYS` | `30` | Leistinos ribos: 1–365 |
| `JOB_TTL_MINUTES` | `60` | Jobo metaduomenų retencija |
| `AUDIO_RETENTION_HOURS` | `24` | Po kiek nuskendę audio failai šalinami |
| `RETENTION_SWEEP_INTERVAL_MINUTES` | `5` | Retencijos ciklo periodas (vienintelis jobų valymo mechanizmas) |

**Prieštaringos ir neteisingos konfigūracijos serveriui startuoti neleidžia**
(`validateConfig`): `PRIVACY_PROFILE=local_only` su `LLM_PROVIDER=claude` yra
klaida, ne įspėjimas.

Taip pat atmetamos **netaisyklingos reikšmės**, o ne tyliai pakeičiamos
numatytosiomis: `JOB_TTL_MINUTES=abc`, `AUDIO_RETENTION_HOURS=-1`,
`RETENTION_SWEEP_INTERVAL_MINUTES=0`, `ALLOW_EXTERNAL_PROVIDERS=maybe`. Priežastis
privatumo: administratoriui atrodytų, kad nustatė 1 val. retenciją, o sistema
naudotų 24. Ribos: `AUDIT_RETENTION_DAYS` 1–365, `JOB_TTL_MINUTES` 1–525600,
`AUDIO_RETENTION_HOURS` 1–8760, intervalai 1–10080.

**Persistentinės saugyklos išjungimas.** `PERSISTENT_STORAGE=false` išjungia
persistentinį **jobų būsenos, transkripcijų ir protokolų** saugojimą: šie duomenys
laikomi tik proceso atmintyje ir dingsta po restarto. Audito žurnalas šiame MVP ir
taip visada tik atmintyje.

Audio **nėra** tik atmintyje: apdorojimo metu jis laikinai laikomas diske
(`utils/fileStorage.js`) ir normaliai pašalinamas jobui pasibaigus
(`utils/audioCleanup.js`). Po proceso kritimo likę failai efemeriškame režime
valomi ne vėliau kaip pagal **vienos valandos** nuskendusių failų retenciją
(vietoj numatytų 24 val.). Tai matyti ir diagnostikoje:
`privacy.storage.audio` = „disk (trinamas po jobo pabaigos)".

Vėliava yra **trijų būsenų sąmoningai**: nenustatyta → išvedama iš `REDIS_URL`
(nieko nelaužo esamiems diegimams); `false` + `REDIS_URL` → **startup klaida**;
`true` be `REDIS_URL` → taip pat klaida, nes „persistentinė" saugykla atmintyje
būtų melas. Tylus `REDIS_URL` ignoravimas reikštų, kad administratorius mano, jog
jobai išgyvena restartą, o jie neišgyvena. Efektyvi būsena matoma
`GET /api/health` → `privacy.storage` (`jobState`/`audit`/`audio`).

**Įkeltų failų priėmimas ir laikina saugykla.** Failai gula tik į serverio
kontroliuojamą katalogą (`UPLOAD_TMP_DIR`, numatyta OS `tmp`), vardas generuojamas
serveryje (`stenograma-<uuid>[.plėtinys]`), o vartotojo failo vardas naudojamas
**tik kaip metaduomuo** – į kelią jis nepatenka. Iš jo paimamas tik plėtinys, ir
tas pats praleidžiamas pro whitelist'ą.

Ribos ir formatai: `MAX_UPLOAD_MB` (numatyta 500), leidžiami mp3/wav/m4a/mp4/webm/
ogg/aac/flac. Naršyklės MIME **nėra vienintelis mechanizmas** – papildomai
tikrinama failo turinio parašo antraštė (`utils/audioMagicBytes.js`), tad
pervadintas tekstinis failas atmetamas.

Kelias tikrinamas prieš **kiekvieną** operaciją (skaitymą ir trynimą), įskaitant
`realpath` patikrą – tekstinė patikra nesustabdytų simbolinės nuorodos, vedančios
iš katalogo į išorę. Vietiniai keliai niekada nepatenka į API atsakymus.

Laikinas failas šalinamas po sėkmės, po validacijos klaidos ir po tiekėjo klaidos;
abu maršrutai (`/api/transcribe` ir `/api/transcribe-jobs`) naudoja tą patį kelią.
Po **restarto** likę failai valomi paleidžiant, prieš priimant naujus įkėlimus –
sąmoningai tik tada, nes periodinis valymas pagal amžių ištrintų vykdomą ilgo
įrašo įkėlimą.

⚠️ **`UPLOAD_TMP_DIR` negali būti bendras tarp vienu metu veikiančių backend
replikų.** Paleidimo valymas remiasi prielaida „šis procesas ką tik startavo,
vadinasi joks įkėlimas nevyksta". Su dviem replikomis ta prielaida krinta: vienos
starto metu kita gali kaip tik priiminėti failą, ir jis būtų pašalintas. Vienai
replikai (dabartinis pilotas) tai saugu; skalaujant reikės arba atskiro katalogo
kiekvienai replikai, arba proceso nuosavybės ir minimalaus amžiaus žymės.

**Redakcija prieš išorinį apdorojimą.** `REQUIRE_REDACTION_BEFORE_EXTERNAL=true`
reiškia, kad į išorinį LLM tiekėją siunčiamas payload'as pirma praleidžiamas per
`redact()`. Vykdoma **dekoratoriumi ties pačiu tiekėjo kvietimu**
(`providers/llm/RedactingLLMProvider.js`, įjungiamas `providers/llm/index.js`
fabrikoje), o ne prompt'o sudarymo metu. Priežastys:

- pro fabriką praeina **abu** vykdymo keliai – inline (`routes/generate.js`) ir
  BullMQ (`queues/processors.js`), tad naujas kelias apsaugą gauna automatiškai;
- **repair retry** siunčia antrą payload'ą su ta pačia transkripcija; redakcija
  prompt'o sudarymo metu jį praleistų.

**Fail-closed:** išorinis tiekėjas gauna **tik `redact()` rezultatą**. Jei redakcija
nepavyksta arba grąžina netinkamą rezultatą, tiekėjas **nekviečiamas** ir operacija
baigiasi aiškia klaida; originalus payload'as niekada nenaudojamas kaip fallback.
Lokalūs tiekėjai neapvyniojami (duomenys ir taip neišeina).

Dekoratorius **netikrina, ar rezultatas skiriasi** nuo įvesties: `redact()`,
grąžinantis tekstą nepakeistą, praeis. Realią PII aptikimo kokybę užtikrina
issue #4 – čia garantuojamas tik kelias, ne turinys.

⚠️ **Aprėptis: tik tekstinis kelias.** Išorinis transkribavimas (`whisper`,
`deepgram`, `azure`, `google`) ir debesų diarizacija (`pyannote-cloud`,
`assemblyai`) gauna **žalią garso įrašą** su vardais ir asmens kodais, o tekstinė
redakcija garso dengti negali. Todėl toks derinys su įjungta nuostata yra
**startup klaida**, ne įspėjimas – kitaip vėliava žadėtų daugiau, nei dengia.
Norint apsaugoti ir garsą, tinkamas įrankis yra `PRIVACY_PROFILE=local_only`.

Komponento aptikimas turi **tris būsenas** (nėra / neįsikelia / netinkamas
kontraktas), kad „modulis parašytas, bet turi `SyntaxError`" neatrodytų kaip
„įgyvendinkite #4". Diagnostika (`GET /api/health` → `privacy.redaction`) skiria
`componentDetected` (rastas modulis su `redact()`) nuo `configuredForEnforcement`
(konfigūracija tokia, kad fabrika tiekėją apvynios). Antrasis laukas sąmoningai
**nevadinamas** `enforced`: jis yra išvedamas iš konfigūracijos, o ne konkretaus
objekto patikra, tad toks pavadinimas žadėtų faktą vietoj prognozės. Kad prognozė
nuo tikrovės neatsiskirtų, fabrikos elgesį dengia testas, tikrinantis
`provider.redactionEnforced`.

⚠️ Kaina: efemeriškame režime nėra restart recovery – ilgas transkribavimas,
nutrūkęs dėl restarto, prarandamas ir jį reikia kartoti.

**Struktūruotas logas (`utils/logger.js`).** Kiekviena eilutė yra JSON su
`ts`, `level`, `component`, `msg` ir – automatiškai – `requestId`, `actor`,
`execution` iš request konteksto. Formatas: `json` produkcijoje, skaitomas
`pretty` kūrimo metu (`LOG_FORMAT`), lygis per `LOG_LEVEL`. Abu formatai rodo
**tą patį laukų rinkinį** – `pretty` tik perrikiuoja jį akiai. Skirtingas
informacijos kiekis reikštų, kad dalis klaidų matoma tik produkcijoje, kur jas
tirti sunkiausia.

Logeris savas, o ne pino: reikėjo tik lygių, JSON eilutės, konteksto įtraukimo
ir redakcijos, o pastarąją jau turim (`sanitizeForLogging`). Išorinė biblioteka
atsineštų **antrą** tiesą apie tai, kas jautru – du sąrašus, kurie ilgainiui
išsiskirtų.

**Redaguojama IR `msg`, IR `data`.** Pirminis projektas sanitizavo tik `data`,
laikydamas `msg` „mūsų pačių tekstu". Peržiūra parodė, kad 33 kvietimo vietos
interpoliuoja kintamuosius į `msg`, o šešiose – `e.message`, kuriame realiai būna
failų kelių. Rekomendacija dėti kintamuosius į `data` lieka, bet ji nebėra
vienintelė apsauga.

**`trust proxy` konfigūruojamas eksplicitiškai** per `TRUST_PROXY`, numatytai
`false`. Už nginx/RunPod proxy be jo visi klientai atrodytų kaip `127.0.0.1`, ir
rate limitas taptų bendras visiems; aklas `true` leistų klastoti
`X-Forwarded-For` ir limitą apeiti. Rekomenduojama skaitinė reikšmė (nginx = `1`).

Sanitizacija turi greitą kelią: pranešimai be `@`, kelio skirtuko ar ilgos
skaitmenų sekos praleidžiami nepatikrinti (20 tūkst. paprastų eilučių ≈ 120 ms).
Filtras sąmoningai platus – kilus abejonei, sanitizuojama.

**Eksporto ir įkėlimo įvykiai.** `EXPORT_STARTED/COMPLETED/FAILED` neša
**struktūrizuotus** `format`, `variant` ir `outcome` laukus, ne laisvos formos
`details` eilutę – kitaip klausimo „kas ir kada eksportavo neredaguotą variantą"
audite neatsakytum, nors visi duomenys jame ir būtų.

Atmesti įkėlimai (`UPLOAD_REJECTED`) fiksuojami visais keliais – trūkstamas
failas, neleidžiamas formatas, per didelis failas, neatitinkantis turinio parašas.
Laukai struktūrizuoti (`route`, `mime`, `outcome`, `sizeBytes`/`limitBytes`), o
dydžiai lieka **skaičiais**, kad auditą būtų galima filtruoti.

MIME išsaugomas `fileFilter` metu, **prieš** atmetimą – multer klaidos objekte jo
nėra. Dydžio limito atveju fiksuojamas **sukonfigūruotas limitas**, ne tariamas
faktinis dydis: multer nutraukia skaitymą peržengęs ribą ir realaus dydžio
nežino.

**Failo vardas neįrašomas** – jį pateikia vartotojas, ir jame dažnai būna
asmenvardis („Jono Jonaičio pokalbis.mp3"). Įvykis susiejamas su `jobId`, kai jis
jau egzistuoja, kad GDPR ištrynimas jį pasiektų.

**IP adresai nesaugomi.** Rate limito įvykiai logina `ip_<12 hex>` – HMAC
pseudonimą su ta pačia druska kaip audito ID (`AUDIT_ID_SALT`). Jis atsako į
klausimą „ar tas pats klientas?", bet adreso neatkuria. Po restarto be nustatytos
druskos pseudonimai pasikeičia – ilgaamžiam sekimui tai apribojimas, privatumui
privalumas. `truncateIp()` (tinklo dalis: `/24` arba `/64`) yra alternatyva
diegimams, kuriems reikia tinklo diagnostikos, bet numatytame kelyje ji
nenaudojama – pseudonimas saugesnis.

**Tailwind v4.** Stilių sistema perkelta į v4: PostCSS įskiepis gyvena atskirame
`@tailwindcss/postcss` pakete, `src/index.css` naudoja vieną `@import "tailwindcss"`
vietoj trijų `@tailwind` direktyvų, o `tailwind.config.js` pašalintas – projektas
temos nekeitė, o v4 ją konfigūruoja CSS'e (`@theme`).

⚠️ **v4 pervadino dalį utility klasių, ir senieji vardai liko galioti su
KITOMIS reikšmėmis** – tai tylus pokytis, kurio nei build'as, nei testai
nepamato:

| v3 | v4 atitikmuo | Kodėl svarbu |
|---|---|---|
| `rounded-sm` | `rounded-xs` | v4 `rounded-sm` yra `0.25rem`, ne `0.125rem` |
| `shadow-sm` | `shadow-xs` | v4 `shadow-sm` didesnis |
| `outline-none` | `outline-hidden` | v4 `outline-none` **pašalina** kontūrą; v3 paliko permatomą, kad fokusas išliktų matomas didelio kontrasto režimu |

Visos 27 naudojimo vietos pervadintos, o rezultatas patikrintas sugeneruotame
CSS: `--radius-xs: .125rem`, šešėlis `0 1px 2px 0 #0000000d` (= 5 % alfa),
kontūras `2px solid #0000` su offsetu – identiška v3.

**React 19.** Atnaujinimas pareikalavo ir `lucide-react` kėlimo: `0.383.0` peer
deps leido tik React ≤18, tad vien React bump'as griūdavo ties `npm ci` su
`ERESOLVE`. Abu keliami kartu – atskirai nė vienas neveikia.

**Testų rinkiniai.** 545 backend testai suskirstyti į rinkinius pagal tai, ką
jie saugo:

| Komanda | Ką apima |
|---|---|
| `npm test` | privatumas + saugumas + funkciniai (numatyta) |
| `npm run test:privacy` | PII redakcija, retencija, ištrynimas, eksporto variantai, auditas |
| `npm run test:security` | prieigos kontrolė, validacija, priėmimo kelias, koreliacija, paleidimo patikros |
| `npm run test:functional` | tiekėjai, formatai, eilės, pagalbinės funkcijos |
| `npm run test:redis` | integraciniai testai su **tikru** Redis |

| `npm run test:suites` | ką apima kiekvienas rinkinys |

Du rinkiniai yra **kryžminiai** – jie netikrina naujos funkcijos, o tikrina, kad
jau įgyvendintos garantijos galiotų **vienodai visur**:

- `criticalGuarantees.route` – autentifikacija, middleware tvarka ir klaidų
  sanitizacija per **visus** maršrutus. Iki tol autentifikacija buvo testuojama
  tik `/api/generate` ir `/api/transcribe`, tad likę penki maršrutai galėjo ją
  prarasti nepastebimai.
- `failClosedMatrix` – **išorinio LLM ir redaguoto eksporto** keliai ×
  kiekvienas gedimo tipas
  (komponento nėra / krenta / grąžina šiukšlę). Fail-closed yra ne funkcija, o
  savybė, kuri turi galioti kiekviename kelyje; kai kiekvienas kelias
  testuojamas savo faile, lengva nepastebėti, kad vienas elgiasi kitaip –
  būtent taip ir buvo su eksporto guard'u, kuris pasitikėjo `redact()`
  rezultatu, kai LLM kelias jau tikrino artefakto variantą. API ir worker
  paritetas lieka `redactionParity4.route` bei `correlationChain.integration`
  testuose – matrica jų nedubliuoja.

Priskyrimas gyvena `backend/tests/suites.js`, o `scripts/run-tests.mjs` prieš
kiekvieną paleidimą tikrina, kad **kiekvienas** `tests/*.test.js` priklausytų
bent vienam rinkiniui ir kad manifeste nebūtų neegzistuojančių įrašų. Be šios
patikros naujas saugumo testas galėtų tyliai likti už `test:security` ribų, o
komanda rodytų žalią būtent todėl, kad jo nepaleido.

**Redis testai nebėra „optional".** Jie vis dar praleidžia save be `REDIS_URL`
(vietinei aplinkai reikalauti Redis kiekvienam `npm test` būtų nepatogu), bet CI
nustato **`REQUIRE_REDIS=1`**, ir tada praleidimas tampa **klaida**. Be to
dingęs `REDIS_URL` reikštų žalią job'ą, kuris nieko nepatikrino – konfigūracija
sakytų „Redis testai vykdomi", o tikrovė ne.

Rinkinys apima restart ir stalled recovery, worker heartbeat → readiness,
koreliacijos laukų kelią per tikrą saugyklą, lygiagrečių jobų izoliaciją,
konteksto atkūrimą **per realų vykdymo kelią** (Redis → jobStore → jobRunner →
`runWithContext` → processor, ne `AsyncLocalStorage` tiesiogiai) ir ištrynimą,
kuris **išgyvena restartą** – jobas ir jo pašalinimas tikrinami po ryšio
atkūrimo, nes vien „ištrinta toje pačioje sesijoje" praeitų ir tada, jei
trynimas veiktų tik atmintyje.

`npm test` **neapima** `redis` rinkinio sąmoningai: be `REDIS_URL` tie testai
save praleidžia, ir įtraukus juos „3 skipped" taptų nuolatiniu triukšmu, kurį
visi išmoktų ignoruoti. CI juos leidžia atskirai su tikru Redis servisu.

CI paleidžia rinkinius **atskirais žingsniais**, nors kartu jie sudaro tą patį
`npm test`: kai kas nors lūžta, iš žingsnio pavadinimo iškart matyti, ar tai
privatumo garantija, ar tiekėjo formatavimas.

**Saugumo testų matrica.** [`docs/security-test-matrix.md`](docs/security-test-matrix.md)
atsako, **kuris testas saugo kurią garantiją ir iš kur žinom, kad jis realiai ją
saugo**. Trečias stulpelis – mutacijos įrodymas – yra svarbiausias: testas,
kurio niekas nebandė sulaužyti, yra teiginys, ne įrodymas.

`npm run test:matrix` tikrina matricą abiem kryptimis: kiekvienas joje minimas
testas turi egzistuoti, ir kiekvienas `privacy`/`security` rinkinio testas turi
būti paminėtas. Rašant šį dokumentą patikra iškart rado **14 testų**, kurių
matricoje nebuvo – be jos ji būtų virtusi sąrašu to, ką kažkada turėjom.

Matricoje yra ir skyrius **„Ko ši matrica neapima"**: semantinis PII aptikimas,
vizualinė regresija, realus GPU kelias, apkrovos testai. Aprėpties dokumentas be
ribų skyriaus klaidina labiau nei jokio dokumento.

**Švara po testų.** `npm run test:clean` tikrina, kad testai nepaliktų artefaktų
su **projekto prefiksais** (`stenograma-*`) `/tmp` kataloge. Bendras `/tmp`
skaičiavimas duotų klaidingus signalus, nes ten rašo ir kiti procesai.

Kad siauras sąrašas netaptų spraga, patikra papildomai **skenuoja testų failus**
ir krinta, jei kuris nors naudoja laikiną prefiksą, kurio sąraše nėra. Be to
teiginys būtų platesnis nei tikrinimas: „nepalieka artefaktų" iš tikrųjų
reikštų „nepalieka artefaktų su šiais prefiksais". Rašant #15 rasta, kad `jobRunner` testas kūrė
`stenograma-test-storage-*` ir jo netrindavo – kiekvienas paleidimas palikdavo
naują. Kai tokių likučių prisikaupia, niekas nebemato, kad **produkcinis** kodas
kažko neištrina.

**Artefaktų inventorius (#19).** Apdorojant vieną susitikimą sukuriama
vienuolika artefaktų tipų – nuo įkelto audio iki eksporto. Iki šiol tas žinojimas
buvo išbarstytas po kodą, tad naujas tipas galėjo likti **nematomas ištrynimui**,
tyliai. Dabar registras, išvedimo grafas ir gyvavimo ciklo būsenos gyvena vienoje
vietoje: [`docs/artefact-lifecycle.md`](docs/artefact-lifecycle.md).

Dvi modelio taisyklės: iš `deleted` **nėra kelio atgal** (kitaip vėluojantis
worker'is paverstų ištrynimą laikinu), ir ištrynimas privalo eiti per
`pending_deletion` (kitaip nelieka būsenos, kurioje worker'is pamatytų ištrynimo
žymą).

**Koordinuotas ištrynimas (#19).** Vienas įėjimo taškas
(`services/lifecycleService.js`) vietoj dviejų identiškų kopijų maršrutuose.
Tvarka svarbi: **žyma uždedama prieš šalinimą**, nes priešingu atveju liktų
langas, kuriame worker'is dar nematytų žymos, o duomenų jau nebūtų – ir jis
juos atkurtų.

Žymos gyvena atskirai nuo jobo įrašo, nes turi atsakyti „ar šis ID buvo
ištrintas?" **tada, kai įrašo nebėra**.

Rezultatas – stabilus struktūrizuotas formatas su kategorijomis: `deleted`,
`remaining`, `retryable`, `nonRetryable` ir `ephemeral`. Efemeriškos rodomos
atskirai sąmoningai: „nėra ko trinti" ir „pamiršome ištrinti" turi atrodyti
skirtingai.

⚠️ Iki #19 abu maršrutai grąžindavo klaidų tekstus **tiesiai klientui**, o
juose būna failų kelių ir Redis raktų. Dabar klientas gauna tik kategorijas.

**Apsauga nuo atkūrimo po ištrynimo (#19).** Žymos nebe tik uždedamos – jos
**tikrinamos**: `jobStore.update` viduje (vienintelis kelias, kuriuo įrašas
keičiasi), BullMQ worker'yje ir inline kelyje. Be to vėluojanti eilės žinutė
atkurtų artefaktus jau ištrintam jobui, ir ištrynimas būtų laikinas.

Patikra `update` viduje sąmoningai, o ne prie kiekvieno kvietėjo: pastarasis
variantas reikštų kelias dešimtis vietų, iš kurių viena būtų pamiršta, ir spraga
būtų tyli.

Apsauga garantuoja, kad **jobas nebus atnaujintas** po ištrynimo ir kad **naujas
darbas nebus pradėtas**. Ji **negarantuoja**, kad jau vykdomas processor'ius
sustos vidury: iki pirmojo `update` jis gali spėti iškviesti tiekėją ar parašyti
laikiną failą. Rezultatas į jobą nepateks, bet tarpiniai pėdsakai gali likti,
kol juos surinks retencija.

⚠️ Žymos gyvena tik atmintyje – **restarto neišgyvena**. Po jo vėluojanti žinutė
vėl galėtų kurti artefaktus; restartui atspariam variantui reikia Redis.

**CI/CD ir tiekimo grandinė.** Taisyklės surašytos
[`docs/ci-security-policy.md`](docs/ci-security-policy.md), o `ci.yml`
`workflow-policy` job'as jas **vykdo**: `GITHUB_TOKEN` teisės, `pull_request_target`
draudimas, action'ų prisegimo politika, job'ų laiko ribos, artefaktų retencija ir
`dependabot.yml` sintaksė.

⚠️ Paskutinis punktas atsirado neatsitiktinai: `dependabot.yml` turėjo sintaksės
klaidą (`open-pull-requests-limit:5` be tarpo), o GitHub tokį failą atmeta
**tyliai** – nė viena priklausomybė nebuvo tikrinama, ir repozitorijoje niekas
apie tai nepranešė. Todėl sintaksė dabar tikrinama CI.

**Autentifikacija (#18, PR1: pamatas).** Naujas, atskiras mechanizmas nuo
bendro `API_KEY`: server-side sesija su `HttpOnly` cookie. Pasirinkta (ne
bearer tokenas), nes frontend ir backend diegiami tame pačiame domene –
sesiją lengviau revokuoti, o naršyklės JavaScript niekada nemato jos reikšmės.

```bash
POST /api/auth/login   {username, password} -> sesijos cookie
GET  /api/auth/me       -> {username, role} arba 401
POST /api/auth/logout   -> revokuoja sesiją
```

Prisijungimo bandymai ribojami **dviem nepriklausomais** limiterias – vien
IP+vardas limitas būtų apeinamas kaitaliojant vardą kiekvienam bandymui.

Vartotojai konfigūruojami per `AUTH_USERS` (kableliais atskirtas
`vardas:rolė:scrypt-maiša` sąrašas) – tai sąžiningas pilotinis apribojimas, ne
pilna registracijos sistema. Maišą generuoja `scripts/hash-password.js`;
slaptažodis niekada nelaikomas tekstu.

Nežinomas vartotojas ir neteisingas slaptažodis atsako **vienodai** (401,
tas pats pranešimas, panašus laikas) – priešingu atveju atsakymas išduotų,
ar vartotojo vardas egzistuoja. Sesija baigiasi pagal du nepriklausomus
limitus: neaktyvumo (`SESSION_IDLE_TIMEOUT_MINUTES`, numatyta 30 min) ir
absoliutų (`SESSION_ABSOLUTE_TIMEOUT_HOURS`, numatyta 12 val., galioja net
esant nuolatiniam aktyvumui).

**Rolėmis grįsta autorizacija (#18 PR2).** Leidimai gyvena viename registre
(`utils/permissions.js`) ir yra **deny-by-default** – naujas leidimas be
eksplicitinio priskyrimo yra uždaras.

| Leidimas | operator | administrator |
|---|:---:|:---:|
| `job:create` – kurti darbus | ✅ | ✅ |
| `job:read` – skaityti būseną ir rezultatą | ✅ | ✅ |
| `protocol:generate` – generuoti protokolą | ✅ | ✅ |
| `export:redacted` – eksportuoti redaguotą | ✅ | ✅ |
| `job:delete` – **GDPR ištrynimas** | ❌ | ✅ |
| `export:original` – **neredaguoti asmens duomenys** | ❌ | ✅ |
| `audit:read` – audito žurnalas | ❌ | ✅ |

Maršrutai nurodo **leidimą**, ne rolę – kitaip rolių žemėlapio pakeitimas
reikštų kiekvieno maršruto redagavimą. `/api/exports` yra ypatingas: reikalingas
leidimas priklauso nuo `variant` reikšmės, tad tikrinamas **po** validacijos.

**Du autentifikacijos mechanizmai veikia lygiagrečiai.** Sesija turi
**pirmenybę** prieš bendrą `API_KEY` – priešingu atveju operatorius galėtų
pasikelti teises vien pridėdamas raktą prie užklausos.

⚠️ **`API_KEY_ROLE` pagal nutylėjimą – `administrator`.** Tai sąmoningas
atgalinio suderinamumo sprendimas: iki #18 rakto turėtojas galėjo viską, ir
numatytoji `operator` tyliai sulaužytų veikiančią automatiką. **Kol taip yra,
RBAC neriboja rakto turėtojų** – `job:delete` ir `export:original` apsaugos jiems
negalioja. Startup apie tai įspėja. Realiam atskyrimui:
`API_KEY_ROLE=operator` arba perėjimas prie sesijų.

**Asinchroniniai darbai ir revokacija (#18 PR3).** Su jobu keliauja **tik**
aktoriaus ID, rolė ir autentifikacijos mechanizmas – jokių tokenų, sesijos ID,
cookie ar slaptažodžių. Jobas gyvena Redis'e ir BullMQ eilėse, tad paslaptis ten
išgyventų kur kas ilgiau nei pati užklausa.

Teisės **perskaičiuojamos vykdymo metu**, ne užšaldomos kuriant jobą. Jobai gali
laukti eilėje valandas; per tą laiką vartotojas gali būti pašalintas iš
`AUTH_USERS` arba jo rolė sumažinta – būtent tada, kai to labiausiai reikia.
Užšaldytos teisės reikštų, kad revokacija neveikia jau sukurtiems darbams.

⚠️ Kaina, priimta sąmoningai: **rolės sumažinimas nutraukia eilėje esančius
darbus**. Geriau nutraukti teisėtą darbą, nei įvykdyti neteisėtą.

⚠️ **Atsijungimas (logout) darbo NENUTRAUKIA** – sesija yra prisijungimo, ne
teisės, mechanizmas. Nutraukiama tik dingus pačiai tapatybei ar teisei.

**Sąsaja pagal roles (#18 PR4).** Frontend gauna leidimus per `/api/auth/me` ir
pagal juos rodo ar slepia veiksmus – originalo eksporto grupės operatorius
tiesiog nemato. Rolė rodoma antraštėje, kad būtų aišku, **kodėl** kai kurių
veiksmų nėra.

⚠️ **UI nėra apsauga.** Paslėptas mygtukas tik gerina sąsają; kiekvieną užklausą
tikrina backend. Regresijos testai tai įrodo tiesioginiais API kvietimais,
apeinant naršyklę – jei UI būtų vienintelė riba, jie kristų.

401 ir 403 apdorojami **skirtingai**: pasibaigusi sesija grąžina į prisijungimą
su paaiškinimu, o teisių trūkumas rodo aiškų pranešimą su konkrečiu trūkstamu
leidimu. Sumaišius juos, vartotojas matytų „neturite teisės" ten, kur tereikia
prisijungti.

Diegimo instrukcijos – rolės, sesijų trukmė, revokacija, kredencialų rotacija,
bootstrap administratorius: [`docs/auth-deployment.md`](docs/auth-deployment.md).

⚠️ **Nuosavybės patikrų nėra.** Rolė sprendžia, kokius veiksmus galima atlikti,
bet ne su kieno duomenimis – bet kuris administratorius gali ištrinti bet kurį
darbą.

⚠️ **Sesijų saugykla – tik atmintyje, vienas procesas.** Sąmoningas
pilotui pritaikytas sprendimas (patvirtinta): restartas atjungia visus
vartotojus, o kelios backend replikos nesidalintų sesijomis. Kai prireiks
kelių replikų, saugykla turės pereiti į Redis – ta pati async sąsaja tam jau
paruošta (žr. `utils/jobStore/` kaip pavyzdį tos pačios memory→Redis
migracijos).

**API saugumo bazė (`utils/securityBaseline.js`).** Vienas modulis,
registruojamas **prieš** maršrutus: `trust proxy`, saugumo antraštės (helmet su
`default-src 'none'` CSP), CORS allow-list ir kūno limitai. Naujas endpointas bazę gauna automatiškai – o ne
tada, kai kas nors prisimena ją pridėti.

| Nustatymas | Numatyta | Pastabos |
|---|---|---|
| `CORS_ORIGIN` | `http://localhost:5173` | Kableliais atskirtas **sąrašas**; kiekviena kilmė tikrinama (`scheme://host[:port]`, be kelio ir prisijungimo duomenų); `*` galimas, bet ne mišinyje |
| `CORS_CREDENTIALS` | `false` | Su `*` – **startup klaida**, ne tylus derinys |
| `JSON_BODY_LIMIT` | `1mb` | Audio eina per multipart, tad JSON gali būti mažas |
| `RATE_LIMIT_GENERAL_MAX` | `300/min` | Bendra riba visiems `/api`; brangūs maršrutai turi griežtesnes |
| `READINESS_TIMEOUT_MS` | `2000` | Be jo pakibęs Redis pakabintų ir `/api/ready` |

CSP nustatoma **griežčiausia**, o ne išjungiama: HTML šis procesas nesiunčia, tad
`default-src 'none'` nieko nelaužo, bet apsaugo klaidos puslapius ir bet kokį
būsimą HTML atsakymą. `CORS_ORIGIN=*` grąžina **literalą**, o ne atspindi
užklausos `Origin` – atspindėjimas tampa pavojingas vos kam nors įjungus
credentials.

Produkcijoje `CORS_ORIGIN=*` ir `TRUST_PROXY=true` **stabdo paleidimą**: pirmasis
leistų bet kuriam domenui kviesti API vartotojo naršyklės vardu, antrasis –
klastoti `X-Forwarded-For` ir apeiti rate limitą. Kūrimo aplinkoje abu lieka
patogumu.

**Validacija (`middleware/validate.js`).** Viena schemų sistema (zod) body, query
ir parametrams, vienas klaidų formatas su `code` ir `details[].path`. Nežinomi
laukai **atmetami**, o ne ignoruojami: tyli ignoracija reikštų, kad
`{ varinat: "original" }` atrodo kaip užklausa be varianto, ir klientas gauna
pranešimą apie trūkstamą lauką, kurį ką tik nurodė. Kaina – naujas kliento laukas
lūžta iškart, bet API sutartis lieka aiški abiem pusėms.

Schemos taikomos **visuose** maršrutuose: `body` (`/api/generate`, `/api/jobs`,
`/api/exports`, `/api/transcribe`, `/api/transcribe-jobs`) ir `params`
(`:id` visuose jobų endpointuose). Middleware eina **po** rate limito ir
autentifikacijos – priešingu atveju schemos dirbtų neautentifikuotam srautui.

Multipart laukai ateina kaip **eilutės** (`diarize=true`, `numSpeakers=3`), tad
schema priima abu pavidalus ir konvertuoja – klientui nereikia žinoti, kad JSON ir
forma elgiasi skirtingai. `audioUrl` ribojamas iki `http`/`https`: `z.string().url()`
praleistų `javascript:`, `file:` ir `data:`, o šis URL keliauja į transkribavimo
tiekėją.

`/api/audit` **puslapiuojamas** (`limit`, `offset`, filtrai `event` ir
`requestId`) ir ribojamas rate limiteriu. Neribotas atsakymas čia buvo pigi
užklausa, kurios kaina auga kartu su žurnalu, o pats auditas yra būtent tas
endpointas, kurį užpuolikas norėtų nuskaityti daug kartų. `/api/health/deep`
irgi ribojamas – jis vykdo realias tiekėjų ir Redis patikras, tad be ribojimo
buvo brangiausias neautentifikuotas kelias sistemoje.

Rezultatas dedamas į `req.validated`, ne į `req.body`: kitaip skaitytojas
nebežinotų, ar mato žalią, ar patikrintą reikšmę.

⚠️ **Klientui siunčiami pranešimai kuriami mūsų, ne bibliotekos.** Zod
`unrecognized_keys` pranešimas įtraukia kliento pateiktą lauko **pavadinimą** –
`{ "Jonas_Jonaitis_39001010000": "x" }` grąžintų tą tekstą atsakyme, o iš ten jis
patektų į frontend klaidos pranešimą ir logus. Todėl pranešimai formuojami pagal
`issue.code`, o `path` segmentai, neatitinkantys lauko vardo formos, pakeičiami
žymeniu.

**Visos saugumo nuostatos validuojamos paleidžiant.** `READINESS_TIMEOUT_MS=abc`
duotų `NaN` timeout (momentinį nutrūkimą, atrodantį kaip pakibęs Redis),
`RATE_LIMIT_GENERAL_MAX=0` užblokuotų visą API, o netinkamas `JSON_BODY_LIMIT`
nuverstų middleware registraciją be konteksto. Visi trys dabar yra startup
klaidos.

**Užklausų koreliacija (`utils/requestContext.js`).** Kiekviena užklausa gauna
`X-Request-Id`: arba serverio sugeneruotą (`req_<uuid>`), arba kliento pateiktą,
jei jis atitinka griežtą formatą (`[A-Za-z0-9_.:-]`, 8–64 simboliai). Ribos
būtinos, nes ID patenka į logus ir auditą – be jų jis taptų log injekcijos
kanalu. ID grąžinamas atsakymo antraštėje **taip pat ir atmestoms užklausoms**,
kad klientas turėtų ką nurodyti kreipdamasis.

ID keliauja per `AsyncLocalStorage`, tad servisams ir tiekėjams jo perduoti per
parašus nereikia. Asinchroniniame kelyje jis saugomas jobo metaduomenyse ir
atkuriamas prieš vykdymą – ir inline, ir BullMQ worker'yje (atskirame procese
HTTP konteksto paveldėti neįmanoma). Taip vienas ID sujungia užklausą, eilę,
worker'į ir tiekėjo kvietimą.

**Grandinės įvykiai.** Kiekvienas etapas rašo savo įvykį su `stage` lauku:
`queued` → `processing` → `provider` → `completed`/`failed`. Tai galioja **abiem**
darbo tipams – ir protokolo, ir transkripcijos; `provider` įvykis neša
`providerType` (`llm`, `transcription`, `diarization`), `jobId` ir paskirtį
(`source_transcript` ar `repair_prompt`).

`failed` rašomas **tik galutinei** nesėkmei. BullMQ `failed` įvykis kviečiamas ir
tarpiniam bandymui, po kurio jobas dar bus kartojamas – tokiu atveju rašoma
`retrying` su bandymo numeriu. Priešingu atveju grandinė rodytų galutinę nesėkmę
ten, kur jos nebuvo. `requestId`
pridedamas automatiškai, tad viena užklausa loguose atsekama nuo HTTP iki
tiekėjo kvietimo ir pabaigos – ir inline, ir worker režimu.

Įvykiai rašomi ten, kur **baigtis realiai žinoma**, o ne apvyniojant vykdymą iš
išorės: inline runner klaidas apdoroja viduje ir grįžta normaliai, tad išorinis
apvalkalas rašydavo `completed` jobui, kurio statusas `failed`. Meluojantis
observability įvykis blogesnis už jokio – juo remiantis tyrimas nueitų ne ta
kryptimi.

**Aktorius** audito įrašuose yra API rakto **scrypt atspaudas** (`key_<12 hex>`),
ne pats raktas: audito įrašai gyvena ilgiau nei raktas.

Kodėl KDF, o ne paprastas hash: `API_KEY` nustatomas ranka `.env` faile, tad gali
būti mažos entropijos. Greitą atspaudą audito žurnale tokiu atveju galima
brute-force'inti ir atkurti raktą. HMAC su druska čia nepakanka, nes
`AUDIT_ID_SALT` gyvena **tame pačiame** `.env` faile – kas gavo vieną, turi ir
kitą; scrypt apsaugo net turint druską.

Kaina karštame kelyje nulinė: raktas yra konstanta, tad atspaudas skaičiuojamas
vieną kartą (~120 ms) ir kešuojamas – 5 000 vėlesnių kvietimų užtrunka vienetus
milisekundžių. `auditLog.record()` ima
`requestId` ir `actor` iš konteksto automatiškai, bet eksplicitinis perdavimas
turi pirmenybę – worker'io retry ir ištrynimo kvitai kartais žino ID geriau nei
aplinkinis scope. Kontekste laikomi tik identifikatoriai – jokio turinio,
antraščių ar IP.

⚠️ Kliento pateiktą `X-Request-Id` galima pakartoti keliose užklausose, tad jis
nėra unikalumo garantija – `requestIdSource` rodo, ar ID mūsų, ar kliento.
Griežtesnis modelis (serverio unikalus ID + atskiras kliento `correlationId`)
paliekamas vėlesniam etapui.

**PII redakcija (`utils/piiRedaction.js`).** Komponentas, kurio laukia abu
apsaugos taškai – išorinis LLM ir eksportas. Kai jis yra, `redact()` pasiimamas
automatiškai, be jokio perjungimo.

**Dengiamos kategorijos:**

| Kategorija | Placeholder | Aptikimas |
|---|---|---|
| Lietuviškas asmens kodas | `[ASMENS_KODAS]` | struktūra + data + **kontrolinė suma** |
| El. pašto adresas | `[EL_PAŠTAS]` | šablonas |
| Telefono numeris | `[TELEFONAS]` | kandidatas + validacija (`+370…`, `8…`, `(8-5)…`) |
| Banko sąskaita (IBAN) | `[SĄSKAITA]` | šalies kodas + kontroliniai skaitmenys |

**Vardai NEREDAGUOJAMI, ir tai sąmoningas sprendimas.** Susitikimo protokole
dalyviai ir atsakingi asmenys yra pats dokumento turinys – „Dalyvis A
įsipareigojo iki kovo 1 d." nėra protokolas. Pavojingas yra vardo **sujungimas**
su asmens kodu, telefonu ar sąskaita; būtent tą jungtį komponentas ir nutraukia.

⚠️ **Tarptautinių numerių aptikimas sąmoningai platus:** bet kokia 8–15 skaitmenų
seka su `+` laikoma telefonu, tad `+12345678` (dokumento kodas) irgi bus
redaguotas. Formatų pasaulyje per daug, kad juos patikimai atskirtum, o
praleistas tikras numeris brangesnis už perteklinį redagavimą. Lietuviškoms
formoms be `+` taisyklės griežtos (po `8` reikalingas realus srities kodas).

⚠️ **Redaguotas artefaktas yra EFEMERIŠKAS.** Jis sukuriamas tik prieš išsiuntimą
išoriniam LLM arba prieš eksportą ir niekur nesaugomas. Job store laiko **tik
originalą**, o visi transkripcijos API atsakymai žymi `variant: "original"` –
tad originalo ir redaguotos versijos supainioti saugykloje neįmanoma, nes
redaguotos versijos ten paprasčiausiai nėra. Jei ateityje prireiktų redaguotą
transkripciją grąžinti klientui ar išsaugoti, reikės atskiro gyvavimo ciklo
(retencija, ištrynimas, `sourceArtefactId` ryšiai) – šiame etape to nėra
sąmoningai.

⚠️ **Rezultatas yra dalinai pseudonimizuotas, NE anonimizuotas** (GDPR 26
konstatuojamosios dalies prasme). Žinomi apribojimai, taip pat surašyti kode
(`LIMITATIONS`):

- adresai neaptinkami – transkripcijoje jie rašomi laisva forma, tad patikimo
  šablono nėra, o spėjimas duotų arba praleidimus, arba sugadintą tekstą;
- transkripcija yra **šneka**: žodžiais padiktuotas asmens kodas neaptinkamas;
- gimimo datos, pareigos ir darbovietės neredaguojamos – sujungtos su vardu jos
  vis tiek gali identifikuoti asmenį.

**Konfigūruojama elgsena.** `PII_REDACTION_CATEGORIES=personal_code,email`
įjungia tik išvardytas kategorijas; nenustatyta – visos. Nežinomas pavadinimas
**stabdo startą**, o ne praleidžiamas tyliai: `persnal_code` (rašybos klaida)
kitaip reikštų „neredaguoti nieko", ir administratorius to nepastebėtų.
Kategorijos yra dalis užšaldytos privatumo politikos (`privacy.redactionCategories`),
ne atskiras `process.env` skaitymas – tad visi komponentai mato tą pačią elgseną.

**Artefaktų modelis (`utils/redactedArtefact.js`).** Redaguotas turinys keliauja
ne kaip eilutė, o kaip artefaktas su `variant`, `sourceArtefactId`,
`redactionStatus`, `policyVersion` ir `createdAt`. Priežastis: eilutė apie save
nieko nepasako – `redact()`, grąžinęs įvestį nepakeistą, atrodo lygiai taip pat
kaip tikra redakcija. Guard'ai prieš išsiuntimą tikrina **variantą**, o ne
prielaidą. Segmentų `speaker`, `start` ir `end` išlieka nepaliesti.

**Variantų semantika – trys reikšmės, ne dvi.** Protokolas **nėra** redaguotas
artefaktas: jis yra LLM **sugeneruotas** tekstas iš redaguoto įėjimo. Modelis gali
įrašyti vardą, iš konteksto atkurtą numerį ar savo sugalvotą identifikatorių,
kurio redaguotame įėjime nebuvo. Todėl `/api/generate` grąžina du atskirus laukus:

```json
{ "protocolVariant": "generated", "sourceTranscriptVariant": "redacted" }
```

Vienas bendras `variant: "redacted"` leistų klientui manyti, kad protokolas jau
saugus platinti – o tai netiesa.

Variantas nurodomas **kiekviename** atsakyme (`/api/transcribe`,
`/api/transcribe-jobs` kūrimo ir būsenos), ne tik redaguotame. Jei žymėtume tik
redaguotus, atsakymas be lauko būtų dviprasmis: arba originalas, arba senesnė API
versija be lauko.

Kai protokolo generavimui prireikia **repair retry** (LLM grąžino netinkamą JSON),
tam pačiam tiekėjui siunčiamas antras payload'as – jis irgi redaguojamas, bet
metaduomenys lieka **šaltinio transkripcijos**. Kitaip API rodytų repair prompto
statistiką (`redactionStats: {}`) net tada, kai originale PII buvo rasta ir
pašalinta.

Auditas ir API atsakymai neša redakcijos būseną (`variant`, `redactionStatus`,
`outcome`, `policyVersion`, kategorijų **skaičius**). Fiksuojama ir **nesėkmė**:
kritus redakcijai audite atsiranda `redactionStatus: "failed"`, `outcome:
"blocked"`, o serverio loge – atskiras įspėjimas. Be to „modelis neatsakė" ir
„duomenys sąmoningai neišsiųsti" atrodytų vienodai. Aptiktų reikšmių niekur
nėra: statistika konstruojama tik iš skaitliukų, o auditas naudoja laukų
whitelist'ą.

**Eksportas: du atskiri variantai.** `POST /api/exports` reikalauja **privalomo**
`variant` lauko (`original` arba `redacted`). Numatytosios reikšmės nėra
sąmoningai: `redacted` tyliai pakeistų turinį senam klientui, `original` tyliai
atiduotų neredaguotą. Abu blogiau už aiškią klaidą.

Politika gali variantą **uždrausti**, bet niekada nepakeičia jo kitu.
`EXPORT_ALLOW_ORIGINAL=false` originalo užklausą atmeta su **403**, o redaguotą
variantą palieka prieinamą – „negali gauti originalo, štai redaguotas" būtų
patogu ir todėl pavojinga: vartotojas gautų kitą dokumentą nei prašė ir to
nepastebėtų.

Trūkstamas redaguotas turinys **niekada** nevirsta originalu: nesant redakcijos
komponento užklausa nutraukiama, o ne patenkinama kitu variantu. Atmetimo
priežastys skiriamos: politikos draudimas → **403**
(`EXPORT_ORIGINAL_FORBIDDEN`), laikinas redakcijos nepasiekiamumas → **503**
(`EXPORT_REDACTION_UNAVAILABLE`), netinkama užklausa → **400**. Vienas kodas
visiems atvejams klaidintų dviem kryptimis: vartotojui atrodytų, kad jam
neleidžiama, o operatoriui gedimas atrodytų kaip normalus politikos atmetimas.

**Sąsajoje** abu variantai rodomi atskiromis grupėmis su aiškiais pavadinimais
(„Redaguotas (jautrūs identifikatoriai pašalinti)" ir „Originalas (visi
duomenys)"). Etiketė sąmoningai **nesako** „be asmens duomenų": pagal #4 aprėptį
vardai lieka, o adresai neaptinkami, tad toks pažadas paskatintų vartotoją
persiųsti dokumentą kaip anoniminį. Po etikete nurodyta, kas konkrečiai pašalinta
ir kas gali likti.
Redaguota grupė yra pirma, o originalo mygtukai reikalauja patvirtinimo, kuriame
įvardyta, kas liks faile. Numatytosios varianto reikšmės nėra nei sąsajoje, nei
API sluoksnyje – kvietimas be varianto meta klaidą, o ne pasirenka už vartotoją.

⚠️ Failo vardas ir `X-Request-Id` yra `Access-Control-Expose-Headers` sąraše.
Be to naršyklė cross-origin užklausoje jų **neperskaito**, ir eksportas tyliai
nusileidžia į bendrinį vardą. Vietiniame nginx `/api` proxy diegime to nesimato
(tas pats originas), tad trūkumas pasireiškia tik atskirtame
`VITE_BACKEND_URL` scenarijuje.

**Failo vardas** generuojamas serveryje ir neša variantą –
`protokolas_redaguotas_2026-03-15.docx`. Tai ne kosmetika: atsisiuntus du failus,
po savaitės neįmanoma pasakyti, kuris redaguotas, o failo vardas yra vienintelis
kontekstas, keliaujantis kartu su dokumentu. Nė viena vardo dalis neateina iš
vartotojo, ir rezultatas papildomai valomas nuo kelio skirtukų bei valdymo
simbolių. Lietuviškos raidės **transliteruojamos** (`posėdžio` → `posedzio`), o ne
išmetamos: aklas filtras paverstų vardą į `pos_d_io` be suprantamos priežasties,
o UTF-8 palikimas reikalautų RFC 5987 kodavimo `Content-Disposition` antraštėje,
kurį klientai apdoroja nevienodai.

Varianto reikšmė parsinama **vienoje vietoje** (`parseRequestedVariant`), tad
pridėjus naują endpointą logika nebus nukopijuota ir nepradės skirtis.

**Eksporto politika.** `EXPORT_ALLOW_ORIGINAL=false` reiškia, kad eksporto failai
generuojami tik iš redaguoto protokolo. Vykdoma `services/exportService.js`
`buildExport()` – vienintelėje vietoje, pro kurią eina visi trys formatai.
Redakcija taikoma **protokolo objektui**, ne galutiniam tekstui: DOCX yra
dvejetainis, tad teksto lygio redagavimas jį tyliai praleistų.

**Fail-closed:** jei redakcijos komponento nėra arba jis krenta, failas
**negeneruojamas**, o ne grąžinamas originalas. Konfigūracija be `redact()`
stabdo startą.

**Dėl retencijos eksportams.** Eksporto artefaktai **niekur nesaugomi** –
`buildExport()` grąžina buferį tiesiai į HTTP atsakymą, jokio failo diske ar
duomenų bazėje nelieka. Todėl retencijai nėra ko dengti, ir tai užfiksuota testu
(`tests/exportPolicy.test.js`), o ne priimta kaip prielaida. Diagnostikoje matoma
kaip `privacy.export.artifactsPersisted: false`. Jei ateityje atsirastų
atsisiunčiamų artefaktų saugykla, šis punktas turės būti perdarytas.

**Dėl pavadinimų sąmoningai:** jau egzistuojantis `PRIVACY_MODE=true` reiškia
„auditas išjungtas". Į jį antros reikšmės (`local_only`) nekraunam – dviprasmiška
vėliava būtų būtent tai, ko šiame projekte vengiama. Tiekėjų ribojimui yra
atskiras `PRIVACY_PROFILE`.

**Numatytoji būsena yra lokali:** be jokių ENV veikia `mock`/`none`/`mock`, tad
iš karto po klonavimo niekas iš mašinos neišeina. `ALLOW_EXTERNAL_PROVIDERS`
numatytai `true` **sąmoningai** – kitaip atnaujinimas nutrauktų veikiančias
Claude/Whisper konfigūracijas be įspėjimo. Privatumą užtikrina ne šis gaidukas,
o numatytas tiekėjų pasirinkimas.

### Automatinis retencijos šalinimas

**Vienas** periodinis ciklas (`utils/retentionSweeper.js`, numatytai kas 5 min)
šalina visus tris dalykus:

1. **Pasenusius jobus** – metaduomenys + rezultatas (transkripcija/protokolas) po `JOB_TTL_MINUTES`.
2. **Nuskendusius audio failus** – senesnius nei `AUDIO_RETENTION_HOURS` ir nepaminėtus nė viename gyvame jobe. Iki tol jų nešalino niekas: jei procesas nukrito tarp failo įkėlimo ir jobo užbaigimo, failas likdavo storage neribotai.
3. **Pasenusius audito įrašus** – pagal `AUDIT_RETENTION_DAYS`, nepriklausomai nuo srauto.

Šalinimas įrašomas kaip `RETENTION_PURGE` su kiekiais (`jobs=2 audio=1 audit=5`),
`subjectId: null` – be identifikatorių, failų vardų ar turinio. Įvykis rašomas
**tik kai kas nors realiai pašalinta**, kitaip kas valandą rašomas tuščias įrašas
per `AUDIT_MAX_ENTRIES` išstumtų naudinguosius.

**Kas laikoma „nuskendusiu" failu.** Tik failas, kurio **nenaudoja nė vienas gyvas
jobas** – nepriklausomai nuo jobo statuso (`queued`, `processing`, `completed`,
`failed`) ar vėliavų. Amžius (`AUDIO_RETENTION_HOURS`) yra papildoma, ne vienintelė
sąlyga. Tai svarbu: 4 val. įrašas, užstrigusi eilė ar GPU trūkumas reiškia, kad
apdorojamo jobo failas gali būti senesnis už retenciją, bet jo trinti negalima.
Jei saugykla neleidžia išvardyti jobų, šalinimas **praleidžiamas** (fail-safe).

Nebaigto valymo jobai (`audio_cleanup_pending`, `deletion_pending`) irgi
praleidžiami – jais rūpinasi `utils/deletionRetry.js` pagal savo backoff.

**Pradinis ciklas** vykdomas praėjus 5 s po starto, po to periodiškai – kitaip po
restarto pasenę duomenys liktų dar visą intervalą.

**Tai vienintelis jobų valymo mechanizmas.** Anksčiau `server.js` turėjo dar ir
atskirą `sweepTimer`, kas 5 min kvietusį tą patį `jobStore.sweepExpired()` –
darbas dubliavosi, o `RETENTION_SWEEP_INTERVAL_MINUTES` nekontroliavo visų
kvietimų. Senasis timer'is pašalintas, o numatytasis intervalas sumažintas iki
5 min, kad jobų valymo tankumas nesumažėtų (kitaip faktinis šalinimas galėtų
nusitęsti iki `JOB_TTL_MINUTES` + 60 min).

### Eksporto auditas

`.txt`, `.csv` ir `.docx` generuoja **backend'as** (`POST /api/exports`), ne
naršyklė. Priežastis grynai audito: kol failai buvo kuriami naršyklėje, serveris
apie eksportą nieko nežinojo, tad `EXPORT_*` įvykių audito žurnale negalėjo būti
iš principo. Kliento pranešimu „aš eksportavau" audite pasitikėti negalima.

Rašoma: `EXPORT_STARTED`, `EXPORT_COMPLETED` (su formatu ir baitų kiekiu) arba
`EXPORT_FAILED`. Įvykiai siejami su **transkribavimo jobo** pseudonimu, tad
`DELETE /api/transcribe-jobs/:id` pašalina ir eksporto įrašus (padengta testu).

**Audito vientisumas:** `jobId` naudojamas tik jei toks jobas realiai egzistuoja
ir yra transkribavimo tipo. Kitaip įvykis rašomas **be ryšio**, o nepatikrintas
`jobId` niekur nesaugomas. `link=` reikšmė rodo tikslią priežastį, kad
infrastruktūros problema neatrodytų kaip išgalvotas ID:

| `link=` | Reiškia |
|---|---|
| `none` | `jobId` nepaduotas |
| `job` | patvirtintas transkribavimo jobas – ryšys sukurtas |
| `missing` | jobo nėra (dažniausiai išnyko pagal `JOB_TTL_MINUTES`) |
| `invalid_type` | jobas yra, bet ne transkribavimo |
| `store_error` | saugyklos klaida – papildomai rašomas **sanitizuotas** įspėjimas į serverio logą | Kitaip klientas
galėtų savavališkai susieti savo eksportą su svetimu jobu, ir vėliau to jobo
ištrynimas pašalintų jam nepriklausančius įrašus. Eksportas dėl nepatikrinto
ryšio **nenutrūksta** (nėra 400): jobo įrašas gali būti teisėtai išnykęs pagal
`JOB_TTL_MINUTES`, kol vartotojas dar redaguoja protokolą – tai audito, ne
vartotojo veiksmo problema.

**CSV formula injection.** `veiksmai` turinys ateina iš LLM arba vartotojo, tad
reikšmė, prasidedanti `=`, `+`, `-` ar `@` (pvz.
`=HYPERLINK("https://evil.example","...")`), Excel'yje ar LibreOffice'e būtų
vykdoma kaip **formulė**. CSV eksportas naudoja `escapeFormulae: true`, tad tokios
reikšmės lieka tekstu. Padengta regresiniu testu (patikrinta, kad be šios
nuostatos jis krenta). TXT ir DOCX formatų tai neliečia. **Nerašoma:** protokolo turinys, pavadinimas, dalyvių vardai,
failo vardas ar tiesioginis `jobId` (tik pseudonimas). Tai patikrinta testu, kuris
per eksportą praleidžia realius PII pavyzdžius (el. paštą, telefoną, asmens kodą,
API raktą) ir tikrina, kad nė vienas iš jų nepatenka į žurnalą.

### Jobo duomenų ištrynimas (terminal job erasure)

**Terminologija (svarbu):** tai **jobo lygmens** ištrynimas, ne pilna BDAR
„teisė būti pamirštam". Endpointas trina pagal VIENĄ jobo ID; jis neatsako į
klausimą „ištrinkite visus su šiuo asmeniu ar susitikimu susijusius duomenis".
Jei tas pats susitikimas turi kelis jobus, reikia žinoti visus jų ID. Subjekto
lygmens ištrynimui reikėtų susitikimo/subjekto indekso ir visų šaltinių
registro – Milestone 2.

```http
DELETE /api/transcribe-jobs/:id     # transkribavimo jobas
DELETE /api/jobs/:id                # protokolo jobas
```

Atsakymai:

- `204 No Content` – jobas ir susiję duomenys pašalinti;
- `404 Not Found` – jobo nėra **arba jo tipas neatitinka endpoint'o**;
- `409 Conflict` – jobas dar `queued`/`processing`;
- `503 Service Unavailable` – dalinis ištrynimas: kritinis žingsnis nepavyko,
  jobas paliktas su `deletion_pending`, užklausą galima pakartoti.

**Kritiniais laikomi visi keturi žingsniai**, įskaitant audito įrašų šalinimą:
pseudonimizuoti duomenys pagal BDAR vis tiek gali būti asmens duomenys, tad
`204` grąžinti, kai audito įrašai liko, būtų netiesa. Visos operacijos
idempotentiškos, todėl `DELETE` galima saugiai kartoti.

Aktyvių jobų netrinam, nes worker'is dar gali juos skaityti ar atnaujinti.

Jobo **tipas saugomas pačiame įraše** (`job.type`), o ne imamas iš URL. Be to
protokolo jobo ID, pateiktas transkripcijos endpoint'ui, būtų surastas (abu
endpoint'ai naudoja tą patį `jobStore`), ištrintas iš `jobStore`, o valymas
vyktų ne toje BullMQ eilėje. Neatitinkantis tipas dabar grąžina `404`.

Ištrynimas (`utils/jobErasure.js`) apima **visas keturias** duomenų vietas:

| Vieta | Kas ten guli |
|---|---|
| `jobStore` (memory/Redis) | jobo metaduomenys + rezultatas (transkripcija/protokolas) |
| BullMQ eilė (Redis) | `job.data` su `storageKey`, `meetingId` IR grąžintas rezultatas |
| Audio storage | įkeltas garso failas (įprastai jau ištrintas po galutinio statuso) |
| Audito žurnalas | įrašai pagal pseudonimizuotą `subjectId` |

**Tvarka svarbi:** `jobStore` įrašas šalinamas PASKUTINIS ir tik tada, kai eilė
bei storage jau išvalyti. Nepavykus kuriam nors kritiniam žingsniui, jobas
paliekamas su `deletion_pending`, o endpoint'as grąžina **`503`** su struktūrizuotu
`deletion` objektu – ne `204`. Kitaip prarastume vienintelį raktą operacijai
pakartoti: klientas manytų, kad ištrinta, pakartotinis `DELETE` duotų `404`, o
audio failas liktų našlaite.

`storageKey` saugomas ir `jobStore` įraše, kad ištrynimas rastų likutį ir
**inline režime**, kur BullMQ jobo išvis nėra. Į `null` jis nustatomas **tik po
sėkmingo** `fileStorage.del()` (`utils/audioCleanup.js`) – kitaip nepavykus
trynimui failas liktų storage, o raktas dingtų, ir audio taptų nepasiekiama
našlaite.

**Retencijos nesutampa** (`jobStore` TTL 60 min < BullMQ `removeOnFail` 24 val.
< auditas 30 d.), todėl `jobStore` įrašas gali išnykti anksčiau už pačius
duomenis. Tokiu atveju `DELETE` **nesustoja ties 404**: ieškoma tiesiogiai
abiejose eilėse ir audite (`eraseOrphanedJobData`), ir tik nieko neradus
grąžinamas `404`. Kitaip teisė ištrinti dingtų anksčiau nei duomenys.

**Nebaigti valymai kartojami automatiškai** – `utils/deletionRetry.js`, numatytai
kas 10 min (`DELETION_RETRY_INTERVAL_MINUTES`). Yra **dvi atskiros** vėliavos ir
du atskiri ciklai, nes tai du skirtingi veiksmai:

| Vėliava | Ką reiškia | Ką kartojimas daro |
|---|---|---|
| `deletion_pending` | vartotojo prašytas VISO jobo ištrynimas nutrūko | kartoja pilną `eraseJob()` |
| `audio_cleanup_pending` | techninis audio valymas po sėkmingos transkripcijos nepavyko | trina TIK audio failą; jobo rezultatas lieka prieinamas |

Painioti jų negalima: `deletion_pending` semantika ištrintų ir transkripciją,
kurios vartotojas gal dar neatsiėmė.

Kol bet kuri vėliava aktyvi, jobo įrašas **neišmetamas pagal TTL** (memory store
jį praleidžia, Redis atveju kviečiamas `PERSIST`) – tai vienintelis šaltinis, iš
kurio žinomas `storageKey`, kai BullMQ jobas jau pašalintas.

Po trijų nesėkmingų bandymų į logą rašomas įspėjimas, reikalaujantis rankinio
įsikišimo.

**Ko automatinis kartojimas NEAPIMA (sąžiningai):** kartojami tik tie ištrynimai,
kurių `jobStore` įrašas dar egzistuoja. Jei `jobStore` įrašo jau nebuvo (orphan
kelias) ir ištrynimas nepavyko, klientas gauna `503`, bet vėliavos nustatyti
nėra kur – pakartojimas priklauso nuo kliento. Pilnam sprendimui reikėtų
atskiros persistentinės ištrynimo užklausų eilės (Milestone 2). Tai taip pat nėra
garantuota dead-letter sistema su SLA.

**Ištrynimo įrodymas:** kai kas nors realiai pašalinta, į auditą įrašomas
`DATA_ERASED` kvitas su `subjectId: null` ir šaltinių suvestine
(`queue=deleted storage=none ...`). Jis nesusietas su jokiu subjektu, todėl jo
nepašalina ir pakartotinis to paties jobo ištrynimas. Nieko neradus kvitas
**nerašomas** – kitaip užklausos nežinomais ID gamintų klaidingus įrašus ir per
`AUDIT_MAX_ENTRIES` išstumtų tikruosius.

Apribojimai: kvitas guli tame pačiame atmintiniame žurnale (tos pačios restarto
ir retencijos ribos), ir jis **nesaistomas su konkrečia užklausa** – rodo, kad
ištrynimas įvyko, bet ne kuriam prašymui. Atskiras `deletionRequestId`,
grąžinamas klientui, būtų kitas žingsnis.

**Legacy jobai:** prieš šį pakeitimą sukurti (Redis'e išlikę) jobai `type` lauko
neturi. Jie **nėra** atmetami – ištrynimas tokiu atveju valo abi BullMQ eiles
(jobo ID sutampa su BullMQ ID, tad ne toje eilėje operacija yra no-op). Aklai
priskirti visiems `transcription` būtų klaida: protokolo jobai tada būtų valomi
iš ne tos eilės.

BullMQ dalis svarbi todėl, kad `removeOnComplete`/`removeOnFail` (žr.
`queues/config.js`) palieka jobo duomenis Redis'e dar 1–24 val. po užbaigimo –
vien `jobStore` įrašo ištrynimas jų nepašalintų.

**Ko ištrynimas NEAPIMA (sąžiningai):**

- serverio `console` logų (nebent `PRIVACY_MODE=true` – ir tada tik sanitizavimas, ne trynimas);
- duomenų, kuriuos jau gavo išorinis LLM tiekėjas (Claude/GPT/Gemini) – jų retencija priklauso nuo tiekėjo sutarties;
- vartotojo naršyklėje eksportuotų DOCX/CSV/TXT failų.

**Autorizacija:** naudojamas bendras `API_KEY`, tad bet kuris rakto turėtojas gali
ištrinti bet kurį jobą. Nėra nei `ownerId`/`tenantId`, nei rolių, nei atskiros
administratoriaus teisės. Tai galioja **visam** projekto API, ne tik šiems
endpointams, ir viešam diegimui netinka – žr. `backend/README.md`
„Autentifikacija ir viešas diegimas" bei Roadmap (per-user auth).

### Žinomi apribojimai (privatumo / ištrynimo funkcionalumo)

Sąrašas sąmoningai vienoje vietoje, kad nereikėtų kompromisų ieškoti pačiam.
Visi punktai yra **žinomi ir apgalvoti**, ne atsitiktiniai.

| # | Apribojimas | Ką tai reiškia praktiškai | Kur spręsti |
|---|---|---|---|
| 1 | **Auditas atmintyje** | Dingsta po restarto, nesidalija tarp replikų, be DB transakcijų, tamper-resistance ar prieigos žurnalo. Retencija = „iki restarto arba iki N dienų". | SQLite/PostgreSQL (Milestone 2) |
| 2 | **`jobStore` atmintyje** (be `REDIS_URL`) | Jobai ir jų būsena neišgyvena restarto. | `REDIS_URL` arba PostgreSQL |
| 3 | **Retry būsena nepersistuojama** | `deletion_pending` / `audio_cleanup_pending` gyvena `jobStore`. Su memory store procesui nukritus retry eilė dingsta kartu su jobais. Su Redis - išlieka. | persistentinė ištrynimo užklausų eilė (Milestone 2) |
| 4 | **Bendras `API_KEY`, be nuosavybės** | Bet kuris rakto turėtojas gali ištrinti bet kurį jobą. Nėra `ownerId`/`tenantId`, rolių ar admin teisės. Galioja **visam** API. | per-user auth / OIDC (Milestone 2) |
| 5 | **Terminal job erasure, ne subjekto lygmens** | Trinama pagal VIENĄ jobo ID. „Ištrinkite visus šio asmens duomenis" nepalaikoma - reikia žinoti visus ID. | subjekto/susitikimo indeksas (Milestone 2) |
| 6 | **`DELETE` nėra ACID transakcija** | Eilė → storage → auditas → `jobStore` yra atskiri žingsniai. Procesui mirus tarp jų gaunamas dalinis rezultatas; jį gaudo `deletion_pending` + retry, bet tikros atominės transakcijos Node + failų sistema + Redis kombinacija turėti negali. | kita architektūra (ne planuojama) |
| 7 | **`DATA_ERASED` kvitas nėra kriptografinis įrodymas** | Tai paprastas audito įrašas be HMAC, hash chain ar append-only garantijos, ir nesaistomas su konkrečia užklausa. | HMAC + immutable log, jei reikia formalaus GDPR evidence |
| 8 | **Orphan ištrynimo nesėkmė nekartojama automatiškai** | Nesant `jobStore` įrašo nėra kur nustatyti vėliavos - pakartojimas priklauso nuo kliento (gavusio `503`). | ta pati persistentinė eilė (#3) |
| 10 | **PII redagavimo (anonimizavimo) nėra** | Transkripcijos siunčiamos išoriniam LLM be redagavimo. Todėl neįgyvendinta ir „redaguoti prieš išorinį apdorojimą", ir anonimizuotas eksportas | GDPR issue #4, po jo – #8 |
| 11 | **Persistentinės saugyklos negalima išjungti vienu jungtuku** | Retenciją galima trumpinti (`JOB_TTL_MINUTES`, `AUDIO_RETENTION_HOURS`), bet atskiro „nieko nerašyti į diską" režimo nėra | GDPR issue #5 liekanos |
| 9 | **Eilių sąrašas ištrynime - rankinis** | `eraseOrphanedJobData()` tikrina abi eiles eksplicitiškai. Prie 10+ eilių reikėtų registro. | šiandien nereikia |

Kas **NĖRA** apribojimas (dažnai klausiama): nepavykę ištrynimai ir audio valymai
kartojami automatiškai su eksponentiniu backoff (10 → 20 → 40 → 80 min, riba ~5 val.),
o pažymėti jobai neišmetami pagal TTL.

### Rekomendacijos diegiant su asmens duomenimis

- nustatykite `API_KEY` ir `AUDIT_ID_SALT`;
- naudokite HTTPS;
- apribokite prieigą prie Redis, worker'ių ir storage;
- laikykite audito ir jobų retenciją kiek įmanoma trumpesnę;
- dokumentuokite išorinius AI tiekėjus ir duomenų perdavimus;
- patikrinkite ištrynimo procedūrą REALIOJE produkcijos aplinkoje (ypač su Redis –
  `tests/queueRecovery.integration.test.js` stiliaus patikra be tikro Redis praleidžiama);
- nenaudokite realių asmens duomenų testuose ir kūrimo logeuose.
