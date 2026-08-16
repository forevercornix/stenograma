const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.BACKUP_ENABLED = "true";
process.env.LLM_PROVIDER = "mock";
process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.DIARIZATION_PROVIDER = "none";
process.env.RATE_LIMIT_MAX_REQUESTS = "500";
process.env.RATE_LIMIT_GENERAL_MAX = "500";
process.env.RATE_LIMIT_LOGIN_IP_MAX = "500";
process.env.RATE_LIMIT_LOGIN_ACCOUNT_MAX = "500";

const { hashPassword } = require("../utils/credentials");

const ADMIN_PASSWORD = "admin-kopijoms-slaptas-1";
const OPERATOR_PASSWORD = "operator-kopijoms-slaptas-2";

process.env.AUTH_USERS = `sysadmin:administrator:${hashPassword(ADMIN_PASSWORD)}:11111111-1111-4111-8111-111111111111,darbuotojas:operator:${hashPassword(
  OPERATOR_PASSWORD
)}:33333333-3333-4333-8333-333333333333`;
process.env.API_KEY = "";

const request = require("supertest");
const jobStore = require("../utils/jobStore");
const tombstones = require("../utils/deletionTombstones");
const maintenanceLock = require("../utils/maintenanceLock");
const app = require("../server");
app._setReadyForTests();

/**
 * #20 PR4: KOPIJŲ ENDPOINT'AI.
 *
 * ⚠️ ŠIS FAILAS UŽDARO SPRAGĄ, kurią review paliko kaip acceptance criterion:
 * iki šiol `backup:create` ir `backup:restore` buvo TIK leidimų lentelėje, o
 * testai tikrino `hasPermission()`, ne realų įėjimo tašką.
 *
 * Lentelė nėra saugumo garantija. Čia ji pirmą kartą tikrinama per HTTP.
 */

test.after(() => {
  tombstones._stopSweepForTests();
  maintenanceLock._resetForTests();
});

async function loginAs(username, password) {
  const res = await request(app).post("/api/auth/login").send({ username, password });
  assert.equal(res.status, 200, `nepavyko prisijungti kaip ${username}`);
  return res.headers["set-cookie"][0];
}

async function completedJob() {
  await jobStore.init();
  const job = await jobStore.create({ type: jobStore.JOB_TYPES.PROTOCOL });
  await jobStore.update(job.id, { status: "completed", result: { x: 1 } });
  return job;
}

async function clearJobs() {
  await jobStore.init();
  for (const job of await jobStore.listAll()) await jobStore.remove(job.id);
}

/* ------------------------------------------------------------------ */
/* RBAC PER TIKRĄ HTTP                                                 */
/* ------------------------------------------------------------------ */

test("RBAC: ANONIMAS negali kurti kopijos (401)", async () => {
  const res = await request(app).post("/api/admin/backups");

  assert.equal(res.status, 401);
  assert.equal(res.body.code, "SESSION_REQUIRED");
});

test("RBAC: ANONIMAS negali atkurti (401)", async () => {
  const res = await request(app).post("/api/admin/backups/restore");

  assert.equal(res.status, 401);
  assert.equal(res.body.code, "SESSION_REQUIRED");
});

test("RBAC: OPERATORIUS negali kurti kopijos (403)", async () => {
  /**
   * Kopija yra visų duomenų nuotrauka vienoje vietoje – galingiausias
   * eksportas, koks įmanomas. 403, ne 401: vartotojas ŽINOMAS, tik neturi
   * teisės.
   */
  const cookie = await loginAs("darbuotojas", OPERATOR_PASSWORD);
  const res = await request(app).post("/api/admin/backups").set("Cookie", cookie);

  assert.equal(res.status, 403);
  assert.equal(res.body.code, "PERMISSION_DENIED");
  assert.equal(res.body.requiredPermission, "backup:create");
});

