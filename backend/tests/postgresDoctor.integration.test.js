const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  skipWithoutPostgres,
  testDatabaseUrl,
  adminDatabaseUrl,
} = require("./helpers/postgresGuard");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { runSelfChecks } = require("../utils/startupChecks");

/**
 * #155, 7.1: PostgreSQL būsena `make doctor` ir `/api/health/deep` išvestyje.
 *
 * Abu naudoja tą patį `runSelfChecks()`, tad patikra viena — ir tai TIKRINAMA,
 * ne prielaida (žr. paskutinį testą).
 */

const VARDAS = /PostgreSQL/;

/** ⚠️ Vardas NEturi žadėti integracijų, kurių dar nėra (7.1). */
const NEŽADA_INTEGRACIJŲ = /job store|sesij|audit/i;

function rasti(checks) {
  return checks.find((c) => VARDAS.test(c.name));
}

test("#155 DOCTOR: be DATABASE_URL PostgreSQL eilutės NĖRA", async () => {
  /**
   * Desktop/demo režimas veikia be Postgres (memoryStore). „PostgreSQL
   * nepasiekiamas" ten būtų klaidinantis įspėjimas, o ne diagnostika.
   */
  const checks = await runSelfChecks({
    ...process.env,
    DATABASE_URL: undefined,
    PGHOST: undefined,
  });
  assert.equal(rasti(checks), undefined, "be DATABASE_URL ir PGHOST eilutės neturi būti");
});

test("#155 DOCTOR: nepasiekiama DB — klaida BE prisijungimo eilutės", async () => {
  /**
   * ⚠️ `DATABASE_URL` turi slaptažodį. Diagnostikos išvestis keliauja į
   * support-bundle ir CI logus, tad rodomas tik hostas — kaip
   * `httpReachability` atveju.
   */
  const checks = await runSelfChecks({
    ...process.env,
    DATABASE_URL: "postgres://vartotojas:LABAI_SLAPTAS@127.0.0.1:59999/db",
  });

  const p = rasti(checks);
  assert.ok(p, "su DATABASE_URL eilutė privalo būti");
  assert.equal(p.ok, false);

  assert.equal(
    p.detail.includes("LABAI_SLAPTAS"),
    false,
    "slaptažodis NETURI patekti į diagnostikos išvestį"
  );
  assert.equal(
    p.detail.includes("vartotojas"),
    false,
    "vartotojo vardas irgi ne — rodomas tik hostas"
  );
  assert.match(p.detail, /127\.0\.0\.1:59999/, "hostas rodomas, kad būtų aišku KUR nepavyko");
});

/**
 * ⚠️ ATSKIRA DUOMENŲ BAZĖ, ne bendra `DATABASE_URL`.
 *
 * `migrations.integration.test.js` daro `DROP DATABASE` + `CREATE DATABASE` tam
 * pačiam vardui, o `node --test` failus vykdo LYGIAGREČIAI.
 *
 * ⚠️ SĄŽININGAI: kritimo dėl to NEMAČIAU — trys paleidimai su bendra baze
 * praėjo. Tai LATENTINĖ rizika, ne patvirtintas gedimas: persidengus
 * `DROP DATABASE` nepavyktų, kol šis failas laiko prisijungimą, ir kristų
 * MIGRACIJŲ rinkinys, ne šis.
 *
 * Izoliacija palikta, nes kaina nulinė, o Redis `flushdb` patirtis parodė, kad
 * tokios lenktynės pasirodo vėliau ir CI, ne lokaliai.
 *
 * ⚠️ VARDAS PER `testDatabaseUrl()`, ne fiksuotas.
 *
 * Ankstesnė versija turėjo `const TESTO_DB = "stenograma_doctor_test"` ir savo
 * URL konstravimą — tai ignoravo kvietėjo namespace. Paleidus su
 * `DATABASE_URL=.../mano_test_db`, migracijų rinkinys naudotų
 * `mano_test_db_migrations`, o šis vis tiek kurtų GLOBALŲ
 * `stenograma_doctor_test`.
 *
 * Helperis būtent tam ir egzistuoja; antra realizacija reiškė du skirtingus
 * vardų modelius tam pačiam invariantui.
 */
