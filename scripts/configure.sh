#!/usr/bin/env bash
# Stenograma - interaktyvus .env konfigūratorius.
# Užduoda kelis klausimus ir sugeneruoja tinkamą backend/.env - kad ne techniniam
# vartotojui (pvz. sekretorei) nereikėtų suprasti visų .env.example kintamųjų.
#
# Naudojimas:  ./scripts/configure.sh      (interaktyvus)
#              make configure
#
# Neinteraktyviai (CI/testams) galima perduoti pasirinkimus per aplinką:
#   MODE=1 LLM_CHOICE=1 ./scripts/configure.sh --non-interactive
set -e

cd "$(dirname "$0")/.."   # projekto šaknis

ENV_FILE="backend/.env"
say()  { echo -e "\033[1;34m[configure]\033[0m $1"; }
warn() { echo -e "\033[1;33m[configure] ⚠️ \033[0m $1"; }

NON_INTERACTIVE=false
[ "${1:-}" = "--non-interactive" ] && NON_INTERACTIVE=true

ask() {
  # ask "klausimas" "env_var_su_numatytu" -> echo pasirinkimą
  local prompt="$1" envvar="$2" default_val="$3"
  if [ "$NON_INTERACTIVE" = true ]; then
    echo "${!envvar:-$default_val}"
  else
    local answer
    read -r -p "$prompt" answer
    echo "${answer:-$default_val}"
  fi
}

if [ -f "$ENV_FILE" ] && [ "$NON_INTERACTIVE" = false ]; then
  read -r -p "$ENV_FILE jau egzistuoja. Perrašyti? [y/N] " confirm
  [ "$confirm" = "y" ] || { say "Atšaukta - $ENV_FILE nekeistas."; exit 0; }
fi

echo ""
say "=== Stenograma konfigūravimas ==="
echo "Kurį transkripcijos režimą norite naudoti?"
echo "  1) Demo be API raktų (mock - veikia iš karto)"
echo "  2) Lokalus Whisper CPU (faster-whisper-embedded)"
echo "  3) Lokalus Whisper GPU + pyannote diarizacija"
echo "  4) Cloud transcription API (Deepgram/Azure/OpenAI)"
MODE=$(ask "Pasirinkimas [1]: " MODE "1")

echo ""
echo "Kurį LLM protokolo generavimui?"
echo "  1) Mock (be raktų, demo)"
echo "  2) Claude (Anthropic)"
echo "  3) OpenAI (GPT)"
echo "  4) Gemini (Google)"
LLM_CHOICE=$(ask "Pasirinkimas [1]: " LLM_CHOICE "1")

# --- Atvaizduojame pasirinkimus į env reikšmes ---
case "$MODE" in
  1) TRANSCRIPTION_PROVIDER="mock"; DIARIZATION_PROVIDER="none"; FW_DEVICE="" ;;
  2) TRANSCRIPTION_PROVIDER="faster-whisper-embedded"; DIARIZATION_PROVIDER="none"; FW_DEVICE="cpu" ;;
  3) TRANSCRIPTION_PROVIDER="faster-whisper-embedded"; DIARIZATION_PROVIDER="pyannote"; FW_DEVICE="cuda" ;;
  4) TRANSCRIPTION_PROVIDER="deepgram"; DIARIZATION_PROVIDER="none"; FW_DEVICE="" ;;
  *) warn "Nežinomas režimas '$MODE' - naudoju mock."; TRANSCRIPTION_PROVIDER="mock"; DIARIZATION_PROVIDER="none"; FW_DEVICE="" ;;
esac

case "$LLM_CHOICE" in
  1) LLM_PROVIDER="mock" ;;
  2) LLM_PROVIDER="claude" ;;
  3) LLM_PROVIDER="gpt" ;;
  4) LLM_PROVIDER="gemini" ;;
  *) warn "Nežinomas LLM '$LLM_CHOICE' - naudoju mock."; LLM_PROVIDER="mock" ;;
esac

# --- Generuojame .env ---
{
  echo "# Sugeneruota ./scripts/configure.sh $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "PORT=3001"
  echo "NODE_ENV=development"
  echo "CORS_ORIGIN=http://localhost:5173"
  echo ""
  echo "TRANSCRIPTION_PROVIDER=$TRANSCRIPTION_PROVIDER"
  echo "DIARIZATION_PROVIDER=$DIARIZATION_PROVIDER"
  echo "LLM_PROVIDER=$LLM_PROVIDER"
  echo "PROMPT_VERSION=meeting_v3"
  echo ""
  if [ "$FW_DEVICE" = "cpu" ]; then
    echo "FASTER_WHISPER_MODEL=small"
    echo "FASTER_WHISPER_DEVICE=cpu"
    echo "FASTER_WHISPER_COMPUTE_TYPE=int8"
  elif [ "$FW_DEVICE" = "cuda" ]; then
    echo "FASTER_WHISPER_MODEL=small"
    echo "FASTER_WHISPER_DEVICE=cuda"
    echo "FASTER_WHISPER_COMPUTE_TYPE=float16"
    echo "FASTER_WHISPER_MAX_CONCURRENCY=1"
    echo "PYANNOTE_URL=http://localhost:8001/diarize"
  fi
  echo ""
  echo "MAX_UPLOAD_MB=500"
  # Raktų vietos - vartotojas užpildys (nekeliame jų į interaktyvų klausimą, kad
  # nepatektų į terminalo istoriją; palikti tušti ir aiškiai pažymėti).
  [ "$LLM_PROVIDER" = "claude" ] && echo "ANTHROPIC_API_KEY=   # <- ĮRAŠYKITE savo raktą"
  [ "$LLM_PROVIDER" = "gpt" ]    && echo "OPENAI_API_KEY=      # <- ĮRAŠYKITE savo raktą"
  [ "$LLM_PROVIDER" = "gemini" ] && echo "GOOGLE_API_KEY=      # <- ĮRAŠYKITE savo raktą"
  [ "$TRANSCRIPTION_PROVIDER" = "deepgram" ] && echo "DEEPGRAM_API_KEY=    # <- ĮRAŠYKITE savo raktą"
  [ "$DIARIZATION_PROVIDER" = "pyannote" ] && echo "# HUGGINGFACE_TOKEN įrašykite į ŠAKNINĮ .env (ne čia) - jį skaito Compose ir preflight"
} > "$ENV_FILE"

say "Sukurtas $ENV_FILE:"
echo "  Transkripcija: $TRANSCRIPTION_PROVIDER${FW_DEVICE:+ ($FW_DEVICE)}"
echo "  Diarizacija:   $DIARIZATION_PROVIDER"
echo "  LLM:           $LLM_PROVIDER"

if grep -q "ĮRAŠYKITE" "$ENV_FILE"; then
  echo ""
  warn "Nepamirškite įrašyti API rakto(-ų) faile $ENV_FILE (pažymėta 'ĮRAŠYKITE')."
fi
if [ "$DIARIZATION_PROVIDER" = "pyannote" ]; then
  warn "GPU+diarizacijai: paleiskite 'make setup-gpu' ir įrašykite HUGGINGFACE_TOKEN"
  warn "  į šakninį .env (cp .env.example .env) - tada nereikės eksportuoti kas sesiją."
fi
