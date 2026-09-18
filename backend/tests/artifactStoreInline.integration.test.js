const { test } = require("node:test");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const crypto = require("node:crypto");
const { Pool, Client } = require("pg");

const { skipWithoutPostgres, testDatabaseUrl, adminDatabaseUrl } = require("./helpers/postgresGuard");
const { paleistiKontrakta } = require("./helpers/artifactStoreContract");
const { createInlineArtifactStore } = require("../utils/artifactStore/inlineStore");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * `ArtifactStore` KONTRAKTAS: `inline` BACKEND'AS (#157, PR-2).
 *
 * ⚠️ TAS PATS RINKINYS, NEKEIČIAMAS. Jei kuris nors scenarijus čia pareikalautų
 * išimties, tai reikštų, kad kontraktas neapibrėžtas - ne kad `inline` ypatingas.
 *
 * ⚠️ ČIA PIRMĄ KARTĄ SUSITINKA RIBOS PREDIKATAS IR TIKRAS `jsonb`.
 *
 * `validation.js` stabilumo patikra yra inline kelio MODELIS
 * (`JSON.parse(JSON.stringify(x))`), o ne pats kelias. Šis failas leidžia tą patį
 * per TIKRĄ round-trip'ą su PG: jei modelis kur nors klysta, kanoninė tapatybė po
 * įrašymo ir perskaitymo nesutaps, ir kontrakto round-trip scenarijus kris.
 *
 * ⚠️ ŠIS FAILAS VIETOJE NEVYKDOMAS - reikia tikros PostgreSQL.
 */

const SAKNIS = path.resolve(__dirname, "..");
const DB_URL = testDatabaseUrl("inlinestore");
const PRALEISTI = skipWithoutPostgres();

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

if (!PRALEISTI) {
  paleistiKontrakta("inline", async () => {
    await pg(adminDatabaseUrl(), `DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`);
    await pg(adminDatabaseUrl(), `CREATE DATABASE "${dbVardas()}"`);
    execFileSync("npx", ["node-pg-migrate", "up"], {
      cwd: SAKNIS,
      env: { ...process.env, DATABASE_URL: DB_URL },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const pool = new Pool({ connectionString: DB_URL });

    /**
     * ⚠️ KIEKVIENAM RAKTUI - TIKRAS `jobs` ĮRAŠAS.
     *
     * `job_results.job_id` turi FK, tad išgalvotas raktas neįrašomas. Adresas
     * inline atveju YRA job'o tapatybė, ir fixture'as tai atspindi: raktų
     * gamykla kartu sukuria eilutę, į kurią jie rodo.
     */
    async function raktas() {
      const id = crypto.randomUUID();
      await pool.query(
        `INSERT INTO jobs (id, type, status, created_at, updated_at)
         VALUES ($1, 'transcription', 'completed', now(), now())`,
        [id]
      );
      return id;
    }

    return {
      saugykla: createInlineArtifactStore({ vykdytojas: pool }),
      raktas,
      /**
       * ⚠️ INLINE INVARIANTAI DEKLARUOJAMI EKSPLICITIŠKAI (Codex, #290).
       *
       * `storage_key` inline eilutėje PRIVALO būti `NULL` (PR-1 invariantas), tad
       * nuorodos nėra. Ir `verify()` čia lygina reikšmę SU SAVIMI — nepriklausomo
       * metaduomens nėra, tad `nepriklausomas: false`. Be šių deklaracijų regresija
       * abiem laukais praeitų vartus, o pasekmę pamatytų PR-4 (`23514`) ir PR-7
       * (tuščia suma, apsimetanti įrodymu).
       */
      nuoroda: "null",
      nepriklausomas: false,
      isvalyti: async () => {
        await pool.end().catch(() => {});
        await pg(adminDatabaseUrl(), `DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`).catch(
          () => {}
        );
      },
    };
  });
} else {
  test("ArtifactStore kontraktas: inline", { skip: true }, () => {});
}
