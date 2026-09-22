const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { Pool, Client } = require("pg");
const { rastiIndeksa, kvalifikuotasVardas, kvalifikuotaLentele } = require("./helpers/indeksoTapatybe");
const { iki } = require("./helpers/migracijuAibe");
const { fikturosDdl } = require("./helpers/resourceStack");
const { stebetiPoola, uzdarytiPoola } = require("./helpers/resourceStack");
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

      const pool = stebetiPoola(new Pool({ connectionString: DB_URL }), { vardas: "pool", dsn: DB_URL });
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
        await fikturosDdl(pool, "jobs", "TRUNCATE jobs CASCADE");

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
        await uzdarytiPoola(pool);
      }
    } finally {
      fs.rmSync(tevine, { recursive: true, force: true });
    }
  }
);

test(
  "#342 STARTAS: TRŪKSTAMA PAGALBINĖ LENTELĖ nutraukia startą, ne pirmą operaciją",
  { skip: skipWithoutPostgres() },
  async () => {
    /**
     * ⚠️ DVIEJŲ LENTELIŲ PATIKROS NEPAKAKO (#342 Codex, P1).
     *
     * Startas tikrino `jobs` ir `job_results`, o store'ą konstruodavo su
     * `bandymuRegistras`/`migracijosProgresas` = `true` (numatytoji reikšmė).
     * Dalinai migruota bazė startą PRAEIDAVO, o krisdavo vėliau:
     *
     *   `job_result_attempts`          → external completion kelias;
     *   `artifact_migration_progress`  → BDAR ištrynimo kelias.
     *
     * ⚠️ ABU JAU PRIĖMUS SRAUTĄ. Būtent to schemos patikra ir turi neleisti.
     *
     * ⚠️ TIKRINAMA PER `DROP`, NE PER DALINĘ MIGRACIJĄ: dalinė migracija duotų ir
     * trūkstamus invariantus, tad kristų ankstesnė patikra, ir šis testas
     * praeitų NE dėl to, ką teigia.
     */
    const buves = process.env.DATABASE_URL;

    try {
      for (const lentele of ["job_result_attempts", "artifact_migration_progress"]) {
        await perkurtiDb();
        migrate("up");

        const pool = stebetiPoola(new Pool({ connectionString: DB_URL }), { vardas: "pool", dsn: DB_URL });
        try {
          await pool.query(`DROP TABLE ${lentele} CASCADE`);
        } finally {
          await uzdarytiPoola(pool);
        }

        process.env.DATABASE_URL = DB_URL;
        delete require.cache[require.resolve("../utils/jobStore")];
        const jobStore = require("../utils/jobStore");

        await assert.rejects(
          () => jobStore._initializePostgresForTests(),
          new RegExp(`trūksta lentelių:.*${lentele}`),
          `be \`${lentele}\` startas privalo NUTRŪKTI - srautas nepriimamas`
        );

        delete require.cache[require.resolve("../utils/jobStore")];
      }

      /**
       * KONTROLĖ: su pilna schema tas pats startas praeina. Be jos „viskas
       * atmetama" praeitų kaip sėkmė - ta pati klaida, kurią #342 taiso
       * async cutover pusėje.
       */
      await perkurtiDb();
      migrate("up");

      process.env.DATABASE_URL = DB_URL;
      delete require.cache[require.resolve("../utils/jobStore")];
      const jobStore = require("../utils/jobStore");
      const store = await jobStore._initializePostgresForTests();

      assert.equal(store.backend, "postgres");
      await store.close();
    } finally {
      delete require.cache[require.resolve("../utils/jobStore")];
      if (buves === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = buves;
    }
  }
);

test(
  "#342 STARTAS: pagalbinių lentelių INVARIANTAI irgi privalomi",
  { skip: skipWithoutPostgres() },
  async () => {
    /**
     * Lentelės buvimo nepakanka - ta pati taisyklė, kurią `jobs`/`job_results`
     * pusėje įvedė #157 PR-1. Be šito bazė su lentele, bet be jos `CHECK`
     * suvaržymų, praeitų startą ir priimtų būsenas, kurių runtime nepripažįsta.
     */
    const buves = process.env.DATABASE_URL;

    try {
      await perkurtiDb();
      migrate("up");

      const pool = stebetiPoola(new Pool({ connectionString: DB_URL }), { vardas: "pool", dsn: DB_URL });
      try {
        await fikturosDdl(
          pool,
          "job_result_attempts",
          "ALTER TABLE job_result_attempts DROP CONSTRAINT job_result_attempts_busena_allowed"
        );
      } finally {
        await uzdarytiPoola(pool);
      }

      process.env.DATABASE_URL = DB_URL;
      delete require.cache[require.resolve("../utils/jobStore")];
      const jobStore = require("../utils/jobStore");

      await assert.rejects(
        () => jobStore._initializePostgresForTests(),
        /trūksta invariantų:.*job_result_attempts_busena_allowed/,
        "pagalbinės lentelės invariantas privalo būti tikrinamas kaip ir pagrindinių"
      );
    } finally {
      delete require.cache[require.resolve("../utils/jobStore")];
      if (buves === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = buves;
    }
  }
);

test(
  "#155 STARTAS: LENTELIŲ BUVIMO NEPAKANKA - trūkstamas invariantas nutraukia startą",
  { skip: skipWithoutPostgres() },
  async () => {
    /**
     * ⚠️ TEIGINYS NEPAKITO; PAKITO BŪDAS JĮ PASIEKTI (#342).
     *
     * Testas nuo pat pradžių įrodinėja VIENĄ dalyką: lentelės gali egzistuoti, o
     * startas vis tiek privalo nutrūkti, jei trūksta invariantų — kitaip DB
     * priiminėtų įrašus, kuriuos naujesnė migracija turi blokuoti (nežinomas
     * tipas, era `1`, nežinomas actor source).
     *
     * ⚠️ ANKSČIAU SCENARIJUS BUVO „TIK TĖVINĖ MIGRACIJA", IR JIS NUSTOJO SIEKTI
     * INVARIANTŲ ŠAKĄ. `a451532` pridėjo į lentelių patikrą dar dvi lenteles
     * (`job_result_attempts`, `artifact_migration_progress`), tad tėvinės
     * migracijos scenarijuje dabar nutraukia GRIEŽTESNIS sargas priekyje —
     * „trūksta lentelių" — ir invariantų kodas nebeįvykdomas.
     *
     * ⚠️ REGEX NESUŠVELNINTAS SĄMONINGAI. `/trūksta/` vietoj
     * `/trūksta invariantų/` būtų pažaliavęs iš karto ir nustojęs tikrinti tai,
     * ką šis komentaras teigia — šeštas „asercija dėl kitos priežasties" atvejis
     * šioje sekoje, tik šįkart matomas, nes testas KRITO, o ne nutilo.
     *
     * ⚠️ MIGRACIJOS RIBOS, KURIOJE VISOS KETURIOS LENTELĖS YRA, O INVARIANTŲ DAR
     * NĖRA, NEEGZISTUOJA: paskutinė migracija (`1756600000000`) sukuria paskutinę
     * lentelę KARTU su jos suvaržymais. Todėl scenarijus konstruojamas
     * eksplicitiškai — pilna schema minus VIENAS invariantas.
     *
     * Tai ir stipriau: senasis scenarijus rėmėsi migracijų TVARKA, tad galėjo
     * nustoti siekti savo šakos dėl bet kurio nesusijusio pakeitimo — kaip ką tik
     * ir nutiko. Šis nuo tvarkos nepriklauso.
     *
     * ⚠️ „PASENUSI (DALINAI MIGRUOTA) DB ATMETAMA" NEDINGO — ją nuo `a451532`
     * dengia `#342 STARTAS: TRŪKSTAMA PAGALBINĖ LENTELĖ…` šiame pat faile.
     */
    const NUIMAMAS = "jobs_type_values";
    const buves = process.env.DATABASE_URL;

    try {
      await perkurtiDb();
      migrate("up");

      const pool = stebetiPoola(new Pool({ connectionString: DB_URL }), { vardas: "pool", dsn: DB_URL });
      try {
        await fikturosDdl(pool, "jobs", `ALTER TABLE jobs DROP CONSTRAINT ${NUIMAMAS}`);
      } finally {
        await uzdarytiPoola(pool);
      }

      process.env.DATABASE_URL = DB_URL;
      delete require.cache[require.resolve("../utils/jobStore")];
      const jobStore = require("../utils/jobStore");

      /** Klaida gaudoma VIENĄ kartą - abi asercijos tikrina TĄ PATĮ pranešimą. */
      const klaida = await jobStore._initializePostgresForTests().then(
        () => {
          throw new Error("startas privalėjo nutrūkti, o praėjo");
        },
        (e) => e
      );

      assert.match(
        klaida.message,
        new RegExp(`trūksta invariantų:.*${NUIMAMAS}`),
        "pasenusi schema privalo nutraukti startą, ne būti paskelbta pasiruošusia"
      );

      /**
       * ⚠️ SARGAS ŠIO TESTO PRASMEI. Jei ateityje priekyje vėl atsirastų
       * griežtesnė patikra, testas kristų ČIA su aiškia priežastimi, o ne
       * pažaliuotų dėl kitos šakos. Būtent tokio sargo iki #342 ir trūko.
       */
      assert.doesNotMatch(
        klaida.message,
        /trūksta lentelių/,
        "lentelių patikra privalo būti PRAEITA - kitaip invariantų šaka nepasiekiama"
      );

      /**
       * KONTROLĖ: su pilna schema tas pats startas praeina. Be jos „viskas
       * atmetama" praeitų kaip sėkmė.
       *
       * ⚠️ DB PERKURIAMA, ne `migrate("down")`: pastarasis atsuktų PASKUTINĘ
       * migraciją, o nuimtas invariantas ateina iš pirmosios.
       */
      await perkurtiDb();
      migrate("up");

      delete require.cache[require.resolve("../utils/jobStore")];
      const sveikas = require("../utils/jobStore");
      const store = await sveikas._initializePostgresForTests();

      assert.equal(store.backend, "postgres");
      await store.close();
    } finally {
      delete require.cache[require.resolve("../utils/jobStore")];
      if (buves === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = buves;
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
    const pool = stebetiPoola(new Pool({ connectionString: DB_URL }), { vardas: "pool", dsn: DB_URL });

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
      await uzdarytiPoola(pool);
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

    const pool = stebetiPoola(new Pool({ connectionString: DB_URL }), { vardas: "pool", dsn: DB_URL });
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
      await uzdarytiPoola(pool);
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
    const pool = stebetiPoola(new Pool({ connectionString: DB_URL }), { vardas: "pool", dsn: DB_URL });

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
      await uzdarytiPoola(pool);
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

    const pries = stebetiPoola(new Pool({ connectionString: DB_URL }), { vardas: "pries", dsn: DB_URL });
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
      await uzdarytiPoola(pries);
    }

    /** 2. Forward migracija. */
    migrate("up");

    const po = stebetiPoola(new Pool({ connectionString: DB_URL }), { vardas: "po", dsn: DB_URL });
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
      await uzdarytiPoola(po);
    }
  }
);

/* ══════════════════════════════════════════════════════════════════════════════
 * #375 — `job_result_attempts_vienas_adresas`
 * ══════════════════════════════════════════════════════════════════════════════ */

const VIENO_ADRESO_MIGRACIJA = "1756700000000_job-result-attempts-vienas-adresas.js";
const VIENO_ADRESO_INDEKSAS = "job_result_attempts_vienas_adresas";

/**
 * Migruoja iki BŪSENOS PRIEŠ #375 — visos migracijos, išskyrus paskutinę.
 *
 * ⚠️ KOPIJUOJAMA Į LAIKINĄ KATALOGĄ, ne filtruojama repo viduje: `node --test`
 * failus vykdo lygiagrečiai, o kiti PostgreSQL testai skaito būtent repo
 * `migrations/`. Repo turinys nepaliečiamas.
 */
function iki375(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stenograma-375-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const visos = fs
    .readdirSync(path.join(ŠAKNIS, "migrations"))
    .filter((f) => f.endsWith(".js"))
    .sort();

  assert.ok(visos.includes(VIENO_ADRESO_MIGRACIJA), "prielaida: #375 migracija repo yra");

  /**
   * ⚠️ FILTRUOJAMA PAGAL TVARKĄ, NE PAGAL VARDĄ (#376 Codex P2 #3).
   *
   * `f !== VIENO_ADRESO_MIGRACIJA` šalino VIENĄ failą, o ne viską po jo. Pridėjus
   * `1756800000000`, ji patektų į „iki #375" katalogą, `checkOrder` atmestų #375
   * kaip ne eilės tvarka, ir testai kristų NEIŠBANDĘ to, ką turėjo išbandyti.
   */
  for (const f of iki(visos, VIENO_ADRESO_MIGRACIJA)) {
    fs.copyFileSync(path.join(ŠAKNIS, "migrations", f), path.join(dir, f));
  }
  return dir;
}

/**
 * ⚠️ PAIEŠKA KVALIFIKUOTA SCHEMA IR LENTELE (#376 Codex P2 #2). Vien `relname`
 * rastų to paties vardo indeksą bet kurioje `search_path` schemoje — tad
 * tvirtinimas „indeksas nesukurtas" galėtų būti melagingas dėl svetimo objekto.
 */
async function indeksoBusena(pool) {
  return rastiIndeksa(pool, VIENO_ADRESO_INDEKSAS, "job_result_attempts");
}

/** Du bandymai vienu adresu — būsena, kurios #375 migracija neturi praleisti. */
async function ivestiDublikata(pool) {
  const jobId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO jobs (id, type, status, progress_known, schema_version, created_at, updated_at)
     VALUES ($1, 'transcription', 'queued', false, 2, now(), now())`,
    [jobId]
  );
  const raktas = `results/${jobId}/bendras.json`;
  for (const busena of ["pending", "abandoned"]) {
    await pool.query(
      `INSERT INTO job_result_attempts (attempt_id, job_id, storage_type, storage_key, busena)
       VALUES ($1, $2, 'fs', $3, $4)`,
      [crypto.randomUUID(), jobId, raktas, busena]
    );
  }
  return { jobId, raktas };
}

test(
  "#375 MIGRACIJA: dublikatas → krenta su diagnostika, indeksas NESUKURIAMAS",
  { skip: skipWithoutPostgres(), timeout: 180000 },
  async (t) => {
    /**
     * ⚠️ TIKRINAMOS TRYS SAVYBĖS, NE VIENA.
     *
     * „Krenta" nepakanka: plikoji `23505` irgi krenta, ir būtent ją D3 pakeičia.
     * Todėl tikrinama, kad (1) pranešime yra skaičius ir `storage_type`,
     * (2) RAKTŲ jame NĖRA, (3) indeksas neliko pusiau sukurtas.
     */
    await perkurtiDb();
    const priesDir = iki375(t);
    migrate("up", priesDir);

    const pool = stebetiPoola(new Pool({ connectionString: DB_URL }), { vardas: "pool", dsn: DB_URL });
    try {
      await ivestiDublikata(pool);

      let klaida = null;
      try {
        migrate("up");
      } catch (e) {
        klaida = e;
      }

      assert.ok(klaida, "migracija su dublikatu privalo KRISTI");

      const tekstas = `${klaida.stdout || ""}${klaida.stderr || ""}${klaida.message || ""}`;
      assert.match(tekstas, /job_result_attempts turi 1 adres/, "diagnostikoje privalo būti SKAIČIUS");
      assert.match(tekstas, /storage_type: fs/, "ir `storage_type`");
      assert.match(tekstas, /#375/, "ir nuoroda į issue");

      /**
       * ⚠️ RAKTAI Į DEPLOY'AUS LOGUS NEPATENKA. `1756300000000` užrašė, kad
       * `storage_key` asmens duomenų neturi, bet diagnostikai pakanka skaičiaus, o
       * logų retencija kitokia nei DB.
       */
      assert.equal(
        /results\/[0-9a-f-]+\/bendras\.json/.test(tekstas),
        false,
        `raktas neturi patekti į išvestį:\n${tekstas.slice(0, 400)}`
      );

      assert.equal(await indeksoBusena(pool), null, "indeksas NEGALI likti pusiau sukurtas");
    } finally {
      await uzdarytiPoola(pool);
    }
  }
);

test(
  "#375 MIGRACIJA: `down` šalina indeksą, `up` vėl praeina, antras `up` — no-op",
  { skip: skipWithoutPostgres(), timeout: 180000 },
  async (t) => {
    await perkurtiDb();
    migrate("up");

    const pool = stebetiPoola(new Pool({ connectionString: DB_URL }), { vardas: "pool", dsn: DB_URL });
    try {
      assert.ok(await indeksoBusena(pool), "po `up` indeksas privalo būti");

      migrate("down");
      assert.equal(await indeksoBusena(pool), null, "`down` privalo jį pašalinti");

      migrate("up");
      const busena = await indeksoBusena(pool);
      assert.ok(busena && busena.indisvalid && busena.indisunique, "`up` privalo atkurti GALIOJANTĮ");

      /** Antras `up` be klaidos: migracija jau pritaikyta, tad ji nebekartojama. */
      migrate("up");
      assert.ok(await indeksoBusena(pool), "antras `up` neturi nieko sugriauti");

      t.diagnostic("#375: down → up → up ciklas žalias");
    } finally {
      await uzdarytiPoola(pool);
    }
  }
);

test(
  "#375 D6: NEVEIKIANTIS indeksas tuo pačiu vardu → migracija KRENTA, ne praeina tyliai",
  { skip: skipWithoutPostgres(), timeout: 180000 },
  async (t) => {
    /**
     * ⚠️ `INVALID` INDEKSAS SUKURIAMAS TIKRU GEDIMU, NE `pg_index` REDAGAVIMU.
     *
     * `CREATE UNIQUE INDEX CONCURRENTLY` ant lentelės su dublikatu krenta ir PALIEKA
     * `indisvalid = false` indeksą tuo vardu — tiksliai ta būsena, kurią `IF NOT
     * EXISTS` praleistų. Redaguojant `pg_index` tiesiogiai testas tikrintų savo
     * paties simuliaciją, ne PostgreSQL elgesį.
     */
    await perkurtiDb();
    const priesDir = iki375(t);
    migrate("up", priesDir);

    const pool = stebetiPoola(new Pool({ connectionString: DB_URL }), { vardas: "pool", dsn: DB_URL });
    try {
      const { raktas } = await ivestiDublikata(pool);

      /**
       * ⚠️ IŠIMTIS IŠ D8: `CONCURRENTLY` TRANSAKCIJOS BLOKE NELEIDŽIAMAS (#380).
       *
       * `fikturosDdl()` sakinį vynioja į `BEGIN`/`COMMIT`, kad `SET LOCAL lock_timeout`
       * apskritai galiotų, o `CREATE INDEX CONCURRENTLY` tokiame bloke krenta su `25001`.
       * Ir riba čia nereikalinga: `CONCURRENTLY` sąmoningai NEIMA `ACCESS EXCLUSIVE` —
       * būtent tai ir yra jo prasmė, o testas tikrina, kad jis krenta dėl DUBLIKATO.
       */
      await assert.rejects(
        () =>
          pool.query(
            `CREATE UNIQUE INDEX CONCURRENTLY ${VIENO_ADRESO_INDEKSAS}
               ON job_result_attempts (storage_type, storage_key)`
          ),
        "prielaida: su dublikatu `CONCURRENTLY` statymas privalo kristi"
      );

      const paliktas = await indeksoBusena(pool);
      assert.ok(paliktas, "prielaida: nutrūkęs statymas paliko indeksą");
      assert.equal(paliktas.indisvalid, false, "prielaida: jis NEVEIKIANTIS");

      /**
       * ⚠️ DUBLIKATAS PAŠALINAMAS — kitaip migracija kristų ties D3 preflight, ir
       * testas įrodytų ne tą dalyką. Dabar duomenys švarūs, o kliūtis viena:
       * neveikiantis indeksas.
       */
      await pool.query("DELETE FROM job_result_attempts WHERE storage_key = $1 AND busena = 'abandoned'", [raktas]);

      let klaida = null;
      try {
        migrate("up");
      } catch (e) {
        klaida = e;
      }

      assert.ok(klaida, "migracija PRIVALO kristi — `IF NOT EXISTS` čia praeitų tyliai");
      const tekstas = `${klaida.stdout || ""}${klaida.stderr || ""}${klaida.message || ""}`;
      assert.match(tekstas, /NEVEIKIANTIS|indisvalid/, "pranešimas privalo įvardyti PRIEŽASTĮ");

      const poBandymo = await indeksoBusena(pool);
      assert.equal(poBandymo.indisvalid, false, "neveikiantis indeksas lieka — jį šalina operatorius");
    } finally {
      await uzdarytiPoola(pool);
    }
  }
);

test(
  "#375 `lock_timeout`: pakibęs rašytojas → migracija KRENTA per ribą, ne kabo",
  { skip: skipWithoutPostgres(), timeout: 180000 },
  async (t) => {
    /**
     * ⚠️ BE `lock_timeout` ŠIS TESTAS VIRŠYTŲ SAVO LAIKO RIBĄ.
     *
     * `LOCK TABLE ... SHARE` laukia už kiekvienos atviros transakcijos, rašiusios į
     * lentelę. Kol migracija laukia, eilėje už jos stovi VISI nauji `registruoti()` —
     * t. y. be ribos migracija sustabdo rezultatų rašymą neribotam laikui, ir tai
     * atrodo kaip pakibęs deploy'us, ne kaip gedimas.
     */
    await perkurtiDb();
    const priesDir = iki375(t);
    migrate("up", priesDir);

    const blokuojantis = new Client({ connectionString: DB_URL });
    await blokuojantis.connect();

    const pool = stebetiPoola(new Pool({ connectionString: DB_URL }), { vardas: "pool", dsn: DB_URL });
    try {
      const jobId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO jobs (id, type, status, progress_known, schema_version, created_at, updated_at)
         VALUES ($1, 'transcription', 'queued', false, 2, now(), now())`,
        [jobId]
      );

      /** Transakcija LIEKA ATVIRA — būtent ji ir yra „pakibęs rašytojas". */
      await blokuojantis.query("BEGIN");
      await blokuojantis.query(
        `INSERT INTO job_result_attempts (attempt_id, job_id, storage_type, storage_key, busena)
         VALUES ($1, $2, 'fs', $3, 'pending')`,
        [crypto.randomUUID(), jobId, `results/${jobId}/kabo.json`]
      );

      const pradzia = Date.now();
      let klaida = null;
      try {
        migrate("up");
      } catch (e) {
        klaida = e;
      }
      const truko = Date.now() - pradzia;

      assert.ok(klaida, "migracija privalo KRISTI, o ne laukti neribotai");

      const tekstas = `${klaida.stdout || ""}${klaida.stderr || ""}${klaida.message || ""}`;
      assert.match(tekstas, /lock_timeout|55P03|timeout/i, `laukiama užrakto ribos klaida:\n${tekstas.slice(0, 300)}`);

      /**
       * ⚠️ TIKRINAMA IR TRUKMĖ. Be jos testas praeitų ir tada, jei kritimą sukeltų
       * kas nors kita po ilgo laukimo — o būtent laukimas ir yra tas defektas.
       * Riba 5 s plius `npx` starto atsarga.
       */
      assert.ok(truko < 60000, `krito per ${truko} ms — riba privalo veikti`);
      t.diagnostic(`#375 lock_timeout: krito per ${truko} ms`);

      const pool2 = stebetiPoola(new Pool({ connectionString: DB_URL }), { vardas: "pool2", dsn: DB_URL });
      try {
        assert.equal(await indeksoBusena(pool2), null, "indeksas nesukurtas — migracija nutrūko");
      } finally {
        await uzdarytiPoola(pool2);
      }
    } finally {
      await blokuojantis.query("ROLLBACK").catch(() => {});
      await blokuojantis.end().catch(() => {});
      await uzdarytiPoola(pool);
    }
  }
);

