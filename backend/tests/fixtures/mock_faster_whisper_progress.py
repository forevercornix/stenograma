#!/usr/bin/env python3
import argparse
import json
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument("audio_path")
parser.add_argument("--model", default="small")
parser.add_argument("--device", default="cpu")
parser.add_argument("--compute-type", default="int8")
parser.add_argument("--language", default=None)
args = parser.parse_args()

total = 30.0
for current in (10.0, 20.0, 30.0):
    print(f"PROGRESS:{json.dumps({'current': current, 'total': total})}", file=sys.stderr, flush=True)
    time.sleep(0.05)

print(json.dumps({"text": "mock su progresu", "segments": [], "language": "lt", "confidence": 1.0}))