function testoUrl() {
  return testDatabaseUrl("doctor");
}

function testoDbVardas() {
  return new URL(testoUrl()).pathname.replace(/^\//, "");
}

async function vykdyti(url, sql) {
  const { Client } = require("pg");
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await c.query(sql);
  } finally {
    await c.end();
  }
}

test(
  "#155 DOCTOR: veikianti DB be migracijų atskiriama nuo neveikiančios",
  { skip: skipWithoutPostgres() },
  async (t) => {
    /**
     * Du skirtingi gedimai, reikalaujantys skirtingų veiksmų:
     *   – DB neveikia        → paleisti servisą;
     *   – DB veikia be schemos → `npm run migrate:up`.
     *
     * Viena bendra „nepasiekiama" žinutė operatorių nukreiptų klaidingai.
     */
    const vardas = testoDbVardas();

    /**
     * `WITH (FORCE)` – kaip `migrations.integration`. Be jo `DROP` nepavyksta,
     * jei liko pakibęs prisijungimas iš nutrūkusio ankstesnio paleidimo.
     */
    await vykdyti(adminDatabaseUrl(), `DROP DATABASE IF EXISTS "${vardas}" WITH (FORCE)`);
    await vykdyti(adminDatabaseUrl(), `CREATE DATABASE "${vardas}"`);

    t.after(async () => {
      await vykdyti(
        adminDatabaseUrl(),
        `DROP DATABASE IF EXISTS "${vardas}" WITH (FORCE)`
      ).catch(() => {});
    });

    /** Švari DB be `pgmigrations` — būtent ta būsena, kurią tikriname. */
    const checks = await runSelfChecks({ ...process.env, DATABASE_URL: testoUrl() });
    const p = rasti(checks);

    assert.equal(p.ok, false, "be migracijų būsena NĖRA gera");
    assert.match(p.detail, /MIGRACIJOS NEPRITAIKYTOS/);
    assert.match(p.detail, /migrate:up/, "turi pasakyti, KĄ daryti");
    assert.match(p.detail, /prisijungta/, "ir kad DB pati veikia");
  }
);

