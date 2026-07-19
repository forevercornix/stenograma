"""
Pyannote serverio REALUS testas su tikru modeliu (antras lygis).

Skiriasi nuo test_diarize_integration.py (mock pipeline): ŠIS naudoja TIKRĄ
pyannote.audio modelį ir realų audio failą. Todėl:
  - reikalauja HUGGINGFACE_TOKEN (gated modelis) - be jo VISI testai praleidžiami;
  - atsisiunčia modelį (~GB) ir jį paleidžia - lėta, netinka kiekvienam CI push'ui;
  - realiam GPU pagreitinimui reikia CUDA (bet veiks ir CPU, tik lėčiau).

Tai vartotojo pasiūlyta "antro lygio" strategija: nemokamas kontrakto testas
(mock) visada CI'e, o šis realus testas - pasirenkamai, su tokenu.

Paleidimas:
  export HUGGINGFACE_TOKEN=hf_...
  pytest test_real_gpu.py -v -s

CI'e: paleidžiamas TIK jei repo turi HUGGINGFACE_TOKEN secret (žr. ci.yml -
job'as pažymėtas continue-on-error ir sąlyginis).
"""
import os
import wave
import struct
import tempfile

import pytest

_HAS_TOKEN = bool(os.environ.get("HUGGINGFACE_TOKEN") or os.environ.get("HF_TOKEN"))

pytestmark = pytest.mark.skipif(
    not _HAS_TOKEN,
    reason="HUGGINGFACE_TOKEN nenustatytas - realus pyannote modelio testas praleidžiamas (naudokite test_diarize_integration.py mock kontrakto testui).",
)


def _make_test_wav(path, seconds=4, sample_rate=16000):
    """Sukuria trumpą tylų WAV failą - realus modelis turi jį apdoroti be klaidos
    (grąžinti tuščią ar minimalų turns sąrašą), net jei nėra tikros kalbos."""
    with wave.open(path, "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        for _ in range(seconds * sample_rate):
            w.writeframes(struct.pack("<h", 0))


def test_realus_modelis_ikeliamas_ir_diarizuoja():
    from fastapi.testclient import TestClient
    import server

    # Priverstinai išvalom bet kokį mock, kad naudotų TIKRĄ _get_pipeline.
    server._pipeline = None
    server._load_error = None

    client = TestClient(server.app)

    # probe=true realiai bando įkelti modelį - turi pavykti su tokenu.
    health = client.get("/health?probe=true")
    assert health.status_code == 200, f"Modelis neįsikėlė: {health.json()}"
    assert health.json()["model_loaded"] is True

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav_path = tmp.name
    try:
        _make_test_wav(wav_path)
        with open(wav_path, "rb") as f:
            resp = client.post("/diarize", files={"file": ("test.wav", f, "audio/wav")})

        assert resp.status_code == 200, f"Diarizacija nepavyko: {resp.text}"
        data = resp.json()
        # Kontraktas turi galioti ir su tikru modeliu (ne tik mock).
        assert "turns" in data
        assert isinstance(data["turns"], list)
        for turn in data["turns"]:
            assert set(turn.keys()) == {"start", "end", "speaker"}
    finally:
        os.unlink(wav_path)
