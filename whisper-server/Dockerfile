# syntax=docker/dockerfile:1.7
# Persistentus faster-whisper serveris (CPU).
# Modelis įkeliamas VIENĄ kartą paleidžiant, laikomas atmintyje tarp užklausų.
# GPU variantas - žr. Dockerfile.gpu.
FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

COPY requirements-cpu.lock.txt ./
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements-cpu.lock.txt

COPY server.py ./

ENV PORT=8000
ENV WHISPER_MODEL=small
ENV WHISPER_DEVICE=cpu
ENV WHISPER_COMPUTE_TYPE=int8
EXPOSE 8000

CMD ["python", "server.py"]
