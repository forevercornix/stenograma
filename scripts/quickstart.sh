#!/usr/bin/env bash
# Stenograma - quickstart: viena komanda visam scenarijui.
#
# Naudojimas:
#   ./scripts/quickstart.sh          (demo/mock - Docker, be raktų)
#   ./scripts/quickstart.sh cpu      (lokalus Whisper CPU per Docker)
#   ./scripts/quickstart.sh gpu      (Whisper GPU + pyannote per Docker)
# arba: make quickstart / quickstart-cpu / quickstart-gpu
#
# Ką daro: patikrina prerequisites (+ GPU passthrough gpu režimu), sukuria .env
# jei nėra, pakelia Docker stacką, LAUKIA healthcheck, paleidžia smoke testą ir
# parodo frontend adresą.
#
# ⚠️  STATUSAS: Docker/GPU keliai NEBUVO realiai išbandyti šioje kūrimo aplinkoje
# (nėra Docker daemon nei GPU). Skripto logika (argumentai, .env kūrimas, laukimo
# ciklas) parašyta ir sintaksiškai patikrinta; pilną Docker srautą patikrinkite
# savo mašinoje.
set -e

# BuildKit BŪTINAS Dockerfile'ų cache mount'ams (RUN --mount=type=cache) - spartina
# pakartotinius build'us. Docker 23+ numatytai įjungtas, bet senesnėse ne - tad
# nustatom eksplicitiškai, kad `# syntax=` direktyva ir cache mount'ai veiktų.
export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1

cd "$(dirname "$0")/.."
PROFILE="${1:-demo}"

say()  { echo -e "\033[1;34m[quickstart]\033[0m $1"; }
ok()   { echo -e "\033[1;32m✅\033[0m $1"; }
bad()  { echo -e "\033[1;31m❌\033[0m $1"; }
warn() { echo -e "\033[1;33m⚠️ \033[0m $1"; }
fail() { bad "$1"; exit 1; }

# --- 1. Docker prerequisites ---
command -v docker >/dev/null 2>&1 || fail "Docker nerastas. Įdiekite Docker + Docker Compose v2."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 nerastas ('docker compose'). Atnaujinkite Docker."
ok "Docker $(docker --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"

# --- 2. Preflight (GPU, Docker GPU passthrough, HF prieiga) - tik gpu profiliui ---
if [ "$PROFILE" = "gpu" ]; then
  say "Paleidžiu GPU preflight patikrą..."
  if ./scripts/preflight-gpu.sh --require-hf; then
    ok "Preflight praėjo"
  elif [ "${FORCE:-0}" = "1" ]; then
    warn "Preflight rado problemų, bet FORCE=1 - tęsiu vartotojo prašymu."
  else
    bad "GPU preflight NEPRAĖJO (žr. aukščiau). Diegimas sustabdytas, kad negaištumėte laiko build'ui."
    warn "Jei vis tiek norite tęsti (pvz. žinote, kad problema nekritiška): make quickstart-gpu FORCE=1"
    exit 1
  fi
fi

# --- 3. .env ---
if [ ! -f backend/.env ]; then
  cp backend/.env.example backend/.env
  say "Sukurtas backend/.env (numatyta - žr. .env.example). Interaktyviam nustatymui: make configure"
fi

# --- 4. Pakeliame stacką ---
COMPOSE_ARGS="-f docker-compose.yml"
case "$PROFILE" in
  gpu)  COMPOSE_ARGS="$COMPOSE_ARGS -f docker-compose.gpu.yml" ;;
  cpu)  COMPOSE_ARGS="$COMPOSE_ARGS -f docker-compose.cpu.yml" ;;
  demo) COMPOSE_ARGS="$COMPOSE_ARGS -f docker-compose.demo.yml" ;;
esac

say "Keliu stacką (profilis: $PROFILE)... Pirmas kartas gali užtrukti (image build/pull)."
# Išsaugome aktyvų profilį, kad make status/logs/down/update naudotų TUOS PAČIUS
# compose failus (kitaip GPU režime jie nematytų pyannote serviso - žr. #6).
echo "$PROFILE" > .active-profile
# shellcheck disable=SC2086
if [ "${BUILD:-0}" = "1" ]; then
  # Priverstinis lokalus build (kūrėjams / kai registry image'ų nėra).
  docker compose $COMPOSE_ARGS up -d --build
elif [ -n "${REGISTRY:-}" ]; then
  # Tikras registry nustatytas - traukiam paruoštus image'us (greita).
  say "REGISTRY=$REGISTRY - traukiu paruoštus image'us..."
  docker compose $COMPOSE_ARGS pull
  docker compose $COMPOSE_ARGS up -d
