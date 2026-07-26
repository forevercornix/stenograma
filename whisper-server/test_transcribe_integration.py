"""
Whisper serverio INTEGRACINIS testas su MOCK modeliu.

KODĖL SVARBU: paleidžia serverį, įkelia audio per POST /transcribe ir validuoja
{text, segments, language} kontraktą END-TO-END su mock modeliu (be tikro
faster-whisper atsisiuntimo). BŪTENT toks testas būtų anksčiau pagavęs pagrindinę
problemą: FasterWhisperProvider egzistavo, o serverio realizacijos NEBUVO. Testas
patvirtina, kad serveris grąžina TIKSLIAI tą formatą, kurio tikisi backend'o
FasterWhisperProvider.js (text + segments su start/end/text).

Paleidimas:  pytest test_transcribe_integration.py -v
"""
import pytest
from fastapi.testclient import TestClient


class _MockSegment:
    def __init__(self, start, end, text, avg_logprob=-0.3):
        self.start = start
        self.end = end
        self.text = text
        self.avg_logprob = avg_logprob


class _MockInfo:
    language = "lt"


class _MockModel:
    """Imituoja faster-whisper WhisperModel - transcribe() grąžina (segments, info),
    kaip tikras modelis. Fiksuoti duomenys deterministiniam testui."""

    def __init__(self, segments=None):
        if segments is None:
            segments = [
                _MockSegment(0.0, 2.5, " Sveiki visi."),
                _MockSegment(2.5, 5.0, " Pradedame susitikimą."),
            ]
        self._segments = segments
        self.last_language = None

    def transcribe(self, audio_path, language=None, **kwargs):
        # **kwargs: tikras faster-whisper priima vad_filter ir kt. - mock turi irgi,
        # kad nesugriūtų, kai serveris perduoda naujus parametrus (pvz. vad_filter=True).
        self.last_language = language
        self.last_kwargs = kwargs
        return iter(self._segments), _MockInfo()


@pytest.fixture
def client_with_mock():
    import server
    mock = _MockModel()
    server._model = mock
    server._load_error = None
    client = TestClient(server.app)
    yield client, mock
    server._model = None
    server._load_error = None


def test_transcribe_grazina_teisinga_kontrakta(client_with_mock):
    client, _mock = client_with_mock

    resp = client.post(
        "/transcribe",
        files={"file": ("meeting.wav", b"fake-audio-bytes", "audio/wav")},
        data={"language": "lt"},
    )

    assert resp.status_code == 200
    data = resp.json()

    # KONTRAKTAS, kurio tikisi backend'o FasterWhisperProvider.js:
    # { text, segments: [{start, end, text}], language, avg_logprob }
    assert "text" in data
    assert "segments" in data
    assert "language" in data
    assert data["text"] == "Sveiki visi. Pradedame susitikimą."
    assert data["language"] == "lt"
    assert len(data["segments"]) == 2
    for seg in data["segments"]:
        assert set(seg.keys()) == {"start", "end", "text"}
        assert isinstance(seg["start"], (int, float))
        assert isinstance(seg["end"], (int, float))
    assert data["segments"][0]["text"] == "Sveiki visi."


def test_transcribe_perduoda_kalba_modeliui(client_with_mock):
    client, mock = client_with_mock
    client.post(
        "/transcribe",
        files={"file": ("m.wav", b"x", "audio/wav")},
        data={"language": "en"},
    )
    assert mock.last_language == "en"


def test_transcribe_perduoda_vad_filter_modeliui(client_with_mock):
    # NEpakanka, kad mock TOLERUOTŲ **kwargs - tikrinam, kad serveris REALIAI perduoda
    # vad_filter=True (numatytai įjungtas, mažina halucinacijas). Be šio testo **kwargs
    # paslėptų bug'ą, jei serveris perduotų blogą parametrą (pvz. vad_fiter opečatką).
    client, mock = client_with_mock
    client.post(
        "/transcribe",
        files={"file": ("m.wav", b"x", "audio/wav")},
        data={"language": "lt"},
    )
    assert mock.last_kwargs.get("vad_filter") is True, \
        f"serveris turi perduoti vad_filter=True, gauta: {mock.last_kwargs}"


def test_transcribe_vad_filter_isjungiamas_env(client_with_mock, monkeypatch):
    # WHISPER_VAD_FILTER=false -> serveris NEperduoda vad_filter (išjungta).
    monkeypatch.setenv("WHISPER_VAD_FILTER", "false")
    client, mock = client_with_mock
    client.post(
        "/transcribe",
        files={"file": ("m.wav", b"x", "audio/wav")},
        data={"language": "lt"},
    )
    assert "vad_filter" not in mock.last_kwargs, \
        f"su WHISPER_VAD_FILTER=false neturi būti vad_filter, gauta: {mock.last_kwargs}"


def test_transcribe_auto_kalba_perduoda_none(client_with_mock):
    client, mock = client_with_mock
    client.post(
        "/transcribe",
        files={"file": ("m.wav", b"x", "audio/wav")},
        data={"language": "auto"},
    )
    # "auto" -> None (faster-whisper pats nustato kalbą).
    assert mock.last_language is None


def test_transcribe_tuscias_audio_vis_tiek_teisingas_kontraktas():
    """Tyla / jokių segmentų -> tuščias text ir segments, ne klaida."""
    import server
    server._model = _MockModel(segments=[])
    server._load_error = None
    try:
        client = TestClient(server.app)
        resp = client.post("/transcribe", files={"file": ("s.wav", b"x", "audio/wav")}, data={"language": "lt"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["text"] == ""
        assert data["segments"] == []
    finally:
        server._model = None
        server._load_error = None


def test_transcribe_didelis_failas_chunked_upload():
    """Didesnis nei 1MB failas apdorojamas per chunked upload be klaidų."""
    import os
    import server

    written = {}

    class _SizeModel(_MockModel):
        def transcribe(self, audio_path, language=None, **kwargs):
            written["bytes"] = os.path.getsize(audio_path)
            return super().transcribe(audio_path, language, **kwargs)

    server._model = _SizeModel()
    server._load_error = None
    try:
        client = TestClient(server.app)
        big = b"x" * (5 * 1024 * 1024)
        resp = client.post("/transcribe", files={"file": ("big.wav", big, "audio/wav")}, data={"language": "lt"})
        assert resp.status_code == 200
        assert written["bytes"] == len(big)
    finally:
        server._model = None
        server._load_error = None
