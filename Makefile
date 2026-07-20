# Stenograma - paleidimo scenarijai.
# Tikslas (vartotojo prašymas po realaus diegimo): nereikėtų prisiminti ilgų komandų.
# Naudojimas:  make <taikinys>   (pvz. `make dev`, `make doctor`, `make gpu`)
# `make` arba `make help` parodo šį sąrašą.
#
# KONFIGŪRUOJAMI PORTAI. RunPod ir kitose aplinkose numatyti portai (3001, 8001)
# gali būti jau užimti (pvz. nginx). Perrašykite juos iš komandinės eilutės:
#   make gpu BACKEND_PORT=4001 PYANNOTE_PORT=9001
# arba eksportuokite aplinkoje. Reikšmės perduodamos ir serveriams (PORT), ir jų
# tarpusavio sąsajai (PYANNOTE_URL), kad viskas liktų nuoseklu.
BACKEND_PORT ?= 3001
PYANNOTE_PORT ?= 8001
FRONTEND_PORT ?= 5173
PYANNOTE_URL ?= http://localhost:$(PYANNOTE_PORT)/diarize

.DEFAULT_GOAL := help
.PHONY: help setup setup-gpu configure preflight-gpu quickstart quickstart-cpu quickstart-gpu quickstart-runpod demo dev prod worker cpu gpu gpu-transcription pyannote doctor smoke smoke-gpu warmup verify status logs update support-bundle test test-frontend test-pyannote docker docker-gpu down clean

help: ## Parodyti šį pagalbos sąrašą
	@echo "Stenograma - galimi paleidimo scenarijai:"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "Greičiausias startas (Docker): make quickstart  (demo) / quickstart-gpu (Whisper GPU + pyannote)"
	@echo "Be Docker, lokaliai:           make setup && make dev"

# ─── Vieno mygtuko UX (Docker) ───────────────────────────────────────────────
quickstart: ## Docker: demo/mock stackas viena komanda (build, laukia health, smoke, rodo URL)
	BUILD=$(BUILD) ./scripts/quickstart.sh demo

quickstart-cpu: ## Docker: lokalus Whisper CPU stackas viena komanda
	BUILD=$(BUILD) ./scripts/quickstart.sh cpu

quickstart-gpu: ## Docker: Whisper GPU + pyannote (tikrina GPU passthrough; FORCE=1 apeiti preflight, BUILD=1 statyti lokaliai)
	FORCE=$(FORCE) BUILD=$(BUILD) ./scripts/quickstart.sh gpu

quickstart-runpod: ## Docker RunPod: GPU stackas su vienu viešu frontend prievadu (0.0.0.0:5173) ir nginx /api proxy
	@echo "RunPod GPU stackas. Reikia HUGGINGFACE_TOKEN ir MODEL_CACHE_DIR (pvz. /workspace/models)."
	@echo "RunPod pod: Expose HTTP Ports = 5173. Frontend: https://<POD_ID>-5173.proxy.runpod.net"
	docker compose -f docker-compose.yml -f docker-compose.gpu.yml -f docker-compose.runpod.yml up -d --build

configure: ## Interaktyviai sugeneruoti backend/.env (režimas + LLM pasirinkimas)
	./scripts/configure.sh

preflight-gpu: ## Patikrinti GPU/Docker/HF prieigą PRIEŠ diegimą (Docker GPU passthrough, HF modelio prieiga)
	./scripts/preflight-gpu.sh

# ─── Diegimas (be Docker) ────────────────────────────────────────────────────
setup: ## Vieno mygtuko diegimas mock/CPU režimui (setup.sh)
	./setup.sh

setup-gpu: ## Kaip setup, + GPU: tikrina nvidia-smi/CUDA, sukuria pyannote venv su CUDA Torch (setup.sh --gpu)
	./setup.sh --gpu

demo: ## "Happy path" po setup: paleidžia backend (mock), atlieka pilną srautą (upload→transkripcija→LLM→protokolas), parodo ✔ ir "System ready"
	./scripts/demo.sh