/**
 * #375 F2: `SET LOCAL lock_timeout` APIMTIS YRA TRANSAKCIJA, NE MIGRACIJA.
 *
 * ⚠️ RADINYS IŠ PERŽIŪROS, NE IŠ KRITUSIO TESTO.
 *
 * `node-pg-migrate` su numatytuoju `singleTransaction` visas laukiančias migracijas
 * vykdo VIENOJE `BEGIN`/`COMMIT` (`dist/legacy/runner.js`). `SET LOCAL` galioja iki
 * transakcijos pabaigos, tad `1756700000000` nustatyta 5 s riba taikoma ir KIEKVIENAI
 * migracijai, einančiai po jos tame pačiame paleidime.
 *
 * ⚠️ ŠIANDIEN TAI NEKENKIA TIK DĖL EILĖS TVARKOS — #375 migracija paskutinė. Būtent
 * todėl testas nekelia klausimo „ar dabar blogai", o gamina SEKANČIĄ migraciją ir
 * matuoja, ką ji paveldi. Prielaida, galiojanti tik todėl, kad niekas dar nepridėjo
 * kito failo, nėra prielaida — ir ji lūžtų TYLIAI, kitame PR, kito žmogaus rankose.
 */
test(
  "#375 F2: po `1756700000000` einanti migracija NEPAVELDI 5 s `lock_timeout`",
  { skip: skipWithoutPostgres(), timeout: 180000 },
  async (t) => {
    await perkurtiDb();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stenograma-375-f2-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    for (const f of fs.readdirSync(path.join(ŠAKNIS, "migrations")).filter((f) => f.endsWith(".js"))) {
      fs.copyFileSync(path.join(ŠAKNIS, "migrations", f), path.join(dir, f));
    }

    /**
     * ⚠️ SINTETINĖ MIGRACIJA, VARDAS PO #375 — kad `node-pg-migrate` ją vykdytų
     * TOJE PAČIOJE transakcijoje iškart po jos. Ji nieko nekeičia schemoje: jos
     * vienintelis darbas — pasakyti, kokią ribą paveldėjo.
     *
     * ⚠️ TIKRINAMA `= '5s'`, NE `<> '0'`. Diegimas gali turėti savo `lock_timeout`
     * serverio lygiu, ir tada `<> '0'` kristų dėl TEISINGOS konfigūracijos. Klausimas
     * čia siauras: ar nuteka BŪTENT ši migracijos nustatyta reikšmė.
     */
    fs.writeFileSync(
      path.join(dir, "1756800000000_f2-lock-timeout-nutekejimas.js"),
      `exports.shorthands = undefined;
exports.up = (pgm) => {
  pgm.sql(\`
    DO $$
    BEGIN
      IF current_setting('lock_timeout') = '5s' THEN
        RAISE EXCEPTION 'F2: paveldėtas lock_timeout = %', current_setting('lock_timeout');
      END IF;
    END $$;
  \`);
};
exports.down = () => {};
`
    );

    let klaida = null;
    try {
      migrate("up", dir);
    } catch (e) {
      klaida = e;
    }

    if (klaida) {
      const tekstas = `${klaida.stdout || ""}${klaida.stderr || ""}${klaida.message || ""}`;
      assert.fail(`sekanti migracija paveldėjo ribą:\n${tekstas.slice(0, 400)}`);
    }

    /** Kontrolė: #375 indeksas vis tiek pastatytas — ribos grąžinimas jo nesugadino. */
    const pool = stebetiPoola(new Pool({ connectionString: DB_URL }), { vardas: "pool", dsn: DB_URL });
    try {
      const busena = await indeksoBusena(pool);
      assert.ok(busena && busena.indisvalid && busena.indisunique, "indeksas privalo likti galiojantis");
    } finally {
      await uzdarytiPoola(pool);
    }

    t.diagnostic("#375 F2: `lock_timeout` grąžintas — sekanti migracija jo nepaveldi");
  }
);

