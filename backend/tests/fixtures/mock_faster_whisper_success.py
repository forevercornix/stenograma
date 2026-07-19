#!/usr/bin/env python3
"""
Simuliuoja faster_whisper_transcribe.py sėkmingą atsakymą, NENAUDOJANT tikros
faster-whisper bibliotekos ar modelio - tam, kad Node pusės subprocess
orkestracija (FasterWhisperEmbeddedProvider.js) būtų testuojama be tinklo
prieigos prie huggingface.co (kuri šioje aplinkoje blokuojama).

Priima TĄ PATĮ CLI kontraktą kaip tikras skriptas (audio_path + --model/--device/
--compute-type/--language), kad testas patikrintų, jog Node pusė teisingai
sudaro argumentus.
"""
import argparse
import json
import sys
import os

parser = argparse.ArgumentParser()
parser.add_argument("audio_path")
parser.add_argument("--model", default="small")
parser.add_argument("--device", default="cpu")
parser.add_argument("--compute-type", default="int8")
parser.add_argument("--language", default=None)
args = parser.parse_args()

# Patikriname, kad Node pusė TIKRAI perdavė egzistuojantį failo kelią (t.y. kad
# audio buferis realiai buvo įrašytas į laikiną failą prieš paleidžiant procesą).
if not os.path.exists(args.audio_path):
    print(json.dumps({"error": f"audio_path neegzistuoja: {args.audio_path}"}))
    sys.exit(1)

result = {
    "text": f"Mock transkripcija (modelis={args.model}, device={args.device}, kalba={args.language or 'auto'})",
    "segments": [
        {"start": 0.0, "end": 2.5, "text": "Pirmas mock segmentas."},
        {"start": 2.5, "end": 5.0, "text": "Antras mock segmentas."},
    ],
    "language": args.language or "lt",
    "confidence": 0.95,
}
print(json.dumps(result))