dev: ## Backend + frontend lokaliai (development, mock tiekėjai - veikia be raktų)
	@echo "Paleidžiu backend (:$(BACKEND_PORT)) ir frontend (:$(FRONTEND_PORT)). Stabdyti - Ctrl+C."
	@$(MAKE) -j2 _dev-backend _dev-frontend

_dev-backend:
	cd backend && PORT=$(BACKEND_PORT) npm run dev

_dev-frontend:
	cd frontend && npm run dev

prod: ## Backend produkcijos režimu (reikalauja NODE_ENV=production ir API_KEY .env faile)
	cd backend && NODE_ENV=production npm start

worker: ## BullMQ worker procesas (reikia REDIS_URL - vykdo transkripcijos/protokolo jobus atskirai nuo HTTP)
	cd backend && node workers/index.js

worker-transcription: ## Tik transkripcijos worker'is (atskiras skalavimas)
	cd backend && node workers/transcriptionWorker.js

worker-protocol: ## Tik protokolo worker'is (atskiras skalavimas)
	cd backend && node workers/protocolWorker.js

cpu: ## Backend su lokalia CPU transkripcija (be diarizacijos)
	cd backend && TRANSCRIPTION_PROVIDER=faster-whisper-embedded FASTER_WHISPER_DEVICE=cpu FASTER_WHISPER_COMPUTE_TYPE=int8 npm start

gpu-transcription: ## TIK backend su GPU transkripcija (device=cuda, be diarizacijos)
	cd backend && TRANSCRIPTION_PROVIDER=faster-whisper-embedded FASTER_WHISPER_DEVICE=cuda FASTER_WHISPER_COMPUTE_TYPE=float16 FASTER_WHISPER_MAX_CONCURRENCY=1 npm start

pyannote: ## TIK pyannote diarizacijos serveris (portas PYANNOTE_PORT, numatyta 8001; naudoja make setup-gpu venv)
	@if [ -x pyannote-server/.venv/bin/python ]; then \
		cd pyannote-server && PORT=$(PYANNOTE_PORT) .venv/bin/python server.py; \
	elif [ -x pyannote-server/.venv/Scripts/python.exe ]; then \
		cd pyannote-server && PORT=$(PYANNOTE_PORT) .venv/Scripts/python.exe server.py; \
	else \
		echo "Pyannote venv (pyannote-server/.venv) nerastas. Pirma paleiskite: make setup-gpu"; \
		echo "(sisteminis python3 nenaudojamas tyčia - jame pyannote greičiausiai neįdiegtas)"; \
		exit 1; \
	fi

gpu: ## Pilnas GPU stackas lokaliai (be Docker): pyannote + backend su GPU transkripcija IR diarizacija
	@echo "Paleidžiu pyannote (:$(PYANNOTE_PORT)) IR backend (:$(BACKEND_PORT)) su GPU+diarizacija. Reikia HUGGINGFACE_TOKEN. Stabdyti - Ctrl+C."
	@echo "Alternatyva per Docker (izoliuota): make quickstart-gpu"
	@echo "Jei portai užimti (pvz. RunPod nginx): make gpu BACKEND_PORT=4001 PYANNOTE_PORT=9001"
	@$(MAKE) -j2 pyannote _gpu-backend-with-diarization

_gpu-backend-with-diarization:
	cd backend && PORT=$(BACKEND_PORT) TRANSCRIPTION_PROVIDER=faster-whisper-embedded FASTER_WHISPER_DEVICE=cuda \
		FASTER_WHISPER_COMPUTE_TYPE=float16 FASTER_WHISPER_MAX_CONCURRENCY=1 \
		DIARIZATION_PROVIDER=pyannote PYANNOTE_URL=$(PYANNOTE_URL) npm start

# ─── Diagnostika ir priežiūra ────────────────────────────────────────────────
doctor: ## Diagnostika: Node, Python, CUDA, ffmpeg, modeliai, diskas, RAM (nekeičia nieko)
	cd backend && npm run doctor