/* ══════════════════════════════════════════════════════════════════════════════
 * #376 R1 — GYVAS STARTAS TIKRINA INDEKSĄ (Codex P2 #1)
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ MATUOJAMAS PRODUKCINIS KELIAS. `_initializePostgresForTests` yra ta pati
 * `initializePostgres()`, kurią kviečia startas — ne jos kopija. `env` paduodamas
 * eksplicitiškai, tad `process.env` neteršiamas.
 */
async function startas(url) {
  const jobStore = require("../utils/jobStore");
  const rezultatas = await jobStore._initializePostgresForTests({
    ...process.env,
    DATABASE_URL: url,
  });
  /** Startas grąžina gyvą pool'ą — testas privalo jį uždaryti. */
  if (rezultatas && rezultatas.pool) await uzdarytiPoola(rezultatas.pool);
  if (rezultatas && rezultatas.store && rezultatas.store.close) {
    await rezultatas.store.close().catch(() => {});
  }
  return rezultatas;
}

test(
  "#376 R1: schema iki `1756600000000` → gyvas startas KRENTA, klaidoje minimas indeksas",
  { skip: skipWithoutPostgres(), timeout: 180000 },
  async (t) => {
    /**
     * ⚠️ BE ŠIOS PATIKROS READINESS PRAEIDAVO. Jis matė tik `contype = 'c'` —
     * check constraint'us, o `1756700000000` jų neprideda. DB, migruota tik iki
     * `1756600000000`, būtų paskelbta pasiruošusia: rašymas vyktų BE invarianto,
     * `BendroAdresoKlaida` niekada nesuveiktų, o #351 D6 remtųsi garantija, kurios
     * nėra.
     *
     * ⚠️ MIGRACIJOS PAČIOS PATIKROS ČIA NEPADEDA — jos veikia tik tada, kai
     * migracija leidžiama. Readiness yra vienintelis autoritetas, vykdomas
     * KIEKVIENAME starte.
     */
    await perkurtiDb();
    const priesDir = iki375(t);
    migrate("up", priesDir);

    await assert.rejects(
      () => startas(DB_URL),
      (klaida) => {
        assert.match(klaida.message, /job_result_attempts_vienas_adresas/, "privalo įvardyti INDEKSĄ");
        assert.match(klaida.message, /migrate:up/, "ir nurodyti veiksmą");
        return true;
      },
      "startas su schema be indekso PRIVALO kristi"
    );
  }
);

