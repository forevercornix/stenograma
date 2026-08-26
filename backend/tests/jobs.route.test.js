const { markCompleted } = require("./helpers/jobPhaseFixtures");
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

test("DELETE /api/jobs/:id - nežinomas jobas grąžina 404", async () => {
  const res = await request(app).delete("/api/jobs/nera-tokio");
  assert.equal(res.status, 404);
});

test("DELETE /api/jobs/:id - ištrina užbaigtą protokolo jobą ir jo auditą", async () => {
  // Protokolo jobai buvo visiškai praleisti šakoje, nors jų payload'e yra
  // VISA transkripcija, o rezultate - sugeneruotas protokolas.
  const auditLog = require("../utils/auditLog");
  const jobStore = require("../utils/jobStore");

  auditLog.clear();

  const createRes = await request(app).post("/api/jobs").send({
    title: "Trynimo testas",
    transcript:
      "Jonas: Sveiki, pradedam susitikima. Reikia parengti ataskaita iki penktadienio.",
  });

  assert.equal(createRes.status, 202);
  const jobId = createRes.body.jobId;

  let status = null;
  for (let i = 0; i < 40 && status !== "completed"; i += 1) {
    await wait(50);
    const poll = await request(app).get(`/api/jobs/${jobId}`);
    status = poll.body.status;
    if (status === "failed") assert.fail(`Jobas krito: ${poll.body.error}`);
  }
  assert.equal(status, "completed");

  const subjectId = auditLog.pseudonymizeIdentifier(jobId);
  assert.ok((await auditLog.getAll()).some((entry) => entry.subjectId === subjectId));

  const delRes = await request(app).delete(`/api/jobs/${jobId}`);
  assert.equal(delRes.status, 204);

  assert.equal(await jobStore.system.get(jobId), null);
  assert.equal(
    (await auditLog.getAll()).filter((entry) => entry.subjectId === subjectId).length,
    0
  );
});

test("DELETE /api/jobs/:id - TRANSKRIPCIJOS jobo ID nepriimamas (404, jobas lieka)", async () => {
  const jobStore = require("../utils/jobStore");

  const transcriptionJob = await jobStore.create({ ownerKind: "unowned",
    type: jobStore.JOB_TYPES.TRANSCRIPTION,
  });
  await markCompleted(jobStore.system, transcriptionJob.id, { result: { text: "Jautri transkripcija" } });

  const res = await request(app).delete(`/api/jobs/${transcriptionJob.id}`);

  assert.equal(res.status, 404);
  assert.ok(await jobStore.system.get(transcriptionJob.id));

  await jobStore.system.remove(transcriptionJob.id);
});
