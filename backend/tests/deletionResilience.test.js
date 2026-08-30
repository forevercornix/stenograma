const { markCompleted } = require("./helpers/jobPhaseFixtures");
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
  // 24 val., auditas 30 d. Anksčiau DELETE pradėdavo nuo jobStore.system.get() ir,
  // jam grąžinus null, iškart atsakydavo 404 - teisė ištrinti dingdavo
  // ANKSČIAU nei patys duomenys.
  auditLog.clear();

  const jobId = "11111111-2222-3333-4444-555555555555";
  await auditLog.record({ jobId, transcriptionProvider: "mock", success: true });

  assert.equal(await jobStore.system.get(jobId), null, "jobStore įrašo neturi būti");
  assert.equal((await auditLog.getAll()).length, 1);

  const res = await request(app).delete(`/api/transcribe-jobs/${jobId}`);

  assert.equal(res.status, 204);
  assert.equal(
    (await auditLog.getAll()).filter((entry) => entry.event !== "DATA_ERASED").length,
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

  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.TRANSCRIPTION });
  await markCompleted(jobStore.system, job.id, { result: { text: "x" } });
  await auditLog.record({ jobId: job.id, transcriptionProvider: "mock", success: true });

  const res = await request(app).delete(`/api/transcribe-jobs/${job.id}`);
  assert.equal(res.status, 204);

  const receipts = (await auditLog.getAll()).filter((entry) => entry.event === "DATA_ERASED");

  assert.equal(receipts.length, 1, "turi likti įrodymas, kad ištrynimas įvyko");
  assert.equal(receipts[0].subjectId, null, "kvitas negali būti susietas su subjektu");
  assert.match(receipts[0].details, /jobStore=deleted/);

  // Pakartotinis to paties jobo ištrynimas kvito nepašalina.
  assert.equal(await auditLog.removeBySubjectIdentifier(job.id), 0);
  assert.equal((await auditLog.getAll()).filter((e) => e.event === "DATA_ERASED").length, 1);
});

test("deletion_pending jobas pakartojamas automatiškai", async () => {
  auditLog.clear();

  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.TRANSCRIPTION });
  await jobStore.system.finish(job.id, jobStore.STATUS.FAILED, { deletion_pending: true });

  const summary = await retryPendingDeletions();

  assert.ok(summary.attempted >= 1);
  assert.ok(summary.succeeded >= 1);
  assert.equal(await jobStore.system.get(job.id), null, "pakartojimas turi užbaigti ištrynimą");
});

test("lenktynės: du vienalaikiai DELETE - vienas 204, kitas 404, be avarijos", async () => {
  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.TRANSCRIPTION });
  await markCompleted(jobStore.system, job.id, { result: { text: "x" } });

  const [first, second] = await Promise.all([
    request(app).delete(`/api/transcribe-jobs/${job.id}`),
    request(app).delete(`/api/transcribe-jobs/${job.id}`),
  ]);

  const statuses = [first.status, second.status].sort();

  assert.ok(
    statuses.every((status) => [204, 404].includes(status)),
    `netikėti statusai: ${statuses.join(", ")}`
  );
  assert.equal(await jobStore.system.get(job.id), null);
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
  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.TRANSCRIPTION, storageKey: key });

  // Imituojam lenktynes: jobo nebėra, kai valymas bando nulinti storageKey.
  await jobStore.system.remove(job.id);

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
  const job = await jobStore.create({ ownerKind: "unowned",
    type: jobStore.JOB_TYPES.TRANSCRIPTION,
    storageKey: key,
  });
  await markCompleted(jobStore.system, job.id, { result: { text: "vertinga transkripcija" } });

  // Priverčiam del() kristi: raktas rodo į katalogą, ne failą.
  const failingKey = "uploads";
  assert.equal(await releaseAudio(job.id, failingKey), false);

  const flagged = await jobStore.system.get(job.id);
  assert.equal(flagged.audio_cleanup_pending, true);
  assert.equal(
    flagged.deletion_pending,
    undefined,
    "techninis audio valymas NETURI būti painiojamas su viso jobo ištrynimu"
  );
  assert.ok(flagged.result, "transkripcijos rezultatas turi likti prieinamas");

  await fileStorage.del(key).catch(() => {});
  await jobStore.system.remove(job.id);
});

