const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { Client, Pool } = require("pg");

const { skipWithoutPostgres, testDatabaseUrl, adminDatabaseUrl } = require("./helpers/postgresGuard");
const { RADINIAI, nustatytiPrijungimoBusena } = require("../utils/artifactStore/prijungimoBusena");
const { createPostgresStore } = require("../utils/jobStore/postgresStore");

/**
 * PRIJUNGIMO STEBĖTOJAS PRIEŠ REALIĄ SCHEMĄ (#157, PR-7, 3 sąlyga).
 *
 * ⚠️ ŠIS FAILAS TIKRINA TIK TAI, KO DUBLIS PASAKYTI NEGALI.
 *
 * Verdikto logika ir sanitizacija išmatuotos be DB (`artifactStorePrijungimas`),
 * ir kartoti jų čia reikštų antrą tų pačių asercijų kopiją lėtesniame kelyje.
 * Lieka du dalykai, kuriems reikia tikros bazės:
 *
 *   1. AR UŽKLAUSOS GALIOJA. Abu `SELECT DISTINCT` sakiniai remiasi lentelėmis ir
 *      stulpeliais, kurių dublis netikrina; pervadintas stulpelis praeitų visus
 *      unit testus ir kristų starte.
 *
 *   2. AR ŠIANDIENOS PRIJUNGIMAS TIKRAI TUŠČIAS. `initializePostgres()` kviečia
 *      `createPostgresStore(pool)` be saugyklos, ir stebėtojas egzistuoja būtent
 *      tam, kad ta spraga būtų matoma. Teiginys tikrinamas su TIKRU store'u.
 *
 * ⚠️ BENDROS BŪSENOS RIBA (klausimas prieš rašant, ne po trijų raundų):
 *   — sava DB su savo priesaga, tad lygiagretūs failai nesusiduria;
 *   — `process.env` NEKEIČIAMAS: aplinka paduodama argumentu, tad kritęs testas
 *     negali palikti `ARTIFACT_STORE_BACKEND` kitiems to paties proceso testams;
 *   — RAŠOMA tik viena `job_results` eilutė ir tik antrame teste;
 *   — pool'as uždaromas PRIEŠ `DROP ... WITH (FORCE)` (ta pati klaida jau taisyta
 *     dukart: `artifactMigration.integration` ir `jobResultsShapeDomain`).
 */

const PRALEISTI = skipWithoutPostgres();
const DB_URL = PRALEISTI ? null : testDatabaseUrl("artifact_prijungimas");
const ŠAKNIS = path.resolve(__dirname, "..");

let pool = null;

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
    cwd: ŠAKNIS,
    env: { ...process.env, DATABASE_URL: DB_URL },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  pool = new Pool({ connectionString: DB_URL });
});

after(async () => {
  if (PRALEISTI) return;
  if (pool) await pool.end().catch(() => {});
  pool = null;
  await pg(adminDatabaseUrl(), `DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`).catch(() => {});
});

test("tuščioje bazėje su `ARTIFACT_STORE_BACKEND=fs` matoma NEPRIJUNGTA rašymo saugykla", { skip: PRALEISTI }, async () => {
  /** ⚠️ TIKRAS `initializePostgres()` kvietimas — be saugyklos, kaip šiandien. */
  const verdiktas = await nustatytiPrijungimoBusena(pool, createPostgresStore(pool), {
    env: { ARTIFACT_STORE_BACKEND: "fs", ARTIFACT_FS_ROOT: "/tmp/nenaudojama" },
  });

  assert.equal(verdiktas.nezinoma, false, "užklausos privalo galioti prieš realią schemą");
  assert.deepEqual(verdiktas.saltiniai, { rezultatai: [], bandymai: [] });
  assert.deepEqual(verdiktas.radiniai, [RADINIAI.RASYMAS_NEPRIJUNGTAS]);
  assert.equal(verdiktas.rasymoBackend, null);
});

test("external eilutė bazėje pakeičia verdiktą — ir tai matoma be nė vieno skaitymo", { skip: PRALEISTI }, async () => {
  /**
   * ⚠️ EILUTĖ RAŠOMA TIESIOGIAI, NE PER `finishAtomic()`.
   *
   * Klausimas yra „ar stebėtojas mato tai, kas GULI bazėje", ne „ar rašymo kelias
   * veikia". Per fasadą einantis paruošimas įvestų priklausomybę nuo rašymo kelio,
   * kuris šiame PR dar keisis, ir testas kristų dėl svetimos priežasties.
   */
  const { rows } = await pool.query(
    `INSERT INTO jobs (id, type, status, created_at, updated_at)
     VALUES (gen_random_uuid(), 'transcription', 'completed', now(), now()) RETURNING id`
  );
  await pool.query(
    `INSERT INTO job_results (job_id, storage_type, storage_key, bytes, checksum, created_at)
     VALUES ($1, 's3', 'k/stebetojas', 10, repeat('a', 64), now())`,
    [rows[0].id]
  );

  const verdiktas = await nustatytiPrijungimoBusena(pool, createPostgresStore(pool), {
    env: { ARTIFACT_STORE_BACKEND: "inline" },
  });

  assert.deepEqual(verdiktas.saltiniai.rezultatai, ["s3"]);
  assert.deepEqual(verdiktas.radiniai, [RADINIAI.SKAITYMUI_TRUKSTA]);
  assert.deepEqual(verdiktas.truksta, ["s3"]);
});
