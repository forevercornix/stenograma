const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const crypto = require("node:crypto");
const { Pool, Client } = require("pg");

const { skipWithoutPostgres, testDatabaseUrl, adminDatabaseUrl } = require("./helpers/postgresGuard");
const { createPostgresStore } = require("../utils/jobStore/postgresStore");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * HIDRATACIJOS RIBA — METADUOMENŲ KELIAI NETEMPIA TURINIO (#157, PR-3).
 *
 * ⚠️ §9.1: „SPY ANT `read`" ČIA NIEKO NEĮRODYTŲ.
 *
 * Tvirtinimas „niekas nekviečia skaitymo" būtų tenkinamas ir tada, jei external
 * kelio apskritai nebūtų — o jo šiandien produkcijoje ir nėra. Todėl naudojamas
 * SKAITIKLIS pačioje saugykloje ir tikrinamos ABI pusės: metaduomenų kelias duoda
 * `0`, o hidratuotas — `1`. Antroji pusė yra kontrolė, be kurios patikra virstų
 * visada-„taip".
 *
 * ⚠️ SKAITIKLIS SKAIČIUOJA `read` IR `verify`, NE VIEN `read`. `fs` backend'e
 * `verify()` perskaito visą objektą, tad skaitiklis, matantis tik `read`, leistų
 * metaduomenų keliui tempti artefaktus per kitą metodą ir liktų žalias. `head()`
 * skaičiuojamas ATSKIRAI ir pažeidimu NĖRA — jo metaduomenų keliuose laukiama.
 *
 * ⚠️ ŠIS FAILAS VIETOJE NEVYKDOMAS - reikia tikros PostgreSQL.
 */

const SAKNIS = path.resolve(__dirname, "..");
const DB_URL = testDatabaseUrl("hydration");
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

/** Skaitiklinė saugykla: TIKRO kontrakto tipai, bet apskaitomi kvietimai (#266). */
function skaitiklineSaugykla(turinys) {
  const { Readable } = require("node:stream");
  const buferis = Buffer.from(JSON.stringify(turinys), "utf8");

  return {
    backend: "skaitiklis",
    /** ⚠️ Turinio skaitymai — VIENAS skaitiklis abiem metodams. */
    perskaityta: 0,
    galvos: 0,
    async patikrintiSaugykla() {
      return { backend: "skaitiklis" };
    },
    async put() {
      throw new Error("rašymas šiame teste nenaudojamas");
    },
    async readStream() {
      this.perskaityta += 1;
      return Readable.from([buferis]);
    },
    async read() {
      this.perskaityta += 1;
      return turinys;
    },
    async head() {
      this.galvos += 1;
      return { exists: true, bytes: buferis.byteLength };
    },
    async verify() {
      this.perskaityta += 1;
      return { ok: true, exists: true, bytes: buferis.byteLength, checksum: "x", nepriklausomas: true };
    },
    async delete() {
      return true;
    },
    dydis: buferis.byteLength,
  };
}

after(async () => {
  if (PRALEISTI) return;
  await adminPg(`DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`).catch(() => {});
});

test("#157 PR-3: hidratacija yra EKSPLICITINĖ ir RIBOTA", { skip: PRALEISTI, timeout: 180000 }, async (t) => {
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

  const turinys = { text: "external transkripcija", segments: [1, 2, 3] };
  const saugykla = skaitiklineSaugykla(turinys);
  const store = createPostgresStore(pool, { artifactStore: saugykla });

  /** External eilutė įrašoma TIESIOGIAI: produkcinio rašymo kelio dar nėra (PR-4). */
  async function sukurtiExternal({ bytes = saugykla.dydis } = {}) {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, created_at, updated_at)
       VALUES ($1, 'transcription', 'completed', now(), now())`,
      [id]
    );
    await pool.query(
      `INSERT INTO job_results (job_id, storage_type, storage_key, bytes, checksum, created_at)
       VALUES ($1, 'fs', $2, $3, $4, now())`,
      [id, `results/${id}/a.json`, bytes, "a".repeat(64)]
    );
    return id;
  }

  await t.test("`get()` hidratuoja external rezultatą — ir tai kainuoja VIENĄ skaitymą", async () => {
    const id = await sukurtiExternal();
    saugykla.perskaityta = 0;

    const job = await store.get(id);

    assert.deepEqual(job.result, turinys, "loginis rezultatas nepriklauso nuo saugyklos");
    assert.equal(saugykla.perskaityta, 1, "hidratacija privalo perskaityti turinį lygiai kartą");
  });

  await t.test("metaduomenų kelias NESKAITO turinio ir `result` lauko NETURI", async () => {
    /**
     * ⚠️ `result: null` čia būtų MELAS: `null` reiškia „rezultato nėra", o jis yra.
     * Be to `applyPatch()` sprendžia pagal `"result" in job`, tad `null` reikštų
     * nurodymą jį IŠTRINTI, jei toks įrašas kada nors keliautų į `update()`.
     */
    const id = await sukurtiExternal();
    saugykla.perskaityta = 0;

    const job = await store.get(id, { hydrate: false });

    assert.equal(saugykla.perskaityta, 0, "metaduomenų kelias turinio neskaito");
    assert.equal("result" in job, false, "nehidratuotas job'as `result` lauko neturi");
    assert.equal(job.status, "completed", "bet metaduomenys grąžinami pilni");
  });

  await t.test("`listAll({hydrate:false})` neskaito NIEKO, o `listAll()` — skaito", async () => {
    /**
     * Antroji pusė yra KONTROLĖ: be jos patikra būtų tenkinama ir tada, jei external
     * hidratacijos kelio apskritai nebūtų.
     */
    const id = await sukurtiExternal();
    saugykla.perskaityta = 0;

    const metaduomenys = await store.listAll({ hydrate: false });
    assert.equal(saugykla.perskaityta, 0, "sąrašas be hidratacijos turinio neskaito");
    assert.ok(metaduomenys.some((j) => j.id === id));
    assert.ok(metaduomenys.every((j) => !("result" in j)), "nė vienas įrašas neturi `result`");

    const hidratuoti = await store.listAll();
    assert.ok(saugykla.perskaityta > 0, "hidratuotas sąrašas turinį skaito");
    assert.deepEqual(hidratuoti.find((j) => j.id === id).result, turinys);
  });

  await t.test("per didelis PERSISTINTAS dydis krenta NEPAKVIETUS saugyklos", async () => {
    /**
     * ⚠️ RIBA TIKRINAMA PRIEŠ ĮKĖLIMĄ. `bytes` persistinamas kartu su nuoroda, tad
     * per didelis rezultatas atmetamas nė nesikreipus į saugyklą — skaitiklis privalo
     * likti `0`. (Kietas stabdis skaitymo metu tikrinamas `artifactStoreBoundedRead`.)
     */
    const { getLimits, LIMIT_KIND } = require("../utils/resultLimits");
    const riba = getLimits()[LIMIT_KIND.RESULT_BYTES];

    const id = await sukurtiExternal({ bytes: riba + 1 });
    saugykla.perskaityta = 0;

    await assert.rejects(
      () => store.get(id),
      (klaida) => klaida.name === "ResultLimitError",
      "viršyta riba yra dydžio klaida, ne tyliai grąžintas `null`"
    );

    assert.equal(saugykla.perskaityta, 0, "saugykla neturi būti net paliesta");
  });

  await t.test("KONTROLĖ: inline eilutė hidratuojama BE saugyklos", async () => {
    /**
     * Be jos ankstesni tvirtinimai būtų tenkinami ir store'o, kuris hidratuoja
     * VISKĄ per saugyklą — o inline kelias privalo likti nepakitęs.
     */
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, created_at, updated_at)
       VALUES ($1, 'transcription', 'completed', now(), now())`,
      [id]
    );
    await pool.query(
      `INSERT INTO job_results (job_id, storage_type, payload, created_at)
       VALUES ($1, 'inline', $2::jsonb, now())`,
      [id, JSON.stringify({ text: "inline" })]
    );

    saugykla.perskaityta = 0;
    const job = await store.get(id);

    assert.deepEqual(job.result, { text: "inline" });
    assert.equal(saugykla.perskaityta, 0, "inline rezultatas saugyklos neliečia");
  });

  await t.test("external eilutė BE sukonfigūruotos saugyklos krenta UŽDARAI", async () => {
    /**
     * ⚠️ Grąžinti `null` čia būtų „`completed` be rezultato" — būsena, po kurios
     * terminalus valymas ištrina šaltinio audio.
     */
    const beSaugyklos = createPostgresStore(pool);
    const id = await sukurtiExternal();

    await assert.rejects(() => beSaugyklos.get(id), /artefaktų saugykla nesukonfigūruota/i);
  });
});
