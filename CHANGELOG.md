# Pakeitimų istorija

Projekto raidos milestone'ai. Formatas grubiai pagal [Keep a Changelog](https://keepachangelog.com/).

---

## v1.0.1 – GHCR Docker publish pataisos

Pataisytas `Publish images (GHCR)` workflow, kuris krito statant GPU Docker image'us.

### Fixed
- GPU Dockerfile'iai (backend / whisper / pyannote) naudoja `nvidia/cuda:...-ubuntu22.04`
  bazę, kurios sisteminis pip per senas `--break-system-packages` flag'ui (jis atsirado
  pip 23.0+). Pridėtas `pip install --upgrade pip` prieš priklausomybių diegimą.
- CPU `backend/Dockerfile.whisper` – tas pats pip atnaujinimas prevenciškai (nuoseklumui
  ir ateities CPU image publikavimui).

Įprastas CI (`ci.yml`) buvo ir lieka žalias – jis GPU image'ų nestato; ši problema
pasireiškė tik GHCR publish workflow'e, paleidžiamame su versijos tag'u.

---

## v1.0.0 – Pirmas stabilus leidimas 🎉

Pirmas stabilus viešas leidimas: produkcijai orientuota architektūra AI pagalbiniam
susitikimų transkribavimui ir protokolų generavimui. Detalus techninis pataisymų
aprašas – commit istorijoje; žemiau glaustas apžvalginis sąrašas.

### Added
- Asinchroniniai transkribavimo jobai (202 + polling)
- BullMQ + Redis eilė su inline fallback
- Keli transkribavimo tiekėjai (faster-whisper embedded/server)
- Keli LLM tiekėjai (Claude / GPT / Gemini / mock)
- Pasirenkama kalbėtojų diarizacija (pyannote)
- Health ir readiness endpointai
- Docker diegimas (demo / cpu / gpu / server / runpod)
- Provider architektūra (tiekėjai keičiami per .env)

### Fixed
- Startavimo race condition
- Worker inicializacija ir paleidimo apsauga
- jobStore/jobRunner režimo nuoseklumas
- Failo validacija prieš storage
- Temp/orphan failų valymas
- Klaidų apdorojimas (ne-JSON / sugadinti atsakymai)
- Saugus transkribavimo nutraukimas (abort)

### Testing
- Backend unit + route testai
- Frontend unit + API testai
- Playwright E2E (Chromium)
- Python kontraktų testai (pyannote + whisper)
- Docker build + smoke

### Sąžiningi apribojimai
- GPU keliai, BullMQ restart recovery su tikru Redis ir worker heartbeat srautas per
  tikrą Redis – parašyti ir unit/statiškai patikrinti, bet ne visi paleisti kūrimo
  aplinkoje. Žr. `DEPLOYMENT_CHECKLIST.md` prieš production.

---

## Pataisyta (po realaus RunPod diegimo audito)

- **VAD filtras + automatinis MP3→WAV + upload/inline nuoseklumas (kodo audito radiniai).**
  Iš kritinio kodo įvertinimo ir 4 val. testo:
  - `WHISPER_VAD_FILTER=true` (numatyta): faster-whisper VAD praleidžia tylą - šalina
    halucinacijų PRIEŽASTĮ (ne tik pasekmę kaip post-filtras).
  - `PYANNOTE_AUTO_WAV=true` (numatyta): pyannote-server automatiškai konvertuoja ne-WAV
    į 16kHz mono WAV per ffmpeg prieš pipeline() - išsprendžia ilgo MP3 įstrigimą be
    rankinio konvertavimo.
  - `MAX_UPLOAD_MB` numatytasis suvienodintas (kodas 50 → 500, atitinka .env.example) -
    ilgi failai nebeatmetami be konfigūracijos.
  - Inline job runner produkcijoje (`NODE_ENV=production` be `REDIS_URL`) dabar garsiai
    ĮSPĖJA apie duomenų praradimo/retry nebuvimo riziką.
  - Progreso streaming (SSE) ilgiems failams: whisper-server `/transcribe-stream` +
    backend SSE skaitymas + jobStore progress. EKSPERIMENTINIS, numatyta IŠJUNGTA
    (`WHISPER_STREAM_PROGRESS=false`), NETESTUOTA su realiu GPU.

- **`file`/`audio` laukų nenuoseklumas įkeliant.** `/api/transcribe` ir
  `/api/transcribe-jobs` priimdavo tik `audio` lauką, o `file` metė "Unexpected field"
  (RASTA realiai - natūralu bandyti `-F "file=@..."`). Dabar priimami ABU laukai.
