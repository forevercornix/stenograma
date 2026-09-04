const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { Client } = require("pg");

const { skipWithoutPostgres, testDatabaseUrl, adminDatabaseUrl } = require("./helpers/postgresGuard");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * `job_results` EXTERNAL REPREZENTACIJOS INVARIANTAS (#157, PR-1).
 *
 * ⚠️ ŠIS FAILAS VIETINĖJE APLINKOJE NEVYKDOMAS. Jam reikia tikros PostgreSQL;
 * registracija `postgres` rinkinyje išvedama iš `postgresGuard` importo, tad
 * `verify-postgres-suite-ran.mjs` reikalaus neprapleisto `ok`.
 *
 * ⚠️ KODĖL ATSKIRAS FAILAS, O NE `migrations.integration`.
 *
 * Tas failas tikrina migracijų KARKASĄ (tvarką, atnaujinimo kelią, kad senos
 * migracijos nekeičiamos). Čia tikrinamas VIENAS duomenų invariantas, ir jis
 * gyvuos ilgiau nei jį įvedusi migracija: po #157 kiekvienas naujas rezultatų
 * saugojimo kelias privalo jį atlaikyti.
 *
 * ⚠️ KĄ ŠIS FAILAS ĮRODO.
 *
 * Kad DB PATI atmeta negaliojančias `job_results` formas — ne aplikacija, ne
 * kodo peržiūra. #157 body: „Integrity metaduomenys tampa DB invariantu, ne
 * aplikacijos susitarimu."
 *
 * ⚠️ KETURI SARGAI TIKRINAMI ATSKIRAI, IR TAI SĄMONINGA.
 *
 * Bendras testas „external forma galioja" praeitų padengęs vieną iš keturių, o
 * ataskaitoje atrodytų kaip keturi. Ta pati klaida, kurią 7.6c padarė su trimis
 * `deleteJobArtefacts` trumpaisiais keliais (#250).
 */

const ŠAKNIS = path.resolve(__dirname, "..");
const DB_URL = testDatabaseUrl("extshape");
const JOB_ID = "aaaaaaaa-0000-4000-8000-000000000001";

function praleisti() {
  return skipWithoutPostgres();
}

async function pg(url, sql, params = []) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await c.query(sql, params);
  } finally {
    await c.end();
  }
}

