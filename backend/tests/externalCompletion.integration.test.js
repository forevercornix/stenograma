const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
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
 * EXTERNAL COMPLETION — RAŠYMO KELIAS SU BANDYMŲ REGISTRU (#157, PR-4).
 *
 * ⚠️ ČIA PIRMĄ KARTĄ SUSITINKA VISOS TRYS DALYS: `ArtifactStore` rašymas, registras ir
 * completion CAS. Kiekviena atskirai jau padengta; klausimas, į kurį atsako šis failas,
 * yra jų TVARKA — kas įvyksta prieš ką ir kas lieka, kai grandinė nutrūksta.
 *
 * ⚠️ ŠIS FAILAS VIETOJE NEVYKDOMAS - reikia tikros PostgreSQL.
 */

const SAKNIS = path.resolve(__dirname, "..");
const DB_URL = testDatabaseUrl("externalcompletion");
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

test("#157 PR-4: external completion, registras ir pakartojimas", { skip: PRALEISTI, timeout: 180000 }, async (t) => {
  await adminPg(`DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`);
  await adminPg(`CREATE DATABASE "${dbVardas()}"`);
  execFileSync("npx", ["node-pg-migrate", "up"], {
    cwd: SAKNIS,
    env: { ...process.env, DATABASE_URL: DB_URL },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const pool = new Pool({ connectionString: DB_URL });
  const saknis = await fsp.mkdtemp(path.join(os.tmpdir(), "stenograma-external-"));
  t.after(async () => {
    await pool.end().catch(() => {});
    await fsp.rm(saknis, { recursive: true, force: true });
  });

  /** Skaitiklis: `put` yra tas kvietimas, kurio pre-check privalo išvengti. */
  const fs = createFsArtifactStore({ root: saknis });
  const saugykla = {
    ...fs,
    backend: "fs",
    rasymai: 0,
    trynimai: [],
    async put(raktas, reiksme) {
      this.rasymai += 1;
      return fs.put(raktas, reiksme);
    },
    async delete(raktas) {
      this.trynimai.push(raktas);
      return fs.delete(raktas);
    },
  };

  const store = createPostgresStore(pool, { rasymoSaugykla: saugykla });

  async function naujasJobas() {
    const job = await store.create({ ownerKind: OWNER_KIND.UNOWNED, type: "transcription" });
    await store.update(job.id, { status: STATUS.PROCESSING, phase: "transcribing" });
    return job.id;
  }

  async function eilute(jobId) {
    const { rows } = await pool.query("SELECT * FROM job_results WHERE job_id = $1", [jobId]);
    return rows[0] || null;
  }

  await t.test("completion parašo NUORODĄ, ne turinį, ir uždaro registro eilutę", async () => {
    const id = await naujasJobas();
    const rezultatas = { text: "external transkripcija", segments: [1, 2] };

    saugykla.rasymai = 0;
    const job = await store.finishAtomic(id, STATUS.COMPLETED, { result: rezultatas });

    assert.equal(job.status, STATUS.COMPLETED);
    assert.deepEqual(job.result, rezultatas, "hidratacija grąžina TĄ PATĮ loginį rezultatą");
    assert.equal(saugykla.rasymai, 1, "vienas bandymas — vienas objektas");

    const r = await eilute(id);
    assert.equal(r.storage_type, "fs");
    assert.equal(r.payload, null, "external eilutėje turinio NĖRA");
    assert.match(r.storage_key, new RegExp(`^results/${id}/`), "raktas neša job'o prefiksą");
    assert.match(r.checksum, /^[0-9a-f]{64}$/);

    const bandymai = await attemptRegistry.joboBandymai(pool, id);
    assert.equal(bandymai.length, 1);
    assert.equal(bandymai[0].busena, attemptRegistry.BUSENA.ISIPAREIGOTA, "registras uždarytas");
    assert.equal(bandymai[0].storage_key, r.storage_key, "registras ir nuoroda rodo TĄ PATĮ objektą");
  });

  await t.test("pakartojimas su TUO PAČIU rezultatu: `put()` NEKVIEČIAMAS, version nedidėja", async () => {
    /**
     * ⚠️ SU ATTEMPT-UNIQUE RAKTU PRE-CHECK YRA VIENINTELIS DALYKAS, NELEIDŽIANTIS
     * ŠIUKŠLĖS. „Tas pats raktas, tad perrašymas nekenkia" nebeegzistuoja: be
     * pre-check kiekvienas pakartojimas sukurtų NAUJĄ objektą.
     */
    const id = await naujasJobas();
    const rezultatas = { text: "idempotencija" };

    const pirmas = await store.finishAtomic(id, STATUS.COMPLETED, { result: rezultatas });
    const pirmaEilute = await eilute(id);

    saugykla.rasymai = 0;
    const antras = await store.finishAtomic(id, STATUS.COMPLETED, { result: rezultatas });

    assert.equal(saugykla.rasymai, 0, "pakartojimas į saugyklą NERAŠO");
    assert.equal(antras.version, pirmas.version, "version nedidėja");
    assert.deepEqual(antras.result, rezultatas, "bet rezultatas grąžinamas kaip visada");

    const antraEilute = await eilute(id);
    assert.equal(antraEilute.storage_key, pirmaEilute.storage_key, "nuoroda neperrašoma");

    const bandymai = await attemptRegistry.joboBandymai(pool, id);
    assert.equal(bandymai.length, 1, "naujas bandymas net neregistruojamas");
  });

  await t.test("pakartojimas su KITU rezultatu: `RESULT_CONFLICT`, o pralaimėjęs objektas IŠVALOMAS", async () => {
    const id = await naujasJobas();
    await store.finishAtomic(id, STATUS.COMPLETED, { result: { text: "pirmas" } });
    const pirmaEilute = await eilute(id);

    saugykla.trynimai = [];
    const verdiktas = await store.finishAtomic(id, STATUS.COMPLETED, { result: { text: "antras" } });

    assert.equal(verdiktas, "RESULT_CONFLICT");

    const bandymai = await attemptRegistry.joboBandymai(pool, id);
    assert.equal(bandymai.length, 2, "antras bandymas registruotas PRIEŠ `put()`");

    const atmestas = bandymai.find((b) => b.busena === attemptRegistry.BUSENA.ATMESTA);
    assert.ok(atmestas, "pralaimėjęs pažymimas `abandoned`, ne ištrinamas iš registro");
    assert.deepEqual(saugykla.trynimai, [atmestas.storage_key], "valymas liečia TIK savo bandymą");

    /** ⚠️ LAIMĖTOJO OBJEKTAS NEPALIESTAS — su skirtingais raktais to net neįmanoma. */
    assert.ok(await saugykla.head(pirmaEilute.storage_key), "laimėtojo objektas vietoje");
    assert.equal(await saugykla.head(atmestas.storage_key), null, "pralaimėjusio — nebėra");
    assert.equal((await eilute(id)).storage_key, pirmaEilute.storage_key, "nuoroda nepakitusi");
  });

  await t.test("checksum sutampa, bet objekto NĖRA: tai REMONTAS, ne pakartojimas", async () => {
    /**
     * ⚠️ NO-OP NEGALI BŪTI SKELBIAMAS NEPATIKRINUS, AR OBJEKTAS DAR YRA (Codex, #289).
     * Sutapęs checksum sako tik tiek, kad METADUOMENYS sutampa; grąžinus sėkmę virš
     * pakibusios nuorodos, job'as liktų `completed` be naudojamo rezultato.
     */
    const id = await naujasJobas();
    const rezultatas = { text: "remontas" };
    await store.finishAtomic(id, STATUS.COMPLETED, { result: rezultatas });

    const sena = await eilute(id);
    /** Objektas dingsta iš saugyklos — DB apie tai nieko nežino. */
    await fs.delete(sena.storage_key);

    saugykla.rasymai = 0;
    const job = await store.finishAtomic(id, STATUS.COMPLETED, { result: rezultatas });

    assert.equal(saugykla.rasymai, 1, "remontas RAŠO naują objektą");
    assert.deepEqual(job.result, rezultatas);

    const nauja = await eilute(id);
    assert.notEqual(nauja.storage_key, sena.storage_key, "nuoroda perjungta į naują bandymą");
    assert.ok(await saugykla.head(nauja.storage_key));
  });

  await t.test("KONTROLĖ: be `rasymoSaugykla` rezultatas ir toliau rašomas INLINE", async () => {
    /**
     * Be jos ankstesni tvirtinimai būtų tenkinami ir store'o, kuris VISKĄ rašo
     * external — o #157 riba sako, kad `inline` lieka teisėtas režimas.
     */
    const inlineStore = createPostgresStore(pool);
    const id = await naujasJobas();

    const job = await inlineStore.finishAtomic(id, STATUS.COMPLETED, { result: { text: "inline" } });

    assert.deepEqual(job.result, { text: "inline" });
    const r = await eilute(id);
    assert.equal(r.storage_type, "inline");
    assert.equal(r.storage_key, null);
    assert.deepEqual(r.payload, { text: "inline" });
    assert.deepEqual(await attemptRegistry.joboBandymai(pool, id), [], "inline registro neliečia");
  });
});
