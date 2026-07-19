#!/usr/bin/env bash
# Stenograma "happy path" demo - paleidžia backend'ą (mock provideriai), atlieka
# PILNĄ vartotojo srautą (upload -> transkripcija -> LLM -> protokolas) ir parodo
# aiškų rezultatą. Skirtas PIRMAM ĮSPŪDŽIUI po ./setup.sh - vienas veiksmas,
# kuris įrodo, kad viskas veikia.
#
# Paleidimas:  make demo   (arba  ./scripts/demo.sh)
#
# Provideriai MOCK - jokių API raktų, GPU ar interneto. Viskas lokaliai per
# sekundes. ffmpeg naudojamas testiniam WAV (jei nėra - minimalus WAV baitų).

set -e
cd "$(dirname "$0")/.."

GREEN='\033[1;32m'; RED='\033[1;31m'; DIM='\033[2m'; BOLD='\033[1m'; NC='\033[0m'
check() { echo -e "${GREEN}✔${NC} $1"; }
fail()  { echo -e "${RED}✗ $1${NC}"; exit 1; }
step()  { echo -e "${DIM}  … $1${NC}"; }

BACKEND_PORT=3001
BACKEND="http://localhost:$BACKEND_PORT"

echo -e "${BOLD}Stenograma demo${NC} — pilnas srautas su mock provideriais\n"

# --- 1. Paleidžiam backend'ą (mock) fone ---
step "paleidžiu backend'ą (mock provideriai)…"
cd backend
[ -d node_modules ] || { step "diegiu backend priklausomybes…"; npm install --no-audit --no-fund >/dev/null 2>&1; }
LLM_PROVIDER=mock TRANSCRIPTION_PROVIDER=mock DIARIZATION_PROVIDER=none \
  node server.js > /tmp/stenograma-demo-backend.log 2>&1 &
BACKEND_PID=$!
cd ..

# Užtikrinam, kad backend'as sustabdomas išeinant (net jei demo nutrūksta).
cleanup() { kill "$BACKEND_PID" 2>/dev/null || true; }
trap cleanup EXIT

# Laukiam, kol backend'as pakyla (/api/health).
for i in $(seq 1 20); do
  curl -fs "$BACKEND/api/health" >/dev/null 2>&1 && break
  [ "$i" = 20 ] && fail "Backend nepakilo. Logai: /tmp/stenograma-demo-backend.log"
  sleep 0.5
done
check "Backend paleistas ($BACKEND)"

# --- 2. Testinis WAV ---
TMP_WAV=$(mktemp --suffix=.wav)
trap 'cleanup; rm -f "$TMP_WAV"' EXIT
if command -v ffmpeg >/dev/null 2>&1; then
  ffmpeg -f lavfi -i "sine=frequency=440:duration=2" -ar 16000 -ac 1 "$TMP_WAV" -y >/dev/null 2>&1
else
  # Minimalus validus WAV (44 baitų header), jei ffmpeg nėra.
  printf 'RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x80\x3e\x00\x00\x00\x7d\x00\x00\x02\x00\x10\x00data\x00\x00\x00\x00' > "$TMP_WAV"
fi

# --- 3. Upload + transkripcija (async job + polling) ---
step "siunčiu audio į /api/transcribe-jobs…"
CREATE=$(curl -fs -X POST "$BACKEND/api/transcribe-jobs" -F "audio=@$TMP_WAV" -F "language=lt") \
  || fail "Upload nepavyko."
JOB_ID=$(echo "$CREATE" | grep -o '"jobId":"[^"]*"' | cut -d'"' -f4)
[ -n "$JOB_ID" ] || fail "Negautas jobId."
check "Upload — audio priimtas (job $JOB_ID)"

step "laukiu transkripcijos…"
TRANSCRIPT=""
for i in $(seq 1 40); do
  RESP=$(curl -fs "$BACKEND/api/transcribe-jobs/$JOB_ID")
  STATUS=$(echo "$RESP" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ "$STATUS" = "completed" ]; then
    TRANSCRIPT=$(echo "$RESP" | grep -o '"text":"[^"]*"' | head -1 | cut -d'"' -f4)
    break
  fi
  [ "$STATUS" = "failed" ] && fail "Transkripcija nepavyko: $RESP"
  sleep 0.5
done
[ -n "$TRANSCRIPT" ] || fail "Transkripcija nebaigta laiku."
check "Transcription — \"$(echo "$TRANSCRIPT" | cut -c1-45)…\""

# --- 4. Protokolo generavimas (LLM) ---
step "generuoju protokolą per /api/jobs (mock LLM)…"
PCREATE=$(curl -fs -X POST "$BACKEND/api/jobs" -H "Content-Type: application/json" \
  -d "{\"title\":\"Demo posėdis\",\"transcript\":\"$TRANSCRIPT Aptartas biudžetas. Nuspręsta patvirtinti planą.\"}") \
  || fail "Protokolo jobas nepavyko."
PJOB_ID=$(echo "$PCREATE" | grep -o '"jobId":"[^"]*"' | cut -d'"' -f4)
check "LLM — užklausa priimta (job $PJOB_ID)"

step "laukiu protokolo…"
PROTOCOL_OK=false
for i in $(seq 1 40); do
  RESP=$(curl -fs "$BACKEND/api/jobs/$PJOB_ID")
  STATUS=$(echo "$RESP" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ "$STATUS" = "completed" ]; then PROTOCOL_OK=true; break; fi
  [ "$STATUS" = "failed" ] && fail "Protokolas nepavyko: $RESP"
  sleep 0.5
done
[ "$PROTOCOL_OK" = true ] || fail "Protokolas nebaigtas laiku."
check "Protocol generated — struktūrizuotas protokolas paruoštas"

# --- 5. Rezultatas ---
echo ""
echo -e "${GREEN}${BOLD}System ready.${NC}"
echo -e "${DIM}Pilnas srautas (upload → transcription → LLM → protocol) veikia su mock provideriais.${NC}"
echo -e "${DIM}Toliau: 'make dev' (backend+frontend naršyklėje) arba 'make quickstart-cpu/gpu' realiems provideriams.${NC}"
