const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.LLM_PROVIDER = "mock";
process.env.DIARIZATION_PROVIDER = "none";
delete process.env.PRIVACY_MODE;

const request = require("supertest");
const app = require("../server");
const jobStore = require("../utils/jobStore");
const auditLog = require("../utils/auditLog");
const { retryPendingDeletions } = require("../utils/deletionRetry");

app._setReadyForTests(); // job route reikalauja readiness (startServer testuose nevyksta)

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retencijos neatitikimas, ištrynimo kvitas, nebaigtų ištrynimų pakartojimas ir
 * lenktynės tarp automatinio valymo bei DELETE.
 */

test("jobStore TTL praėjo, bet audito įrašai liko - DELETE juos vis tiek ištrina", async () => {
  // Retencijos NESUTAMPA: jobStore TTL numatytai 60 min, BullMQ removeOnFail
  // 24 val., auditas 30 d. Anksčiau DELETE pradėdavo nuo jobStore.get() ir,
  // jam grąžinus null, iškart atsakydavo 404 - teisė ištrinti dingdavo
  // ANKSČIAU nei patys duomenys.
  auditLog.clear();

  const jobId = "11111111-2222-3333-4444-555555555555";
  auditLog.record({ jobId, transcriptionProvider: "mock", success: true });

  assert.equal(await jobStore.get(jobId), null, "jobStore įrašo neturi būti");
  assert.equal(auditLog.getAll().length, 1);

  const res = await request(app).delete(`/api/transcribe-jobs/${jobId}`);

  assert.equal(res.status, 204);
  assert.equal(
    auditLog.getAll().filter((entry) => entry.event !== "DATA_ERASED").length,
    0,
    "likę audito įrašai turi būti pašalinti"
  );
});

test("visiškai nežinomas ID vis dar grąžina 404", async () => {
  auditLog.clear();

  const res = await request(app).delete(
    "/api/transcribe-jobs/99999999-8888-7777-6666-555555555555"
  );

  assert.equal(res.status, 404);
});

test("ištrynimo kvitas įrašomas ir NĖRA susietas su subjektu", async () => {
  auditLog.clear();

  const job = await jobStore.create({ type: jobStore.JOB_TYPES.TRANSCRIPTION });
  await jobStore.update(job.id, { status: jobStore.STATUS.COMPLETED, result: { text: "x" } });
  auditLog.record({ jobId: job.id, transcriptionProvider: "mock", success: true });

  const res = await request(app).delete(`/api/transcribe-jobs/${job.id}`);
  assert.equal(res.status, 204);

  const receipts = auditLog.getAll().filter((entry) => entry.event === "DATA_ERASED");

  assert.equal(receipts.length, 1, "turi likti įrodymas, kad ištrynimas įvyko");
  assert.equal(receipts[0].subjectId, null, "kvitas negali būti susietas su subjektu");
  assert.match(receipts[0].details, /jobStore=deleted/);

  // Pakartotinis to paties jobo ištrynimas kvito nepašalina.
  assert.equal(await auditLog.removeBySubjectIdentifier(job.id), 0);
  assert.equal(auditLog.getAll().filter((e) => e.event === "DATA_ERASED").length, 1);
});

test("deletion_pending jobas pakartojamas automatiškai", async () => {
  auditLog.clear();

  const job = await jobStore.create({ type: jobStore.JOB_TYPES.TRANSCRIPTION });
  await jobStore.update(job.id, {
    status: jobStore.STATUS.FAILED,
    deletion_pending: true,
  });

  const summary = await retryPendingDeletions();

  assert.ok(summary.attempted >= 1);
  assert.ok(summary.succeeded >= 1);
  assert.equal(await jobStore.get(job.id), null, "pakartojimas turi užbaigti ištrynimą");
});

test("lenktynės: du vienalaikiai DELETE - vienas 204, kitas 404, be avarijos", async () => {
  const job = await jobStore.create({ type: jobStore.JOB_TYPES.TRANSCRIPTION });
  await jobStore.update(job.id, { status: jobStore.STATUS.COMPLETED, result: { text: "x" } });

  const [first, second] = await Promise.all([
    request(app).delete(`/api/transcribe-jobs/${job.id}`),
    request(app).delete(`/api/transcribe-jobs/${job.id}`),
  ]);

  const statuses = [first.status, second.status].sort();

  assert.ok(
    statuses.every((status) => [204, 404].includes(status)),
    `netikėti statusai: ${statuses.join(", ")}`
  );
  assert.equal(await jobStore.get(job.id), null);
});

test("lenktynės: DELETE kol jobas dar aktyvus -> 409, jobas nepaliestas", async () => {
  const wav = Buffer.alloc(64);
  wav.write("RIFF", 0, "ascii");
  wav.write("WAVE", 8, "ascii");

  const createRes = await request(app)
    .post("/api/transcribe-jobs")
    .attach("audio", wav, { filename: "irasas.wav", contentType: "audio/wav" });

  const jobId = createRes.body.jobId;

  const delRes = await request(app).delete(`/api/transcribe-jobs/${jobId}`);
  assert.equal(delRes.status, 409);

  // Palaukiam pabaigos ir sutvarkom.
  for (let i = 0; i < 40; i += 1) {
    const poll = await request(app).get(`/api/transcribe-jobs/${jobId}`);
    if (["completed", "failed"].includes(poll.body.status)) break;
    await wait(50);
  }

  await request(app).delete(`/api/transcribe-jobs/${jobId}`);
});

