"""
SSE /transcribe-stream integraciniai testai su MOCK modeliu (be GPU/faster-whisper).

Tikrina Python serverio pusę, kurios Node mock-testai NEpasiekia:
  - bendras concurrency limitas (/transcribe + /transcribe-stream kartu);
  - semaforo atlaisvinimas po klaidos;
  - temp failo valymas (worker'is trina, ne per anksti);
  - started/progress/done event kontraktas;
  - queue timeout / eilės laukimas.

Mock modelis imituoja faster-whisper: transcribe() grąžina (segmentai, info) su
kontroliuojama delsa, kad galėtume testuoti lygiagretumą.
"""
import os
import time
import threading
import importlib

import pytest
from fastapi.testclient import TestClient


class _Seg:
    def __init__(self, start, end, text):
        self.start = start
        self.end = end
        self.text = text
        self.avg_logprob = -0.2


class _Info:
    def __init__(self, duration=10.0, language="lt"):
        self.duration = duration
        self.language = language


class MockModel:
    """Imituoja faster-whisper modelį. seg_delay - delsa tarp segmentų (lygiagretumui)."""
    def __init__(self, n_segments=3, seg_delay=0.0):
        self.n_segments = n_segments
        self.seg_delay = seg_delay
        self.active = 0
        self.max_active = 0
        self._lock = threading.Lock()

    def transcribe(self, audio_path, **kwargs):
        with self._lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)

        def gen():
            try:
                for i in range(self.n_segments):
                    if self.seg_delay:
                        time.sleep(self.seg_delay)
                    yield _Seg(float(i), float(i + 1), f"seg{i}")
            finally:
                with self._lock:
                    self.active -= 1

        return gen(), _Info(duration=float(self.n_segments))


@pytest.fixture
def server_mod():
    import server
    importlib.reload(server)
    return server


def _install_model(server, model):
    server._model = model
    server._load_error = None
    # apeinam _get_model lazy-load
    server._get_model = lambda: (model, None)


def _parse_sse(text):
    """Grąžina event'ų sąrašą [(event, data_str), ...]."""
    events = []
    for block in text.split("\n\n"):
        if not block.strip():
            continue
        ev, data = "message", ""
        for line in block.split("\n"):
            if line.startswith("event:"):
                ev = line[6:].strip()
            elif line.startswith("data:"):
                data += line[5:].strip()
        events.append((ev, data))
    return events


def test_stream_kontraktas_started_progress_done(server_mod):
    _install_model(server_mod, MockModel(n_segments=3))
    client = TestClient(server_mod.app)
    r = client.post("/transcribe-stream", files={"file": ("a.wav", b"x" * 100, "audio/wav")})
    assert r.status_code == 200
    events = _parse_sse(r.text)
    names = [e[0] for e in events]
    assert "started" in names, "turi būti 'started' event"
    assert "progress" in names, "turi būti bent vienas progress"
    assert "done" in names, "turi būti done"
    # done turi turėti tekstą
    done = [d for (e, d) in events if e == "done"][0]
    assert "seg0" in done


def test_stream_temp_failas_istrinamas_po_darbo(server_mod, tmp_path):
    _install_model(server_mod, MockModel(n_segments=2))
    client = TestClient(server_mod.app)
    # suskaičiuojam temp failus prieš ir po
    import tempfile
    tdir = tempfile.gettempdir()
    before = set(os.listdir(tdir))
    r = client.post("/transcribe-stream", files={"file": ("a.wav", b"x" * 100, "audio/wav")})
    assert r.status_code == 200
    # worker daemon thread gali dar valyti - duodam trumpą laiką
    time.sleep(0.5)
    after = set(os.listdir(tdir))
    leaked = [f for f in (after - before) if f.endswith(".wav") or "tmp" in f]
    assert not leaked, f"temp failai neišvalyti: {leaked}"


def test_bendras_concurrency_limitas(server_mod):
    """KRITINIS (P1): /transcribe ir /transcribe-stream dalijasi VIENĄ semaforą.
    Su MAX_CONCURRENCY=1 du lygiagretūs kvietimai NEturi veikti vienu metu."""
    os.environ["WHISPER_MAX_CONCURRENCY"] = "1"
    importlib.reload(server_mod)
    model = MockModel(n_segments=3, seg_delay=0.15)  # lėti segmentai
    _install_model(server_mod, model)
    client = TestClient(server_mod.app)

    results = []

    def call_stream():
        r = client.post("/transcribe-stream", files={"file": ("a.wav", b"x" * 100, "audio/wav")})
        results.append(r.status_code)

    def call_regular():
        r = client.post("/transcribe", files={"file": ("b.wav", b"x" * 100, "audio/wav")})
        results.append(r.status_code)

    t1 = threading.Thread(target=call_stream)
    t2 = threading.Thread(target=call_regular)
    t1.start(); t2.start()
    t1.join(); t2.join()

    # Su bendru limitu=1, max_active NIEKADA neturi viršyti 1.
    assert model.max_active <= 1, f"concurrency limitas pažeistas: max_active={model.max_active} (turi būti <=1)"
    os.environ["WHISPER_MAX_CONCURRENCY"] = "2"


def test_semaforas_atlaisvinamas_po_klaidos(server_mod):
    """Jei transcribe meta klaidą, semaforas turi būti atlaisvintas (kitaip užsirakintų)."""
    os.environ["WHISPER_MAX_CONCURRENCY"] = "1"
    importlib.reload(server_mod)

    class FailingModel:
        def transcribe(self, path, **kw):
            raise RuntimeError("modelio klaida")

    _install_model(server_mod, FailingModel())
    client = TestClient(server_mod.app)

    # pirmas kvietimas - klaida (bet semaforas turi atsilaisvinti)
    r1 = client.post("/transcribe-stream", files={"file": ("a.wav", b"x" * 100, "audio/wav")})
    events = _parse_sse(r1.text)
    assert any(e == "error" for (e, _) in events), "turi būti error event"

    # antras kvietimas - jei semaforas neatsilaisvino, šis pakibtų/timeout'intų.
    # Naudojam veikiantį modelį.
    _install_model(server_mod, MockModel(n_segments=1))
    r2 = client.post("/transcribe-stream", files={"file": ("a.wav", b"x" * 100, "audio/wav")})
    events2 = _parse_sse(r2.text)
    assert any(e == "done" for (e, _) in events2), "antras kvietimas turi pavykti (semaforas atsilaisvino)"
    os.environ["WHISPER_MAX_CONCURRENCY"] = "2"