test("audio valymo retry ištrina TIK audio, rezultatą palieka", async () => {
  const fileStorage = require("../utils/fileStorage");
  const { retryPendingAudioCleanups } = require("../utils/deletionRetry");

  const key = await fileStorage.put(Buffer.from("audio"), { ext: ".wav" });
  const job = await jobStore.create({ ownerKind: "unowned",
    type: jobStore.JOB_TYPES.TRANSCRIPTION,
    storageKey: key,
  });
  await markCompleted(jobStore.system, job.id, { result: { text: "vertinga transkripcija" },
    audio_cleanup_pending: true });

  const summary = await retryPendingAudioCleanups();

  assert.ok(summary.succeeded >= 1);

  const after = await jobStore.system.get(job.id);
  assert.ok(after, "jobas turi LIKTI - trinamas tik audio");
  assert.equal(after.storageKey, null);
  assert.equal(after.audio_cleanup_pending, false);
  assert.ok(after.result, "rezultatas nepaliestas");

  await jobStore.system.remove(job.id);
});

test("nebaigto valymo jobas neišmetamas per TTL", async () => {
  // jobStore įrašas yra vienintelis šaltinis, iš kurio žinomas storageKey.
  const job = await jobStore.create({ ownerKind: "unowned",
    type: jobStore.JOB_TYPES.TRANSCRIPTION,
    storageKey: "uploads/likes.wav",
  });
  await markCompleted(jobStore.system, job.id, { audio_cleanup_pending: true });

  const farFuture = Date.now() + 10 * 24 * 60 * 60 * 1000;
  await jobStore.sweepExpired(farFuture);

  assert.ok(await jobStore.system.get(job.id), "pažymėtas jobas turi išlikti po TTL");

  await jobStore.system.update(job.id, { audio_cleanup_pending: false });
  await jobStore.sweepExpired(farFuture);
  assert.equal(await jobStore.system.get(job.id), null, "be vėliavos - išmetamas normaliai");
});

test("nežinomas ID nesukuria klaidingo DATA_ERASED kvito", async () => {
  auditLog.clear();

  const res = await request(app).delete(
    "/api/transcribe-jobs/00000000-1111-2222-3333-444444444444"
  );

  assert.equal(res.status, 404);
  assert.equal(
    (await auditLog.getAll()).filter((entry) => entry.event === "DATA_ERASED").length,
    0,
    "niekas nebuvo ištrinta - kvito būti neturi"
  );
});

test("lenktynės: DELETE ir scheduler retry tuo pačiu metu", async () => {
  // Idempotencija turėtų tai padengti, bet be testo tai tik prielaida.
  const { retryPendingDeletions } = require("../utils/deletionRetry");
  const fileStorage = require("../utils/fileStorage");

  auditLog.clear();

  const key = await fileStorage.put(Buffer.from("audio"), { ext: ".wav" });
  const job = await jobStore.create({ ownerKind: "unowned",
    type: jobStore.JOB_TYPES.TRANSCRIPTION,
    storageKey: key,
  });
  await jobStore.system.finish(job.id, jobStore.STATUS.FAILED, { deletion_pending: true });
  await auditLog.record({ jobId: job.id, transcriptionProvider: "mock", success: false });

  // Abu keliai startuoja vienu metu ir trina TĄ PATĮ jobą.
  const [httpRes, retrySummary] = await Promise.all([
    request(app).delete(`/api/transcribe-jobs/${job.id}`),
    retryPendingDeletions(),
  ]);

  assert.ok(
    [204, 404].includes(httpRes.status),
    `netikėtas statusas: ${httpRes.status} ${JSON.stringify(httpRes.body)}`
  );
  // Ant `attempted` netikrinam: jei HTTP kelias nugalėjo pirmas, scheduler'is
  // jobo tiesiog neberas. Svarbu, kad nė vienas bandymas nesukluptų.
  assert.equal(retrySummary.failed, 0);

  // Nesvarbu, kuris nugalėjo - galutinė būsena turi būti ta pati.
  assert.equal(await jobStore.system.get(job.id), null);
  assert.equal(
    (await auditLog.getAll()).filter((entry) => entry.subjectId === auditLog.pseudonymizeIdentifier(job.id))
      .length,
    0
  );
  assert.equal(await fileStorage.del(key), false, "audio failo neturi būti");
});

