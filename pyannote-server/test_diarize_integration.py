"""
Pyannote serverio INTEGRACINIS testas su MOCK pipeline.

KODĖL TAI SVARBU: šis testas realiai paleidžia FastAPI serverį, įkelia audio
failą per POST /diarize ir validuoja {turns: [...]} kontraktą END-TO-END - be
gated pyannote modelio ir be GPU (naudoja mock pipeline). BŪTENT toks testas būtų
anksčiau pagavęs pagrindinę problemą, dėl kurios vartotojui nepavyko diarizacija:
backend'o provideris egzistavo, o serverio realizacijos APSKRITAI NEBUVO. Kontrakto
testas (mock) tikrina, kad serveris grąžina TIKSLIAI tą formatą, kurio tikisi
backend'o PyannoteDiarizationProvider (turns su start/end/speaker).

Du lygiai (kaip vartotojas siūlė):
  1. NEMOKAMAS kontrakto testas su mock pipeline - ČIA (veikia CI'e, be tokeno/GPU).
  2. Pasirenkamas realus GPU testas su HF tokenu - žr. test_real_gpu.py (skip be tokeno).

Paleidimas:  pytest test_diarize_integration.py -v
"""
import pytest
from fastapi.testclient import TestClient


class _MockAnnotation:
    """Imituoja pyannote diarization rezultatą - itertracks(yield_label=True)
    grąžina (segment, track, speaker) trejetus, kaip tikras pyannote.core.Annotation."""

    class _Segment:
        def __init__(self, start, end):
            self.start = start
            self.end = end

    def __init__(self, turns):
        self._turns = turns  # sąrašas (start, end, speaker)

    def itertracks(self, yield_label=False):
        for i, (start, end, speaker) in enumerate(self._turns):
            seg = self._Segment(start, end)
            if yield_label:
                yield seg, f"_{i}", speaker
            else:
                yield seg, f"_{i}"


class _MockPipeline:
    """Imituoja pyannote Pipeline - iškviečiamas su audio keliu, grąžina Annotation.
    Fiksuoti duomenys, kad testas būtų deterministinis (jokio realaus modelio)."""

    def __init__(self, turns=None):
        # SVARBU: negalima `turns or [...]`, nes tuščias sąrašas [] yra falsy ir
        # būtų pakeistas numatytais - o mums reikia leisti EKSPLICITIŠKAI tuščią
        # (tylos/be kalbėtojų atvejis). Todėl tikriname `is None`.
        if turns is None:
            turns = [
                (0.0, 2.5, "SPEAKER_00"),
                (2.5, 5.0, "SPEAKER_01"),
                (5.0, 7.3, "SPEAKER_00"),
            ]
        self._turns = turns
        self.last_call_kwargs = None

    def __call__(self, audio_path, **kwargs):
        self.last_call_kwargs = kwargs
        return _MockAnnotation(self._turns)


@pytest.fixture
def client_with_mock():
    """TestClient su įdėtu mock pipeline - /diarize veikia be gated modelio."""
    import server
    mock = _MockPipeline()
    server._pipeline = mock
    server._load_error = None
    client = TestClient(server.app)
    yield client, mock
    # Išvalom po testo, kad neveiktų kitų testų.
    server._pipeline = None
    server._load_error = None


def test_diarize_grazina_teisinga_turns_kontrakta(client_with_mock):
    client, _mock = client_with_mock

    resp = client.post(
        "/diarize",
        files={"file": ("meeting.wav", b"fake-audio-bytes", "audio/wav")},
    )

    assert resp.status_code == 200
    data = resp.json()

    # KONTRAKTAS, kurio tikisi backend'o PyannoteDiarizationProvider:
    # { "turns": [ {"start": <sek>, "end": <sek>, "speaker": <str>}, ... ] }
    assert "turns" in data, "atsakyme privalo būti 'turns' laukas"
    assert isinstance(data["turns"], list)
    assert len(data["turns"]) == 3

    for turn in data["turns"]:
        assert set(turn.keys()) == {"start", "end", "speaker"}, f"neteisingi laukai: {turn.keys()}"
        assert isinstance(turn["start"], (int, float))
        assert isinstance(turn["end"], (int, float))
        assert isinstance(turn["speaker"], str)
        assert turn["end"] >= turn["start"]

    # Konkretūs mock duomenys - patvirtina, kad realiai perduota, ne tuščia.
    assert data["turns"][0] == {"start": 0.0, "end": 2.5, "speaker": "SPEAKER_00"}
    assert data["turns"][1]["speaker"] == "SPEAKER_01"


def test_diarize_perduoda_num_speakers_pipeline(client_with_mock):
    client, mock = client_with_mock

    resp = client.post(
        "/diarize",
        files={"file": ("meeting.wav", b"fake-audio", "audio/wav")},
        data={"num_speakers": "2"},
    )

    assert resp.status_code == 200
    # num_speakers turi pasiekti pipeline kaip kwarg (ne būti tyliai ignoruotas).
    assert mock.last_call_kwargs.get("num_speakers") == 2


def test_diarize_be_num_speakers_neperduoda_kwarg(client_with_mock):
    client, mock = client_with_mock

    resp = client.post("/diarize", files={"file": ("m.wav", b"x", "audio/wav")})

    assert resp.status_code == 200
    # Be num_speakers - pipeline neturi gauti šio kwarg (kad pyannote pats nustatytų).
    assert "num_speakers" not in (mock.last_call_kwargs or {})


def test_health_su_ikeltu_pipeline_grazina_ok(client_with_mock):
    client, _mock = client_with_mock
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["model_loaded"] is True


def test_diarize_tuscias_rezultatas_vis_tiek_teisingas_kontraktas():
    """Kraštinis atvejis: jei diarizacija neranda kalbėtojų (tyla), turi grąžinti
    {turns: []}, ne klaidą - kaip transkripcija tyloje grąžina tuščią tekstą."""
    import server
    server._pipeline = _MockPipeline(turns=[])  # jokių kalbėtojų
    server._load_error = None
    try:
        client = TestClient(server.app)
        resp = client.post("/diarize", files={"file": ("silence.wav", b"x", "audio/wav")})
        assert resp.status_code == 200
        assert resp.json() == {"turns": []}
    finally:
        server._pipeline = None
        server._load_error = None


def test_diarize_didelis_failas_chunked_upload():
    """Didesnis nei vienas chunk (1MB) failas turi būti apdorotas be klaidų ir
    realiai įrašytas į diską - patvirtina, kad chunked kopijavimas (ne
    await file.read()) veikia ir kontraktas nepakinta dideliems failams."""
    import os
    import server

    written_size = {}

    class _SizeCheckPipeline(_MockPipeline):
        def __call__(self, audio_path, **kwargs):
            # Patvirtinam, kad visas failas realiai diske (ne tik dalis).
            written_size["bytes"] = os.path.getsize(audio_path)
            return super().__call__(audio_path, **kwargs)

    server._pipeline = _SizeCheckPipeline()
    server._load_error = None
    try:
        client = TestClient(server.app)
        big = b"x" * (5 * 1024 * 1024)  # 5MB = 5 chunk'ai po 1MB
        resp = client.post("/diarize", files={"file": ("big.wav", big, "audio/wav")})
        assert resp.status_code == 200
        assert "turns" in resp.json()
        assert written_size["bytes"] == len(big)  # visas failas įrašytas
    finally:
        server._pipeline = None
        server._load_error = None
