const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Client, Pool } = require("pg");

const { skipWithoutPostgres, testDatabaseUrl, adminDatabaseUrl } = require("./helpers/postgresGuard");
const { stebetiPoola, uzdarytiPoola } = require("./helpers/resourceStack");
const attemptRegistry = require("../utils/attemptRegistry");
const { createPostgresStore } = require("../utils/jobStore/postgresStore");
const { createFsArtifactStore } = require("../utils/artifactStore/fsStore");
/** ⚠️ `STATUS` gyvena `jobStore` fasade, ne `jobPhase` (pastarasis eksportuoja `PHASE`). */
const { STATUS } = require("../utils/jobStore/common");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * VIENAS PAKARTOJIMAS PO TVOROS ATMETIMO (#415, D1–D4).
 *
 * ⚠️ KĄ ŠIS FAILAS ĮRODO. Kad tvoros atmetimas nebeišmeta jau APSKAIČIUOTO rezultato:
 * `finishAtomic` kartoja VIENĄ kartą su nauju bandymu, ir rezultatas išsaugomas be
 * pakartotinio transkribavimo. Ir kad pakartojimas yra tiksliai vienas, eina per visą
 * transakciją su jos užraktu, ir naudoja NAUJĄ `attemptId` bei raktą.
 *
 * ⚠️ TVORA SUKELIAMA PER `registruoti` SEAM'Ą, NE PER LAIKRODĮ. Produkcinė tvora yra
 * 1 val.; laukti jos testas negali, o `MAX_RASYMO_TRUKME_MS` keitimas reikštų, kad
 * tikrinama testinė konstanta. Todėl bandymo eilutė po registracijos SENINAMA tiesiogiai
 * — tas pats būdas, kurį #351 rinkinys jau naudoja (`sukurtiBandyma({ amziusMs })`).
 *
 * ⚠️ ŠIS FAILAS VIETOJE NEVYKDOMAS — reikia tikros PostgreSQL.
 */

const SAKNIS = path.resolve(__dirname, "..");
const DB_URL = testDatabaseUrl("tvorospakartojimas");
const PRALEISTI = skipWithoutPostgres();
const MAX = attemptRegistry.MAX_RASYMO_TRUKME_MS;

let pool = null;
let saknis = null;
let saugykla = null;
let store = null;

async function pg(url, sql) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await c.query(sql);
  } finally {
    await c.end();
  }
}

