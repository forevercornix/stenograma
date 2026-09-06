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

test("DELETE /api/jobs/:id per MARŠRUTĄ prašo job'o BE rezultato", async (t) => {
  /**
   * ⚠️ MATUOJAMA PER MARŠRUTĄ, NE PER SAUGYKLĄ (#157, PR-3, Codex P1 #291).
   *
   * `getOwned()` pataisymas praėjusiame raunde gyveno saugyklos viduje, o produkcinis
   * `DELETE` toliau prašė hidratuoto job'o. Testas su `removeOwned()` to nepagautų —
   * maršrutas jo nekviečia.
   *
   * ⚠️ KODĖL SKAITIKLIS ČIA NEĮMANOMAS: maršrutai testuose eina per atminties
   * backend'ą, kuris artefaktų saugyklos apskritai neturi (PostgreSQL už maršrutų
   * uždarytas aktyvavimo barjero). Todėl grandinė tikrinama dviem susietomis
   * dalimis: ČIA — kad maršrutas prašo `hydrate: false`; `jobStoreHydration.
   * integration` — kad `hydrate: false` reiškia NULĮ kreipinių į saugyklą.
   */
  const jobStore = require("../utils/jobStore");
  const originalus = jobStore.get;
  const kvietimai = [];

  jobStore.get = async (scope, nustatymai) => {
    kvietimai.push(nustatymai);
    return originalus(scope, nustatymai);
  };
  t.after(() => {
    jobStore.get = originalus;
  });

  const createRes = await request(app)
    .post("/api/jobs")
    .send({ title: "Ištrynimo kelias", transcript: "Jonas: Sveiki, pradedam susitikima. Reikia parengti ataskaita." });
  assert.equal(createRes.status, 202);

  const jobId = createRes.body.jobId;
  for (let i = 0; i < 20; i++) {
    const pollRes = await request(app).get(`/api/jobs/${jobId}`);
    if (["completed", "failed"].includes(pollRes.body.status)) break;
    await wait(50);
  }

  kvietimai.length = 0;
  const delRes = await request(app).delete(`/api/jobs/${jobId}`);

  assert.ok([200, 202, 204].includes(delRes.status), `ištrynimas privalo pavykti (${delRes.status})`);
  assert.deepEqual(
    kvietimai.map((n) => n && n.hydrate),
    [false],
    "DELETE maršrutas privalo prašyti job'o BE rezultato"
  );
});

test("GET /api/jobs/:id per MARŠRUTĄ prašo job'o SU rezultatu", async (t) => {
  /**
   * KONTROLĖ: be jos ankstesnis testas būtų tenkinamas ir maršrutų rinkinio, kuris
   * NIEKADA nehidratuoja — o `READ` be rezultato grąžintų klientui tuščią atsakymą.
   */
  const jobStore = require("../utils/jobStore");
  const originalus = jobStore.get;
  const kvietimai = [];

  jobStore.get = async (scope, nustatymai) => {
    kvietimai.push(nustatymai);
    return originalus(scope, nustatymai);
  };
  t.after(() => {
    jobStore.get = originalus;
  });

  const createRes = await request(app)
    .post("/api/jobs")
    .send({ title: "Skaitymo kelias", transcript: "Jonas: Sveiki, pradedam susitikima. Reikia parengti ataskaita." });

  const getRes = await request(app).get(`/api/jobs/${createRes.body.jobId}`);

  assert.equal(getRes.status, 200);
  assert.deepEqual(
    kvietimai.map((n) => n && n.hydrate),
    [true],
    "READ be rezultato grąžintų klientui tuščią atsakymą"
  );
});
