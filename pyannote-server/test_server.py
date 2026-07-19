"""
Pyannote serverio /health diagnostikos testai.

Paleidimas:  cd pyannote-server && pip install -r requirements.txt pytest && pytest

Testuoja RASTĄ IR IŠTAISYTĄ trūkumą: anksčiau /health grąžindavo
{"status":"ok","model_loaded":false} net be HUGGINGFACE_TOKEN - t.y. rodė "ok"
kai modelis realiai negalėjo veikti. Dabar grąžina status=degraded su aiškia
"reason", o /health?probe=true grąžina HTTP 503, jei įkelti nepavyksta.
"""
import os

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv("HUGGINGFACE_TOKEN", raising=False)
    monkeypatch.delenv("HF_TOKEN", raising=False)
    import server
    # Nunulinam būseną tarp testų (modulis dalinamas).
    server._pipeline = None
    server._load_error = None
    return TestClient(server.app)


def test_health_be_tokeno_grazina_degraded_su_priezastimi(client):
    r = client.get("/health")
    assert r.status_code == 200  # be probe - greitas atsakymas
    body = r.json()
    assert body["model_loaded"] is False
    assert body["status"] == "degraded"
    # SVARBU: turi būti AIŠKI priežastis, ne tuščias model_loaded:false
    assert "reason" in body
    assert "HUGGINGFACE_TOKEN" in body["reason"]


def test_health_probe_be_tokeno_grazina_503(client):
    r = client.get("/health?probe=true")
    # probe=true bando įkelti; be tokeno nepavyksta -> 503, kad healthcheck matytų
    assert r.status_code == 503
    assert r.json()["model_loaded"] is False


def test_diarize_be_tokeno_grazina_503_ne_400(client):
    r = client.post("/diarize", files={"file": ("test.wav", b"fake-audio", "audio/wav")})
    # Modelis neįkeltas dėl serverio konfigūracijos (trūksta tokeno) - tai 503
    # (serverio pusės problema), NE 400 (kliento klaida).
    assert r.status_code == 503
    assert "detail" in r.json()