test(
  "#376 R1: tas pats VARDAS ant kitos stulpelių poros → startas KRENTA",
  { skip: skipWithoutPostgres(), timeout: 180000 },
  async () => {
    /**
     * ⚠️ TAI ATVEJIS, KURĮ VARDO PATIKRA PRALEISTŲ.
     *
     * Indeksas yra, galiojantis, unikalus ir teisingu vardu — bet ant `(job_id,
     * storage_key)`. Invarianto, kuriuo remiasi #351 D6, jis NETEIKIA. Tenkinantis
     * vardu readiness paskelbtų žalią.
     */
    await perkurtiDb();
    migrate("up");

    const pool = stebetiPoola(new Pool({ connectionString: DB_URL }), { vardas: "pool", dsn: DB_URL });
    try {
      const indeksas = await kvalifikuotasVardas(pool, VIENO_ADRESO_INDEKSAS);
      await fikturosDdl(pool, "job_result_attempts", `DROP INDEX ${indeksas}`);
      const lentele = await kvalifikuotaLentele(pool, "job_result_attempts");
      await fikturosDdl(
        pool,
        lentele,
        `CREATE UNIQUE INDEX ${VIENO_ADRESO_INDEKSAS} ON ${lentele} (job_id, storage_key)`
      );

      await assert.rejects(
        () => startas(DB_URL),
        (klaida) => klaida.message.includes(VIENO_ADRESO_INDEKSAS),
        "neteisinga stulpelių pora privalo kristi taip pat kaip nebuvimas"
      );
    } finally {
      await uzdarytiPoola(pool);
    }
  }
);

