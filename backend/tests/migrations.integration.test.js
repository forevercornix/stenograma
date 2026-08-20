const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
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
 * @param {string} kryptis
 * @param {string} [dir] – migracijų katalogas. Numatytai repo `migrations/`.
 */
function migrate(kryptis = "up", dir) {
  return execFileSync(
    "npx",
    ["node-pg-migrate", kryptis, ...(dir ? ["-m", dir] : [])],
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
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "steno-migr-"));
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