- **Whisper halucinacijų filtras.** Backend'as automatiškai šalina tyloje "prasimanytus"
  YouTube-titrų segmentus (segmentai be kalbėtojo su žinomais šablonais). Konservatyvus -
  realios kalbos neliečia. Išjungiama `FILTER_HALLUCINATIONS=false`, plečiama
  `HALLUCINATION_EXTRA_PATTERNS`. Nauji testai. (4 val. teste tai buvo ~37% segmentų.)

- **Fiksuotas 90s HTTP timeout nutraukdavo ilgų failų apdorojimą (defektas).** Backend'as,
  kviesdamas pyannote/Whisper per HTTP, naudojo fiksuotą 90s timeout. RASTA su 4 val.
  įrašu: diarizacija trunka ilgiau nei 90s, tad backend'as klaidingai pažymėdavo jobą
  `failed` su `viršijo 90000ms limitą`, NORS pyannote realiai užbaigdavo (`POST /diarize
  200 OK` matėsi jau po klaidos). Pataisyta: numatytas timeout pakeltas iki 5 min, o audio
  apdorojimui naudojamas PROPORCINGAS timeout pagal failo dydį (5-90 min), naudojamas ir
  diarizacijoje, ir transkripcijoje. Perrašoma per `API_TIMEOUT_MS` / `AUDIO_TIMEOUT_*`.
  Pridėti regresijos testai (`tests/httpClient.timeout.test.js`). Dokumentuota RUNPOD.md §4b.

- **Hardcodinti portai Makefile (diegimo defektas).** `make gpu`/`make dev`/`make pyannote`
  naudojo fiksuotus portus (backend `3001`, pyannote `8001`), kurie RunPod'e jau užimti
  nginx/proxy - dėl to stackas nepasileidžia net su teisingais raktais. Portai padaryti
  konfigūruojami per Makefile kintamuosius (`BACKEND_PORT`, `PYANNOTE_PORT`,
  `FRONTEND_PORT`), perduodamus ir serveriams, ir jų tarpusavio sąsajai (`PYANNOTE_URL`).
  Naudojimas: `make gpu BACKEND_PORT=4001 PYANNOTE_PORT=9001`. Dokumentuota RUNPOD.md.

---

## Milestone 1 – Reliable processing pipeline ✅

Tikslas: paversti veikiantį prototipą patikimu apdorojimo konvejeriu, kuris
nepraranda vartotojo darbo ir turi aiškią sistemos būseną.

