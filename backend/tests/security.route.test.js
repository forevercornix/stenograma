const test = require("node:test");
const assert = require("node:assert/strict");
const { fakeMp3Buffer, fakeWavBuffer, fakeMp4Buffer } = require("./helpers/fakeAudio");

process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.LLM_PROVIDER = "mock";
process.env.DIARIZATION_PROVIDER = "none";
process.env.ALLOW_PROVIDER_OVERRIDE = "false";
process.env.NODE_ENV = "test";
process.env.API_KEY = ""; // testai patys nustato pagal poreikį

const request = require("supertest");
const app = require("../server");

test("API_KEY tuščias, NODE_ENV != production -> /api/generate veikia be autentifikacijos (dev patogumas)", async () => {
  process.env.API_KEY = "";
  process.env.NODE_ENV = "test";
  const res = await request(app).post("/api/generate").send({ transcript: "Pakankamai ilgas testinis tekstas apie susitikimą." });
  assert.equal(res.status, 200);
});

test("API_KEY nustatytas -> /api/generate be x-api-key grąžina 401", async () => {
  process.env.API_KEY = "slaptas-raktas";
  const res = await request(app).post("/api/generate").send({ transcript: "Pakankamai ilgas testinis tekstas apie susitikimą." });
  assert.equal(res.status, 401);
  process.env.API_KEY = "";
});

test("API_KEY nustatytas -> /api/generate su teisingu x-api-key veikia", async () => {
  process.env.API_KEY = "slaptas-raktas";
  const res = await request(app)
    .post("/api/generate")
    .set("x-api-key", "slaptas-raktas")
    .send({ transcript: "Pakankamai ilgas testinis tekstas apie susitikimą." });
  assert.equal(res.status, 200);
  process.env.API_KEY = "";
});

test("API_KEY tuščias IR NODE_ENV=production -> /api/transcribe uždarytas (503)", async () => {
  process.env.API_KEY = "";
  process.env.NODE_ENV = "production";
  const res = await request(app).post("/api/transcribe").attach("audio", fakeMp3Buffer(), "a.mp3");
  assert.equal(res.status, 503);
  process.env.NODE_ENV = "test";
});

test("/api/health: NODE_ENV=production be x-audit-key -> tik {status:'ok'}, jokių tiekėjų detalių", async () => {
  process.env.NODE_ENV = "production";
  process.env.HEALTH_DETAILS = "";
  const res = await request(app).get("/api/health");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: "ok" });
  process.env.NODE_ENV = "test";
});

test("/api/health: NODE_ENV=production, bet HEALTH_DETAILS=public -> detalės matomos", async () => {
  process.env.NODE_ENV = "production";
  process.env.HEALTH_DETAILS = "public";
  const res = await request(app).get("/api/health");
  assert.equal(res.body.llmProvider, "mock");
  process.env.NODE_ENV = "test";
  process.env.HEALTH_DETAILS = "";
});

test("/api/health: development režime detalės matomos pagal nutylėjimą", async () => {
  process.env.NODE_ENV = "test";
  process.env.HEALTH_DETAILS = "";
  const res = await request(app).get("/api/health");
  assert.equal(res.body.transcriptionProvider, "mock");
});

test("upload: neleidžiamas failo formatas (.txt) atmetamas su 400", async () => {
  const res = await request(app).post("/api/transcribe").attach("audio", Buffer.from("ne audio"), "dokumentas.txt");
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Neleidžiamas failo formatas/);
});

test("upload: leidžiamas .mp3 plėtinys priimamas net su bendriniu mimetype", async () => {
  const res = await request(app)
    .post("/api/transcribe")
    .attach("audio", fakeMp3Buffer(), { filename: "irasas.mp3", contentType: "application/octet-stream" });
  assert.equal(res.status, 200);
});

test("upload: leidžiamas .wav mimetype priimamas", async () => {
  const res = await request(app)
    .post("/api/transcribe")
    .attach("audio", fakeWavBuffer(), { filename: "irasas", contentType: "audio/wav" });
  assert.equal(res.status, 200);
});

test("upload: video/mp4 mimetype priimamas (video+audio .mp4 realiai transkribuojamas - žr. routes/transcribe.js pastabą)", async () => {
  const res = await request(app)
    .post("/api/transcribe")
    .attach("audio", fakeMp4Buffer(), { filename: "irasymas.mp4", contentType: "video/mp4" });
  assert.equal(res.status, 200);
});

test("upload: video/webm mimetype priimamas (pvz. ekrano įrašymas su kalba)", async () => {
  const res = await request(app)
    .post("/api/transcribe")
    .attach("audio", Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("papildomas turinys")]), {
      filename: "ekrano-irasas.webm",
      contentType: "video/webm",
    });
  assert.equal(res.status, 200);
});
