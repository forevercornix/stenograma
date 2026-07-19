const test = require("node:test");
const assert = require("node:assert/strict");
const { fakeMp3Buffer } = require("./helpers/fakeAudio");

// ALLOW_PROVIDER_OVERRIDE skaitomas VIENĄ kartą routes/*.js modulio įkėlimo metu,
// todėl jis turi būti nustatytas PRIEŠ require("../server") - kitaip pakeitimas
// runtime metu neturėtų jokio efekto (žr. routes/transcribe.js, routes/generate.js).
process.env.ALLOW_PROVIDER_OVERRIDE = "true";
process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.LLM_PROVIDER = "mock";
process.env.DIARIZATION_PROVIDER = "none";
process.env.NODE_ENV = "test";

const request = require("supertest");
const app = require("../server");

test("ALLOW_PROVIDER_OVERRIDE=true: nežinomas diarizationProvider grąžina 400", async () => {
  const res = await request(app)
    .post("/api/transcribe")
    .field("diarizationProvider", "nesamas-tiekejas")
    .field("diarize", "true")
    .attach("audio", fakeMp3Buffer(), "a.mp3");

  assert.equal(res.status, 400);
});

test("ALLOW_PROVIDER_OVERRIDE=true: nežinomas transkribavimo provideris grąžina 400", async () => {
  const res = await request(app)
    .post("/api/transcribe")
    .field("provider", "nesamas-tiekejas")
    .attach("audio", fakeMp3Buffer(), "a.mp3");

  assert.equal(res.status, 400);
});

test("ALLOW_PROVIDER_OVERRIDE=true: žinomas diarizationProvider=mock per užklausą veikia be serverio DIARIZATION_PROVIDER nustatymo", async () => {
  const res = await request(app)
    .post("/api/transcribe")
    .field("diarizationProvider", "mock")
    .field("diarize", "true")
    .attach("audio", fakeMp3Buffer(), "a.mp3");

  assert.equal(res.status, 200);
  assert.equal(res.body.diarizationProvider, "MockDiarizationProvider");
  assert.equal(res.body.segments[0].speaker, "Kalbėtojas A");
});

test("ALLOW_PROVIDER_OVERRIDE=true: nežinoma LLM provider override /api/generate grąžina 400", async () => {
  const res = await request(app)
    .post("/api/generate")
    .send({ transcript: "Pakankamai ilgas testinis tekstas.", llmProviderOverride: "nesamas" });

  assert.equal(res.status, 400);
});