test("RBAC: OPERATORIUS negali atkurti (403)", async () => {
  /**
   * Atkūrimas destruktyvesnis už kūrimą: jis PERRAŠO esamą būseną, tad
   * griežtesnis net už `job:delete`.
   */
  const cookie = await loginAs("darbuotojas", OPERATOR_PASSWORD);
  const res = await request(app).post("/api/admin/backups/restore").set("Cookie", cookie);

  assert.equal(res.status, 403);
  assert.equal(res.body.requiredPermission, "backup:restore");
});

test("RBAC: ADMINISTRATORIUS gali kurti kopiją", async () => {
  await clearJobs();
  await completedJob();

  const cookie = await loginAs("sysadmin", ADMIN_PASSWORD);
  const res = await request(app).post("/api/admin/backups").set("Cookie", cookie);

  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /multipart\/mixed/);
});

test("RBAC: leidimai tikrinami ATSKIRAI kūrimui ir atkūrimui", async () => {
  /**
   * Bendra „administratoriaus" patikra būtų silpnesnė: ji reikštų, kad vienos
   * teisės suteikimas duoda ir kitą, nors jų rizikos skiriasi.
   */
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "..", "routes", "backup.js"), "utf8");

  assert.match(source, /requirePermission\(PERMISSIONS\.BACKUP_CREATE\)/);
  assert.match(source, /requirePermission\(PERMISSIONS\.BACKUP_RESTORE\)/);
});

/* ------------------------------------------------------------------ */
/* ATSAKYMO FORMATAS                                                   */
/* ------------------------------------------------------------------ */

test("ATSISIUNTIMAS: `multipart/mixed` su manifestu ir duomenimis", async () => {
  await clearJobs();
  await completedJob();

  const cookie = await loginAs("sysadmin", ADMIN_PASSWORD);

  /**
   * Supertest `multipart/mixed` neparsina savarankiškai – renkam žalius baitus.
   * Be `.parse()` `res.body` būtų tuščias objektas, ir testas tikrintų nieko.
   */
  const res = await request(app)
    .post("/api/admin/backups")
    .set("Cookie", cookie)
    .buffer()
    .parse((response, cb) => {
      const chunks = [];
      response.on("data", (c) => chunks.push(c));
      response.on("end", () => cb(null, Buffer.concat(chunks)));
    });

  assert.equal(res.status, 200);

  const body = res.body.toString("utf8");

  assert.match(body, /filename="manifest\.json"/);
  assert.match(body, /filename="backup\.data"/);
  assert.match(res.headers["content-disposition"], /attachment/);
});

test("ATSISIUNTIMAS: serveris kopijos NESAUGO", () => {
  /**
   * Serverio saugykla atvertų retencijos, valymo, prieigos ir disko
   * užsipildymo klausimus – tai atskira posistemė, ne endpointo dalis
   * (#20 sprendimų žurnalas, Decision 14).
   */
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "..", "routes", "backup.js"), "utf8");

  assert.ok(!/fs\.writeFile|createWriteStream/.test(source), "kopija neturi būti rašoma į diską");
});

/* ------------------------------------------------------------------ */
/* ĮKĖLIMO RIBOS                                                       */
/* ------------------------------------------------------------------ */

test("ĮKĖLIMAS: trūkstamas laukas atmetamas (400)", async () => {
  const cookie = await loginAs("sysadmin", ADMIN_PASSWORD);

  const res = await request(app)
    .post("/api/admin/backups/restore")
    .set("Cookie", cookie)
    .attach("manifest", Buffer.from("{}"), "manifest.json");

  assert.equal(res.status, 400);
  assert.equal(res.body.code, "BACKUP_PARTS_MISSING");
});

test("ĮKĖLIMAS: netikėtas laukas atmetamas (400)", async () => {
  /**
   * Neaiški įvestis atkūrimo kelyje reikštų spėjimą, kurį failą laikyti
   * kopija.
   */
  const cookie = await loginAs("sysadmin", ADMIN_PASSWORD);

  const res = await request(app)
    .post("/api/admin/backups/restore")
    .set("Cookie", cookie)
    .attach("manifest", Buffer.from("{}"), "manifest.json")
    .attach("data", Buffer.from("x"), "backup.data")
    .attach("kazkas", Buffer.from("y"), "kita.bin");

  assert.equal(res.status, 400);
  assert.equal(res.body.code, "BACKUP_UNEXPECTED_PART");
});