test(
  "#376 R1: teisingi stulpeliai ATVIRKŠTINE tvarka → startas KRENTA",
  { skip: skipWithoutPostgres(), timeout: 180000 },
  async () => {
    /**
     * ⚠️ TVARKA YRA DALIS TAPATYBĖS, NE DETALĖ. `(storage_key, storage_type)`
     * uždraudžia tą pačią porų aibę, bet duoda kitą prefiksą paieškoms — ir
     * `1756700000000` deklaruoja būtent `(storage_type, storage_key)`. Patikra,
     * lyginanti aibes, o ne sekas, šio skirtumo nematytų.
     */
    await perkurtiDb();
    migrate("up");

    const pool = stebetiPoola(new Pool({ connectionString: DB_URL }), { vardas: "pool", dsn: DB_URL });
    try {
      const indeksas = await kvalifikuotasVardas(pool, VIENO_ADRESO_INDEKSAS);
      await fikturosDdl(pool, "job_result_attempts", `DROP INDEX ${indeksas}`);
      const lentele = await kvalifikuotaLentele(pool, "job_result_attempts");
      await fikturosDdl(
        pool,
        lentele,
        `CREATE UNIQUE INDEX ${VIENO_ADRESO_INDEKSAS} ON ${lentele} (storage_key, storage_type)`
      );

      await assert.rejects(
        () => startas(DB_URL),
        (klaida) => klaida.message.includes(VIENO_ADRESO_INDEKSAS),
        "atvirkštinė tvarka privalo būti atmesta"
      );
    } finally {
      await uzdarytiPoola(pool);
    }
  }
);

