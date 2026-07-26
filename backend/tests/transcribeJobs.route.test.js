const test = require("node:test");
const assert = require("node:assert/strict");
const { fakeMp3Buffer } = require("./helpers/fakeAudio");

process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.DIARIZATION_PROVIDER = "none";
process.env.LLM_PROVIDER = "mock";
process.env.ALLOW_PROVIDER_OVERRIDE = "false";
process.env.API_KEY = "";
process.env.NODE_ENV = "test";

const request = require("supertest");
const app = require("../server");
app._setReadyForTests(); // job route reikalauja readiness (startServer nevyksta testuose)

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test("POST /api/transcribe-jobs - be failo grąžina 400 iš karto", async () => {
  const res = await request(app).post("/api/transcribe-jobs");
  assert.equal(res.status, 400);
});

test("POST /api/transcribe-jobs - priima ir 'file' lauką (ne tik 'audio')", async () => {
  // Regresija: anksčiau .single("audio") mesdavo "Unexpected field", jei vartotojas
  // siųsdavo -F "file=@...". Dabar priimami abu laukai. RASTA realiai testuojant.
  const res = await request(app).post("/api/transcribe-jobs").attach("file", fakeMp3Buffer(), "test.mp3");
  assert.equal(res.status, 202);
  assert.ok(res.body.jobId);
});

test("POST /api/transcribe-jobs - grąžina jobId IŠ KARTO (202), o GET vėliau parodo completed rezultatą su transkripcija", async () => {
  const createRes = await request(app).post("/api/transcribe-jobs").attach("audio", fakeMp3Buffer(), "test.mp3");

  assert.equal(createRes.status, 202);
  assert.ok(createRes.body.jobId);
  assert.equal(createRes.body.status, "queued");

  let job;
  for (let i = 0; i < 20; i++) {
    const pollRes = await request(app).get(`/api/transcribe-jobs/${createRes.body.jobId}`);
    job = pollRes.body;
    if (job.status === "completed" || job.status === "failed") break;
    await wait(50);
  }

  assert.equal(job.status, "completed");
  assert.equal(job.result.provider, "mock");
  assert.ok(job.result.text.length > 0);
  assert.ok(Array.isArray(job.result.segments));
});

test("GET /api/transcribe-jobs/:id - nežinomas jobId grąžina 404", async () => {
  const res = await request(app).get("/api/transcribe-jobs/nesamas-id-456");
  assert.equal(res.status, 404);
});

test("POST /api/transcribe-jobs - neleidžiamas failo formatas atmetamas su 400 dar PRIEŠ sukuriant jobą", async () => {
  const res = await request(app).post("/api/transcribe-jobs").attach("audio", Buffer.from("x"), "dokumentas.txt");
  assert.equal(res.status, 400);
});

test("POST /api/transcribe-jobs - atsakymo greitis: jobId grąžinamas GREITAI, nelaukiant viso transkribavimo (imituoja HTTP proxy trumpą timeout, pvz. RunPod 100s)", async () => {
  const start = Date.now();
  const res = await request(app).post("/api/transcribe-jobs").attach("audio", fakeMp3Buffer(), "test.mp3");
  const elapsedMs = Date.now() - start;

  assert.equal(res.status, 202);
  // Pats HTTP atsakymas turi grįžti per milisekundes/sekundes, NE laukti viso
  // (galimai kelias minutes trunkančio) transkribavimo - tai IR YRA šio
  // endpoint'o prasmė.
  assert.ok(elapsedMs < 2000, `Tikėtasi greito atsakymo (<2s), gauta ${elapsedMs}ms`);
});