test("#155 DOCTOR: `doctor.js` neturi TIESIOGINĖS pg patikros", () => {
  /**
   * ⚠️ ANKSČIAU TURĖJO, IR ELGESYS SKYRĖSI.
   *
   *   be DATABASE_URL   doctor: OK eilutė      | selfChecks: eilutės nėra
   *   be migracijų      doctor: OK             | selfChecks: FAIL
   *   klaida            doctor: e.message      | selfChecks: tik hostas
   *
   * Paskutinis skirtumas buvo ir saugumo klausimas: `e.message` gali turėti
   * vartotojo vardą, o diagnostikos išvestis keliauja į support-bundle.
   *
   * Šio failo testai tikrina `runSelfChecks()`. Jei `doctor.js` vėl gautų savo
   * kelią, jie apie tai nieko nesakytų — todėl tikrinama, kad jo NĖRA.
   *
   * ⚠️ APIMTIS: saugoma nuo TIESIOGINIO `require("pg")` grąžinimo — būtent nuo
   * įvykusios klaidos. Antras kelias per atskirą modulį (`require("../utils/
   * postgresCheck")`) šiuo testu NEBŪTŲ pagautas.
   */
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.resolve(__dirname, "..", "scripts", "doctor.js"), "utf8");

  /**
   * ⚠️ KOMENTARAI PAŠALINAMI PRIEŠ TIKRINANT.
   *
   * Pirmoji versija ieškojo `runSelfChecks` visame faile — o paaiškinamasis
   * komentaras jį mini TRIS kartus. Pašalinus importą ir kvietimą, bet palikus
   * komentarą, sargas liktų žalias, o `npm run doctor` tyliai nustotų rodyti
   * PostgreSQL ir kitas komponentų patikras.
   *
   * Tas pats galioja `require("pg")`: komentaras jį irgi mini.
   */
  const kodas = src
    .replace(/\/\*[\s\S]*?\*\//g, "")   // blokiniai
    .replace(/^\s*\/\/.*$/gm, "");        // eilutiniai

  assert.equal(
    /require\(["']pg["']\)/.test(kodas),
    false,
    "doctor.js neturi tiesiogiai kviesti `pg` - patikra gyvena runSelfChecks()"
  );

  /** Importas VIENAS nepakanka — reikia realaus KVIETIMO. */
  assert.match(
    kodas,
    /require\(["']\.\.\/utils\/startupChecks["']\)/,
    "doctor.js privalo importuoti bendrą patikrų modulį"
  );
  assert.match(
    kodas,
    /\brunSelfChecks\s*\(/,
    "doctor.js privalo KVIESTI runSelfChecks(), ne tik importuoti"
  );
});

test("#155 DOCTOR: komponento vardas NEŽADA neįgyvendintų integracijų", async () => {
  /**
   * 7.1 metu `jobStore` PostgreSQL nenaudoja, sesijos ir auditas irgi ne.
   * Žalia varnelė su vardu „job store, sesijos, auditas" operatoriui reikštų,
   * kad tie įrašai jau persistenti — o jie nėra.
   *
   * Vardas pasikeis 7.2a–7.4, kai integracijos realiai atsiras; iki tol jis
   * turi sakyti tik tiek, kiek yra.
   */
  const checks = await runSelfChecks({
    ...process.env,
    DATABASE_URL: "postgres://x@127.0.0.1:59999/x",
  });

  const p = rasti(checks);
  assert.ok(p, "su DATABASE_URL eilutė privalo būti");
  assert.equal(
    NEŽADA_INTEGRACIJŲ.test(p.name),
    false,
    `vardas žada neįgyvendintas integracijas: "${p.name}"`
  );
});

test("#155 DOCTOR: prisijungimo klaidos ATSKIRIAMOS pagal kodą", async () => {
  /**
   * Neteisingas slaptažodis, nesanti DB ir neveikiantis servisas reikalauja
   * SKIRTINGŲ operatoriaus veiksmų. Viena bendra „NEPASIEKIAMAS: ar servisas
   * paleistas?" siuntė klaidinga kryptimi.
   */
  const nesantiDb = new URL(process.env.DATABASE_URL || "postgres://x@127.0.0.1:1/x");
  nesantiDb.pathname = "/tikrai_nera_tokios_db";

  const checks = await runSelfChecks({ ...process.env, DATABASE_URL: nesantiDb.toString() });
  const p = rasti(checks);

  if (skipWithoutPostgres()) return; // be DB šio kodo negausim

  assert.equal(p.ok, false);
  assert.match(p.detail, /3D000|duomenų bazės NĖRA/i, "nesanti DB atskiriama nuo išjungto serviso");
  assert.equal(
    /ar servisas paleistas/.test(p.detail),
    false,
    "servisas VEIKIA - klaidingas patarimas"
  );
});

test("#155 DOCTOR: DATABASE_URL ir PG* KARTU yra klaida, ne pirmenybė", async () => {
  /**
   * ⚠️ OBSERVABILITY DIVERGENCE.
   *
   * Docker profiliai backend'ui perduoda `PG*`, o `.env` failuose dažnai lieka
   * `DATABASE_URL`. `doctor` skaito ABU failus, tad operatorius gali turėti abu
   * vienu metu — ir `doctor` tikrintų VISAI KITĄ DB nei tą, su kuria dirba
   * stackas.
   *
   * Tyli pirmenybė blogesnė už klaidą: diagnostika, rodanti ne tą duomenų bazę,
   * yra blogesnė nei diagnostikos nebuvimas.
   */
  const checks = await runSelfChecks({
    ...process.env,
    DATABASE_URL: "postgres://a@kitas-hostas/kita_db",
    PGHOST: "postgres",
  });

  const p = rasti(checks);
  assert.ok(p, "eilutė privalo būti");
  assert.equal(p.ok, false, "konfliktas NĖRA gera būsena");
  assert.match(p.detail, /KONFLIKTAS/);
  assert.match(p.detail, /DATABASE_URL/);
  assert.match(p.detail, /PGHOST/);
});