test(
  "#376 R1: galiojantis to paties vardo indeksas KITOJE schemoje → startas KRENTA",
  { skip: skipWithoutPostgres(), timeout: 180000 },
  async () => {
    /**
     * ⚠️ TAI ATVEJIS, DĖL KURIO `current_schema()` FILTRAS APSKRITAI REIKALINGAS.
     *
     * `relname` unikalus tik schemos ribose. Be filtro readiness rastų svetimą
     * objektą — teisingo vardo, galiojantį, unikalų, ant tos pačios stulpelių poros
     * — ir paskelbtų žalią, nors DABARTINĖJE schemoje invarianto nėra.
     */
    await perkurtiDb();
    migrate("up");

    const pool = stebetiPoola(new Pool({ connectionString: DB_URL }), { vardas: "pool", dsn: DB_URL });
    try {
      /** Svetima schema su TIKSLIA kopija — tik kitoje vietoje. */
      await pool.query("CREATE SCHEMA svetima");
      await pool.query(
        `CREATE TABLE svetima.job_result_attempts (
           attempt_id uuid, storage_type text, storage_key text)`
      );
      await fikturosDdl(
        pool,
        "svetima",
        `CREATE UNIQUE INDEX ${VIENO_ADRESO_INDEKSAS}
           ON svetima.job_result_attempts (storage_type, storage_key)`
      );

      /** O dabartinėje schemoje jo NEBĖRA. */
      const musu = await kvalifikuotasVardas(pool, VIENO_ADRESO_INDEKSAS);
      await fikturosDdl(pool, "job_result_attempts", `DROP INDEX ${musu}`);

      await assert.rejects(
        () => startas(DB_URL),
        (klaida) => klaida.message.includes(VIENO_ADRESO_INDEKSAS),
        "svetimos schemos indeksas NEGALI tenkinti readiness"
      );
    } finally {
      await uzdarytiPoola(pool);
    }
  }
);