smoke: ## Greitas smoke testas (backend mock, be tinklo/Docker)
	cd backend && npm run test-install

smoke-gpu: ## End-to-end smoke per VEIKIANTĮ stacką: WAV -> transkripcija -> protokolas (tikras HTTP)
	BACKEND=$(or $(BACKEND),http://localhost:$(BACKEND_PORT)) ./scripts/smoke-gpu.sh

warmup: ## Modelių "warm-up": paleidžia trumpą audio, kad modeliai įsikeltų į cache/VRAM (per smoke-gpu)
	@echo "Warm-up: pirmas realus failas nebus 'netikėtai lėtas' po šito."
	BACKEND=$(or $(BACKEND),http://localhost:$(BACKEND_PORT)) ./scripts/smoke-gpu.sh

verify: ## Pilnas end-to-end patikrinimas (= smoke-gpu prieš veikiantį stacką). Portą keiskite: make verify BACKEND_PORT=4001
	BACKEND=$(or $(BACKEND),http://localhost:$(BACKEND_PORT)) ./scripts/smoke-gpu.sh

status: ## Konteinerių ir health būsena (pagal aktyvų profilį)
	@docker compose $$(./scripts/compose-args.sh) ps 2>/dev/null || echo "(Docker stackas nepaleistas)"
	@echo "--- Health ---"
	@curl -fs http://localhost:$(BACKEND_PORT)/api/health 2>/dev/null || echo "backend: nepasiekiamas"
	@echo ""

logs: ## Svarbiausi visų servisų logai (pagal aktyvų profilį - GPU režime rodo ir pyannote)
	docker compose $$(./scripts/compose-args.sh) logs --tail=100 -f

update: ## Nauji image'ai ir saugus restartas (su REGISTRY - pull; be jo - lokalus build)
	@if [ -n "$$REGISTRY" ]; then \
		echo "REGISTRY=$$REGISTRY - traukiu paruoštus image'us..."; \
		docker compose $$(./scripts/compose-args.sh) pull && \
		docker compose $$(./scripts/compose-args.sh) up -d; \
	else \
		echo "REGISTRY nenustatytas - atnaujinu lokaliu build'u (pull praleidžiamas,"; \
		echo "nes lokalūs image'ai stenograma-*:gpu viešame registry neegzistuoja)."; \
		docker compose $$(./scripts/compose-args.sh) up -d --build; \
	fi

support-bundle: ## Diagnostikos paketas gedimams (viskas į vieną failą, slapti duomenys užmaskuoti)
	./scripts/support-bundle.sh

# ─── Testai ──────────────────────────────────────────────────────────────────
test: ## Backend testai (node:test, mock tiekėjai, be raktų)
	cd backend && npm test

test-frontend: ## Frontend testai (Vitest)
	cd frontend && npm test

test-pyannote: ## Pyannote serverio testai (/health + /diarize kontraktas su mock pipeline)
	cd pyannote-server && pytest -v

# ─── Docker ──────────────────────────────────────────────────────────────────
docker: ## Pakelti visą stacką per Docker Compose (CPU, mock - veikia iš karto)
	docker compose up --build

docker-gpu: ## GPU stackas: traukia paruoštus image'us (jei publikuoti) arba stato lokaliai
	docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d

docker-gpu-build: ## GPU stackas: PRIVERSTINAI stato image'us lokaliai (kai registry image'ų nėra)
	docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build

down: ## Sustabdyti Docker Compose stacką (pagal aktyvų profilį)
	docker compose $$(./scripts/compose-args.sh) down
	@rm -f .active-profile

clean: ## Išvalyti node_modules, dist, venv ir Python cache (nekeičia .env ir modelių)
	rm -rf backend/node_modules frontend/node_modules frontend/dist pyannote-server/.venv
	find . -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true
	@echo "Išvalyta. Iš naujo: make setup"
