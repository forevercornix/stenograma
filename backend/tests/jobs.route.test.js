const test = require("node:test");
const assert = require("node:assert/strict");

process.env.LLM_PROVIDER = "mock";
process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.ALLOW_PROVIDER_OVERRIDE = "false";
process.env.API_KEY = "";
process.env.NODE_ENV = "test";

const request = require("supertest");
const app = require("../server");
app._setReadyForTests(); // job route reikalauja readiness (startServer nevyksta testuose)

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test("POST /api/jobs - per trumpa transkripcija grąžina 400 iš karto", async () => {
  const res = await request(app).post("/api/jobs").send({ transcript: "trumpa" });
  assert.equal(res.status, 400);
});

test("POST /api/jobs - grąžina jobId iš karto (202), o GET /api/jobs/:id vėliau parodo completed rezultatą", async () => {
  const createRes = await request(app)
    .post("/api/jobs")
    .send({ title: "Async testas", transcript: "Jonas: Sveiki, pradedam susitikima. Reikia parengti ataskaita iki penktadienio." });

  assert.equal(createRes.status, 202);
  assert.ok(createRes.body.jobId);
  assert.equal(createRes.body.status, "queued");

  // Pollinam GET /api/jobs/:id, kol status taps completed (mock LLM greitas, bet vis tiek asinchroninis)
  let job;
  for (let i = 0; i < 20; i++) {
    const pollRes = await request(app).get(`/api/jobs/${createRes.body.jobId}`);
    job = pollRes.body;
    if (job.status === "completed" || job.status === "failed") break;
    await wait(50);
  }

  assert.equal(job.status, "completed");
  assert.equal(job.result.protocol.pavadinimas, "Async testas");
  assert.ok(job.result.meta);
});

test("GET /api/jobs/:id - nežinomas jobId grąžina 404", async () => {
  const res = await request(app).get("/api/jobs/nesamas-id-123");
  assert.equal(res.status, 404);
});