test(
  "#376 R1: DALINIS (WHERE) indeksas tuo pačiu vardu → startas KRENTA",
  { skip: skipWithoutPostgres(), timeout: 180000 },
  async () => {
    /**
     * ⚠️ DALINIS INDEKSAS ATRODO TEISINGAS PAGAL VISUS KITUS KRITERIJUS: tas pats
     * vardas, ta pati schema, ta pati lentelė, ta pati stulpelių SEKA, `UNIQUE`,
     * `indisvalid`. Skiriasi tik apimtis — jis draudžia pasikartojimus TIK
     * predikatą tenkinančiose eilutėse. `('s3', 'k')` pora už predikato ribų
     * liktų leidžiama du kartus, o `1756700000000` garantija būtų tik tariama.
     *
     * ⚠️ TAI VIENINTELIS TESTAS, ĮRODANTIS `salyginis` KRITERIJŲ. Be jo užtektų
     * keturių ankstesnių, ir dalinis indeksas praeitų readiness tyliai.
     */
    await perkurtiDb();
    migrate("up");

    const pool = stebetiPoola(new Pool({ connectionString: DB_URL }), { vardas: "pool", dsn: DB_URL });
    try {
      const indeksas = await kvalifikuotasVardas(pool, VIENO_ADRESO_INDEKSAS);
      await fikturosDdl(pool, "job_result_attempts", `DROP INDEX ${indeksas}`);
      const lentele = await kvalifikuotaLentele(pool, "job_result_attempts");
      await fikturosDdl(
        pool,
        lentele,
        `CREATE UNIQUE INDEX ${VIENO_ADRESO_INDEKSAS}
           ON ${lentele} (storage_type, storage_key)
           WHERE storage_type <> 'inline'`
      );

      await assert.rejects(
        () => startas(DB_URL),
        (klaida) => klaida.message.includes(VIENO_ADRESO_INDEKSAS),
        "dalinis indeksas NEGALI tenkinti readiness"
      );
    } finally {
      await uzdarytiPoola(pool);
    }
  }
);

