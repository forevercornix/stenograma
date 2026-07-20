#!/usr/bin/env bash
# Stenograma - vieno mygtuko diegimas (Linux/macOS/RunPod).
# Windows vartotojams: žr. README.md "Diegimas Windows" skyrių (žingsniai rankiniai,
# bet dokumentuoti ir realiai patikrinti su vartotoju).
#
# Naudojimas:  ./setup.sh            (CPU/mock profilis - veikia iš karto be raktų)
#              ./setup.sh --gpu      (papildomai: tikrina nvidia-smi/CUDA, paruošia
#                                     pyannote diarizacijos serverį su GPU Torch)
set -e

say()  { echo -e "\033[1;34m[setup]\033[0m $1"; }
warn() { echo -e "\033[1;33m[setup] ⚠️ \033[0m $1"; }
fail() { echo -e "\033[1;31m[setup] KLAIDA:\033[0m $1"; exit 1; }

cd "$(dirname "$0")"

# --- 0. Argumentai ---
GPU_MODE=false
for arg in "$@"; do
  case "$arg" in
    --gpu) GPU_MODE=true ;;
    *) warn "Nežinomas argumentas: $arg (ignoruojama). Galimi: --gpu" ;;
  esac
done

# --- 1. Prerequisites ---
command -v node >/dev/null 2>&1 || fail "Node.js nerastas. Įdiekite Node 20+ iš https://nodejs.org"
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$NODE_MAJOR" -ge 20 ] || fail "Node $(node -v) per senas - reikia >= 20."
say "Node $(node -v) ✅"

PYTHON_BIN=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1; then PYTHON_BIN="$c"; break; fi
done
if [ -n "$PYTHON_BIN" ]; then
  say "Python: $($PYTHON_BIN --version 2>&1) (per $PYTHON_BIN) ✅"
else
  say "⚠️  Python nerastas - lokali transkripcija (faster-whisper-embedded) neveiks, bet mock/API tiekėjai veiks."
fi

# --- 2. Backend ---
say "Diegiu backend Node priklausomybes..."
(cd backend && npm install --no-audit --no-fund)

if [ -n "$PYTHON_BIN" ]; then
  say "Diegiu Python priklausomybes (faster-whisper)..."
  # --break-system-packages reikalingas naujesnėse Debian/Ubuntu (PEP 668);
  # senesnėse sistemose šio flag'o nėra - todėl bandome abu variantus.
  (cd backend && ($PYTHON_BIN -m pip install -r scripts/requirements.txt --quiet 2>/dev/null \
    || $PYTHON_BIN -m pip install -r scripts/requirements.txt --break-system-packages --quiet)) \
    || say "⚠️  pip diegimas nepavyko - lokali transkripcija neveiks; žr. backend/scripts/requirements.txt"
fi

# --- 3. Frontend ---
say "Diegiu frontend priklausomybes..."
(cd frontend && npm install --no-audit --no-fund)

# --- 4. Konfigūracija ---
[ -f backend/.env ]  || { cp backend/.env.example backend/.env;   say "Sukurtas backend/.env (iš .env.example - numatyta MOCK demo režimas be raktų)"; }
[ -f frontend/.env ] || { cp frontend/.env.example frontend/.env; say "Sukurtas frontend/.env"; }

