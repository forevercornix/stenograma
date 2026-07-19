#!/usr/bin/env bash
# Stenograma - diagnostikos paketas gedimams spręsti.
# Surenka viską, ko reikia diagnozei, į VIENĄ tekstinį failą su UŽMASKUOTAIS
# slaptais duomenimis - kad vietoj dešimties ekrano nuotraukų vartotojas atsiųstų
# vieną failą.
#
# Naudojimas:  ./scripts/support-bundle.sh   (sukuria stenograma-support-*.txt)
#              make support-bundle
set -e

cd "$(dirname "$0")/.."
OUT="stenograma-support-$(date -u +%Y%m%d-%H%M%S).txt"

# Slaptų reikšmių maskavimas: bet kuris raktas, kurio pavadinime yra KEY/TOKEN/
# SECRET/PASSWORD, rodomas kaip pavadinimas=***. Kritiškai svarbu, kad į paketą
# nepatektų API_KEY/ANTHROPIC_API_KEY/OPENAI_API_KEY/HUGGINGFACE_TOKEN reikšmės.
mask() {
  sed -E 's/((KEY|TOKEN|SECRET|PASSWORD)[A-Z_]*)=.+/\1=***UŽMASKUOTA***/gI'
}

section() { echo ""; echo "=================================================="; echo "== $1"; echo "=================================================="; }

{
  echo "Stenograma support bundle - $(date -u +%Y-%m-%dT%H:%M:%SZ)"

  section "OS"
  uname -a 2>/dev/null || echo "(uname neprieinamas)"
  [ -f /etc/os-release ] && cat /etc/os-release

  section "Versijos"
  echo "Node:   $(node --version 2>/dev/null || echo 'nerastas')"
  echo "npm:    $(npm --version 2>/dev/null || echo 'nerastas')"
  echo "Python: $(python3 --version 2>&1 || echo 'nerastas')"
  echo "Docker: $(docker --version 2>/dev/null || echo 'nerastas')"
  echo "Compose: $(docker compose version 2>/dev/null | head -1 || echo 'nerastas')"

  section "GPU / CUDA"
  if command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi 2>/dev/null || echo "(nvidia-smi klaida)"
  else
    echo "nvidia-smi nerastas (GPU gali būti neprieinama arba tvarkyklės neįdiegtos)"
  fi

  section "Docker GPU passthrough"
  if command -v docker >/dev/null 2>&1; then
    if docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi >/dev/null 2>&1; then
      echo "OK - konteineris mato GPU (nvidia-container-toolkit veikia)"
    else
      echo "FAILED - konteineris NEMATO GPU (tikriausiai neįdiegtas nvidia-container-toolkit)"
    fi
  else
    echo "(Docker nerastas - praleista)"
  fi

  section "Konteinerių būsena"
  docker compose ps 2>/dev/null || echo "(docker compose ps neprieinamas - stackas gali būti nepaleistas)"

  section "Health endpointai"
  for url in "http://localhost:3001/api/health" "http://localhost:3001/api/health/deep" "http://localhost:8001/health?probe=true"; do
    echo "--- $url ---"
    curl -fs --max-time 10 "$url" 2>/dev/null | mask || echo "(nepasiekiamas)"
    echo ""
  done

  section "Konfigūracija (backend/.env - UŽMASKUOTA)"
  if [ -f backend/.env ]; then
    mask < backend/.env
  else
    echo "(backend/.env nerastas)"
  fi

  section "Paskutiniai logai (backend, UŽMASKUOTA, iki 50 eil.)"
  docker compose logs --tail=50 backend 2>/dev/null | mask || echo "(docker logai neprieinami)"

  section "Paskutiniai logai (pyannote, UŽMASKUOTA, iki 30 eil.)"
  docker compose -f docker-compose.yml -f docker-compose.gpu.yml logs --tail=30 pyannote 2>/dev/null | mask || echo "(pyannote logai neprieinami - gali būti nepaleistas)"

} > "$OUT"

echo "Sukurtas diagnostikos paketas: $OUT"
echo "Slapti duomenys (KEY/TOKEN/SECRET/PASSWORD) užmaskuoti - saugu siųsti."
echo "PATIKRINKITE prieš siųsdami: grep -iE 'key|token|secret' $OUT"