test(
  "#376 R1 KONTROLĖ: pilna schema → startas PRAEINA",
  { skip: skipWithoutPostgres(), timeout: 180000 },
  async () => {
    /**
     * ⚠️ BE ŠIOS KONTROLĖS keturi aukščiau esantys testai suderinami su readiness,
     * kuris atmeta VISKĄ. Tokia realizacija juos praeitų, o produkcija nebepakiltų.
     */
    await perkurtiDb();
    migrate("up");

    const rezultatas = await startas(DB_URL);
    assert.ok(rezultatas, "pilna schema privalo praleisti startą");
  }
);

test(
  "#376 R2: helper'is NERANDA to paties vardo indekso kitoje schemoje",
  { skip: skipWithoutPostgres(), timeout: 180000 },
  async () => {
    /**
     * ⚠️ TESTŲ HELPER'IS TIKRINAMAS ATSKIRAI NUO READINESS.
     *
     * Jį naudoja trys tvirtinimai, sakantys „invariantas galioja". Jei jis rastų
     * svetimą objektą, tie testai liktų žali bazėje be invarianto — sargai, kurie
     * negali kristi.
     */
    await perkurtiDb();
    migrate("up");

    const pool = stebetiPoola(new Pool({ connectionString: DB_URL }), { vardas: "pool", dsn: DB_URL });
    try {
      await pool.query("CREATE SCHEMA svetima2");
      await pool.query(
        `CREATE TABLE svetima2.job_result_attempts (
           attempt_id uuid, storage_type text, storage_key text)`
      );
      await fikturosDdl(
        pool,
        "svetima2",
        `CREATE UNIQUE INDEX ${VIENO_ADRESO_INDEKSAS}
           ON svetima2.job_result_attempts (storage_type, storage_key)`
      );

      const musu = await kvalifikuotasVardas(pool, VIENO_ADRESO_INDEKSAS);
      await fikturosDdl(pool, "job_result_attempts", `DROP INDEX ${musu}`);

      const rastas = await rastiIndeksa(pool, VIENO_ADRESO_INDEKSAS, "job_result_attempts");
      assert.equal(rastas, null, "svetimos schemos objektas NĖRA mūsų indeksas");

      /** Kontrolė: atkūrus savoje schemoje — randamas, su teisinga stulpelių seka. */
      const lentele = await kvalifikuotaLentele(pool, "job_result_attempts");
      await fikturosDdl(
        pool,
        lentele,
        `CREATE UNIQUE INDEX ${VIENO_ADRESO_INDEKSAS} ON ${lentele} (storage_type, storage_key)`
      );
      const vel = await rastiIndeksa(pool, VIENO_ADRESO_INDEKSAS, "job_result_attempts");
      assert.ok(vel, "savoje schemoje privalo būti randamas");
      assert.deepEqual(vel.stulpeliai, ["storage_type", "storage_key"]);
    } finally {
      await uzdarytiPoola(pool);
    }
  }
);

test(
  "#376 R1 KONTROLĖ: `restoredJobStore` su schema BE indekso — elgesys NEPAKITĘS",
  { skip: skipWithoutPostgres(), timeout: 180000 },
  async (t) => {
    /**
     * ⚠️ ŠI KONTROLĖ SAUGO RIBĄ, O NE PATIKRĄ (#339, #376 §0.1).
     *
     * Gyvas startas privalo reikalauti pilnos schemos; atkurta kopija TEISĖTAI gali
     * būti senesnė. Jei R1 reikalavimas kada nors nuslystų į `restoredJobStore`
     * kelią, atkūrimas iš prieš `1756700000000` sukurtos kopijos nustotų veikti —
     * t. y. DR procedūra kristų dėl invarianto, kurio ta kopija negalėjo turėti.
     *
     * ⚠️ RIBA YRA STRUKTŪRINĖ, NE DRAUSMĖ: `restoredJobStore.paruosti()` schemą
     * ZONDUOJA (`try/catch` apie `job_result_attempts`), o `initializePostgres()`
     * jos REIKALAUJA. Šis testas tikrina, kad taip ir liko.
     */
    await perkurtiDb();
    const priesDir = iki375(t);
    migrate("up", priesDir);

    const pool = stebetiPoola(new Pool({ connectionString: DB_URL }), { vardas: "pool", dsn: DB_URL });
    try {
      const restoredJobStore = require("../utils/restoredJobStore");

      /** Startas tą pačią schemą atmeta — kontrolė, kad testas matuoja skirtumą. */
      await assert.rejects(() => startas(DB_URL), /job_result_attempts_vienas_adresas/);

      /** O atkūrimo kelias ją PRIIMA. */
      const paruosta = await restoredJobStore.paruosti(pool);
      assert.ok(paruosta, "atkurta kopija be indekso privalo likti naudojama");

      if (paruosta.store && paruosta.store.close) await paruosta.store.close().catch(() => {});
    } finally {
      await uzdarytiPoola(pool);
    }
  }
);
