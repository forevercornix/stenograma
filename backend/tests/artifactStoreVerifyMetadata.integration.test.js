const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const { Client } = require("pg");

const { skipWithoutPostgres, testDatabaseUrl, adminDatabaseUrl } = require("./helpers/postgresGuard");
const { createFsArtifactStore } = require("../utils/artifactStore/fsStore");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * `verify()` PRIEŠ TIKRĄ `bigint` STULPELĮ (#157, PR-2, Codex P1 #290).
 *
 * ⚠️ KODĖL NEUŽTENKA JS LITERALO.
 *
 * Kontrakto rinkinys tikrina, kad `verify()` priima `bytes` eilute — bet tą tipą
 * jis IMITUOJA (`String(bytes)`). Teiginys, dėl kurio visa pataisa egzistuoja,
 * yra kitas: kad `job_results.bytes` REALIAI atkeliauja eilute per `node-postgres`.
 * Imituotas tipas to neįrodo — jei `pg` kada nors grąžintų skaičių, imitacija
 * liktų žalia, o prielaida taptų nebeteisinga (AGENTS.md §14.1).
 *
 * ⚠️ MATUOJAMA PIRMA, TVIRTINAMA PASKUI. Testas pirmiausia fiksuoja, KOKS tipas
 * ateina, ir tik tada tikrina, kad `verify()` su juo sutampa.
 *
 * ⚠️ ŠIS FAILAS VIETOJE NEVYKDOMAS - reikia tikros PostgreSQL.
 */

const SAKNIS = path.resolve(__dirname, "..");
const DB_URL = testDatabaseUrl("verifymeta");
const PRALEISTI = skipWithoutPostgres();

async function pg(sql, params = []) {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  try {
    return await c.query(sql, params);
  } finally {
    await c.end();
  }
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

function dbVardas() {
  return new URL(DB_URL).pathname.replace(/^\//, "");
}

after(async () => {
  if (PRALEISTI) return;
  await adminPg(`DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`).catch(() => {});
});

test("`verify()` sutampa su metaduomenimis, atėjusiais iš `bigint` stulpelio", { skip: PRALEISTI, timeout: 180000 }, async (t) => {
  await adminPg(`DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`);
  await adminPg(`CREATE DATABASE "${dbVardas()}"`);
  execFileSync("npx", ["node-pg-migrate", "up"], {
    cwd: SAKNIS,
    env: { ...process.env, DATABASE_URL: DB_URL },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const saknis = await fsp.mkdtemp(path.join(os.tmpdir(), "stenograma-verifymeta-"));
  t.after(() => fsp.rm(saknis, { recursive: true, force: true }));

  const saugykla = createFsArtifactStore({ root: saknis });
  const jobId = crypto.randomUUID();
  const raktas = `results/${jobId}/${crypto.randomUUID()}.json`;

  /** Rašoma tuo pačiu keliu, kurį naudos PR-3/PR-4: `put()` -> eilutė su nuoroda. */
  const kvitas = await saugykla.put(raktas, { text: "vientisumas", segments: [1, 2, 3] });

  await pg(
    `INSERT INTO jobs (id, type, status, created_at, updated_at)
     VALUES ($1, 'transcription', 'completed', now(), now())`,
    [jobId]
  );
  await pg(
    `INSERT INTO job_results (job_id, storage_type, storage_key, bytes, checksum, created_at)
     VALUES ($1, 'fs', $2, $3, $4, now())`,
    [jobId, kvitas.reference, kvitas.bytes, kvitas.checksum]
  );

  const { rows } = await pg("SELECT bytes, checksum FROM job_results WHERE job_id = $1", [jobId]);
  const eilute = rows[0];

  await t.test("IŠMATUOTA: kokiu tipu `bigint` grįžta į JS", () => {
    /**
     * ⚠️ TVIRTINIMAS FIKSUOJA IŠMATUOTĄ TIESĄ. Jei `pg` elgesys pasikeis
     * (versija, `pg-types` konfigūracija), testas kris ir privers peržiūrėti
     * normalizavimą — o ne tyliai leis jam tapti nereikalingam ar nepakankamam.
     */
    assert.equal(typeof eilute.bytes, "string", `bigint grįžo kaip ${typeof eilute.bytes}`);
    assert.equal(eilute.bytes, String(kvitas.bytes));
  });

  await t.test("verdiktas su DB eilute yra `ok`, ne „sugadinta\"", async () => {
    /**
     * ⚠️ BE NORMALIZAVIMO ČIA KRISTŲ KIEKVIENAS ARTEFAKTAS: `"12" === 12` yra
     * `false`, tad 7.6 restore verifikacija paskelbtų visuotinį gedimą būtent
     * tada, kai ja remiamasi.
     */
    const verdiktas = await saugykla.verify(raktas, eilute);

    assert.equal(verdiktas.ok, true, `verdiktas: ${JSON.stringify(verdiktas)}`);
    assert.equal(verdiktas.exists, true);
    assert.equal(verdiktas.nepriklausomas, true, "metaduomenys atėjo IŠ DB, tad palyginimas nepriklausomas");
  });

  await t.test("KONTROLĖ: pakeitus turinį, tas pats verdiktas tampa `ok: false`", async () => {
    /**
     * Be jos ankstesnis tvirtinimas būtų tenkinamas ir `verify()`, kuris
     * normalizavęs grąžina `true` visada.
     */
    await fsp.writeFile(path.join(saknis, raktas), JSON.stringify({ text: "pakeista" }), "utf8");

    const verdiktas = await saugykla.verify(raktas, eilute);
    assert.equal(verdiktas.ok, false, "pakeistas turinys privalo nesutapti su DB metaduomenimis");
    assert.equal(verdiktas.exists, true);
  });
});
