const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Client, Pool } = require("pg");

const { skipWithoutPostgres, testDatabaseUrl, adminDatabaseUrl } = require("./helpers/postgresGuard");
const { createPostgresStore } = require("../utils/jobStore/postgresStore");
const { createFsArtifactStore } = require("../utils/artifactStore/fsStore");
const { STATUS, OWNER_KIND } = require("../utils/jobStore/common");

/**
 * `finishAtomic()` ANT UŽBAIGTO JOB'O SU EXTERNAL EILUTE (#157, PR-7, 2 sąlyga).
 *
 * ⚠️ UŽDUOTIS PERKLASIFIKUOTA: TAI NE „SARGO PAŠALINIMAS", O DEFEKTO TAISYMAS.
 *
 * Non-inline sargas (`postgresStore.finishAtomic`) gyvena `job.status === COMPLETED`
 * šakoje ir suveikia, kai eilutė external, o `rasymas === null`. Matavimas PRIEŠ
 * rašant parodė, kad jis atsako neteisingai DVIEM iš trijų atvejų, o trečiąjį
 * pasiglemžia:
 *
 *   finish(failed) ant completed job'o -> sargas meta vidinę klaidą apie „lygybės
 *     autoritetą", nors lygybės čia niekas neklausė. Teisingas atsakymas yra
 *     `JobPhaseError` iš `jobPhase.finish` — GYVAVIMO CIKLO klausimas.
 *
 *   finish(completed) be rezultato   -> po sargu esantis kelias duotų
 *   finish(completed) su rezultatu,     `COMPLETED_WITHOUT_RESULT`, nes
 *     bet be saugyklos                  `sviezias.result = eilute.payload`, o
 *                                       external eilutėje `payload` PRIVALOMAI yra
 *                                       `NULL` (formos `CHECK`).
 *
 * ⚠️ IR TAI NE KOSMETIKA. `COMPLETED_WITHOUT_RESULT` dokumentuotas kaip REMONTUOTINA
 * būsena, po kurios kvietėjas gali perrašyti rezultatą. Toks perrašymas external
 * eilutę perjungtų į inline ir paliktų objektą NAŠLAIČIU — t. y. pažodinis sargo
 * trynimas būtų atidaręs orphan'ų kelią per remonto semantiką. Būtent tai visa #157
 * grandinė ir uždarinėjo.
 *
 * ⚠️ ŠIS FAILAS RAŠOMAS PRIEŠ TAISYMĄ IR PRIEŠ JĮ KRENTA. Sargo elgesys šiandien
 * nefiksuotas NIEKUR, tik plane — tad be šių testų po taisymo nebūtų su kuo lyginti.
 * Raundas su raudonais yra įrodymas, ne nesėkmė.
 *
 * ⚠️ KONTROLĖ BŪTINA: be jos trys krentantys testai būtų suderinami su taisymu,
 * kuris sulaužo viską. Ji tikrina kelią, veikiantį ir prieš, ir po.
 */

const PRALEISTI = skipWithoutPostgres();
const DB_URL = PRALEISTI ? null : testDatabaseUrl("finish_external_fazes");
const SAKNIS = path.resolve(__dirname, "..");

let pool = null;
let saknis = null;
let saugykla = null;
/** Store SU rašymo saugykla — juo sukuriamos external eilutės. */
let store = null;
/** Store BE rašymo saugyklos — atkartoja diegimą, kuriame saugykla neprijungta. */
let beSaugyklos = null;

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
  saknis = fs.mkdtempSync(path.join(os.tmpdir(), "stenograma-fazes-"));
  saugykla = createFsArtifactStore({ root: saknis });
  await saugykla.patikrintiSaugykla();
  store = createPostgresStore(pool, { rasymoSaugykla: saugykla });
  beSaugyklos = createPostgresStore(pool);
});

after(async () => {
  if (PRALEISTI) return;
  if (pool) await pool.end().catch(() => {});
  pool = null;
  if (saknis) fs.rmSync(saknis, { recursive: true, force: true });
  await pg(adminDatabaseUrl(), `DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`).catch(() => {});
});

/** Sukuria job'ą ir užbaigia jį EXTERNAL rezultatu (per store su saugykla). */
async function uzbaigtasExternal(rezultatas = { text: "external" }) {
  const job = await store.create({ ownerKind: OWNER_KIND.UNOWNED, type: "transcription" });
  await store.update(job.id, { status: STATUS.PROCESSING, phase: "transcribing" });
  await store.finishAtomic(job.id, STATUS.COMPLETED, { result: rezultatas });

  const { rows } = await pool.query("SELECT storage_type FROM job_results WHERE job_id = $1", [job.id]);
  assert.equal(rows[0].storage_type, "fs", "paruošimas privalo duoti EXTERNAL eilutę");
  return job.id;
}

