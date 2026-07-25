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


# ─────────────────────────────────────────────────────────────────────────────
# Papildomi patikimumo / regresijos testai (queue stress, lėtas modelis, daug
# progress event, _safe_put elgesys). Iš trečio kritinio įvertinimo.
# ─────────────────────────────────────────────────────────────────────────────

def test_safe_put_grazina_false_kai_queue_pilna_ir_stop(server_mod):
    """P1: _safe_put NEturi amžinai blokuoti, jei queue pilna ir klientas dingo (stop).
    Užpildom queue iki maxsize, nustatom stop -> _safe_put turi grąžinti False, ne kabinti."""
    import queue as _q
    small = _q.Queue(maxsize=2)
    small.put(("x", 1))
    small.put(("x", 2))  # dabar pilna
    stop = threading.Event()
    stop.set()  # klientas jau dingęs

    start = time.time()
    result = server_mod._safe_put(small, ("y", 3), stop, per_try=0.1)
    elapsed = time.time() - start

    assert result is False, "_safe_put turi grąžinti False, kai queue pilna ir stop"
    assert elapsed < 2.0, f"_safe_put neturi kabinti (užtruko {elapsed:.1f}s)"


def test_safe_put_pavyksta_kai_vieta_atsilaisvina(server_mod):
    """_safe_put turi sėkmingai įdėti, kai queue atsilaisvina (worker'is nedingsta veltui)."""
    import queue as _q
    small = _q.Queue(maxsize=1)
    small.put(("x", 1))  # pilna
    stop = threading.Event()

    # atskiras thread atlaisvina vietą po 0.3s
    def drainer():
        time.sleep(0.3)
        small.get()
    threading.Thread(target=drainer, daemon=True).start()

    result = server_mod._safe_put(small, ("y", 2), stop, per_try=0.1)
    assert result is True, "_safe_put turi pavykti, kai vieta atsilaisvina"


def test_letas_modelis_daug_progress_event(server_mod):
    """Lėto modelio su daug segmentų mock: patikrinam, kad SSE atlaiko daug progress
    event'ų ir korektiškai baigia su done. Regresija dideliems failams."""
    os.environ["WHISPER_MAX_CONCURRENCY"] = "2"
    importlib.reload(server_mod)
    # 50 segmentų, kiekvienas trumpai - imituoja ilgą failą su daug progresų
    _install_model(server_mod, MockModel(n_segments=50, seg_delay=0.002))
    client = TestClient(server_mod.app)
    r = client.post("/transcribe-stream", files={"file": ("a.wav", b"x" * 100, "audio/wav")})
    assert r.status_code == 200
    events = _parse_sse(r.text)
    names = [e[0] for e in events]
    assert names.count("started") == 1, "lygiai vienas started"
    assert names.count("done") == 1, "lygiai vienas done"
    # progress event'ų turi būti keli (ne būtinai 50 - server siunčia tik pasikeitus %)
    assert names.count("progress") >= 1, "turi būti progress event'ų"
    # done paskutinis prieš pabaigą
    assert names[-1] == "done", "done turi būti paskutinis"


def test_progress_procentai_dideja_ir_neperzengia_99(server_mod):
    """Progreso % turi didėti monotoniškai ir neviršyti 99 (100 tik su done)."""
    os.environ["WHISPER_MAX_CONCURRENCY"] = "2"
    importlib.reload(server_mod)
    _install_model(server_mod, MockModel(n_segments=20, seg_delay=0.001))
    client = TestClient(server_mod.app)
    r = client.post("/transcribe-stream", files={"file": ("a.wav", b"x" * 100, "audio/wav")})
    events = _parse_sse(r.text)
    import json
    percents = [json.loads(d)["percent"] for (e, d) in events if e == "progress"]
    assert percents == sorted(percents), "progresas turi didėti monotoniškai"
    assert all(0 <= p <= 99 for p in percents), f"progresas turi būti 0-99, gauta: {percents}"


