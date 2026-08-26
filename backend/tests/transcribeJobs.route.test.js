const { markCompleted } = require("./helpers/jobPhaseFixtures");
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
const jobStore = require("../utils/jobStore");
const auditLog = require("../utils/auditLog");
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

test("DELETE /api/transcribe-jobs/:id - nežinomas jobas grąžina 404", async () => {
  const res = await request(app).delete(
    "/api/transcribe-jobs/unknown-delete-job"
  );

  assert.equal(res.status, 404);
});

test("DELETE /api/transcribe-jobs/:id - aktyvus jobas grąžina 409", async () => {
  const job = await jobStore.create({ ownerKind: "unowned" });

  const res = await request(app).delete(
    `/api/transcribe-jobs/${job.id}`
  );

  assert.equal(res.status, 409);
  assert.ok(await jobStore.system.get(job.id));
});

test("DELETE /api/transcribe-jobs/:id - ištrina užbaigtą jobą ir jo auditą", async () => {
  auditLog.clear();

  const job = await jobStore.create({ ownerKind: "unowned" });

  await markCompleted(jobStore.system, job.id, { result: { text: "Jautrus transkripcijos rezultatas" } });

  await auditLog.record({
    event: "TRANSCRIPTION_COMPLETED",
    jobId: job.id,
    success: true,
  });

  // Tikrinam ŠIO jobo įrašus, ne bendrą žurnalo ilgį: ankstesnių testų jobai
  // apdorojami FONE (inline runner per setImmediate) ir gali įrašyti savo
  // TRANSCRIPTION_COMPLETED jau po šio testo auditLog.clear() - dėl to bendro
  // skaičiaus tikrinimas buvo flaky.
  const subjectId = auditLog.pseudonymizeIdentifier(job.id);
  const own = async () => (await auditLog.getAll()).filter((e) => e.subjectId === subjectId);

  assert.equal((await own()).length, 1);

  const res = await request(app).delete(
    `/api/transcribe-jobs/${job.id}`
  );

  assert.equal(res.status, 204);
  assert.equal(await jobStore.system.get(job.id), null);

  // DATA_ERASED kvitas SĄMONINGAI lieka, bet jis nesusietas su subjektu
  // (subjectId=null), tad į own() nepatenka - žr. utils/jobErasure.js.
  assert.equal((await own()).length, 0);
  assert.ok(
    (await auditLog.getAll()).some((e) => e.event === "DATA_ERASED"),
    "turi likti įrodymas, kad ištrynimas įvyko"
  );
});

test("DELETE /api/transcribe-jobs/:id - PILNAS srautas: upload -> polling -> ištrynimas išvalo ir auditą", async () => {
  // Skirtingai nuo testo aukščiau, čia audito įrašą sukuria REALUS transkribavimo
  // servisas (per jobRunner -> processors -> transcriptionService), o ne testas.
  // Būtent šis kelias buvo neveikiantis: servisas rašydavo tik meetingId, tad
  // removeBySubjectIdentifier(job.id) nieko nerasdavo.
  auditLog.clear();

  const wav = Buffer.alloc(64);
  wav.write("RIFF", 0, "ascii");
  wav.write("WAVE", 8, "ascii");

  const createRes = await request(app)
    .post("/api/transcribe-jobs")
    .attach("audio", wav, { filename: "irasas.wav", contentType: "audio/wav" });

  assert.equal(createRes.status, 202);
  const jobId = createRes.body.jobId;

  let status = null;
  for (let i = 0; i < 40 && status !== "completed"; i += 1) {
    await wait(50);
    const poll = await request(app).get(`/api/transcribe-jobs/${jobId}`);
    status = poll.body.status;
    if (status === "failed") assert.fail(`Jobas krito: ${poll.body.error}`);
  }
  assert.equal(status, "completed");

  const beforeDelete = (await auditLog.getAll())
    .filter((entry) => entry.subjectId === auditLog.pseudonymizeIdentifier(jobId));
  assert.ok(
    beforeDelete.length >= 1,
    "realus transkribavimo srautas turi palikti su jobId susietą audito įrašą"
  );

  const delRes = await request(app).delete(`/api/transcribe-jobs/${jobId}`);
  assert.equal(delRes.status, 204);

  const afterDelete = (await auditLog.getAll())
    .filter((entry) => entry.subjectId === auditLog.pseudonymizeIdentifier(jobId));
  assert.equal(afterDelete.length, 0);
  assert.equal(await jobStore.system.get(jobId), null);
});

test("DELETE /api/transcribe-jobs/:id - PROTOKOLO jobo ID nepriimamas (404, jobas lieka)", async () => {
  // Regresija: abu endpoint'ai naudoja tą patį jobStore. Be job.type patikros
  // protokolo jobas būdavo surandamas, ištrinamas iš jobStore, o valymas vyktų
  // ne toje BullMQ eilėje - duomenys liktų, o klientas gautų 204.
  const protocolJob = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });
  await markCompleted(jobStore.system, protocolJob.id, { result: { protocol: { pavadinimas: "Jautrus protokolas" } } });

  const res = await request(app).delete(`/api/transcribe-jobs/${protocolJob.id}`);

  assert.equal(res.status, 404);
  assert.ok(await jobStore.system.get(protocolJob.id), "protokolo jobas turi likti nepaliestas");

  await jobStore.system.remove(protocolJob.id);
});

test("DELETE /api/transcribe-jobs/:id - LEGACY jobas be type ištrinamas (ne 404)", async () => {
  // Suderinamumas: prieš `type` įvedimą sukurti jobai lauko neturi. Griežta
  // patikra juos paverstų neištrinamais po deployment'o.
  const legacy = await jobStore.create({ ownerKind: "unowned" });
  await markCompleted(jobStore.system, legacy.id, { result: { text: "Senas rezultatas" },
    type: undefined });

  const stored = await jobStore.system.get(legacy.id);
  stored.type = undefined; // imituojam seną Redis įrašą be lauko

  const res = await request(app).delete(`/api/transcribe-jobs/${legacy.id}`);

  assert.equal(res.status, 204);
  assert.equal(await jobStore.system.get(legacy.id), null);
});