/**
 * ⚠️ ATVEJIS (b) — TREČIASIS RADINYS, IR STIPRIAUSIAS IŠ TRIJŲ.
 *
 * `finish(failed)` ant užbaigto job'o yra GYVAVIMO CIKLO klausimas, ir atsakymas
 * privalo būti `JobPhaseError` — lygiai kaip inline kelyje. Sargas jį pasiglemžia ir
 * pakeičia vidine klaida apie lygybės autoritetą, nors lygybės čia niekas neklausė.
 */
test("(b) `finish(failed)` ant užbaigto external job'o duoda `JobPhaseError`", { skip: PRALEISTI }, async () => {
  const id = await uzbaigtasExternal();

  await assert.rejects(
    () => store.finishAtomic(id, STATUS.FAILED, { error: "vėluoja" }),
    (klaida) => {
      assert.equal(klaida.name, "JobPhaseError", `gauta: ${klaida.name}: ${klaida.message}`);
      assert.doesNotMatch(
        klaida.message,
        /lygybės autoritet/,
        "sargas neturi pasiglemžti gyvavimo ciklo klausimo"
      );
      return true;
    }
  );
});

/**
 * ⚠️ ATVEJIS (c) — PARITETAS SU INLINE.
 *
 * Job'as rezultatą TURI (jis guli saugykloje). Ateina `completed` be rezultato —
 * tai ne tas pats rezultatas, tad `RESULT_CONFLICT`, lygiai kaip inline kelyje.
 * `COMPLETED_WITHOUT_RESULT` čia būtų MELAS: jis reiškia „rezultato nėra".
 */
test("(c) `finish(completed)` BE rezultato duoda `RESULT_CONFLICT`, ne `COMPLETED_WITHOUT_RESULT`", { skip: PRALEISTI }, async () => {
  const id = await uzbaigtasExternal();

  const atsakymas = await store.finishAtomic(id, STATUS.COMPLETED, {});

  assert.equal(atsakymas, "RESULT_CONFLICT");
  assert.notEqual(
    atsakymas,
    "COMPLETED_WITHOUT_RESULT",
    "job'as rezultatą TURI — jis saugykloje; remontuotina būsena čia atidarytų orphan'ų kelią"
  );
});

/**
 * ⚠️ ATVEJIS (a) — VIENINTELIS, KURIAM SARGAS TEISINGAS.
 *
 * External eilutė diegime, kuris rašymo saugyklos neturi: palyginti IŠ TIKRŲJŲ nėra
 * kuo, ir įrašyti irgi nėra kur. Klaida lieka — bet jos pranešimas privalo įvardyti
 * TIKRĄ priežastį (saugykla neprijungta), ne `storage_type`.
 */
test("(a) be rašymo saugyklos `completed` su rezultatu KRENTA, ir pranešimas įvardija saugyklą", { skip: PRALEISTI }, async () => {
  const id = await uzbaigtasExternal();

  await assert.rejects(
    () => beSaugyklos.finishAtomic(id, STATUS.COMPLETED, { result: { text: "kitas" } }),
    (klaida) => {
      assert.match(
        klaida.message,
        /saugykl/i,
        `pranešimas privalo įvardyti neprijungtą saugyklą, gauta: ${klaida.message}`
      );
      return true;
    }
  );
});

/**
 * ⚠️ KONTROLĖ — BE JOS TRYS KRENTANTYS NIEKO NEĮRODYTŲ.
 *
 * Inline kelias su prijungta saugykla veikia ir prieš, ir po taisymo. Jei taisymas
 * sulaužytų idempotenciją apskritai, trys testai aukščiau vis tiek pažaliuotų.
 */
test("KONTROLĖ: inline pakartojimas su tuo pačiu rezultatu lieka no-op", { skip: PRALEISTI }, async () => {
  const beSaugyklosStore = createPostgresStore(pool);
  const job = await beSaugyklosStore.create({ ownerKind: OWNER_KIND.UNOWNED, type: "transcription" });
  await beSaugyklosStore.update(job.id, { status: STATUS.PROCESSING, phase: "transcribing" });

  const rezultatas = { text: "inline rezultatas" };
  await beSaugyklosStore.finishAtomic(job.id, STATUS.COMPLETED, { result: rezultatas });

  const { rows } = await pool.query("SELECT storage_type FROM job_results WHERE job_id = $1", [job.id]);
  assert.equal(rows[0].storage_type, "inline", "be saugyklos rezultatas rašomas INLINE");

  const antras = await beSaugyklosStore.finishAtomic(job.id, STATUS.COMPLETED, { result: rezultatas });
  assert.equal(antras.status, STATUS.COMPLETED);
  assert.deepEqual(antras.result, rezultatas, "tas pats rezultatas — idempotentiška sėkmė, ne konfliktas");

  const kitas = await beSaugyklosStore.finishAtomic(job.id, STATUS.COMPLETED, { result: { text: "kitas" } });
  assert.equal(kitas, "RESULT_CONFLICT", "kitas rezultatas — konfliktas");
});
