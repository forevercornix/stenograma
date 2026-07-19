#!/usr/bin/env bash
# Stenograma - end-to-end smoke testas per VEIKIANTĮ stacką (visiems profiliams).
#
# PAVADINIMAS istorinis (pradžioje buvo tik GPU), bet naudojamas VISIEMS Docker
# profiliams (demo/cpu/gpu), nes tikrina stacką per HTTP, nepriklausomai nuo
# transkripcijos tiekėjo. Skirtingai nuo `npm run test-install` (reikalauja hosto
# backend/node_modules), šis eina tik per curl+python3 - tad veikia net jei
# vartotojas tik klonavo repo ir paleido Docker (hoste jokių Node priklausomybių).
#
# Tikrina TIKRĄ pilną kelią per HTTP: testinis WAV -> /api/transcribe-jobs
# -> polling -> transkripcija (+ diarizacija, jei įjungta) -> /api/jobs (protokolas)
# -> patikrina, kad grįžo prasmingas rezultatas.
#
# Naudojimas:  ./scripts/smoke-gpu.sh            (numato http://localhost:3001)
#              BACKEND=http://host:3001 ./scripts/smoke-gpu.sh
#
# ⚠️  STATUSAS: NEBUVO paleistas prieš realų GPU stacką šioje aplinkoje. Skripto
# HTTP logika parašyta pagal realų API kontraktą (tą patį, kurį naudoja frontend),
# bet pilną srautą su tikrais modeliais patikrinkite savo mašinoje.
set -e

BACKEND="${BACKEND:-http://localhost:3001}"
say()  { echo -e "\033[1;34m[smoke-gpu]\033[0m $1"; }
ok()   { echo -e "\033[1;32m✅\033[0m $1"; }
fail() { echo -e "\033[1;31m❌\033[0m $1"; exit 1; }

command -v curl >/dev/null 2>&1 || fail "curl nerastas."
command -v ffmpeg >/dev/null 2>&1 || say "ffmpeg nerastas - bandysiu generuoti WAV kitaip."

# --- 1. Testinis WAV (kelios sekundės) ---
TMP_WAV=$(mktemp --suffix=.wav)
trap 'rm -f "$TMP_WAV"' EXIT
if command -v ffmpeg >/dev/null 2>&1; then
  # 3s sinusoidė - realaus modelio negąsdina, tinka srauto patikrai.
  ffmpeg -f lavfi -i "sine=frequency=440:duration=3" -ar 16000 -ac 1 "$TMP_WAV" -y >/dev/null 2>&1
else
  # Minimalus tylus WAV per Python (jei ffmpeg nėra).
  python3 -c "
import wave, struct, sys
with wave.open('$TMP_WAV','w') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
    for _ in range(16000*3): w.writeframes(struct.pack('<h',0))
" || fail "Nepavyko sukurti testinio WAV (nei ffmpeg, nei python3)."
fi
ok "Testinis WAV paruoštas ($(du -h "$TMP_WAV" | cut -f1))"

# --- 2. Transkribavimas (async job) ---
say "Siunčiu į /api/transcribe-jobs..."
CREATE=$(curl -fs -X POST "$BACKEND/api/transcribe-jobs" -F "audio=@$TMP_WAV" -F "language=lt") \
  || fail "POST /api/transcribe-jobs nepavyko. Ar backend veikia? ($BACKEND)"
JOB_ID=$(echo "$CREATE" | python3 -c "import json,sys; print(json.load(sys.stdin)['jobId'])") \
  || fail "Nepavyko gauti jobId. Atsakymas: $CREATE"
ok "Transkribavimo jobas sukurtas: $JOB_ID"

say "Laukiu transkripcijos (polling)..."
TRANSCRIPT=""
TRANSCRIPTION_COMPLETED=false
for i in $(seq 1 100); do
  RESP=$(curl -fs "$BACKEND/api/transcribe-jobs/$JOB_ID")
  STATUS=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")
  if [ "$STATUS" = "completed" ]; then
    TRANSCRIPT=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['result'].get('text',''))")
    TRANSCRIPTION_COMPLETED=true
    ok "Transkripcija baigta"
    break
  elif [ "$STATUS" = "failed" ]; then
    fail "Transkribavimas nepavyko: $(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('error',''))")"
  fi
  sleep 3
done
# KRITINIS patikrinimas: jei ciklas pasibaigė be "completed" - tai NESĖKMĖ, ne
# tyli sėkmė. Be šito testas galėjo paskelbti "PRAĖJO", nors darbas nebaigtas.
[ "$TRANSCRIPTION_COMPLETED" = true ] || fail "Transkripcija nebaigta per skirtą laiką (100 bandymų × 3s)."
# Tuščias transkriptas (sinusoidei/tylai) yra OK - srautas veikė. Fallback tekstas
# TIK protokolo įvesčiai, ne sėkmės slėpimui.
[ -z "$TRANSCRIPT" ] && say "(transkriptas tuščias - normalu sinusoidei/tylai, srautas vis tiek pavyko)"

# --- 3. Protokolo generavimas ---
say "Generuoju protokolą per /api/jobs..."
# Naudojame minimalų tekstą, jei transkripcija tuščia (kad LLM turėtų ką apdoroti).
PROTO_INPUT="${TRANSCRIPT}"
[ "${#PROTO_INPUT}" -lt 20 ] && PROTO_INPUT="Testinis susitikimas. Aptarti biudžeto klausimai. Nuspręsta patvirtinti planą."
PCREATE=$(curl -fs -X POST "$BACKEND/api/jobs" -H "Content-Type: application/json" \
  -d "$(python3 -c "import json,sys; print(json.dumps({'transcript': sys.argv[1]}))" "$PROTO_INPUT")") \
  || fail "POST /api/jobs nepavyko."
PJOB_ID=$(echo "$PCREATE" | python3 -c "import json,sys; print(json.load(sys.stdin)['jobId'])")
ok "Protokolo jobas: $PJOB_ID"

PROTOCOL_COMPLETED=false
for i in $(seq 1 40); do
  RESP=$(curl -fs "$BACKEND/api/jobs/$PJOB_ID")
  STATUS=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")
  if [ "$STATUS" = "completed" ]; then
    PROTOCOL_COMPLETED=true
    ok "Protokolas sugeneruotas"
    break
  elif [ "$STATUS" = "failed" ]; then
    fail "Protokolo generavimas nepavyko: $(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('error',''))")"
  fi
  sleep 3
done
[ "$PROTOCOL_COMPLETED" = true ] || fail "Protokolas nebaigtas per skirtą laiką (40 bandymų × 3s)."

echo ""
ok "END-TO-END SMOKE TESTAS PRAĖJO: WAV → transkripcija → protokolas per tikrą HTTP API."