- **Persistent job orchestration** – HTTP endpoint'as tik įdeda jobą ir grąžina
  202; darbą vykdo atskiras procesas (ne HTTP handler'is). Su fallback į inline
  režimą, kai nėra Redis.
- **BullMQ workers** – atskiri transkripcijos ir protokolo worker'iai
  (`workers/transcriptionWorker.js`, `protocolWorker.js`) su retry + eksponentiniu
  backoff, dead-letter (failed po visų bandymų), stalled job recovery (worker
  restartavus nebaigtas jobas grąžinamas), atominiu job reservation (du worker'iai
  nepaima to paties jobo). Skaluojami nepriklausomai.
- **Redis-backed state** – pluggable job store (`utils/jobStore/`): su `REDIS_URL`
  job'ų būsena persistuojama Redis'e (atspari restartams, keli procesai), be jo –
  in-memory fallback. Laukai: `attempt_count`, `error_code`, `error_message`,
  `created_at`/`started_at`/`completed_at`. Statusai: queued/processing/completed/
  failed/cancelled.
- **Dedicated Whisper service** – persistentus `whisper-server/` (FastAPI), modelis
  įkeliamas vieną kartą ir laikomas atmintyje/VRAM tarp užklausų (vietoj naujo
  Python proceso kiekvienai užklausai). Concurrency semaforas, chunked upload.
  Simetriška pyannote-server architektūrai.
- **Browser E2E** – Playwright testai su tikra naršykle: (a) įklijuoti tekstą →
  protokolas → DOCX; (b) pilnas audio upload → polling → protokolas → DOCX; plius
  klaidų keliai (netinkamas formatas, backend offline, protokolo jobo klaida su
  paslapčių sanitizacija). Vykdomi CI'e su Chromium.
- **Protocol generation pipeline** – async `/api/jobs` (protokolas) ir
  `/api/transcribe-jobs` (transkripcija) su polling; provider pattern (Claude/GPT/
  Gemini/mock LLM; faster-whisper embedded/server; pyannote diarizacija); JSON
  schema validacija su repair retry; bendras failų storage (worker pasiekia audio
  pagal raktą, ne lokalų /tmp; failas trinamas po galutinio statuso, ne tarp retry).
- **Docker deployment** – profiliais atskirti compose failai (demo/cpu/gpu/server/
  runpod) su literalia provider izoliacija; nginx `/api` proxy (be CORS, universalus
  frontend image); quickstart/preflight/smoke/configure UX skriptai; Redis ir worker
  servisai; RunPod topologija su vienu viešu prievadu.
- **Health/readiness checks** – `/api/health` (backend), `/health?probe=true`
  (whisper-server ir pyannote-server priverstinai įkelia modelį ir grąžina 503 jei
  nepavyksta); Docker healthcheck'ai su `service_healthy` priklausomybėmis
  (backend laukia, kol Redis/pyannote/whisper realiai pasiruošę).

**Testų aprėptis milestone pabaigoje:** 129 backend + 9 pyannote + 8 whisper +
24 frontend + 6 E2E.

**Sąžiningi apribojimai (reikia realios aplinkos, ne sandbox):** GPU keliai
(CUDA/Torch/Whisper/pyannote su `device=cuda`), BullMQ restart recovery su tikru
Redis, ir E2E su tikra naršykle nebuvo paleisti kūrimo aplinkoje – parašyti,
statiškai patikrinti ir paruošti CI'ui / jūsų mašinai. Žr. README skiltį
„Ką realiai patikrina CI vs. kas tikrinta rankiniu būdu".

---

## Kitas: Milestone 2 – Sauga ir duomenų valdymas (planuojama)

OIDC autentifikavimas, organizacijų/rolių multi-tenancy, PostgreSQL + migracijos,
MinIO/S3 failų saugykla, retention/GDPR, audit logas. Žr. README roadmap.

## Žinomi apribojimai (iš realaus RunPod testavimo, taisytini atskirai)

- **SSE progreso cancellation yra COOPERATIVE (ne hard).** Kliento disconnect nutraukia
  darbą TIK tarp Whisper segmentų - vieno ilgo segmento apdorojimo (`model.transcribe`
  iteracijos) nutraukti negalima be atskiro proceso modelio. Temp failą trina worker'is
  savo `finally` bloke (kai TIKRAI baigia), ne event generatorius - tad failas
  neištrinamas, kol thread gyvas. Serverio pusė padengta Python integraciniais testais
  (`whisper-server/test_stream_integration.py`: bendras concurrency, semaforo
  atlaisvinimas, temp valymas). Vis dar EKSPERIMENTINIS - `WHISPER_STREAM_PROGRESS=false`
  numatytai.

- **Whisper halucinacijos tyloje (VAD neįjungtas).** RASTA su 4 val. įrašu: tyliose
  vietose (pauzės, tylus fonas) faster-whisper „prasimano" tekstą - dažniausiai YouTube
  titrų likučius („www.youtube.com" ir pan.). 4 val. teste ~37% segmentų (462 iš 1274)
  buvo tokios halucinacijos. Pyannote joms NEPRISKYRĖ kalbėtojo (`speaker=null`), tad
  jos atskiriamos. Du sprendimai (atskiras darbas): (1) įjungti faster-whisper
  `vad_filter=True` (voice activity detection praleidžia tylą - šalinama priežastis);
  (2) filtruoti segmentus be kalbėtojo su žinomais halucinacijų šablonais prieš protokolą.
  Pagrindinis kalbos turinys NENUKENČIA - halucinacijos tik tyliose vietose.
- **Job progresas ilgiems failams.** `progress` laukas visada `null` iki `completed` -
  kelių valandų įrašui vartotojas nemato „kiek liko". Infrastruktūra paruošta (job
  laukas, frontend rodymas, servisas priima `onProgress`), bet whisper-server → backend
  grandinė neteikia tarpinio progreso (vienas HTTP POST vietoj streaming'o). Sprendimas:
  whisper-server SSE/chunked su progresu → backend rašo į jobStore. Žr. README trade-off'ai.
- **MP3 ilgiems failams + pyannote.** Ilgas MP3 pyannote/torchaudio kelyje sukelia
  begalinį `MPEG_LAYER_III` warning'ų srautą ir įstrigimą; WAV veikia švariai. Kol nėra
  automatinio konvertavimo (planuojama), ilgus MP3 konvertuokite į WAV prieš siunčiant:
  `ffmpeg -i input.mp3 -ar 16000 -ac 1 output.wav`.