test("jobStore įrašas dingsta tarp del() ir update() - klaida netrikdo srauto", async () => {
  const { releaseAudio } = require("../utils/audioCleanup");
  const fileStorage = require("../utils/fileStorage");

  const key = await fileStorage.put(Buffer.from("audio"), { ext: ".wav" });
  const job = await jobStore.create({ type: jobStore.JOB_TYPES.TRANSCRIPTION, storageKey: key });

  // Imituojam lenktynes: jobo nebėra, kai valymas bando nulinti storageKey.
  await jobStore.remove(job.id);

  const removed = await releaseAudio(job.id, key);

  assert.equal(removed, true, "failas ištrintas - tai svarbiausia");
});

test("audio valymo klaida pažymima ATSKIRA vėliava (ne deletion_pending)", async () => {
  // Regresija: anksčiau releaseAudio() tik palikdavo storageKey ir nieko
  // nepažymėdavo, tad nebaigto valymo niekas nepamatydavo, o po jobStore TTL
  // dingdavo vienintelė nuoroda į likusį audio failą.
  const fileStorage = require("../utils/fileStorage");
  const { releaseAudio } = require("../utils/audioCleanup");

  const key = await fileStorage.put(Buffer.from("audio"), { ext: ".wav" });
  const job = await jobStore.create({
    type: jobStore.JOB_TYPES.TRANSCRIPTION,
    storageKey: key,
  });
  await jobStore.update(job.id, {
    status: jobStore.STATUS.COMPLETED,
    result: { text: "vertinga transkripcija" },
  });

  // Priverčiam del() kristi: raktas rodo į katalogą, ne failą.
  const failingKey = "uploads";
  assert.equal(await releaseAudio(job.id, failingKey), false);

  const flagged = await jobStore.get(job.id);
  assert.equal(flagged.audio_cleanup_pending, true);
  assert.equal(
    flagged.deletion_pending,
    undefined,
    "techninis audio valymas NETURI būti painiojamas su viso jobo ištrynimu"
  );
  assert.ok(flagged.result, "transkripcijos rezultatas turi likti prieinamas");

  await fileStorage.del(key).catch(() => {});
  await jobStore.remove(job.id);
});

test("audio valymo retry ištrina TIK audio, rezultatą palieka", async () => {
  const fileStorage = require("../utils/fileStorage");
  const { retryPendingAudioCleanups } = require("../utils/deletionRetry");

  const key = await fileStorage.put(Buffer.from("audio"), { ext: ".wav" });
  const job = await jobStore.create({
    type: jobStore.JOB_TYPES.TRANSCRIPTION,
    storageKey: key,
  });
  await jobStore.update(job.id, {
    status: jobStore.STATUS.COMPLETED,
    result: { text: "vertinga transkripcija" },
    audio_cleanup_pending: true,
  });

  const summary = await retryPendingAudioCleanups();

  assert.ok(summary.succeeded >= 1);

  const after = await jobStore.get(job.id);
  assert.ok(after, "jobas turi LIKTI - trinamas tik audio");
  assert.equal(after.storageKey, null);
  assert.equal(after.audio_cleanup_pending, false);
  assert.ok(after.result, "rezultatas nepaliestas");

  await jobStore.remove(job.id);
});

test("nebaigto valymo jobas neišmetamas per TTL", async () => {
  // jobStore įrašas yra vienintelis šaltinis, iš kurio žinomas storageKey.
  const job = await jobStore.create({
    type: jobStore.JOB_TYPES.TRANSCRIPTION,
    storageKey: "uploads/likes.wav",
  });
  await jobStore.update(job.id, {
    status: jobStore.STATUS.COMPLETED,
    audio_cleanup_pending: true,
  });

  const farFuture = Date.now() + 10 * 24 * 60 * 60 * 1000;
  await jobStore.sweepExpired(farFuture);

  assert.ok(await jobStore.get(job.id), "pažymėtas jobas turi išlikti po TTL");

  await jobStore.update(job.id, { audio_cleanup_pending: false });
  await jobStore.sweepExpired(farFuture);
  assert.equal(await jobStore.get(job.id), null, "be vėliavos - išmetamas normaliai");
});

test("nežinomas ID nesukuria klaidingo DATA_ERASED kvito", async () => {
  auditLog.clear();

  const res = await request(app).delete(
    "/api/transcribe-jobs/00000000-1111-2222-3333-444444444444"
  );

  assert.equal(res.status, 404);
  assert.equal(
    auditLog.getAll().filter((entry) => entry.event === "DATA_ERASED").length,
    0,
    "niekas nebuvo ištrinta - kvito būti neturi"
  );
});
