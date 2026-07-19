const test = require("node:test");
const assert = require("node:assert/strict");
const { fakeMp3Buffer } = require("./helpers/fakeAudio");

process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.LLM_PROVIDER = "mock";
process.env.ALLOW_PROVIDER_OVERRIDE = "false";
process.env.NODE_ENV = "test";

const request = require("supertest");
const app = require("../server");

test("POST /api/transcribe - be failo grąžina 400", async () => {
  const res = await request(app).post("/api/transcribe");
  assert.equal(res.status, 400);
});

test("POST /api/transcribe - su failu grąžina segmentus ir tekstą (mock provideris)", async () => {
  const res = await request(app)
    .post("/api/transcribe")
    .attach("audio", fakeMp3Buffer(), "test.mp3");

  assert.equal(res.status, 200);
  assert.equal(res.body.provider, "mock");
  assert.ok(res.body.text.length > 0);
  assert.ok(Array.isArray(res.body.segments));
  assert.ok(res.body.segments[0].speaker);
});

test("POST /api/transcribe - provider override atmetamas, jei ALLOW_PROVIDER_OVERRIDE=false", async () => {
  const res = await request(app)
    .post("/api/transcribe")
    .field("provider", "whisper")
    .attach("audio", fakeMp3Buffer(), "test.mp3");

  assert.equal(res.status, 403);
});

test("POST /api/transcribe - nežinomas failo formatas atmetamas su 400 (upload validacija)", async () => {
  const res = await request(app)
    .post("/api/transcribe")
    .attach("audio", Buffer.from("x"), "test.unknownformat");

  assert.equal(res.status, 400);
});