function dbVardas() {
  return new URL(DB_URL).pathname.replace(/^\//, "");
}

async function perkurtiDb() {
  const admin = adminDatabaseUrl();
  await pg(admin, `DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`);
  await pg(admin, `CREATE DATABASE "${dbVardas()}"`);

  execFileSync("npx", ["node-pg-migrate", "up"], {
    cwd: ŠAKNIS,
    env: { ...process.env, DATABASE_URL: DB_URL },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  await pg(
    DB_URL,
    `INSERT INTO jobs (id, type, status, created_at, updated_at)
     VALUES ($1, 'transcription', 'completed', now(), now())`,
    [JOB_ID]
  );
}

after(async () => {
  if (praleisti()) return;
  await pg(adminDatabaseUrl(), `DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`).catch(() => {});
});

/**
 * Bando įrašyti `job_results` eilutę ir grąžina SQLSTATE arba `null`.
 *
 * ⚠️ GRĄŽINAMAS KODAS, NE `boolean`. „Atmesta" gali reikšti ir `23514`
 * (invariantas suveikė), ir `42703` (stulpelio nėra) — o tai visai kitas
 * gedimas. Testas, tenkinęsis `boolean`, žaliuotų dėl neteisingos priežasties.
 */
async function ideti(laukai) {
  const stulpeliai = ["job_id", "created_at", ...Object.keys(laukai)];
  const reiksmes = ["$1", "now()", ...Object.keys(laukai).map((_, i) => `$${i + 2}`)];

  try {
    await pg(
      DB_URL,
      `INSERT INTO job_results (${stulpeliai.join(", ")}) VALUES (${reiksmes.join(", ")})`,
      [JOB_ID, ...Object.values(laukai)]
    );
    return null;
  } catch (klaida) {
    return klaida.code;
  } finally {
    await pg(DB_URL, "DELETE FROM job_results WHERE job_id = $1", [JOB_ID]).catch(() => {});
  }
}

const RAKTAS = "results/aaaaaaaa-0000-4000-8000-000000000001/abc.json";
const SUMA = "e".repeat(64);

test("#157 PR-1: `job_results` external forma yra DB invariantas", { timeout: 180000 }, async (t) => {
  if (praleisti()) return;

  await perkurtiDb();

  /* ═══ SARGAS 1: `fs` yra teisėta reikšmė ═══ */

  await t.test("`fs` reference įrašomas BE schemos apėjimo", async () => {
    assert.equal(
      await ideti({ storage_type: "fs", storage_key: RAKTAS, bytes: 1024, checksum: SUMA }),
      null,
      "`fs` privalo būti leistina `storage_type` reikšmė (#157: `FsArtifactStore` reference įrašomas be schemos apėjimo)"
    );
  });

  /* ═══ SARGAS 2: `payload IS NULL` external atveju ═══ */

  await t.test("external + `payload` ATMETAMAS", async () => {
    assert.equal(
      await ideti({
        storage_type: "s3",
        storage_key: RAKTAS,
        payload: JSON.stringify({ text: "x" }),
        bytes: 1024,
        checksum: SUMA,
      }),
      "23514",
      "hibridinė eilutė (external + payload) yra būtent tai, ką dabartinis `upsertResult()` sugeneruotų"
    );
  });

  /* ═══ SARGAS 3: `bytes IS NOT NULL` external atveju ═══ */

  await t.test("external be `bytes` ATMETAMAS", async () => {
    assert.equal(
      await ideti({ storage_type: "fs", storage_key: RAKTAS, checksum: SUMA }),
      "23514",
      "be dydžio restore verifikacija neturėtų ko palyginti"
    );
  });

  /* ═══ SARGAS 4: `checksum IS NOT NULL` external atveju ═══ */

  await t.test("external be `checksum` ATMETAMAS", async () => {
    assert.equal(
      await ideti({ storage_type: "fs", storage_key: RAKTAS, bytes: 1024 }),
      "23514",
      "be kontrolinės sumos patikra įrodytų tik tai, kad objektas skaitomas, ne kad jis tas pats"
    );
  });

  /* ═══ KONTROLĖS ═══
   *
   * ⚠️ Be jų invariantas galėtų būti „viską atmesti", ir keturi sargai aukščiau
   * praeitų nieko neįrodydami.
   */

  await t.test("KONTROLĖ: `inline` + `payload` ir toliau PRAEINA", async () => {
    assert.equal(
      await ideti({ storage_type: "inline", payload: JSON.stringify({ text: "x" }) }),
      null,
      "esama inline forma nesugriauta"
    );
  });

  await t.test("KONTROLĖ: `inline` be `bytes`/`checksum` PRAEINA", async () => {
    assert.equal(
      await ideti({ storage_type: "inline", payload: JSON.stringify({ text: "x" }) }),
      null,
      "naujos kolonos inline eilučių NEAPKRAUNA — privalomumas galioja tik external šakai"
    );
  });

  await t.test("KONTROLĖ: `inline` + `storage_key` ATMETAMAS", async () => {
    assert.equal(
      await ideti({ storage_type: "inline", payload: JSON.stringify({ text: "x" }), storage_key: RAKTAS }),
      "23514",
      "sena šaka gyva: inline eilutė rakto neturi"
    );
  });

  await t.test("KONTROLĖ: nežinomas `storage_type` ATMETAMAS", async () => {
    assert.equal(
      await ideti({ storage_type: "gcs", storage_key: RAKTAS, bytes: 1, checksum: SUMA }),
      "23514",
      "reikšmių aibė praplėsta `fs`, ne atidaryta"
    );
  });
});