test("backoff: intervalas ilgėja su bandymais ir turi ribą", () => {
  const { _backoffMs } = require("../utils/deletionRetry");
  const base = 10 * 60 * 1000;

  assert.equal(_backoffMs(1, base), base);
  assert.equal(_backoffMs(2, base), 2 * base);
  assert.equal(_backoffMs(4, base), 8 * base);
  assert.equal(_backoffMs(50, base), 32 * base, "turi būti riba, ne begalinis augimas");
});

test("backoff: dar neatėjęs bandymo laikas praleidžiamas (deferred)", async () => {
  const { retryPendingAudioCleanups } = require("../utils/deletionRetry");

  const job = await jobStore.create({ ownerKind: "unowned",
    type: jobStore.JOB_TYPES.TRANSCRIPTION,
    storageKey: "uploads/dar-ne.wav",
  });
  await markCompleted(jobStore.system, job.id, { audio_cleanup_pending: true,
    audio_cleanup_attempts: 2,
    audio_cleanup_next_attempt_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() });

  const summary = await retryPendingAudioCleanups();

  assert.ok(summary.deferred >= 1, "jobas turi būti atidėtas, o ne bandomas iš karto");

  const untouched = await jobStore.system.get(job.id);
  assert.equal(untouched.audio_cleanup_attempts, 2, "skaitliukas neturi keistis");

  await jobStore.system.update(job.id, { audio_cleanup_pending: false });
  await jobStore.system.remove(job.id);
});

