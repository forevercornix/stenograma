const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Client, Pool } = require("pg");

const { skipWithoutPostgres, testDatabaseUrl, adminDatabaseUrl } = require("./helpers/postgresGuard");
const { createPostgresStore } = require("../utils/jobStore/postgresStore");
const { createFsArtifactStore } = require("../utils/artifactStore/fsStore");
const { VERDIKTAS } = require("../utils/artifactRestoreVerify");

/**
 * RESTORE VIENTISUMAS PRIEŠ TIKRĄ SAUGYKLĄ (#157, PR-7, sąlygos 6-8).
 *
 * ⚠️ ČIA TIKRINAMA TIK TAI, KO DUBLIS PASAKYTI NEGALI.
 *
 * Verdiktų matrica išmatuota be DB (`artifactRestoreVerify`); kartoti ją čia reikštų
 * antrą tų pačių asercijų kopiją lėtesniame kelyje. Lieka trys dalykai, kuriems
 * reikia tikros bazės IR tikros saugyklos:
 *
 *   1. AR UŽKLAUSA IR PUSLAPIAVIMAS VEIKIA prieš realią schemą.
 *   2. AR TIKRAS `fs` `verify()` sugadinimą IŠ TIKRŲJŲ pagauna — dublis grąžina tai,
 *      kas jam pasakyta; čia objektas gadinamas failų sistemoje, aplenkiant saugyklą.
 *   3. AR KONTROLĖ PRAEINA — nepaliestas objektas privalo duoti `patikrinta`.
 *      Be jos „sugadintas krenta" būtų neatskiriama nuo „krenta visada".
 *
 * ⚠️ SUGADINIMAS IŠLAIKO ILGĮ. Pakeitus dydį, kristų `bytes` palyginimas, ir testas
 * įrodytų SILPNESNĘ savybę: kad `head()` pakaktų. Tikrinama būtent tai, kam `verify()`
 * ir egzistuoja — sugadintas TO PATIES ilgio objektas.
 *
 * ⚠️ BENDROS BŪSENOS RIBA: sava DB su savo priesaga, savas laikinas katalogas,
 * pool'as uždaromas PRIEŠ `DROP ... WITH (FORCE)`, `process.env` neliečiamas.
 */

const PRALEISTI = skipWithoutPostgres();
const DB_URL = PRALEISTI ? null : testDatabaseUrl("restore_vientisumas");
const SAKNIS = path.resolve(__dirname, "..");

let pool = null;
let saknis = null;
let store = null;
let saugykla = null;

async function pg(url, sql, params = []) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await c.query(sql, params);
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

  pool = new Pool({ connectionString: DB_URL });
  saknis = fs.mkdtempSync(path.join(os.tmpdir(), "stenograma-vientisumas-"));
  saugykla = createFsArtifactStore({ root: saknis });
  await saugykla.patikrintiSaugykla();
  store = createPostgresStore(pool, { rasymoSaugykla: saugykla });
});

after(async () => {
  if (PRALEISTI) return;
  if (pool) await pool.end().catch(() => {});
  pool = null;
  if (saknis) fs.rmSync(saknis, { recursive: true, force: true });
  await pg(adminDatabaseUrl(), `DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`).catch(() => {});
});

/** Sukuria job'ą ir jam eilutę: `inline` arba TIKRAI įrašytą `fs` objektą. */
async function naujaEilute({ external }) {
  const { rows } = await pool.query(
    `INSERT INTO jobs (id, type, status, created_at, updated_at)
     VALUES (gen_random_uuid(), 'transcription', 'completed', now(), now()) RETURNING id`
  );
  const jobId = rows[0].id;

  if (!external) {
    await pool.query(
      `INSERT INTO job_results (job_id, storage_type, payload, created_at)
       VALUES ($1, 'inline', $2::jsonb, now())`,
      [jobId, JSON.stringify({ text: "inline rezultatas" })]
    );
    return { jobId, raktas: null };
  }

  /**
   * ⚠️ OBJEKTAS RAŠOMAS PER TIKRĄ SAUGYKLĄ, o `bytes`/`checksum` imami iš JOS kvito —
   * ne skaičiuojami testo pusėje. Testas, skaičiuojantis juos pats, tikrintų savo
   * paties aritmetiką, o ne tai, ką įrašė rašymo kelias.
   */
  const raktas = `results/${jobId}.json`;
  const kvitas = await saugykla.put(raktas, { text: "external rezultatas", n: 42 });

  await pool.query(
    `INSERT INTO job_results (job_id, storage_type, storage_key, bytes, checksum, created_at)
     VALUES ($1, 'fs', $2, $3, $4, now())`,
    [jobId, raktas, kvitas.bytes, kvitas.checksum]
  );
  return { jobId, raktas };
}

