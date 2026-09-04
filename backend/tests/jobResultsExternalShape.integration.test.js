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

/* ═══════════════════════════════════════════════════════════════════════════
 * MUTACIJOS: KIEKVIENAS SARGAS JAUČIAMAS ATSKIRAI
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ KODĖL TO REIKIA, NORS TESTAS JAU KRITO PRIEŠ MIGRACIJĄ.
 *
 * Raudonas raundas (CI 33854194027) parodė, kad VISI keturi sargai krenta —
 * bet visi su `42703` (stulpelio nėra), ne su `23514`. Tai įrodo, kad testas
 * jaučia migracijos NEBUVIMĄ, o ne kiekvieną invarianto dalį atskirai.
 * Pašalinus vien `bytes IS NOT NULL` iš `CHECK`, ankstesni testai vis tiek
 * kristų — bet tik todėl, kad kita mutacija juos laužia.
 *
 * Todėl sargas pašalinamas ČIA, PAČIAME TESTE, ir grąžinamas: mutacija
 * vykdoma, ne teigiama (§9.1). Tai vienintelis būdas įrodyti, kad kiekviena
 * `CHECK` dalis yra nešanti, o ne dekoratyvi.
 *
 * ⚠️ IZOLIACIJA: dirbama nuosavoje `<bazė>_extshape` DB, kuri po rinkinio
 * sunaikinama. `DROP CONSTRAINT` bendroje bazėje būtų tiksliai tai, ką
 * AGENTS.md §9.3 draudžia.
 */

const PILNA_FORMA = `
  CASE storage_type
    WHEN 'inline' THEN payload IS NOT NULL AND storage_key IS NULL
    ELSE storage_key IS NOT NULL
         AND payload IS NULL
         AND bytes IS NOT NULL
         AND checksum IS NOT NULL
  END
`;

async function suSusilpnintaForma(salyga, veiksmas) {
  await pg(DB_URL, "ALTER TABLE job_results DROP CONSTRAINT job_results_storage_shape");
  await pg(DB_URL, `ALTER TABLE job_results ADD CONSTRAINT job_results_storage_shape CHECK (${salyga})`);

  try {
    return await veiksmas();
  } finally {
    await pg(DB_URL, "ALTER TABLE job_results DROP CONSTRAINT job_results_storage_shape");
    await pg(
      DB_URL,
      `ALTER TABLE job_results ADD CONSTRAINT job_results_storage_shape CHECK (${PILNA_FORMA})`
    );
  }
}

test("#157 PR-1: kiekviena `CHECK` dalis yra NEŠANTI", { timeout: 180000 }, async (t) => {
  if (praleisti()) return;

  await perkurtiDb();

  await t.test("be `payload IS NULL` — hibridinė eilutė ĮSIRAŠO", async () => {
    const kodas = await suSusilpnintaForma(
      `CASE storage_type
         WHEN 'inline' THEN payload IS NOT NULL AND storage_key IS NULL
         ELSE storage_key IS NOT NULL AND bytes IS NOT NULL AND checksum IS NOT NULL
       END`,
      () =>
        ideti({
          storage_type: "s3",
          storage_key: RAKTAS,
          payload: JSON.stringify({ text: "x" }),
          bytes: 1024,
          checksum: SUMA,
        })
    );

    assert.equal(kodas, null, "sargas pašalintas → eilutė praeina, vadinasi jis buvo nešantis");
  });

  await t.test("be `bytes IS NOT NULL` — eilutė be dydžio ĮSIRAŠO", async () => {
    const kodas = await suSusilpnintaForma(
      `CASE storage_type
         WHEN 'inline' THEN payload IS NOT NULL AND storage_key IS NULL
         ELSE storage_key IS NOT NULL AND payload IS NULL AND checksum IS NOT NULL
       END`,
      () => ideti({ storage_type: "fs", storage_key: RAKTAS, checksum: SUMA })
    );

    assert.equal(kodas, null, "`bytes` sąlyga jaučiama ATSKIRAI nuo `checksum`");
  });

  await t.test("be `checksum IS NOT NULL` — eilutė be sumos ĮSIRAŠO", async () => {
    const kodas = await suSusilpnintaForma(
      `CASE storage_type
         WHEN 'inline' THEN payload IS NOT NULL AND storage_key IS NULL
         ELSE storage_key IS NOT NULL AND payload IS NULL AND bytes IS NOT NULL
       END`,
      () => ideti({ storage_type: "fs", storage_key: RAKTAS, bytes: 1024 })
    );

    assert.equal(kodas, null, "`checksum` sąlyga jaučiama ATSKIRAI nuo `bytes`");
  });

  await t.test("KONTROLĖ: grąžinus pilną formą, tos pačios eilutės vėl ATMETAMOS", async () => {
    /**
     * ⚠️ BE ŠIOS DALIES mutacijos nieko neįrodytų: jos rodytų, kad susilpninta
     * forma praleidžia, bet ne kad pilna — atmeta. Tikrinama, kad `finally`
     * blokas invariantą tikrai atstatė.
     */
    assert.equal(await ideti({ storage_type: "fs", storage_key: RAKTAS, checksum: SUMA }), "23514");
    assert.equal(await ideti({ storage_type: "fs", storage_key: RAKTAS, bytes: 1024 }), "23514");
    assert.equal(
      await ideti({
        storage_type: "s3",
        storage_key: RAKTAS,
        payload: JSON.stringify({ text: "x" }),
        bytes: 1024,
        checksum: SUMA,
      }),
      "23514"
    );
  });

  await t.test("`fs` reikšmės sargas jaučiamas atskirai nuo formos", async () => {
    /**
     * Reikšmių aibė ir forma yra DU sargai vienoje migracijoje. Susilpninus
     * TIK reikšmes, forma privalo likti galiojanti — kitaip vienas testas
     * dengtų abu ir nė vieno neįrodytų.
     */
    await pg(DB_URL, "ALTER TABLE job_results DROP CONSTRAINT job_results_storage_type_values");
    await pg(
      DB_URL,
      "ALTER TABLE job_results ADD CONSTRAINT job_results_storage_type_values CHECK (storage_type IN ('inline', 's3'))"
    );

    try {
      assert.equal(
        await ideti({ storage_type: "fs", storage_key: RAKTAS, bytes: 1024, checksum: SUMA }),
        "23514",
        "grąžinus senąją aibę, `fs` vėl neįrašomas"
      );
    } finally {
      await pg(DB_URL, "ALTER TABLE job_results DROP CONSTRAINT job_results_storage_type_values");
      await pg(
        DB_URL,
        "ALTER TABLE job_results ADD CONSTRAINT job_results_storage_type_values CHECK (storage_type IN ('inline', 'fs', 's3'))"
      );
    }

    assert.equal(
      await ideti({ storage_type: "fs", storage_key: RAKTAS, bytes: 1024, checksum: SUMA }),
      null,
      "KONTROLĖ: atstačius aibę `fs` vėl praeina"
    );
  });
});
