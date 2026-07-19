# Pakeitimų istorija

Projekto raidos milestone'ai. Formatas grubiai pagal [Keep a Changelog](https://keepachangelog.com/).

---

## Pataisyta (po realaus RunPod diegimo audito)

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
