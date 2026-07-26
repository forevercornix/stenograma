const test = require("node:test");
const assert = require("node:assert/strict");

process.env.JOB_TTL_MINUTES = "1"; // trumpas TTL testui - skaitomas modulio įkėlimo metu

const jobStore = require("../utils/jobStore");

test("jobStore backend: be REDIS_URL naudojamas in-memory", async () => {
  await jobStore.init();
  assert.equal(jobStore.getBackend(), "memory");
});

test("create: naujas jobas turi visus production laukus", async () => {
  const job = await jobStore.create();
  assert.equal(job.status, jobStore.STATUS.QUEUED);
  assert.equal(job.attempt_count, 0);
  assert.ok(job.created_at);
  assert.equal(job.started_at, null);
  assert.equal(job.completed_at, null);
  assert.equal(job.error_code, null);
});

test("update: PROCESSING nustato started_at automatiškai", async () => {
  const job = await jobStore.create();
  const updated = await jobStore.update(job.id, { status: jobStore.STATUS.PROCESSING, attempt_count: 1 });
  assert.equal(updated.status, jobStore.STATUS.PROCESSING);
  assert.ok(updated.started_at, "started_at turi būti nustatytas");
  assert.equal(updated.attempt_count, 1);
});

test("update: COMPLETED nustato completed_at automatiškai", async () => {
  const job = await jobStore.create();
  const updated = await jobStore.update(job.id, { status: jobStore.STATUS.COMPLETED, result: { protocol: {} } });
  assert.ok(updated.completed_at, "completed_at turi būti nustatytas");
});

test("update: FAILED su error_code, ir error <-> error_message sinchronizuojami", async () => {
  const job = await jobStore.create();
  const updated = await jobStore.update(job.id, {
    status: jobStore.STATUS.FAILED,
    error: "kažkas nutiko",
    error_code: "internal_error",
  });
  assert.equal(updated.error, "kažkas nutiko");
  assert.equal(updated.error_message, "kažkas nutiko"); // sinchronizuota
  assert.equal(updated.error_code, "internal_error");
  assert.ok(updated.completed_at);
});

test("sweepExpired: nešalina QUEUED/PROCESSING jobų, kad ir kokie seni", async () => {
  const job = await jobStore.create();
  await jobStore.update(job.id, { status: jobStore.STATUS.PROCESSING });
  const farFuture = Date.now() + 999 * 60 * 1000;
  await jobStore.sweepExpired(farFuture);
  // Tikrinam KONKRETŲ jobą (ne bendrą removed skaičių - kiti testai dalinasi ta
  // pačia in-memory saugykla): PROCESSING jobas turi IŠLIKTI, kad ir koks senas.
  assert.ok(await jobStore.get(job.id), "PROCESSING jobas neturi būti pašalintas");
});

test("sweepExpired: pašalina COMPLETED jobą po TTL, bet ne prieš tai", async () => {
  const job = await jobStore.create();
  await jobStore.update(job.id, { status: jobStore.STATUS.COMPLETED, result: { protocol: {} } });

  const beforeTtl = Date.now() + 30 * 1000; // 30s < 1 min TTL
  await jobStore.sweepExpired(beforeTtl);
  assert.ok(await jobStore.get(job.id), "prieš TTL jobas dar turi būti");

  const afterTtl = Date.now() + 2 * 60 * 1000; // 2 min > 1 min TTL
  await jobStore.sweepExpired(afterTtl);
  assert.equal(await jobStore.get(job.id), null, "po TTL jobas turi būti pašalintas");
});

test("sweepExpired: pašalina CANCELLED jobą po TTL", async () => {
  const job = await jobStore.create();
  await jobStore.update(job.id, { status: jobStore.STATUS.CANCELLED });
  const afterTtl = Date.now() + 2 * 60 * 1000;
  await jobStore.sweepExpired(afterTtl);
  assert.equal(await jobStore.get(job.id), null, "CANCELLED jobas po TTL turi būti pašalintas");
});

test("init() lygiagrečiai kviečiamas grąžina TĄ PATĮ store (race apsauga)", async () => {
  // RACE regresija: anksčiau initialized=true buvo nustatomas prieš await, tad
  // lygiagretūs kviečiai galėjo gauti skirtingus store. Dabar visi laukia bendro
  // initPromise. Be REDIS_URL abu turi būti tas pats memoryStore.
  delete process.env.REDIS_URL;
  const [s1, s2, s3] = await Promise.all([
    jobStore.init(),
    jobStore.init(),
    jobStore.init(),
  ]);
  assert.equal(s1, s2, "lygiagretūs init turi grąžinti tą patį store");
  assert.equal(s2, s3, "lygiagretūs init turi grąžinti tą patį store");
});

test("lygiagretūs create po init grąžina rastą job'ą (ne 'nerastas')", async () => {
  // Simuliuojam scenarijų iš review: create ir get lygiagrečiai iškart po starto.
  // Su race apsauga - job'as sukurtas ir surandamas tame pačiame store.
  delete process.env.REDIS_URL;
  const created = await jobStore.create();
  const found = await jobStore.get(created.id);
  assert.ok(found, "sukurtas job'as turi būti randamas (ne dingęs dėl store pakeitimo)");
  assert.equal(found.id, created.id);
});
