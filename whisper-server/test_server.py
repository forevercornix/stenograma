"""
Whisper serverio /health diagnostikos testai.

Paleidimas:  pip install fastapi python-multipart pytest && pytest test_server.py

Testuoja tą patį principą kaip pyannote-server: /health be probe grąžina greitą
būseną, /health?probe=true bando įkelti modelį ir grąžina 503, jei nepavyksta.
"""
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    import server
    server._model = None
    server._load_error = None
    return TestClient(server.app)


def test_health_be_probe_grazina_ok_greitai(client):
    # Be probe - nekrauna modelio, grąžina greitą būseną (200).
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["model_loaded"] is False


def test_health_probe_be_faster_whisper_grazina_503(client):
    # probe=true bando įkelti; faster-whisper testų aplinkoje neįdiegtas -> 503.
    r = client.get("/health?probe=true")
    assert r.status_code == 503
    assert r.json()["model_loaded"] is False
    assert "reason" in r.json()


def test_transcribe_be_modelio_grazina_503_ne_400(client):
    # Modelis neįkeltas (serverio konfigūracijos problema) -> 503, NE 400.
    r = client.post(
        "/transcribe",
        files={"file": ("audio.wav", b"fake", "audio/wav")},
        data={"language": "lt"},
    )
    assert r.status_code == 503
    assert "detail" in r.json()