const rasti = (ataskaita, jobId) => ataskaita.nesekmes.find((n) => n.jobId === jobId);

test("KONTROLĖ: nepaliestas external objektas duoda `patikrinta`, inline — `nepatikrinama`", { skip: PRALEISTI }, async () => {
  await pool.query("DELETE FROM job_results");
  const { jobId } = await naujaEilute({ external: true });
  await naujaEilute({ external: false });

  const ataskaita = await store.verifyResultArtifacts({ puslapis: 1 });

  assert.equal(ataskaita.ok, true, ataskaita.santrauka);
  assert.equal(ataskaita.eiluciuIsViso, 2, "puslapiavimas privalo pereiti VISAS eilutes");
  assert.equal(ataskaita.nepriklausomaiPatikrinta, 1);
  assert.equal(ataskaita.nepatikrinama, 1, "inline eilutė NEGALI būti skaičiuojama kaip patikrinta");
  assert.equal(rasti(ataskaita, jobId), undefined);
});

test("TRŪKSTAMAS objektas: eilutė yra, objekto nėra — fail-closed", { skip: PRALEISTI }, async () => {
  await pool.query("DELETE FROM job_results");
  const { jobId, raktas } = await naujaEilute({ external: true });

  /** ⚠️ TRINAMA FAILŲ SISTEMOJE, aplenkiant saugyklą — kitaip trintų ir DB eilutę. */
  fs.unlinkSync(path.join(saknis, raktas));

  const ataskaita = await store.verifyResultArtifacts();

  assert.equal(ataskaita.ok, false);
  assert.equal(ataskaita.nepriklausomaiPatikrinta, 0);
  assert.equal(rasti(ataskaita, jobId).verdiktas, VERDIKTAS.NERASTA);
});

test("SUGADINTAS objektas: TAS PATS ilgis, kitas turinys — `nesutampa`", { skip: PRALEISTI }, async () => {
  await pool.query("DELETE FROM job_results");
  const { jobId, raktas } = await naujaEilute({ external: true });

  const kelias = path.join(saknis, raktas);
  const originalas = fs.readFileSync(kelias);
  const sugadintas = Buffer.from(originalas);
  sugadintas[sugadintas.length - 2] = sugadintas[sugadintas.length - 2] === 0x32 ? 0x33 : 0x32;
  fs.writeFileSync(kelias, sugadintas);

  /**
   * ⚠️ KONTROLĖ TIES PAČIU SUGADINIMU: ilgis NEPAKITO, o turinys pakito. Be jos
   * testas įrodytų, kad pakanka `head()` — t. y. kitą, silpnesnę savybę.
   */
  assert.equal(fs.statSync(kelias).size, originalas.length, "ilgis privalo likti tas pats");
  assert.notEqual(
    crypto.createHash("sha256").update(sugadintas).digest("hex"),
    crypto.createHash("sha256").update(originalas).digest("hex")
  );

  const ataskaita = await store.verifyResultArtifacts();

  assert.equal(ataskaita.ok, false);
  assert.equal(rasti(ataskaita, jobId).verdiktas, VERDIKTAS.NESUTAMPA);
});

/**
 * ⚠️ SĄLYGA 8 PRIEŠ TIKRĄ SAUGYKLĄ: laukiama reikšmė ateina iš DB.
 *
 * Sugadinamas ne objektas, o DB `checksum`. Jei verifikacija laukiamą reikšmę
 * perskaičiuotų iš tikrinamo objekto, ji nieko nepastebėtų — objektas juk vientisas.
 * Krenta tik tada, kai autoritetas yra DB pusė.
 */
test("sąlyga 8: pakeitus DB `checksum`, vientisas objektas KRENTA", { skip: PRALEISTI }, async () => {
  await pool.query("DELETE FROM job_results");
  const { jobId } = await naujaEilute({ external: true });

  await pool.query("UPDATE job_results SET checksum = $2 WHERE job_id = $1", [jobId, "d".repeat(64)]);

  const ataskaita = await store.verifyResultArtifacts();

  assert.equal(ataskaita.ok, false, "laukiama reikšmė privalo ateiti iš DB, ne iš objekto");
  assert.equal(rasti(ataskaita, jobId).verdiktas, VERDIKTAS.NESUTAMPA);
});

test("neregistruotas `storage_type` bazėje — nesėkmė, ne tyla", { skip: PRALEISTI }, async () => {
  await pool.query("DELETE FROM job_results");
  const { jobId } = await naujaEilute({ external: true });
  await pool.query("UPDATE job_results SET storage_type = 's3' WHERE job_id = $1", [jobId]);

  const ataskaita = await store.verifyResultArtifacts();

  assert.equal(ataskaita.ok, false);
  assert.equal(rasti(ataskaita, jobId).verdiktas, VERDIKTAS.SAUGYKLA_NEREGISTRUOTA);
});