# --- 5. GPU / pyannote diarizacija (tik su --gpu) ---
if [ "$GPU_MODE" = true ]; then
  echo ""
  say "=== GPU režimas: tikrinu CUDA ir ruošiu pyannote diarizaciją ==="

  # 5a. Preflight: host GPU, Docker GPU passthrough, HF prieiga, diskas, RAM.
  # Native diegimui Docker patikros nebūtinos, bet paleidžiam pilną - jei Docker
  # yra, passthrough patikra naudinga; jei ne, ji tiesiog praleidžiama su įspėjimu.
  say "Paleidžiu GPU preflight patikrą (scripts/preflight-gpu.sh)..."
  ./scripts/preflight-gpu.sh || warn "Preflight rado problemų (žr. aukščiau) - tęsiu diegimą, bet patikrinkite."

  [ -z "$PYTHON_BIN" ] && fail "Python nerastas - pyannote diarizacijai jis būtinas. Įdiekite Python 3.9+."

  # 5b. pyannote virtuali aplinka (atskira nuo backend faster-whisper, nes torch
  # versijos gali skirtis; venv izoliuoja priklausomybes).
  say "Kuriu pyannote Python virtualią aplinką (pyannote-server/.venv)..."
  if [ ! -d pyannote-server/.venv ]; then
    "$PYTHON_BIN" -m venv pyannote-server/.venv || fail "Nepavyko sukurti venv. Ar įdiegtas python3-venv paketas?"
  fi
  VENV_PIP="pyannote-server/.venv/bin/pip"
  [ -f "$VENV_PIP" ] || VENV_PIP="pyannote-server/.venv/Scripts/pip"  # Windows/Git-bash

  # 5c. GPU Torch (CUDA 12.4) + pyannote priklausomybės (UŽFIKSUOTOS versijos).
  say "Diegiu GPU Torch (CUDA 12.4) - tai gali užtrukti (didelis paketas)..."
  "$VENV_PIP" install --quiet torch==2.5.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cu124 \
    || warn "GPU Torch diegimas nepavyko - patikrinkite CUDA versiją (gal reikia kitos cuXXX). Bandykite rankiniu būdu."
  say "Diegiu pyannote.audio ir serverio priklausomybes (užfiksuotos versijos)..."
  "$VENV_PIP" install --quiet -r pyannote-server/requirements-gpu.lock.txt \
    || warn "pyannote priklausomybių diegimas nepavyko - žr. pyannote-server/requirements-gpu.lock.txt."

  # 5c-bis. hf_transfer: RunPod'e praktiškai būtinas - be jo dideli modeliai dažnai
  # timeout'ina/nutrūksta atsisiunčiant iš Hugging Face. Diegiam į TĄ PATĮ venv
  # (ne sisteminį python) ir pasiūlom įjungti. Nėra lock failuose tyčia (versija ne
  # kritinė, o be jo diegimas RunPod'e dažnai visai neįvyktų).
  say "Diegiu hf_transfer (atsparesnis modelių atsisiuntimas - RunPod'e ~būtinas)..."
  "$VENV_PIP" install --quiet hf_transfer \
    || warn "hf_transfer diegimas nepavyko - modelių atsisiuntimas RunPod'e gali timeout'inti. Bandykite: pyannote-server/.venv/bin/python -m pip install hf_transfer"
  say "PATARIMAS: prieš pirmą paleidimą įjunkite greitą atsisiuntimą: export HF_HUB_ENABLE_HF_TRANSFER=1"

  # 5d. (HF tokeno IR modelio prieigos patikra jau atlikta 5a preflight'e -
  # scripts/preflight-gpu.sh realiai tikrina prieigą prie gated modelio, ne tik
  # ar kintamasis nustatytas.)

  # 5e. Readiness testas: bandome importuoti pyannote venv'e.
  VENV_PY="pyannote-server/.venv/bin/python"
  [ -f "$VENV_PY" ] || VENV_PY="pyannote-server/.venv/Scripts/python"
  if [ -f "$VENV_PY" ]; then
    say "Readiness testas: tikrinu pyannote ir CUDA prieinamumą venv'e..."
    "$VENV_PY" -c "import torch; print('[setup]   torch CUDA prieinama:', torch.cuda.is_available())" 2>/dev/null \
      || warn "Nepavyko importuoti torch venv'e - diegimas galėjo nepavykti."
    "$VENV_PY" -c "import pyannote.audio; print('[setup]   pyannote.audio importuotas OK')" 2>/dev/null \
      || warn "Nepavyko importuoti pyannote.audio - diarizacija neveiks."
  fi

  say "GPU/pyannote paruošimas baigtas. Paleidimas: make gpu (arba make docker-gpu izoliuotai)."
fi

# --- 6. Diagnostika ---
say "Paleidžiu diagnostiką (npm run doctor)..."
(cd backend && npm run doctor) || say "⚠️  doctor rado problemų - žr. aukščiau. Mock režimu sistema vis tiek veiks."

echo ""
say "Diegimas baigtas. Greičiausias būdas įsitikinti, kad viskas veikia:"
echo -e "    \033[1mmake demo\033[0m                     # pilnas srautas per sekundes (mock, be raktų): ✔ upload ✔ transkripcija ✔ LLM ✔ protokolas"
echo ""
say "Paleidimas naršyklėje (dviejuose terminaluose):"
echo "    cd backend  && npm start      # http://localhost:3001"
echo "    cd frontend && npm run dev    # http://localhost:5173"
echo -e "    \033[2m(arba tiesiog: make dev)\033[0m"
echo ""
say "Realiam AI: backend/.env nustatykite LLM_PROVIDER=claude + ANTHROPIC_API_KEY,"
say "lokaliam transkribavimui - TRANSCRIPTION_PROVIDER=faster-whisper-embedded (žr. .env komentarus)."
if [ "$GPU_MODE" = true ]; then
  say "GPU stackas su diarizacija: make gpu  (pyannote :8001 + backend GPU) arba make docker-gpu (izoliuota)."
fi
say "RunPod/GPU diegimui - žr. RUNPOD.md."
