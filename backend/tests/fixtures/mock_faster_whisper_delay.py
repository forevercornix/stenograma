#!/usr/bin/env python3
import argparse
import json
import time

parser = argparse.ArgumentParser()
parser.add_argument("audio_path")
parser.add_argument("--model", default="small")
parser.add_argument("--device", default="cpu")
parser.add_argument("--compute-type", default="int8")
parser.add_argument("--language", default=None)
args = parser.parse_args()

time.sleep(0.15)  # simuliuoja transkribavimo trukmę, kad būtų galima matuoti persidengimą
print(json.dumps({"text": "delayed mock", "segments": [], "language": "lt", "confidence": 1.0}))
