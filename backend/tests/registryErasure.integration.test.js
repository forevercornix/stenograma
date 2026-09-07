const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");
const { Pool, Client } = require("pg");

const { skipWithoutPostgres, testDatabaseUrl, adminDatabaseUrl } = require("./helpers/postgresGuard");
const { createPostgresStore } = require("../utils/jobStore/postgresStore");
const { createFsArtifactStore } = require("../utils/artifactStore/fsStore");
const attemptRegistry = require("../utils/attemptRegistry");
const { STATUS, OWNER_KIND } = require("../utils/jobStore/common");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * ERASURE PER BANDYMŲ REGISTRĄ (#157, PR-5).
 *
 * ⚠️ ČIA `joboBandymai()` PIRMĄ KARTĄ TAMPA PRODUKCINIU KELIU.
 *
 * PR-4 registrą parašė, bet už modulio ribų jo niekas nekvietė — tad „erasure trina
 * pagal registrą" buvo dokumentacija, ne savybė. Šis failas tikrina ne tik tai, kad
 * objektai pašalinti, bet ir kad REGISTRAS buvo skaitymo šaltinis: nereferencuotas
 * bandymas pasiekiamas TIK per jį.
 *
 * ⚠️ ŠIS FAILAS VIETOJE NEVYKDOMAS - reikia tikros PostgreSQL.
 */

const SAKNIS = path.resolve(__dirname, "..");
const DB_URL = testDatabaseUrl("registryerasure");
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

test("#157 PR-5: erasure trina PAGAL REGISTRĄ", { skip: PRALEISTI, timeout: 180000 }, async (t) => {
  await adminPg(`DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`);
  await adminPg(`CREATE DATABASE "${dbVardas()}"`);
  execFileSync("npx", ["node-pg-migrate", "up"], {
    cwd: SAKNIS,
    env: { ...process.env, DATABASE_URL: DB_URL },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const pool = new Pool({ connectionString: DB_URL });
  const saknis = await fsp.mkdtemp(path.join(os.tmpdir(), "stenograma-erasure-"));
  t.after(async () => {
    await pool.end().catch(() => {});
    await fsp.rm(saknis, { recursive: true, force: true });
  });

  const fs = createFsArtifactStore({ root: saknis });
  const saugykla = { ...fs, backend: "fs" };
  const store = createPostgresStore(pool, { rasymoSaugykla: saugykla });

  async function naujasJobas() {
    const job = await store.create({ ownerKind: OWNER_KIND.UNOWNED, type: "transcription" });
    await store.update(job.id, { status: STATUS.PROCESSING, phase: "transcribing" });
    return job.id;
  }

  /**
   * ⚠️ NUTRŪKĘS PROCESAS ATKURIAMAS TIESIOGIAI, IR TAI VIENINTELIS BŪDAS.
   *
   * Bandymas, kurio objektas parašytas, bet nuoroda neįsipareigota, atsiranda tik tada,
   * kai procesas miršta tarp `put()` ir commit'o. Per produkcinį kelią to nepakartosi
   * nenužudžius proceso; per registro API — pakartoji tiksliai. Būtent šitą klasę
   * registras ir sukurtas padaryti matomą.
   */
  async function nutrukesBandymas(jobId, turinys) {
    const attemptId = attemptRegistry.naujasBandymas();
    const raktas = attemptRegistry.bandymoRaktas(jobId, attemptId);

    await attemptRegistry.registruoti(pool, {
      attemptId,
      jobId,
      storageType: "fs",
      storageKey: raktas,
    });
    await saugykla.put(raktas, turinys);

    return { attemptId, raktas };
  }

  async function rezultatoEilute(jobId) {
    const { rows } = await pool.query("SELECT storage_type, storage_key FROM job_results WHERE job_id = $1", [jobId]);
    return rows[0] || null;
  }

  await t.test("`listResultArtifacts()` grąžina IR nereferencuotus bandymus", async () => {
    const id = await naujasJobas();
    await store.finishAtomic(id, STATUS.COMPLETED, { result: { text: "laimėtojas" } });

    const eilute = await rezultatoEilute(id);
    const nutrukes = await nutrukesBandymas(id, { text: "niekada neįsipareigotas" });

    const artefaktai = await store.listResultArtifacts(id);
    const raktai = artefaktai.map((a) => a.storageKey);

    assert.ok(raktai.includes(eilute.storage_key), "referencuotas objektas privalo būti sąraše");
    assert.ok(
      raktai.includes(nutrukes.raktas),
      `nereferencuotas bandymas privalo būti sąraše — jis pasiekiamas TIK per registrą: ${raktai.join(", ")}`
    );

    /** ⚠️ KONTROLĖ: `job_results` apie jį NIEKO nežino. */
    assert.notEqual(nutrukes.raktas, eilute.storage_key);
    const { rows } = await pool.query("SELECT 1 FROM job_results WHERE storage_key = $1", [nutrukes.raktas]);
    assert.equal(rows.length, 0, "nuoroda į nutrūkusį bandymą neegzistuoja — tai ir yra esmė");

    /** Referencuotas grąžinamas PASKUTINIS: kvietėjas trina eilės tvarka. */
    assert.equal(
      artefaktai[artefaktai.length - 1].storageKey,
      eilute.storage_key,
      "referencuotas objektas privalo būti paskutinis"
    );
    assert.equal(artefaktai[artefaktai.length - 1].referencuotas, true);
  });

  await t.test("`deleteResultArtifacts()` pašalina VISUS bandymus, ne tik referencuotą", async () => {
    const id = await naujasJobas();
    await store.finishAtomic(id, STATUS.COMPLETED, { result: { text: "laimėtojas" } });

    const eilute = await rezultatoEilute(id);
    const a = await nutrukesBandymas(id, { text: "nutrūkęs A" });
    const b = await nutrukesBandymas(id, { text: "nutrūkęs B" });

    assert.ok(await saugykla.head(a.raktas), "kontrolė: objektas prieš šalinimą YRA");

    const rezultatas = await store.deleteResultArtifacts(id);

    assert.deepEqual(rezultatas.nepavyko, [], "nė vienas šalinimas negali nepavykti");
    assert.equal(rezultatas.pasalinti.length, 3, `laukta trijų: ${JSON.stringify(rezultatas)}`);

    for (const raktas of [a.raktas, b.raktas, eilute.storage_key]) {
      assert.equal(await saugykla.head(raktas), null, `objektas liko: ${raktas}`);
    }
  });

  await t.test("REGISTRAS yra šaltinis NEREFERENCUOTIEMS bandymams: be jo eilutės objektas IŠLIEKA", async () => {
    /**
     * ⚠️ MUTACIJOS EKVIVALENTAS, ĮVYKDYTAS DUOMENIMIS, NE KODU.
     *
     * Jei erasure eitų per `job_results.storage_key`, nutrūkusio bandymo objektas
     * išliktų — ir tai vienintelis skirtumas tarp „trina pagal nuorodą" ir „trina pagal
     * registrą". Pašalinus registro eilutę, sąlygos tampa lygiai tokios, kokios būtų
     * BE registro, ir objektas privalo išlikti.
     *
     * ⚠️ KĄ TIKSLIAI ĮRODO — IR KO NE. Įrodoma, kad registras yra šaltinis
     * NEREFERENCUOTIEMS bandymams. REFERENCUOTAS objektas atrandamas ABIEM keliais:
     * `listResultArtifacts()` jį grąžina ir be registro eilutės (`busena: null` šaka,
     * `job_results` pusė). Tai SĄMONINGA dviguba gynyba, ne spraga — bet jei šio testo
     * pavadinimas ar komentaras teigtų „registras yra vienintelis šaltinis", teiginys
     * būtų platesnis už tai, kas patikrinta, ir kitas skaitytojas jo nebetikrintų.
     */
    const id = await naujasJobas();
    await store.finishAtomic(id, STATUS.COMPLETED, { result: { text: "laimėtojas" } });
    const nutrukes = await nutrukesBandymas(id, { text: "be registro eilutės" });

    await pool.query("DELETE FROM job_result_attempts WHERE attempt_id = $1", [nutrukes.attemptId]);

    const rezultatas = await store.deleteResultArtifacts(id);

    assert.deepEqual(rezultatas.nepavyko, []);
    assert.ok(
      await saugykla.head(nutrukes.raktas),
      "be registro eilutės objektas PRIVALO likti — kitaip testas nieko apie registrą neįrodo"
    );

    /** Sutvarkoma, kad likutis neterštų kitų subtestų. */
    await saugykla.delete(nutrukes.raktas);
  });

  await t.test("`eraseJob()` per fasado paviršių nueina iki saugyklos", async () => {
    /**
     * ⚠️ ANKSTESNI SUBTESTAI TIKRINA STORE'Ą; ŠIS — LAIDĄ.
     *
     * `jobErasure` klausia `store.system.deleteResultArtifacts()`, ir be šio subtesto
     * liktų neįrodyta, kad produkcinis erasure kelias tą metodą apskritai kviečia.
     * Adapteris atkartoja fasado paviršių, o ne apeina jį: `jobStore/index.js` `system`
     * bloke tie patys keturi metodai.
     */
    const { eraseJob } = require("../utils/jobErasure");

    const id = await naujasJobas();
    await store.finishAtomic(id, STATUS.COMPLETED, { result: { text: "per fasadą" } });
    const eilute = await rezultatoEilute(id);
    const nutrukes = await nutrukesBandymas(id, { text: "per fasadą, nutrūkęs" });

    const adapteris = {
      system: {
        get: (jobId, nustatymai) => store.get(jobId, nustatymai),
        update: (jobId, patch) => store.update(jobId, patch),
        remove: (jobId) => store.remove(jobId),
        deleteResultArtifacts: (jobId) => store.deleteResultArtifacts(jobId),
      },
    };

    const outcome = await eraseJob({ id, type: "transcription", storageKey: null }, { store: adapteris });

    assert.equal(outcome.criticalFailure, false, `klaidos: ${outcome.errors.join("; ")}`);
    assert.equal(outcome.resultArtifactsRemoved, 2, "abu objektai — referencuotas ir nutrūkęs");
    assert.equal(await saugykla.head(eilute.storage_key), null);
    assert.equal(await saugykla.head(nutrukes.raktas), null);
    assert.equal(outcome.jobRemoved, true, "objektai pašalinti, tad eilutę šalinti leidžiama");
  });
});