const dbVardas = () => new URL(DB_URL).pathname.replace(/^\//, "");

before(async () => {
  if (PRALEISTI) return;
  const admin = adminDatabaseUrl();
  await pg(admin, `DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`);
  await pg(admin, `CREATE DATABASE "${dbVardas()}"`);
  execFileSync("npx", ["node-pg-migrate", "up"], {
    cwd: SAKNIS,
    env: { ...process.env, DATABASE_URL: DB_URL },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  pool = stebetiPoola(new Pool({ connectionString: DB_URL }), { vardas: "pool", dsn: DB_URL });
  saknis = fs.mkdtempSync(path.join(os.tmpdir(), "stenograma-tvora-"));
  saugykla = createFsArtifactStore({ root: saknis });
  await saugykla.patikrintiSaugykla();
  store = createPostgresStore(pool, { rasymoSaugykla: saugykla });
});

after(async () => {
  if (PRALEISTI) return;
  if (pool) await uzdarytiPoola(pool);
  pool = null;
  if (saknis) fs.rmSync(saknis, { recursive: true, force: true });
  await pg(adminDatabaseUrl(), `DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`).catch(() => {});
});

async function naujasJobas() {
  const { rows } = await pool.query(
    `INSERT INTO jobs (id, type, status, owner_kind, created_at, updated_at)
     VALUES (gen_random_uuid(), 'protocol', 'processing', 'unowned', now(), now())
     RETURNING id`
  );
  return rows[0].id;
}

/**
 * Pakeičia `registruoti` taip, kad PIRMI `kiek` bandymai gimtų jau senesni už tvorą.
 *
 * ⚠️ SEAM'AS SKAIČIUOJA KVIETIMUS — tai ir yra D3 įrodymo pagrindas: „tiksliai vienas
 * pakartojimas" reiškia „tiksliai du `registruoti`", ir tą tikriname skaičiumi, ne
 * elgsenos nuojauta.
 */
function seninantisSeam(kiek) {
  const tikrasis = attemptRegistry.registruoti;
  const bandymai = [];

  attemptRegistry.registruoti = async function (vykdytojas, args) {
    const rezultatas = await tikrasis.call(attemptRegistry, vykdytojas, args);
    bandymai.push({ attemptId: args.attemptId, storageKey: args.storageKey });

    if (bandymai.length <= kiek) {
      await pool.query(
        `UPDATE job_result_attempts
            SET created_at = clock_timestamp() - ($2::double precision * INTERVAL '1 millisecond')
          WHERE attempt_id = $1`,
        [args.attemptId, MAX + 60_000]
      );
    }
    return rezultatas;
  };

  return {
    bandymai,
    atstatyti() { attemptRegistry.registruoti = tikrasis; },
  };
}

const busena = async (attemptId) => {
  const { rows } = await pool.query(
    "SELECT busena FROM job_result_attempts WHERE attempt_id = $1",
    [attemptId]
  );
  return rows.length ? rows[0].busena : null;
};

/* ══════════════════════════════════════════════════════════════════════════ */

test("#415 D1: pirmas bandymas atmestas tvora, ANTRAS praeina - rezultatas išsaugotas", { skip: PRALEISTI }, async (t) => {
  const jobId = await naujasJobas();
  const seam = seninantisSeam(1);
  t.after(() => seam.atstatyti());

  const rezultatas = { text: "apskaičiuota vieną kartą", segments: [1, 2, 3] };
  const baigtas = await store.finishAtomic(jobId, STATUS.COMPLETED, { result: rezultatas });

  assert.equal(baigtas.status, STATUS.COMPLETED, "job'as privalo būti užbaigtas");
  assert.deepEqual(baigtas.result, rezultatas, "rezultatas NEBUVO perskaičiuotas ir išsaugotas");

  assert.equal(seam.bandymai.length, 2, "D3: tiksliai vienas pakartojimas, t. y. DU registruoti");

  const [pirmas, antras] = seam.bandymai;
  assert.notEqual(pirmas.attemptId, antras.attemptId, "D4: naujas `attemptId`");
  assert.notEqual(pirmas.storageKey, antras.storageKey, "D4: naujas raktas");

  assert.equal(await busena(pirmas.attemptId), "abandoned", "atmestas bandymas sutvarkytas");
  assert.equal(await busena(antras.attemptId), "committed", "antrasis įsipareigojo");

  assert.equal(
    await saugykla.head(pirmas.storageKey),
    null,
    "D4: pirmojo bandymo objektas pašalintas - kitaip liktų nereferencuota transkripcija"
  );
  assert.ok(await saugykla.head(antras.storageKey), "antrojo bandymo objektas vietoje");
});

test("#415 D3: abu bandymai atmesti - job'as krenta NUOLATINAI, registruoti lygiai 2", { skip: PRALEISTI }, async (t) => {
  const jobId = await naujasJobas();
  const seam = seninantisSeam(2);
  t.after(() => seam.atstatyti());

  const klaida = await assert.rejects(
    () => store.finishAtomic(jobId, STATUS.COMPLETED, { result: { text: "abu per lėti" } }),
    (e) => e.code === "ATTEMPT_COMMIT_TOO_LATE"
  ).then(() => null, (e) => e);

  assert.equal(klaida, null, "turi mesti tvoros klaidą");
  assert.equal(seam.bandymai.length, 2, "D3: JOKIO ciklo - lygiai du bandymai");

  for (const b of seam.bandymai) {
    assert.equal(await busena(b.attemptId), "abandoned", "abu bandymai sutvarkyti");
    assert.equal(await saugykla.head(b.storageKey), null, "abu objektai pašalinti");
  }

  const { rows } = await pool.query("SELECT status FROM jobs WHERE id = $1", [jobId]);
  assert.notEqual(rows[0].status, STATUS.COMPLETED, "job'as NELIEKA užbaigtas");
});

/**
 * ⚠️ D3 ANTRA PUSĖ: klaida privalo pasiekti worker'į forma, kuri NEBESUKELIA viso
 * procesoriaus pakartojimo. Čia tikrinama vėliava; kad worker'is ją paverčia
 * `UnrecoverableError` ir procesorius realiai nebepaleidžiamas — `redis` rinkinyje
 * (`tvorosGrandine.integration`), nes BullMQ reikia Redis.
 */
test("#415 D3: tvoros klaida neša `neatkartojama: true`", { skip: PRALEISTI }, async (t) => {
  const jobId = await naujasJobas();
  const seam = seninantisSeam(2);
  t.after(() => seam.atstatyti());

  await assert.rejects(
    () => store.finishAtomic(jobId, STATUS.COMPLETED, { result: { text: "x" } }),
    (e) => e.neatkartojama === true
  );
});

/**
 * ⚠️ D2: PAKARTOJIMAS EINA PER VISĄ TRANSAKCIJĄ SU JOS UŽRAKTU.
 *
 * Jei tarp bandymų job'ą užbaigia kitas vykdytojas, pakartojimas privalo pamatyti
 * `status === COMPLETED` ir NEPERRAŠYTI nugalėtojo. Trumpesnis kelias tiesiai į
 * `isipareigoti` šito nematytų — tai ir yra priežastis, kodėl D2 jį draudžia.
 */
test("#415 D2: kitas vykdytojas baigė tarp bandymų - nugalėtojo rezultatas NEPERRAŠOMAS", { skip: PRALEISTI }, async (t) => {
  const jobId = await naujasJobas();

  const tikrasis = attemptRegistry.registruoti;
  t.after(() => { attemptRegistry.registruoti = tikrasis; });

  const bandymai = [];
  attemptRegistry.registruoti = async function (vykdytojas, args) {
    const r = await tikrasis.call(attemptRegistry, vykdytojas, args);
    bandymai.push(args);

    if (bandymai.length === 1) {
      /** Pirmą bandymą seniname, kad tvora jį atmestų. */
      await pool.query(
        `UPDATE job_result_attempts
            SET created_at = clock_timestamp() - ($2::double precision * INTERVAL '1 millisecond')
          WHERE attempt_id = $1`,
        [args.attemptId, MAX + 60_000]
      );

      /** …ir SVETIMAS vykdytojas job'ą užbaigia inline, kol mūsų bandymas dar gyvas. */
      await pool.query(
        `UPDATE jobs SET status = 'completed', updated_at = now() WHERE id = $1`,
        [jobId]
      );
      await pool.query(
        `INSERT INTO job_results (job_id, payload, storage_type, created_at, updated_at)
         VALUES ($1, $2::jsonb, 'inline', now(), now())`,
        [jobId, JSON.stringify({ text: "SVETIMAS nugalėtojas" })]
      );
    }
    return r;
  };

  await store
    .finishAtomic(jobId, STATUS.COMPLETED, { result: { text: "mūsų vėlyvas rezultatas" } })
    .catch(() => null);

  const { rows } = await pool.query(
    "SELECT payload, storage_type FROM job_results WHERE job_id = $1",
    [jobId]
  );

  assert.equal(rows.length, 1, "dublikato būti negali");
  assert.equal(rows[0].storage_type, "inline", "nugalėtojo eilutė nepakeista");
  assert.deepEqual(rows[0].payload, { text: "SVETIMAS nugalėtojas" }, "rezultatas NEPERRAŠYTAS");

  for (const b of bandymai) {
    assert.equal(await saugykla.head(b.storageKey), null, "mūsų bandymų objektai išvalyti");
  }
});
