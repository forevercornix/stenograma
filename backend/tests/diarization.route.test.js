const test = require("node:test");
const assert = require("node:assert/strict");
const { fakeMp3Buffer } = require("./helpers/fakeAudio");

process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.LLM_PROVIDER = "mock";
process.env.ALLOW_PROVIDER_OVERRIDE = "false";
process.env.NODE_ENV = "test";
process.env.DIARIZATION_PROVIDER = "none"; // pradinė reikšmė, testai keičia dinamiškai

const request = require("supertest");
const app = require("../server");

test("diarize=true, DIARIZATION_PROVIDER=none -> diarizationProvider=null, bet MockTranscriptionProvider vis tiek grąžina savo pačio speaker laukus", async () => {
  process.env.DIARIZATION_PROVIDER = "none";
  const res = await request(app).post("/api/transcribe").attach("audio", fakeMp3Buffer(), "a.mp3").field("diarize", "true");

  assert.equal(res.status, 200);
  assert.equal(res.body.diarizationProvider, null);
  // MockTranscriptionProvider visada grąžina diarizuotus segmentus - tai NEsusiję su DIARIZATION_PROVIDER=none sprendimu
  assert.equal(res.body.segments[0].speaker, "Jonas");
});

test("diarize=true, DIARIZATION_PROVIDER=inline -> pasitikima transkribavimo tiekėjo pačio diarizacija", async () => {
  process.env.DIARIZATION_PROVIDER = "inline";
  const res = await request(app).post("/api/transcribe").attach("audio", fakeMp3Buffer(), "a.mp3").field("diarize", "true");

  assert.equal(res.status, 200);
  assert.match(res.body.diarizationProvider, /inline/);
  assert.equal(res.body.segments[0].speaker, "Jonas");
});

test("diarize=true, DIARIZATION_PROVIDER=mock -> ATSKIRAS diarizacijos etapas perrašo speaker laukus pagal overlap", async () => {
  process.env.DIARIZATION_PROVIDER = "mock";
  const res = await request(app).post("/api/transcribe").attach("audio", fakeMp3Buffer(), "a.mp3").field("diarize", "true");

  assert.equal(res.status, 200);
  assert.equal(res.body.diarizationProvider, "MockDiarizationProvider");
  assert.equal(res.body.diarization, true);
  // MockDiarizationProvider turns sutampa laike su MockTranscriptionProvider segmentais,
  // todėl speaker turi būti PERRAŠYTAS iš "Jonas" į "Kalbėtojas A" (atskiro etapo rezultatas).
  assert.equal(res.body.segments[0].speaker, "Kalbėtojas A");
  assert.equal(res.body.segments[1].speaker, "Kalbėtojas B");
});

test("diarize=false -> diarizacijos etapas visai nekviečiamas, net jei DIARIZATION_PROVIDER=mock", async () => {
  process.env.DIARIZATION_PROVIDER = "mock";
  const res = await request(app).post("/api/transcribe").attach("audio", fakeMp3Buffer(), "a.mp3").field("diarize", "false");

  assert.equal(res.status, 200);
  assert.equal(res.body.diarizationProvider, null);
});
