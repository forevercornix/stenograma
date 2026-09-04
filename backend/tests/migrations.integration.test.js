const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { Pool } = require("pg");
const {
  skipWithoutPostgres,
  testDatabaseUrl,
  adminDatabaseUrl,
} = require("./helpers/postgresGuard");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * MIGRACIJŲ KARKASO TESTAI (#155, 7.1).
 *
 * ⚠️ Šie testai KEIČIA SCHEMĄ, tad dirba atskiroje duomenų bazėje
 * (`<bazė>_migrations`), kurią patys sukuria ir sunaikina. `node --test` failus
 * vykdo lygiagrečiai — bendra DB reikštų tą patį gedimo šaltinį, kurį Redis
 * pusėje jau turėjome su `flushdb`.
 */

const ŠAKNIS = path.resolve(__dirname, "..");
const DB_URL = testDatabaseUrl("migrations");

function pg(url, sql) {
  const { Client } = require("pg");
  return (async () => {
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      return await c.query(sql);
    } finally {
      await c.end();
    }
  })();
}

function testoDbVardas() {
  return new URL(DB_URL).pathname.replace(/^\//, "");
}

async function perkurtiDb() {
  const admin = adminDatabaseUrl();
  const vardas = testoDbVardas();

  // `IF EXISTS` – pirmas paleidimas neturi ką šalinti.
  //
  // ⚠️ `WITH (FORCE)` – kitaip `DROP` nepavyksta, jei liko pakibęs
  // prisijungimas iš nutrūkusio ankstesnio paleidimo. Palaikoma nuo PG 13.
  await pg(admin, `DROP DATABASE IF EXISTS "${vardas}" WITH (FORCE)`);
  await pg(admin, `CREATE DATABASE "${vardas}"`);
}

/**
 * Testinė DB pašalinama PO rinkinio.
 *
 * ⚠️ Be to nutrūkęs testas palieka bazę visam laikui. CI konteineryje tai
 * nesvarbu (jis vis tiek dingsta), bet lokaliame PostgreSQL šiukšlė kaupiasi,
 * o kitas paleidimas jos NEIŠVALO: `perkurtiDb()` kviečiamas tik tuose
 * testuose, kurie iki jo priena.
 */
async function išvalyti() {
  if (skipWithoutPostgres()) return;
  await pg(adminDatabaseUrl(), `DROP DATABASE IF EXISTS "${testoDbVardas()}" WITH (FORCE)`).catch(
    () => {}
  );
}

/**
 * @param {string} kryptis komanda su neprivalomu kiekiu, pvz. `"up"` arba `"up 2"`.
 *   ⚠️ Skaidoma per tarpą: `execFileSync` argumentų NESKAIDO, tad `"up 2"`
 *   nueitų kaip VIENAS argumentas ir CLI jo neatpažintų.
 * @param {string} [dir] – migracijų katalogas. Numatytai repo `migrations/`.
 */
function migrate(kryptis = "up", dir) {
  return execFileSync(
    "npx",
    ["node-pg-migrate", ...kryptis.split(/\s+/).filter(Boolean), ...(dir ? ["-m", dir] : [])],
    {
      cwd: ŠAKNIS,
      env: { ...process.env, DATABASE_URL: DB_URL },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
}

test(
  "#155 MIGRACIJOS: tuščia DB → dabartinė schema",
  { skip: skipWithoutPostgres() },
  async () => {
    await perkurtiDb();

    const išvestis = migrate("up");
    assert.ok(išvestis !== undefined, "migrate:up turi įvykdyti");

    /** `pgmigrations` lentelė yra karkaso egzistavimo įrodymas. */
    const r = await pg(
      DB_URL,
      "SELECT to_regclass('public.pgmigrations') IS NOT NULL AS yra"
    );
    assert.equal(r.rows[0].yra, true, "pgmigrations lentelė turi būti sukurta");
  }
);

test(
  "#155 MIGRACIJOS: antras migrate:up iš eilės = NO-OP",
  { skip: skipWithoutPostgres() },
  async (t) => {
    /**
     * ⚠️ Ne „nemeta klaidos", o „nieko nepakeičia".
     *
     * Migracija, kuri pakartotinai pritaikoma, tyliai sugriautų schemą arba
     * dubliuotų duomenis. Tikrinama `pgmigrations` eilučių aibė PRIEŠ ir PO.
     */
    /**
     * ⚠️ REIKIA TIKROS MIGRACIJOS.
     *
     * `backend/migrations/` kol kas turi tik `.gitkeep`, tad be fixture'o abi
     * užklausos grąžintų TUŠČIAS aibes ir testas praeitų nieko netikrindamas —
     * idempotentiškumo garantija liktų be mutacijai atsparaus įrodymo.
     *
     * Fixture kuriamas testo metu ir pašalinamas po jo: repo migracijų
     * katalogas lieka švarus, o pati migracija turi STEBIMĄ poveikį (lentelę),
     * kad pakartotinis pritaikymas būtų matomas.
     */
    /**
     * ⚠️ LAIKINAS KATALOGAS, ne repo `migrations/`.
     *
     * `node --test` failus vykdo LYGIAGREČIAI, o `postgresReachability()`
     * skaito būtent repo `migrations/`, kad rastų laukiančias migracijas. Rašant
     * fixture ten, kitas PostgreSQL testų failas trumpam matytų
     * `9999999999999_test_idempotency` kaip tikrą repo migraciją.
     *
     * `-m` nurodo `node-pg-migrate` kitą katalogą; repo turinys nepaliečiamas.
     */
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "stenograma-migr-"));
    const fixtureVardas = `9999999999999_test_idempotency`;
    const fixtureKelias = path.join(fixtureDir, `${fixtureVardas}.js`);

    fs.writeFileSync(
      fixtureKelias,
      [
        "/** TESTO fixture — kuriamas ir šalinamas `migrations.integration` metu. */",
        "exports.up = (pgm) => {",
        "  pgm.createTable('migracijos_idempotency_probe', { id: 'id' });",
        "};",
        "exports.down = (pgm) => {",
        "  pgm.dropTable('migracijos_idempotency_probe');",
        "};",
        "",
      ].join("\n")
    );

    t.after(() => {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    });

    await perkurtiDb();
    migrate("up", fixtureDir);

    /** Migracija realiai pritaikyta — kitaip lyginame tuščias aibes. */
    const lentelė = await pg(
      DB_URL,
      "SELECT to_regclass('public.migracijos_idempotency_probe') IS NOT NULL AS yra"
    );
    assert.equal(lentelė.rows[0].yra, true, "fixture migracija privalo būti pritaikyta");

    const prieš = await pg(DB_URL, "SELECT name FROM pgmigrations ORDER BY name");
    assert.ok(prieš.rows.length > 0, "prielaida: bent viena migracija pritaikyta");

    migrate("up", fixtureDir);
    const po = await pg(DB_URL, "SELECT name FROM pgmigrations ORDER BY name");

    assert.deepEqual(
      po.rows.map((x) => x.name),
      prieš.rows.map((x) => x.name),
      "antras paleidimas neturi pridėti nė vienos migracijos"
    );

    /**
     * Pakartotinis `createTable` be `IF NOT EXISTS` kristų — tad lentelės
     * buvimas PO antro paleidimo įrodo, kad migracija NEBUVO pritaikyta iš
     * naujo, o ne kad jos apskritai nebuvo.
     */
    const poAntro = await pg(
      DB_URL,
      "SELECT to_regclass('public.migracijos_idempotency_probe') IS NOT NULL AS yra"
    );
    assert.equal(poAntro.rows[0].yra, true, "lentelė išliko, migracija nepakartota");
  }
);

test(
  "#155 MIGRACIJOS: checkOrder neleidžia pritaikyti ne eilės tvarka",
  { skip: skipWithoutPostgres() },
  () => {
    /**
     * Konfigūracinis invariantas, ne runtime.
     *
     * Be `checkOrder`, migracija su ankstesne laiko žyma nei jau pritaikyta
     * būtų pritaikyta TYLIAI. Rezultatas: dvi aplinkos su ta pačia
     * `pgmigrations` lentele, bet skirtinga schema — ir niekas apie tai
     * nepraneša.
     */
    const fs = require("node:fs");
    const cfg = JSON.parse(
      fs.readFileSync(path.join(ŠAKNIS, ".node-pg-migraterc"), "utf8")
    );

    assert.equal(cfg.checkOrder, true, "checkOrder privalo likti įjungtas");
    assert.equal(cfg.dir, "migrations");
  }
);

/** node:test kviečia po VISŲ šio failo testų, įskaitant kritusius. */
after(išvalyti);

test(
  "#155 MIGRACIJOS: atnaujinimas iš TĖVINĖS schemos sugriežtina constraint'us",
  { skip: skipWithoutPostgres() },
  async () => {
    /**
     * ⚠️ ŠVARIOS DB TESTO NEPAKANKA.
     *
     * `node-pg-migrate` praleidžia failą pagal VARDĄ (`pgmigrations` lentelė),
     * tad pakeitus JAU IŠSIŲSTĄ migraciją švarios DB testai praeitų, o
     * egzistuojančios liktų su laisvesne schema - tyliai, nes antras
     * `migrate:up` teisėtai yra no-op (žr. testą aukščiau).
     *
     * Todėl tikrinamas būtent atnaujinimo kelias: pirma pritaikoma TIK tėvinė
     * migracija, tada visos, ir įrodoma, kad reikšmė, kurią tėvinė schema
     * priimdavo, dabar atmetama.
     */
    await perkurtiDb();

    const tevine = fs.mkdtempSync(path.join(os.tmpdir(), "stenograma-migr-"));
    try {
      /** ⚠️ Filtruojama pagal plėtinį - kataloge yra ir `.gitkeep`. */
      const visos = fs
        .readdirSync(path.join(ŠAKNIS, "migrations"))
        .filter((f) => f.endsWith(".js"))
        .sort();
      assert.ok(visos.length >= 2, "testas prasmingas tik esant bent dviem migracijoms");
      const pirma = visos[0];
      fs.copyFileSync(
        path.join(ŠAKNIS, "migrations", pirma),
        path.join(tevine, pirma)
      );

      migrate("up", tevine);

      const pool = new Pool({ connectionString: DB_URL });
      try {
        const irasyti = (tipas, era) =>
          pool.query(
            `INSERT INTO jobs (id, type, status, progress_known, schema_version, created_at, updated_at)
             VALUES (gen_random_uuid(), $1, 'queued', false, $2, now(), now())`,
            [tipas, era]
          );

        // Tėvinė schema šias reikšmes PRIIMA - tai ir yra spraga.
        await assert.doesNotReject(() => irasyti("transcription", 1));
        await assert.doesNotReject(() => irasyti("bogus", 2));
        await pool.query("TRUNCATE jobs CASCADE");

        // Atnaujinimas.
        migrate("up");

        await assert.rejects(
          () => irasyti("transcription", 1),
          (err) => err.code === "23514",
          "schema_version=1 privalo būti atmestas PO atnaujinimo"
        );
        await assert.rejects(
          () => irasyti("bogus", 2),
          (err) => err.code === "23514",
          "nežinomas tipas privalo būti atmestas PO atnaujinimo"
        );
      } finally {
        await pool.end();
      }
    } finally {
      fs.rmSync(tevine, { recursive: true, force: true });
    }
  }
);

test(
  "#155 STARTAS: pasenusi schema (tik tėvinė migracija) nutraukia initializePostgres()",
  { skip: skipWithoutPostgres() },
  async () => {
    /**
     * ⚠️ LENTELIŲ BUVIMO NEPAKANKA.
     *
     * DB, kurioje paleista TIK `1755000000000`, abi lenteles jau turi, tad
     * `SELECT 1` + lentelių patikra praeitų: `readiness.jobStore` taptų
     * `true`, serveris imtų klausytis, o DB priiminėtų įrašus, kuriuos
     * naujesnė migracija turi blokuoti (nežinomas tipas, era `1`, nežinomas
     * actor source).
     */
    await perkurtiDb();

    const tevine = fs.mkdtempSync(path.join(os.tmpdir(), "stenograma-migr-"));
    const buves = process.env.DATABASE_URL;

    try {
      const pirma = fs
        .readdirSync(path.join(ŠAKNIS, "migrations"))
        .filter((f) => f.endsWith(".js"))
        .sort()[0];
      fs.copyFileSync(path.join(ŠAKNIS, "migrations", pirma), path.join(tevine, pirma));
      migrate("up", tevine);

      process.env.DATABASE_URL = DB_URL;
      delete require.cache[require.resolve("../utils/jobStore")];
      const jobStore = require("../utils/jobStore");

      await assert.rejects(
        () => jobStore._initializePostgresForTests(),
        /trūksta invariantų/,
        "pasenusi schema privalo nutraukti startą, ne būti paskelbta pasiruošusia"
      );

      // Paleidus visas migracijas startas praeina.
      migrate("up");
      const store = await jobStore._initializePostgresForTests();
      assert.equal(store.backend, "postgres");
      await store.close();
    } finally {
      delete require.cache[require.resolve("../utils/jobStore")];
      if (buves === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = buves;
      fs.rmSync(tevine, { recursive: true, force: true });
    }
  }
);

test(
  "#155 7.3 STARTAS: REQUIRED_SESSION_CONSTRAINTS apima VISUS `sessions` invariantus",
  { skip: skipWithoutPostgres() },
  async () => {
    /**
     * ⚠️ TAS PATS MODELIS KAIP `REQUIRED_JOB_CONSTRAINTS` (#155, 7.2a).
     *
     * Ten dalinis sąrašas praleido tris invariantus, ir tai pastebėjo tik
     * peržiūra. Narystės patikra po vieną tikrintų tik APATINĘ ribą: sąrašas
     * galėtų būti trumpesnis už schemą, ir startas praleistų DB, kurioje
     * sesijų laiko invariantų nėra.
     *
     * Todėl sąrašas IŠVEDAMAS iš šviežiai migruotos DB ir lyginamas
     * `deepEqual` - naujas `CHECK` migracijoje be įrašo sąraše krinta iškart.
     */
    await perkurtiDb();
    migrate("up");

    const { REQUIRED_SESSION_CONSTRAINTS } = require("../utils/sessionStore");
    const pool = new Pool({ connectionString: DB_URL });

    try {
      const { rows } = await pool.query(
        `SELECT c.conname
           FROM pg_constraint c
           JOIN pg_class t     ON t.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE t.relname = 'sessions'
            AND n.nspname = current_schema()
            AND c.contype = 'c'`
      );

      assert.deepEqual(
        rows.map((r) => r.conname).sort(),
        [...REQUIRED_SESSION_CONSTRAINTS].sort(),
        "migracijų sukurtų sesijų CHECK invariantų aibė nesutampa su tikrinamu sąrašu"
      );
    } finally {
      await pool.end();
    }
  }
);

test(
  "#155 7.3 MIGRACIJA: atnaujinimas iš PRIEŠ-7.3 schemos sukuria `sessions` su invariantais",
  { skip: skipWithoutPostgres() },
  async () => {
    /**
     * ⚠️ ŠVARIOS DB TESTO NEPAKANKA.
     *
     * `node-pg-migrate` praleidžia failą pagal VARDĄ, tad jau migruotoje DB
     * pakeista SENA migracija nebūtų pritaikyta: „tuščia DB → pilna schema"
     * praeitų, o egzistuojanti DB liktų be `sessions` - tyliai, nes antras
     * `migrate:up` teisėtai yra no-op. Tai jau įvyko #155 darbe (#200).
     *
     * Todėl tikrinamas būtent ATNAUJINIMO kelias: pirma pakeliama schema iki
     * 7.2b būsenos (dvi migracijos), tada paleidžiamas likęs `up`.
     */
    await perkurtiDb();

    /** Iki 7.3: `jobs` + `job_results` ir runtime pariteto sugriežtinimas. */
    migrate("up 2");

    const pool = new Pool({ connectionString: DB_URL });
    try {
      const { rows: pries } = await pool.query(
        `SELECT to_regclass(current_schema() || '.sessions') AS yra`
      );
      assert.equal(pries[0].yra, null, "prielaida: prieš 7.3 sesijų lentelės nėra");

      migrate("up");

      const { REQUIRED_SESSION_CONSTRAINTS } = require("../utils/sessionStore");
      const { rows } = await pool.query(
        `SELECT c.conname
           FROM pg_constraint c
           JOIN pg_class t     ON t.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE t.relname = 'sessions'
            AND n.nspname = current_schema()
            AND c.contype = 'c'`
      );

      assert.deepEqual(
        rows.map((r) => r.conname).sort(),
        [...REQUIRED_SESSION_CONSTRAINTS].sort(),
        "atnaujinta DB privalo gauti VISUS sesijų invariantus, ne tik lentelę"
      );
    } finally {
      await pool.end();
    }
  }
);

test(
  "#155 STARTAS: REQUIRED_JOB_CONSTRAINTS apima VISUS migracijų sukurtus invariantus",
  { skip: skipWithoutPostgres() },
  async () => {
    /**
     * ⚠️ DALINIS SĄRAŠAS YRA TYLI SPRAGA.
     *
     * Startas tikrina tik tuos constraint'us, kurie surašyti
     * `REQUIRED_JOB_CONSTRAINTS`. Praleidus bent vieną (taip ir buvo:
     * trūko `jobs_status_values`, `jobs_progress_known`,
     * `jobs_progress_only_processing`), nukrypusi schema praeitų startą, nors
     * priima būsenas, kurias runtime atmeta.
     *
     * Sąrašas IŠVEDAMAS iš šviežiai migruotos DB, ne surašomas teste - tad
     * naujas constraint'as migracijoje be įrašo sąraše krinta iškart.
     */
    await perkurtiDb();
    migrate("up");

    const { REQUIRED_JOB_CONSTRAINTS } = require("../utils/jobStore");
    const pool = new Pool({ connectionString: DB_URL });

    try {
      const { rows } = await pool.query(
        `SELECT c.conname
           FROM pg_constraint c
           JOIN pg_class t     ON t.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE t.relname = 'jobs'
            AND n.nspname = current_schema()
            AND c.contype = 'c'`
      );

      assert.deepEqual(
        rows.map((r) => r.conname).sort(),
        [...REQUIRED_JOB_CONSTRAINTS].sort(),
        "migracijų sukurtų CHECK invariantų aibė nesutampa su tikrinamu sąrašu"
      );

      /**
       * ⚠️ TA PATI PILNUMO PATIKRA `job_results` LENTELEI (#157, PR-1).
       *
       * Readiness anksčiau filtravo tik `jobs`, tad `job_results` invariantai
       * nebuvo tikrinami nei starte, nei čia (Codex #289). Sąrašas išvedamas iš
       * šviežiai migruotos DB — naujas constraint'as migracijoje be įrašo
       * `REQUIRED_JOB_RESULT_CONSTRAINTS` krinta iškart.
       */
      const { REQUIRED_JOB_RESULT_CONSTRAINTS } = require("../utils/jobStore");
      const { rows: rezultatai } = await pool.query(
        `SELECT c.conname
           FROM pg_constraint c
           JOIN pg_class t     ON t.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE t.relname = 'job_results'
            AND n.nspname = current_schema()
            AND c.contype = 'c'`
      );

      assert.deepEqual(
        rezultatai.map((r) => r.conname).sort(),
        [...REQUIRED_JOB_RESULT_CONSTRAINTS].sort(),
        "`job_results` CHECK invariantų aibė nesutampa su tikrinamu sąrašu"
      );
    } finally {
      await pool.end();
    }
  }
);

test(
  "#157 STARTAS: dingęs `job_results` invariantas SUSTABDO paleidimą",
  { skip: skipWithoutPostgres() },
  async () => {
    /**
     * ⚠️ CODEX RADINYS (#289): readiness užklausa filtravo `t.relname = 'jobs'`,
     * tad diegimas, pritaikęs tik pirmąją #157 migraciją arba praradęs
     * constraint'ą dėl schemos nukrypimo, startuodavo SĖKMINGAI — o rezultatų
     * rašymo ir restore verifikacijos keliai remiasi būtent tais invariantais.
     *
     * Tikrinamas ELGESYS, ne sąrašas: constraint'as realiai pašalinamas, ir
     * startas privalo kristi fail-closed.
     */
    await perkurtiDb();
    migrate("up");

    const { _initializePostgresForTests } = require("../utils/jobStore");
    assert.ok(_initializePostgresForTests, "startas turi būti pasiekiamas testui");

    /**
     * ⚠️ `initializePostgres()` SKAITO `process.env`, ARGUMENTŲ NEPRIIMA, ir
     * sėkmės atveju pool'o NEUŽDARO (jį perima store). Todėl aplinka keičiama
     * trumpam, o sukurtas store'as uždaromas rankomis — kitaip liktų atviros
     * jungtys, ir kitas failas gautų „too many clients" (§9.3).
     */
    const senasUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = DB_URL;

    async function startas() {
      const store = await _initializePostgresForTests();
      await store.close?.();
      return store;
    }

    try {
      /** KONTROLĖ: pilna schema startą PRAEINA — kitaip patikra būtų visada „ne". */
      await startas();

      await pg(DB_URL, "ALTER TABLE job_results DROP CONSTRAINT job_results_storage_shape");

      await assert.rejects(
        startas,
        /job_results_storage_shape/,
        "dingęs invariantas privalo sustabdyti startą ir būti ĮVARDYTAS"
      );
    } finally {
      await pg(
        DB_URL,
        `ALTER TABLE job_results ADD CONSTRAINT job_results_storage_shape CHECK (
           CASE storage_type
             WHEN 'inline' THEN payload IS NOT NULL AND storage_key IS NULL
                  AND bytes IS NULL AND checksum IS NULL
             ELSE storage_key IS NOT NULL AND payload IS NULL
                  AND bytes IS NOT NULL AND checksum IS NOT NULL
           END
         )`
      );
      if (senasUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = senasUrl;
    }
  }
);

test(
  "#184 SCHEMA: `jobs.version` upgrade iš ankstesnės schemos + INSERT/SELECT",
  { skip: skipWithoutPostgres(), timeout: 120000 },
  async () => {
    /**
     * ⚠️ KODĖL ŠIS TESTAS APSKRITAI REIKALINGAS (#184, 7.5b).
     *
     * Readiness patikra (`utils/jobStore/index.js`) tikrina LENTELES ir
     * CHECK CONSTRAINT'US — ne stulpelius. Pamirštas stulpelių žemėlapis
     * (`COLUMNS` / `PATCH_STULPELIAI` / `jobToRow`) starte NEKRIS: jis kris
     * pirmo `INSERT` metu, gyvame sraute. Todėl schemos garantija tikrinama
     * čia, o ne pasitikima startu.
     *
     * ⚠️ TIKRINAMAS UPGRADE, NE TIK ŠVIEŽIA SCHEMA. Švarioje DB stulpelis
     * atsirastų ir be `DEFAULT`; klausimas yra, ką gauna EILUTĖS, kurios jau
     * egzistavo. `NOT NULL` be galiojančios numatytosios reikšmės tokį
     * `ALTER TABLE` nutrauktų — ir tai paaiškėtų tik produkcijoje.
     */
    await perkurtiDb();

    /**
     * 1. Schema BE `version` — viskas IKI 7.5b migracijos imtinai.
     *
     * ⚠️ `--timestamp` YRA PRIVALOMAS, NE PAPUOŠIMAS. Be jo `node-pg-migrate`
     * skaitinį argumentą traktuoja kaip migracijų KIEKĮ
     * (`upMigrations.slice(0, Math.abs(count))`), tad `up 1755800000000`
     * pritaikytų VISAS — įskaitant tą, kurios čia dar neturi būti. Su vėliava
     * filtras yra `timestamp <= count`.
     */
    migrate("up 1755800000000 --timestamp");

    const pries = new Pool({ connectionString: DB_URL });
    let jobId;
    try {
      const { rows: stulpeliai } = await pries.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'jobs' AND column_name = 'version'`
      );
      assert.deepEqual(stulpeliai, [], "prielaida: prieš migraciją stulpelio NĖRA");

      const { rows } = await pries.query(
        `INSERT INTO jobs (id, type, status, created_at, updated_at)
         VALUES (gen_random_uuid(), 'transcription', 'queued', now(), now())
         RETURNING id`
      );
      jobId = rows[0].id;
    } finally {
      await pries.end();
    }

    /** 2. Forward migracija. */
    migrate("up");

    const po = new Pool({ connectionString: DB_URL });
    try {
      /** 2a. JAU EGZISTAVUSI eilutė gavo galiojančią pradinę reikšmę. */
      const { rows: senos } = await po.query("SELECT version FROM jobs WHERE id = $1", [jobId]);
      assert.equal(senos[0].version, 1, "esama eilutė po migracijos turi `version = 1`");

      /** 2b. Nauja eilutė be eksplicitinės reikšmės — tas pats `1`. */
      const { rows: naujos } = await po.query(
        `INSERT INTO jobs (id, type, status, created_at, updated_at)
         VALUES (gen_random_uuid(), 'transcription', 'queued', now(), now())
         RETURNING id, version`
      );
      assert.equal(naujos[0].version, 1, "DEFAULT 1");

      /** 2c. `NOT NULL` realiai galioja. */
      await assert.rejects(
        () => po.query("UPDATE jobs SET version = NULL WHERE id = $1", [jobId]),
        /null value|not-null/i,
        "`version` privalo būti NOT NULL"
      );

      /**
       * 2d. `jobs_version_positive` realiai galioja.
       *
       * ⚠️ TAI IR YRA PRIEŽASTIS, DĖL KURIOS CONSTRAINT ĮVESTAS. `DEFAULT 1`
       * pats nulio nedraudžia, o `0` JS pusėje yra FALSY: `expectedVersion`
       * patikra tokią reikšmę palaikytų „versija nenurodyta". DB lygmuo tą
       * klasę pašalina ten, kur JS jos nepasiekia — rankinis `UPDATE`,
       * atkūrimas iš kopijos.
       */
      await assert.rejects(
        () => po.query("UPDATE jobs SET version = 0 WHERE id = $1", [jobId]),
        /jobs_version_positive/,
        "`version = 0` privalo būti atmestas"
      );

      /** 2e. Įprastas increment'as praeina. */
      const { rows: padidinta } = await po.query(
        "UPDATE jobs SET version = version + 1 WHERE id = $1 RETURNING version",
        [jobId]
      );
      assert.equal(padidinta[0].version, 2);
    } finally {
      await po.end();
    }
  }
);