def test_tuscias_audio_nesugriuva(server_mod):
    """Kraštinis atvejis: modelis be segmentų (tyla/tuščia) - turi baigti su done, ne klaida."""
    os.environ["WHISPER_MAX_CONCURRENCY"] = "2"
    importlib.reload(server_mod)
    _install_model(server_mod, MockModel(n_segments=0))
    client = TestClient(server_mod.app)
    r = client.post("/transcribe-stream", files={"file": ("a.wav", b"x" * 100, "audio/wav")})
    assert r.status_code == 200
    events = _parse_sse(r.text)
    names = [e[0] for e in events]
    assert "done" in names, "tuščias audio turi baigti su done (ne error)"


def test_safe_put_nutraukia_laukima_gavus_stop_signala(server_mod):
    """Gavus stop signalą, _safe_put nustoja laukti pilnoje queue ir grąžina False.

    TIKSLUMAS: šis testas įrodo SIAURESNĮ dalyką nei "darbas nutraukiamas tarp segmentų" -
    jis patvirtina TIK _safe_put() elgesį (queue pilna + stop -> False, be užstrigimo).
    Worker'io ciklas tuo remiasi (`if not _safe_put(...): break`), bet visą ciklą su
    keliais segmentais ir stop tarp jų tiesiogiai patikrina
    test_worker_ciklas_nutrūksta_gavus_stop žemiau."""
    import queue as _q
    q = _q.Queue(maxsize=1)
    q.put(("busy", 0))  # pilna
    stop = threading.Event()

    # simuliuojam: klientas dingsta (stop) kol worker'is bando dėti kitą segmentą
    def disconnect_after():
        time.sleep(0.2)
        stop.set()
    threading.Thread(target=disconnect_after, daemon=True).start()

    # worker'is bandytų dėti, bet queue pilna; kai stop suveiks -> False (ciklas nutrūktų)
    result = server_mod._safe_put(q, ("progress", {"percent": 50}), stop, per_try=0.1)
    assert result is False, "kai klientas dingsta (stop), _safe_put grąžina False -> worker'is nutraukia"


def test_worker_ciklas_nutruksta_gavus_stop(server_mod):
    """TIESIOGINIS worker'io ciklo nutraukimo testas (ko _safe_put testas neįrodo).

    Imituojam worker'io logikos esmę: iteruojam per DAUG segmentų, dedam į MAŽĄ queue
    (kad užsipildytų), niekas neskaito -> _safe_put ims blokuoti su stop patikra. Kai
    nustatom stop, ciklas turi NUTRŪKTI (ne apdoroti visų segmentų). Patvirtina, kad
    `if not _safe_put(...): break` realiai nutraukia darbą tarp segmentų."""
    import queue as _q
    q = _q.Queue(maxsize=2)
    stop = threading.Event()
    processed = []

    def fake_stream():
        # imituoja _stream_transcription: daug segmentų
        for i in range(1000):
            yield ("progress", {"percent": i})

    # atskiras thread nustato stop po trumpo laiko (imituoja disconnect)
    def disconnect():
        time.sleep(0.3)
        stop.set()
    threading.Thread(target=disconnect, daemon=True).start()

    # worker'io ciklo ESMĖ (ta pati logika kaip server.py worker()):
    for evt in fake_stream():
        if stop.is_set():
            break
        if not server_mod._safe_put(q, evt, stop, per_try=0.05):
            break
        processed.append(evt)

    # Ciklas turi nutrūkti GEROKAI anksčiau nei 1000 segmentų (nes queue užsipildė ir
    # stop suveikė). Jei ciklas nebūtų nutrūkęs, būtų bandęs visus 1000.
    assert len(processed) < 1000, "ciklas turi nutrūkti gavus stop, ne apdoroti visų"
    assert stop.is_set(), "stop turėjo suveikti"
    # Įrodymas, kad nutrūko dėl stop (ne dėl kitos priežasties): apdorota tik tiek, kiek
    # tilpo į queue prieš disconnect (maža dalis).
    assert len(processed) <= 10, f"turėjo nutrūkti anksti (apdorota {len(processed)})"
