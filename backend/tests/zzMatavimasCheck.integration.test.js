const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { Pool, Client } = require("pg");

const { skipWithoutPostgres, testDatabaseUrl, adminDatabaseUrl } = require("./helpers/postgresGuard");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/** LAIKINAS MATAVIMAS (#157 PR-6): kurias reference switch skaidymo formas DB PRIIMA. */
const SAKNIS = path.resolve(__dirname, "..");
const DB_URL = testDatabaseUrl("checkmatavimas");
const PRALEISTI = skipWithoutPostgres();

function dbVardas() {
  return new URL(DB_URL).pathname.replace(/^\//, "");
}

async function adminPg(sql) {
  const c = new Client({ connectionString: adminDatabaseUrl() });
  await c.connect();
  try {
    return await c.query(sql);
  } finally {
    await c.end();
  }
}

after(async () => {
  if (PRALEISTI) return;
  await adminPg(`DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`).catch(() => {});
});

test("MATAVIMAS: reference switch skaidymo formos", { skip: PRALEISTI, timeout: 180000 }, async (t) => {
  await adminPg(`DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`);
  await adminPg(`CREATE DATABASE "${dbVardas()}"`);
  execFileSync("npx", ["node-pg-migrate", "up"], {
    cwd: SAKNIS,
    env: { ...process.env, DATABASE_URL: DB_URL },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const pool = new Pool({ connectionString: DB_URL });
  t.after(() => pool.end().catch(() => {}));

  async function naujaInlineEilute() {
    const { rows } = await pool.query(
      `INSERT INTO jobs (id, status, type, owner_kind, schema_version, created_at, updated_at)
       VALUES (gen_random_uuid(), 'completed', 'transcription', 'unowned', 1, now(), now()) RETURNING id`
    );
    const id = rows[0].id;
    await pool.query(
      "INSERT INTO job_results (job_id, storage_type, payload) VALUES ($1, 'inline', '{\"t\":1}'::jsonb)",
      [id]
    );
    return id;
  }

  const formos = [
    {
      vardas: "A: tik `storage_key` (paliekant `inline`)",
      sql: "UPDATE job_results SET storage_key = 'results/x/a.json' WHERE job_id = $1",
    },
    {
      vardas: "B: `storage_type` + `storage_key` (be `bytes`/`checksum`, `payload` lieka)",
      sql: "UPDATE job_results SET storage_type = 'fs', storage_key = 'results/x/a.json' WHERE job_id = $1",
    },
    {
      vardas: "C: `storage_type` + visas trejetas, `payload` LIEKA",
      sql:
        "UPDATE job_results SET storage_type = 'fs', storage_key = 'results/x/a.json', " +
        "bytes = 10, checksum = repeat('a', 64) WHERE job_id = $1",
    },
    {
      vardas: "D: tik `payload = NULL` (paliekant `inline`)",
      sql: "UPDATE job_results SET payload = NULL WHERE job_id = $1",
    },
    {
      vardas: "E: PILNAS perėjimas vienu sakiniu (kontrolė — privalo PRAEITI)",
      sql:
        "UPDATE job_results SET storage_type = 'fs', storage_key = 'results/x/a.json', " +
        "bytes = 10, checksum = repeat('a', 64), payload = NULL WHERE job_id = $1",
    },
  ];

  const rezultatai = [];

  for (const forma of formos) {
    const id = await naujaInlineEilute();
    try {
      await pool.query(forma.sql, [id]);
      rezultatai.push(`PRIIMTA  ${forma.vardas}`);
    } catch (klaida) {
      rezultatai.push(`ATMESTA  ${forma.vardas} (${klaida.code} ${klaida.constraint || ""})`);
    }
  }

  for (const eilute of rezultatai) t.diagnostic(eilute);

  /** Kontrolė: pilnas perėjimas PRIVALO praeiti, kitaip matavimas nieko nesako. */
  assert.match(rezultatai[4], /^PRIIMTA/, rezultatai.join(" | "));
});
