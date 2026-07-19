#!/usr/bin/env bash
# Grąžina (echo) teisingus `docker compose -f ...` argumentus pagal aktyvų profilį,
# išsaugotą .active-profile faile (jį rašo scripts/quickstart.sh). Naudoja Makefile
# priežiūros komandos (status/logs/down/update), kad GPU režime jos matytų VISĄ
# stacką (įskaitant pyannote), o ne tik bazinį - žr. atsiliepimo #6.
#
# Naudojimas:  eval "docker compose $(./scripts/compose-args.sh) ps"
cd "$(dirname "$0")/.."
PROFILE="demo"
[ -f .active-profile ] && PROFILE=$(cat .active-profile 2>/dev/null || echo demo)

case "$PROFILE" in
  gpu)  echo "-f docker-compose.yml -f docker-compose.gpu.yml" ;;
  cpu)  echo "-f docker-compose.yml -f docker-compose.cpu.yml" ;;
  demo) echo "-f docker-compose.yml -f docker-compose.demo.yml" ;;
  *)    echo "-f docker-compose.yml" ;;
esac
