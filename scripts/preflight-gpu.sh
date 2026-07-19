#!/usr/bin/env bash
# Stenograma - GPU/diegimo preflight patikra.
# VIENA vieta visoms prerequisites patikroms, kurią naudoja IR setup.sh --gpu,
# IR scripts/quickstart.sh - kad logika nesidubliuotų ir būtų nuosekli.
#
# Naudojimas:  ./scripts/preflight-gpu.sh              (pilna patikra, HF tokenas pasirenkamas)
#              ./scripts/preflight-gpu.sh --no-docker  (praleisti Docker patikras, native diegimui)
#              ./scripts/preflight-gpu.sh --require-hf  (HF tokenas PRIVALOMAS - GPU Docker profilis)
#
# Grąžina 0, jei kritinių problemų nėra (įspėjimai neblokuoja); >0, jei kažkas
# tikrai neveiks. Kiekviena patikra spausdina ✅/⚠️/❌ eilutę.
#
# ⚠️  Docker GPU passthrough ir HF prieigos patikros REALIAI vykdo tinklo/Docker
# komandas - jos NEBUVO išbandytos GPU/Docker aplinkoje čia, bet pačios komandos
# (curl HF API, docker run --gpus) yra standartinės ir sintaksiškai patikrintos.
set -u

SKIP_DOCKER=false
REQUIRE_HF=false
for arg in "$@"; do
  case "$arg" in
    --no-docker) SKIP_DOCKER=true ;;
    --require-hf) REQUIRE_HF=true ;;
  esac
done

ok()   { echo -e "\033[1;32m✅\033[0m $1"; }
warn() { echo -e "\033[1;33m⚠️ \033[0m $1"; }
bad()  { echo -e "\033[1;31m❌\033[0m $1"; }

PROBLEMS=0

# Šakninis .env: jei HUGGINGFACE_TOKEN dar nenustatytas shell aplinkoje, saugiai
# perskaitom jį iš projekto šaknies .env (tą patį failą skaito Docker Compose).
# SAUGIAI = tik konkrečios eilutės grep'as, NE `source` (kuris vykdytų bet kokį
# kodą faile). Cituotas ar necituotas reikšmes apdorojam nuėmę kabutes.
_read_env_var() {
  local key="$1" file="$2"
  [ -f "$file" ] || return 1
  local line
  line=$(grep -E "^[[:space:]]*${key}=" "$file" 2>/dev/null | tail -1)
  [ -z "$line" ] && return 1
  local val="${line#*=}"
  val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"  # nuimam kabutes
  echo "$val"
}
if [ -z "${HUGGINGFACE_TOKEN:-}" ] && [ -z "${HF_TOKEN:-}" ]; then
  _root_env="$(dirname "$0")/../.env"
  _hf_from_file=$(_read_env_var "HUGGINGFACE_TOKEN" "$_root_env" || _read_env_var "HF_TOKEN" "$_root_env" || true)
  if [ -n "${_hf_from_file:-}" ]; then
    export HUGGINGFACE_TOKEN="$_hf_from_file"
    echo "   (HUGGINGFACE_TOKEN perskaitytas iš šakninio .env)"
  fi
fi

# --- Host GPU ---
if command -v nvidia-smi >/dev/null 2>&1; then
  ok "Host GPU: $(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)"
  ok "NVIDIA driver: $(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1)"
else
  warn "nvidia-smi nerastas - host GPU neprieinama ar tvarkyklės neįdiegtos (CPU fallback išliks galimas)."
fi