test("retry suvestinė: deferred NEįskaičiuojami į attempted", async () => {
  const { retryPendingAudioCleanups } = require("../utils/deletionRetry");
  const fileStorage = require("../utils/fileStorage");

  // Vienas jobas paruoštas bandymui, du - atidėti pagal backoff.
  const dueKey = await fileStorage.put(Buffer.from("audio"), { ext: ".wav" });
  const due = await jobStore.create({ ownerKind: "unowned",
    type: jobStore.JOB_TYPES.TRANSCRIPTION,
    storageKey: dueKey,
  });
  await markCompleted(jobStore.system, due.id, { audio_cleanup_pending: true });

  const notDue = [];
  for (let i = 0; i < 2; i += 1) {
    const job = await jobStore.create({ ownerKind: "unowned",
      type: jobStore.JOB_TYPES.TRANSCRIPTION,
      storageKey: `uploads/dar-ne-${i}.wav`,
    });
    await markCompleted(jobStore.system, job.id, { audio_cleanup_pending: true,
      audio_cleanup_attempts: 3,
      audio_cleanup_next_attempt_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
    notDue.push(job);
  }

  const summary = await retryPendingAudioCleanups();

  assert.equal(summary.scanned, 3, "rasta visi pažymėti jobai");
  assert.equal(summary.attempted, 1, "bandytas tik tas, kurio laikas atėjo");
  assert.equal(summary.deferred, 2);
  assert.equal(summary.succeeded, 1);
  assert.equal(
    summary.attempted + summary.deferred,
    summary.scanned,
    "attempted ir deferred neturi persidengti"
  );

  for (const job of [due, ...notDue]) {
    await jobStore.system.update(job.id, { audio_cleanup_pending: false }).catch(() => {});
    await jobStore.system.remove(job.id);
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 * #183 BARJERO NULEMTI HTTP ATSAKYMAI
 * ══════════════════════════════════════════════════════════════════════════ */

test("#183 MARŠRUTAS: svetima `deletion_pending` žyma duoda 202, o ne dubliuotą darbą", async () => {
  /**
   * 7.5a DoD: antras lygiagretus `DELETE` gauna determinuotą atsakymą pagal
   * autoritetingą būseną, ir jokio papildomo I/O nepradedama.
   *
   * ⚠️ TIKRINAMAS IR KŪNAS, IR DUOMENYS. Vien 202 statusas nieko neįrodytų, jei
   * jobStore įrašo tuo metu jau nebūtų - tada tai būtų ne „susilaikėm“, o
   * „ištrynėm ir pameluojam“.
   */
  const tombstones = require("../utils/deletionTombstones");

  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.TRANSCRIPTION });
  await markCompleted(jobStore.system, job.id, { result: { text: "x" } });

  // Kita replika jau pasiėmė šį jobą - žymos šis procesas neįrašė.
  await tombstones.mark(job.id, { reason: "user_request", actorKind: "user" });

  const res = await request(app).delete(`/api/transcribe-jobs/${job.id}`);

  assert.equal(res.status, 202);
  assert.equal(res.body.status, "in_progress");
  assert.ok(await jobStore.system.get(job.id), "202 reiškia, kad darbas NEPRADĖTAS");
});

test("#183 MARŠRUTAS: neišspręsta žyma duoda 503, ne 204", async () => {
  /**
   * Duomenys ištrinti, barjeras liko `deletion_failed`. 204 teigtų patvirtintą
   * ištrynimą, kurio persistentinis įrašas neliudija.
   */
  const tombstones = require("../utils/deletionTombstones");

  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.TRANSCRIPTION });
  await markCompleted(jobStore.system, job.id, { result: { text: "x" } });

  await tombstones.mark(job.id, { reason: "user_request", actorKind: "user" });
  await tombstones.complete(job.id, tombstones.TOMBSTONE_STATUS.FAILED, { failureKind: "retryable" });

  const res = await request(app).delete(`/api/transcribe-jobs/${job.id}`);

  assert.equal(res.status, 503);
  assert.equal(res.body.status, "tombstone_unresolved");
});

test("#183 NUTEKĖJIMAS: našlaičio 503 atsakyme NĖRA klaidų tekstų", async () => {
  /**
   * ⚠️ #19: `expose no filesystem paths, storage keys, Redis keys, provider
   * payloads or deleted content`.
   *
   * Savininko kelias šios taisyklės laikėsi su eksplicitiniu komentaru, o
   * našlaičių kelias siųsdavo `deletion: result.outcome` - kartu su `errors`,
   * kuriuose yra `storage: <žinutė>` ir `jobStore: <žinutė>`. Administracinis
   * kelias negali būti išimtis (AGENTS.md §16).
   *
   * Tikrinamas ATVAIZDAVIMAS, ne maršruto integracija: dirbtinai sugadinti
   * saugyklą per HTTP neįmanoma deterministiškai, o būtent atvaizdavimas ir
   * sprendžia, kas patenka į kūną.
   */
  const { atsakytiNaslaicioValymu } = require("../utils/deletionHttp");

  let kunas = null;
  const res = {
    status(kodas) {
      this._kodas = kodas;
      return this;
    },
    json(turinys) {
      kunas = turinys;
      return this;
    },
  };

  atsakytiNaslaicioValymu(
    res,
    {
      cleaned: false,
      barjeras: null,
      outcome: {
        found: true,
        jobRemoved: false,
        queueJobRemoved: false,
        storageRemoved: false,
        auditEntriesRemoved: 0,
        errors: [
          "storage: ENOENT /var/data/stenograma/uploads/slaptas-raktas.wav",
          "jobStore: WRONGTYPE bull:transcription:42",
        ],
      },
    },
    { jobId: "j1", log: { error() {}, warn() {} } }
  );

  assert.equal(res._kodas, 503);

  const tekstas = JSON.stringify(kunas);
  assert.ok(!("errors" in kunas.deletion), "`errors` laukas negali patekti į atsakymą");
  assert.ok(!tekstas.includes("/var/data"), "failų keliai negali patekti į atsakymą");
  assert.ok(!tekstas.includes("bull:"), "eilės raktai negali patekti į atsakymą");
  assert.equal(kunas.deletion.auditEntriesRemoved, 0, "kiek pašalinta - lieka");
});