test("ĮKĖLIMAS: per didelis MANIFESTAS atmetamas (413)", async () => {
  /**
   * Manifestas yra metaduomenys – tipai, skaičiai, kontrolinės sumos.
   * Didesnis failas reiškia arba klaidą, arba bandymą išnaudoti atmintį.
   */
  const cookie = await loginAs("sysadmin", ADMIN_PASSWORD);

  const huge = Buffer.alloc(300 * 1024, "x"); // > 256 KB
  const res = await request(app)
    .post("/api/admin/backups/restore")
    .set("Cookie", cookie)
    .attach("manifest", huge, "manifest.json")
    .attach("data", Buffer.from("x"), "backup.data");

  assert.equal(res.status, 413, "per didelis manifestas turi duoti 413, ne 400");
  assert.equal(res.body.code, "BACKUP_MANIFEST_TOO_LARGE");
});

test("ĮKĖLIMAS: netinkamas manifesto JSON atmetamas (400)", async () => {
  const cookie = await loginAs("sysadmin", ADMIN_PASSWORD);

  const res = await request(app)
    .post("/api/admin/backups/restore")
    .set("Cookie", cookie)
    .attach("manifest", Buffer.from("ne json"), "manifest.json")
    .attach("data", Buffer.from("x"), "backup.data");

  assert.equal(res.status, 400);
  assert.equal(res.body.code, "BACKUP_MANIFEST_INVALID");
});

/* ------------------------------------------------------------------ */
/* AKTYVŪS DARBAI IR PRIEŽIŪROS UŽRAKTAS                               */
/* ------------------------------------------------------------------ */

test("KONFLIKTAS: atkurti su AKTYVIAIS darbais negalima (409)", async () => {
  await clearJobs();
  await jobStore.create({ type: jobStore.JOB_TYPES.TRANSCRIPTION }); // lieka `queued`

  const cookie = await loginAs("sysadmin", ADMIN_PASSWORD);

  const res = await request(app)
    .post("/api/admin/backups/restore")
    .set("Cookie", cookie)
    .attach("manifest", Buffer.from(JSON.stringify({ formatVersion: 1 })), "manifest.json")
    .attach("data", Buffer.from("{}"), "backup.data");

  assert.equal(res.status, 409);
  assert.equal(res.body.code, "ACTIVE_JOBS_PRESENT");
});

test("KONFLIKTAS: pranešime tik SKAIČIUS, jokio darbų turinio", async () => {
  await clearJobs();
  const job = await jobStore.create({ type: jobStore.JOB_TYPES.TRANSCRIPTION });
  await jobStore.update(job.id, { transcript: "slaptas susitikimo tekstas" });

  const cookie = await loginAs("sysadmin", ADMIN_PASSWORD);

  const res = await request(app)
    .post("/api/admin/backups/restore")
    .set("Cookie", cookie)
    .attach("manifest", Buffer.from("{}"), "manifest.json")
    .attach("data", Buffer.from("{}"), "backup.data");

  const serialized = JSON.stringify(res.body);

  assert.ok(!serialized.includes("slaptas susitikimo tekstas"), "jokio darbų turinio");
  assert.ok(!serialized.includes(job.id), "net jobo ID neatskleidžiamas");
});

test("UŽRAKTAS: TOCTOU langas uždarytas – naujų darbų kurti negalima", async () => {
  /**
   * ⚠️ SVARBIAUSIA šio failo garantija.
   *
   * Vien 409 patikros endpointo pradžioje NEUŽTENKA: tarp jos ir pritaikymo
   * worker'is gali paimti naują darbą iš eilės arba vartotojas jį sukurti.
   * Patikra buvo teisinga tuo momentu, kai ją atlikom, ir neteisinga tada, kai
   * ja rėmėmės.
   */
  maintenanceLock._resetForTests();
  await clearJobs();

  maintenanceLock.acquire("test_restore");

  try {
    await assert.rejects(
      () => jobStore.create({ type: jobStore.JOB_TYPES.PROTOCOL }),
      (e) => e.code === "MAINTENANCE_IN_PROGRESS",
      "su užraktu naujų darbų kurti negalima"
    );
  } finally {
    maintenanceLock.release();
  }

  // Nuėmus užraktą – vėl galima.
  const job = await jobStore.create({ type: jobStore.JOB_TYPES.PROTOCOL });
  assert.ok(job, "po priežiūros darbai vėl priimami");
});