# --- Docker + Docker GPU passthrough ---
if [ "$SKIP_DOCKER" = false ]; then
  if command -v docker >/dev/null 2>&1; then
    ok "Docker: $(docker --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
    if docker compose version >/dev/null 2>&1; then
      # Tikrinam MINIMALIĄ Compose versiją. `env_file: [{path, required}]` sintaksė
      # (naudojama compose failuose) reikalauja Compose v2.24+. Senesni v2 leidimai
      # jos nesupras ir mes klaidą.
      COMPOSE_VER=$(docker compose version --short 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
      if [ -n "$COMPOSE_VER" ]; then
        COMPOSE_MAJOR=$(echo "$COMPOSE_VER" | cut -d. -f1)
        COMPOSE_MINOR=$(echo "$COMPOSE_VER" | cut -d. -f2)
        if [ "$COMPOSE_MAJOR" -ge 2 ] && { [ "$COMPOSE_MAJOR" -gt 2 ] || [ "$COMPOSE_MINOR" -ge 24 ]; }; then
          ok "Docker Compose v$COMPOSE_VER (>= 2.24 - env_file required: sintaksė palaikoma)"
        else
          bad "Docker Compose v$COMPOSE_VER per senas - reikia >= 2.24 (env_file 'required:' sintaksei)."
          warn "  Atnaujinkite Docker Desktop / Compose plugin'ą."
          PROBLEMS=$((PROBLEMS+1))
        fi
      else
        ok "Docker Compose v2 (versijos nepavyko nustatyti, bet 'docker compose' veikia)"
      fi
    else
      bad "Docker Compose v2 ('docker compose') nerastas."; PROBLEMS=$((PROBLEMS+1))
    fi

    # KRITINĖ patikra: host nvidia-smi NEGARANTUOJA, kad KONTEINERIS matys GPU.
    # Ši dviejų būsenų painiava (nvidia-smi OK, bet Docker GPU FAILED dėl trūkstamo
    # nvidia-container-toolkit) - dažna RunPod/serverio problema.
    echo "   tikrinu Docker GPU passthrough (gali užtrukti - traukiamas mažas CUDA image)..."
    if docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi >/dev/null 2>&1; then
      ok "Docker GPU passthrough: konteineris MATO GPU (nvidia-container-toolkit veikia)"
    else
      bad "Docker GPU passthrough: konteineris NEMATO GPU."
      warn "  Host GPU gali veikti, bet Docker jos nemato - tikriausiai neįdiegtas/nesukonfigūruotas nvidia-container-toolkit."
      warn "  Diegimas: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html"
      PROBLEMS=$((PROBLEMS+1))
    fi
  else
    warn "Docker nerastas - praleidžiu Docker patikras (native diegimui tai gerai)."
  fi
fi

# --- Diskas ir RAM ---
if command -v df >/dev/null 2>&1; then
  AVAIL=$(df -BG . 2>/dev/null | awk 'NR==2 {gsub("G","",$4); print $4}')
  # GPU build (CUDA baziniai image'ai + Torch + pyannote + faster-whisper + Node)
  # realiai gali pareikalauti 25-30GB. 15GB buvo per optimistiška.
  if [ -n "${AVAIL:-}" ] && [ "$AVAIL" -lt 25 ] 2>/dev/null; then
    warn "Laisvos vietos: ${AVAIL}GB - GPU image'ams (CUDA/Torch/pyannote) rekomenduojama 25-30GB+."
  else
    ok "Laisvos disko vietos: ${AVAIL:-?}GB (>= 25GB rekomenduojama GPU build'ui)"
  fi
fi
if [ -r /proc/meminfo ]; then
  RAM_GB=$(awk '/MemTotal/ {printf "%.0f", $2/1024/1024}' /proc/meminfo)
  ok "Sistemos RAM: ${RAM_GB}GB"
fi

# --- Hugging Face tokenas IR modelio prieiga (ne tik "ar egzistuoja") ---
# GPU Docker profilyje (--require-hf) pyannote VISADA paleidžiamas ir be tokeno
# tampa unhealthy -> backend laukia service_healthy -> visas quickstart nepasileidžia.
# Todėl ten trūkstamas tokenas yra KRITINĖ klaida, ne įspėjimas. Native diegime
# (setup.sh --gpu be --require-hf) diarizacija gali būti pasirenkama, tad įspėjimas.
HF="${HUGGINGFACE_TOKEN:-${HF_TOKEN:-}}"
if [ -z "$HF" ]; then
  if [ "$REQUIRE_HF" = true ]; then
    bad "HUGGINGFACE_TOKEN nenustatytas - pyannote NEGALĖS įkelti modelio, o GPU stackas"
    bad "  laukia pyannote service_healthy, tad NEPASILEIS. Nustatykite: export HUGGINGFACE_TOKEN=hf_..."
    PROBLEMS=$((PROBLEMS+1))
  else
    warn "HUGGINGFACE_TOKEN nenustatytas - pyannote diarizacija neveiks (transkripcija be diarizacijos veiks)."
  fi
else
  echo "   tikrinu HF tokeną IR pyannote modelio prieigą..."
  # Tikrina, ar tokenas GALIOJA ir turi prieigą prie GATED modelio (priimtos sąlygos).
  if curl -fsSL --max-time 15 -H "Authorization: Bearer $HF" \
       https://huggingface.co/api/models/pyannote/speaker-diarization-3.1 >/dev/null 2>&1; then
    ok "HF tokenas galioja IR turi prieigą prie pyannote/speaker-diarization-3.1"
  else
    bad "HF tokenas NEGALIOJA arba nepriimtos pyannote modelio sąlygos."
    warn "  1) Priimkite: https://hf.co/pyannote/speaker-diarization-3.1"
    warn "  2) Tokenas: https://hf.co/settings/tokens"
    PROBLEMS=$((PROBLEMS+1))
  fi
fi

echo ""
if [ "$PROBLEMS" -eq 0 ]; then
  ok "Preflight: kritinių problemų nerasta."
else
  bad "Preflight: rasta $PROBLEMS kritinių problemų (žr. aukščiau). GPU stackas gali nepasileisti."
fi
exit "$PROBLEMS"
