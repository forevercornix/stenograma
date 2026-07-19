# syntax=docker/dockerfile:1.7
# Pyannote diarizacijos serveris.
#
# CPU variantas (numatytas): veikia bet kur, bet 4 val. įrašo diarizacija CPU gali
# užtrukti labai ilgai. GPU variantui - žr. komentarą apačioje.
FROM python:3.11-slim

WORKDIR /app

# ffmpeg - pyannote/torchaudio audio dekodavimui.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

COPY requirements-cpu.lock.txt ./
# CPU torch (mažesnis, be CUDA), užfiksuotos versijos. GPU atveju - žr. Dockerfile.gpu.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install torch==2.5.1 --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir -r requirements-cpu.lock.txt

COPY server.py ./

ENV PORT=8001
EXPOSE 8001

CMD ["python", "server.py"]

# ─────────────────────────────────────────────────────────────────────────
# GPU VARIANTAS (žymiai greitesnis dideliems įrašams):
# Vietoj `FROM python:3.11-slim` naudokite CUDA bazinį image ir GPU torch, pvz.:
#
#   FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04
#   RUN apt-get update && apt-get install -y python3 python3-pip ffmpeg
#   RUN pip install torch --index-url https://download.pytorch.org/whl/cu124
#   ... (likusi dalis ta pati)
#
# Ir paleisdami perduokite GPU: `docker run --gpus all ...` arba compose
# `deploy.resources.reservations.devices` (žr. docker-compose.gpu.yml).
# ─────────────────────────────────────────────────────────────────────────