test("UŽRAKTAS: nuimamas net operacijai NEPAVYKUS", async () => {
  /**
   * Be `finally` nepavykęs atkūrimas paliktų sistemą užblokuotą, o operatorius
   * matytų „vyksta priežiūros operacija" po to, kai ji seniai baigėsi.
   */
  maintenanceLock._resetForTests();

  const outcome = await maintenanceLock.withLock("test", async () => {
    throw new Error("gedimas");
  }).catch(() => null);

  assert.equal(maintenanceLock.isLocked(), false, "užraktas turi būti nuimtas net po gedimo");
  void outcome;
});

test("UŽRAKTAS: turi MAKSIMALIĄ trukmę", () => {
  /**
   * Procesui nukritus vidury atkūrimo sistema kitaip liktų užblokuota
   * neribotai, ir vienintelė išeitis būtų restartas.
   */
  maintenanceLock._resetForTests();

  maintenanceLock.acquire("test", { maxHoldMs: 1 });
  assert.equal(maintenanceLock.isLocked(), true);

  const start = Date.now();
  while (Date.now() - start < 5) {
    /* laukiam, kol pasibaigs */
  }

  assert.equal(maintenanceLock.isLocked(), false, "pasibaigęs užraktas nebegalioja");
});

/* ------------------------------------------------------------------ */
/* PILNAS CIKLAS PER HTTP                                              */
/* ------------------------------------------------------------------ */

test("E2E: kopija sukuriama ir atkuriama per TIKRUS endpoint'us", async () => {
  await clearJobs();
  maintenanceLock._resetForTests();

  const job = await completedJob();
  const cookie = await loginAs("sysadmin", ADMIN_PASSWORD);

  // 1. Sukuriam kopiją per HTTP.
  const created = await request(app).post("/api/admin/backups").set("Cookie", cookie).buffer().parse((res, cb) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });

  assert.equal(created.status, 200);

  // 2. Išskiriam dalis iš multipart atsakymo.
  const boundary = created.headers["content-type"].match(/boundary=([^\s;]+)/)[1];
  const { manifest, data } = splitMultipart(created.body, boundary);

  assert.ok(manifest.formatVersion, "manifestas turi būti perskaitomas");

  // 3. Ištrinam jobą ir atkuriam.
  await jobStore.remove(job.id);
  assert.equal(await jobStore.get(job.id), null);

  const restored = await request(app)
    .post("/api/admin/backups/restore")
    .set("Cookie", cookie)
    .attach("manifest", Buffer.from(JSON.stringify(manifest)), "manifest.json")
    .attach("data", data, "backup.data");

  assert.equal(restored.status, 200, `atkūrimas nepavyko: ${JSON.stringify(restored.body)}`);
  assert.ok(restored.body.completedSteps.includes("applied"));
  assert.ok(await jobStore.get(job.id), "jobas turi grįžti");
});

/** Išskiria `manifest.json` ir `backup.data` iš `multipart/mixed` atsakymo. */
function splitMultipart(buffer, boundary) {
  const text = buffer.toString("binary");
  const parts = text.split(`--${boundary}`);

  let manifest = null;
  let data = null;

  for (const part of parts) {
    const separator = part.indexOf("\r\n\r\n");
    if (separator === -1) continue;

    const headers = part.slice(0, separator);
    const body = part.slice(separator + 4).replace(/\r\n$/, "");

    if (headers.includes("manifest.json")) manifest = JSON.parse(body);
    else if (headers.includes("backup.data")) data = Buffer.from(body, "binary");
  }

  return { manifest, data };
}