else
  # Numatyta: image'ai NEPUBLIKUOTI (docker-compose.gpu.yml turi placeholder
  # ghcr.io/OWNER). NEBANDOM pull - tai tik klaidintų bandymu jungtis prie netikro
  # registry. Statome lokaliai iš build: sekcijos. Greitam diegimui: publikuokite
  # image'us ir nustatykite REGISTRY (žr. README "Paruošti Docker image'ai").
  docker compose $COMPOSE_ARGS up -d --build
fi

# --- 5. Laukiame healthcheck ---
# GPU/server profiliai pirmą kartą ATSISIUNČIA modelius (Whisper ~500MB + pyannote),
# tad pirmas paleidimas gali užtrukti kelias minutes - tai NE strigimas. Aiškiai
# pasakom, kad vartotojas nepalaikytų laukimo už gedimą.
if [ "$PROFILE" = "gpu" ]; then
  say "PASTABA: pirmą kartą modeliai (Whisper ~500MB + pyannote) atsisiunčiami -"
  say "  tai gali užtrukti kelias minutes priklausomai nuo interneto. Progresą matote: make logs"
fi
say "Laukiu, kol backend taps sveikas (/api/health)..."
BACKEND_URL="http://localhost:3001/api/health"
# GPU profiliui - ilgesnis laukimas (modeliai + healthcheck start_period), kad
# lėtas pirmas download nesukeltų klaidingo "netapo sveikas".
MAX_TRIES=60
[ "$PROFILE" = "gpu" ] && MAX_TRIES=120
for i in $(seq 1 "$MAX_TRIES"); do
  if curl -fs "$BACKEND_URL" >/dev/null 2>&1; then
    ok "Backend sveikas"
    break
  fi
  [ "$i" = "$MAX_TRIES" ] && { bad "Backend netapo sveikas per $MAX_TRIES bandymų. Logai: make logs"; exit 1; }
  sleep 3
done

# --- 6. Smoke testas ---
say "Paleidžiu smoke testą..."
SMOKE_OK=true
# SVARBU: smoke testas eina per HTTP prieš VEIKIANTĮ konteinerį (scripts/smoke-gpu.sh),
# NE per hosto `npm run test-install`. Antraip, jei vartotojas tik klonavo repo ir
# paleido Docker quickstart, hoste nebūtų backend/node_modules ir smoke klaidingai
# kristų, nors konteineriai veikia. HTTP smoke tikrina tikrą stacką, nepriklausomai
# nuo hosto priklausomybių.
if [ "$PROFILE" = "gpu" ]; then
  # GPU: papildomai realus pyannote modelio testas (jei venv + tokenas yra) -
  # test_real_gpu.py automatiškai praleidžiamas be jų. Docker naudotojas venv
  # paprastai neturės, tad šis žingsnis dažnai bus praleistas - E2E HTTP smoke
  # (žemiau) lieka pagrindinis patikrinimas.
  if [ -x pyannote-server/.venv/bin/python ] && [ -n "${HUGGINGFACE_TOKEN:-}" ]; then
    say "Realus pyannote modelio testas (test_real_gpu.py)..."
    (cd pyannote-server && .venv/bin/python -m pytest test_real_gpu.py -v) \
      || { warn "Realus pyannote testas nepavyko."; SMOKE_OK=false; }
  fi
fi
# End-to-end per veikiantį stacką (VISI profiliai): WAV -> transkripcija -> protokolas.
./scripts/smoke-gpu.sh || { warn "Smoke testas nepavyko - žr. logus (make logs)."; SMOKE_OK=false; }

# --- 7. Rezultatas ---
echo ""
if [ "$SMOKE_OK" = true ]; then
  ok "Stenograma paleista IR funkcinis smoke testas praėjo."
  echo ""
  echo "   Atidarykite: http://localhost:5173"
  echo "   Būsena:      make status"
  echo "   Logai:       make logs"
  echo "   Stabdyti:    make down"
else
  bad "Servisai paleisti, BET funkcinis smoke testas NEPRAĖJO."
  warn "Konteineriai gali veikti, bet visas srautas nepatvirtintas. Diagnostika:"
  echo "   Logai:          make logs"
  echo "   Būsena:         make status"
  echo "   Diagnostika:    make support-bundle"
  # Ne nulinis exit - kad automatizacija ir vartotojas aiškiai matytų nesėkmę.
  exit 1
fi
