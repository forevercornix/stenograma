const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * SARGAS PRIEŠ NAUJĄ NEAPGAUBTĄ `new Pool(` (#380 D1).
 *
 * ⚠️ MIGRACIJA BE SARGO YRA MOMENTINĖ NUOTRAUKA. #380 apgaubė 99 kūrimo vietas, bet
 * kitas PR pridės 100-ąją, ir niekas to nepamatys: neapgaubtas pool'as veikia
 * normaliai tol, kol kas nors nenuteka kliento — o tada vėl kabo be diagnostikos.
 *
 * ⚠️ TIKRINAMA STRUKTŪRIŠKAI, NE PAGAL PAVADINIMUS. Sąlyga viena: kiekvienas
 * `new Pool(` teste ar testų helper'yje privalo būti arba `stebetiPoola(new Pool(`,
 * arba `poolasTestui(...)` viduje (autoritetas), arba įrašytas IŠIMČIŲ sąraše su
 * priežastimi.
 */

const TESTU_KATALOGAS = path.resolve(__dirname);

/**
 * ⚠️ IŠIMTYS TURI PRIEŽASTĮ, NE TIK VARDĄ. Sąrašas be paaiškinimo per metus virsta
 * vieta, kur tyliai dedama viskas, kas nepatogu.
 */
const ISIMTYS = Object.freeze([
  {
    failas: "sessionPersistence.integration.test.js",
    priezastis:
      "`VAIKO_SKRIPTAS` — atskiro proceso kodas, įterptas kaip TEKSTAS ir paleidžiamas " +
      "per `node -e`. Jame nėra šio failo importų; gyvavimo ciklą riboja `execFileSync`.",
    kiek: 1,
  },
]);

function skaityti(failas) {
  return fs.readFileSync(path.join(TESTU_KATALOGAS, failas), "utf8");
}

/**
 * ⚠️ APIMTIS — `*.integration.test.js` IR `tests/helpers/*.js`, NE VISI TESTAI.
 *
 * Būtent ten gyvena ilgaamžiai pool'ai, kurių nutekėjimas kabina failą. Unit testai
 * (`auditStoreFields`, `suiteDerivation`, `sessionAuthFailClosed.route`,
 * `drRestorePreconditions`) `new Pool` mini konstrukcijos ar manifesto prasme, be gyvos
 * DB — jiems autoritetas nieko nepridėtų, tik triukšmo.
 *
 * ⚠️ IR PATS ŠIS FAILAS Į APIMTĮ NEĮEINA: jo tekste `new Pool(` figūruoja kaip DUOMUO
 * (šablonai, savipatikros eilutės), tad įtrauktas jis rastų pats save.
 */
function surinktiFailus() {
  const saknis = fs
    .readdirSync(TESTU_KATALOGAS)
    .filter((f) => f.endsWith(".integration.test.js"))
    .map((f) => ({ vardas: f, kelias: f }));
  const helpers = fs
    .readdirSync(path.join(TESTU_KATALOGAS, "helpers"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => ({ vardas: f, kelias: path.join("helpers", f) }));
  return [...saknis, ...helpers];
}

/**
 * Suskaičiuoja `new Pool(` vietas, KURIOS NĖRA apgaubtos autoriteto.
 *
 * ⚠️ `poolasTestui` skaičiuojamas kaip apgaubta pagal konstrukciją: jis pats kviečia
 * `registruotiPoola`, tad jo viduje esantis `new Pool(` yra autoriteto dalis.
 */
function neapgaubti(turinys) {
  const visi = (turinys.match(/new Pool\(/g) || []).length;
  const apgaubti = (turinys.match(/stebetiPoola\(\s*new Pool\(/g) || []).length;
  return visi - apgaubti;
}

test("#380 SARGAS: joks testų failas neturi neapgaubto `new Pool(`", () => {
  const pazeidimai = [];

  for (const { vardas, kelias } of surinktiFailus()) {
    const kiek = neapgaubti(skaityti(kelias));
    if (kiek === 0) continue;

    const isimtis = ISIMTYS.find((i) => i.failas === vardas);
    if (isimtis && kiek === isimtis.kiek) continue;

    pazeidimai.push(
      `${kelias}: ${kiek} neapgaubta \`new Pool(\`` +
        (isimtis ? ` (išimtis leidžia ${isimtis.kiek})` : "")
    );
  }

  assert.deepEqual(
    pazeidimai,
    [],
    "kiekvienas `new Pool(` privalo eiti per `stebetiPoola()` arba `poolasTestui()`; " +
      "kitaip nutekėjęs klientas vėl kabins failą be diagnostikos (#380)"
  );
});

test("#380 SARGAS SAVIPATIKRA: įterptas pažeidimas RANDAMAS, o švarus tekstas — ne", () => {
  /**
   * ⚠️ SARGAS, KURIS NIEKADA NERADO PAŽEIDIMO, YRA NEPATIKRINTAS. Čia tas pats
   * skaitiklis paleidžiamas ant dviejų sintetinių tekstų — vieno su pažeidimu, kito be.
   * Tai mutacija, vykdoma KIEKVIENAME paleidime, ne vieną kartą rankomis.
   */
  const svarus = 'const p = stebetiPoola(new Pool({ connectionString: X }), { vardas: "p" });';
  const pazeistas = svarus + "\nconst q = new Pool({ connectionString: X });";

  assert.equal(neapgaubti(svarus), 0, "apgaubtas pool'as NĖRA pažeidimas");
  assert.equal(neapgaubti(pazeistas), 1, "neapgaubtas pool'as PRIVALO būti randamas");
});

test("#380 SARGAS: kiekviena išimtis turi priežastį ir tebegalioja", () => {
  /**
   * ⚠️ IŠIMTIS, KURIOS PRIEŽASTIS DINGO, YRA BLOGIAU NEI JOKIOS. Jei failas pasitaisė,
   * išimtis privalo kristi — antraip ji lieka atvira durys.
   */
  for (const i of ISIMTYS) {
    assert.ok(i.priezastis && i.priezastis.length > 40, `${i.failas}: išimtis be priežasties`);

    assert.equal(
      neapgaubti(skaityti(i.failas)),
      i.kiek,
      `${i.failas}: išimtis nebeatitinka tikrovės — arba failas pasitaisė (šalinti išimtį), ` +
        "arba atsirado naujas neapgaubtas pool'as"
    );
  }
});

/* ══════════════════ D8 — FIKTŪRŲ DDL PER AUTORITETĄ (#380) ══════════════════ */

const DDL = /\b(DROP\s+INDEX|CREATE\s+(UNIQUE\s+)?INDEX|ALTER\s+TABLE|TRUNCATE|LOCK\s+TABLE)\b/i;

/**
 * ⚠️ IŠIMTYS SU PRIEŽASTIMI, KAIP IR POOL'Ų PUSĖJE.
 */
const DDL_ISIMTYS = Object.freeze([
  {
    failas: "isipareigojimoTvora.integration.test.js",
    priezastis:
      "du `ALTER TABLE ... RENAME` čia TURI savo ribą — `ribotas()` plius " +
      "`pg_terminate_backend` (#351 8b); perdavus juos `fikturosDdl()`, dingtų būtent tas " +
      "sargas, kurį testas įrodo. Trečias radinys yra ASERCIJOS PRANEŠIMO tekstas, ne " +
      "sakinys — skaitiklis teksto nuo kodo neskiria, ir to nebandau apeiti euristika.",
    kiek: 3,
  },
  {
    failas: "migrations.integration.test.js",
    priezastis:
      "`CREATE UNIQUE INDEX CONCURRENTLY` transakcijos bloke krenta su `25001`, o " +
      "`fikturosDdl()` vynioja į `BEGIN`/`COMMIT`, kad `SET LOCAL` galiotų. Riba ten ir " +
      "nereikalinga: `CONCURRENTLY` sąmoningai neima `ACCESS EXCLUSIVE`.",
    kiek: 1,
  },
]);

/**
 * Suskaičiuoja DDL sakinius, kurie NEEINA per autoritetą.
 *
 * ⚠️ KONTEKSTAS — ŠEŠIOS EILUTĖS AUKŠČIAU. Daugiaeilis `fikturosDdl(\n pool,\n "t",\n
 * `SQL`)` kvietimas SQL eilutėje paties `fikturosDdl` neturi, tad vien eilutės tikrinimas
 * duotų netikrą pažeidimą kiekvienam teisingai migruotam sakiniui.
 */
function neapgaubtasDdl(turinys) {
  const eil = turinys.split("\n");
  let n = 0;
  for (let i = 0; i < eil.length; i += 1) {
    const s = eil[i].trim();
    if (s.startsWith("*") || s.startsWith("//") || !DDL.test(eil[i])) continue;
    /**
     * ⚠️ REGEX APIBRĖŽIMAS NĖRA SAKINYS. Pats `UZRAKTO_DDL` šablonas vardija tuos
     * pačius raktažodžius, tad be šios eilutės sargas rastų pažeidimą kiekviename
     * faile, kuris D8 taisyklę tik APRAŠO.
     */
    if (/=\s*\//.test(eil[i]) || s.startsWith("const ") || s.startsWith("Object.freeze")) continue;
    const ctx = eil.slice(Math.max(0, i - 6), i + 1).join("\n");
    if (ctx.includes("fikturosDdl(") || ctx.includes("await pg(") || ctx.includes("NE_TRANSAKCIJOJE")) continue;
    n += 1;
  }
  return n;
}

test("#380 D8: fiktūrų DDL eina per autoritetą, ne tiesiai į `pool.query()`", () => {
  const pazeidimai = [];

  for (const { vardas, kelias } of surinktiFailus()) {
    const kiek = neapgaubtasDdl(skaityti(kelias));
    if (kiek === 0) continue;

    const isimtis = DDL_ISIMTYS.find((i) => i.failas === vardas);
    if (isimtis && kiek === isimtis.kiek) continue;

    pazeidimai.push(`${kelias}: ${kiek} DDL be \`fikturosDdl()\`` + (isimtis ? ` (išimtis leidžia ${isimtis.kiek})` : ""));
  }

  assert.deepEqual(
    pazeidimai,
    [],
    "`DROP`/`CREATE INDEX`, `ALTER`, `TRUNCATE`, `LOCK` privalo eiti per `fikturosDdl()`: " +
      "be `lock_timeout` jie laukia už kiekvienos atviros transakcijos NERIBOTAI (#380 D8)"
  );
});

test("#380 D8 SAVIPATIKRA: įterptas DDL be helper'io RANDAMAS, o per helper'į — ne", () => {
  /**
   * ⚠️ TA PATI TAISYKLĖ KAIP POOL'Ų SARGE: skaitiklis, niekada neradęs pažeidimo, yra
   * nepatikrintas. Tikrinamos ABI kryptys, įskaitant daugiaeilį kvietimą — būtent jis
   * pirmoje redakcijoje būtų davęs netikrą pažeidimą.
   */
  const perHelperi = 'await fikturosDdl(pool, "t", `DROP INDEX x`);';
  const daugiaeilis = 'await fikturosDdl(\n  pool,\n  "t",\n  `CREATE UNIQUE INDEX i ON t (a)`\n);';
  const pazeistas = 'await pool.query(`DROP INDEX x`);';

  assert.equal(neapgaubtasDdl(perHelperi), 0, "vienaeilis per helper'į NĖRA pažeidimas");
  assert.equal(neapgaubtasDdl(daugiaeilis), 0, "daugiaeilis per helper'į NĖRA pažeidimas");
  assert.equal(neapgaubtasDdl(pazeistas), 1, "DDL be helper'io PRIVALO būti randamas");
});

test("#380 D8: kiekviena DDL išimtis turi priežastį ir tebegalioja", () => {
  for (const i of DDL_ISIMTYS) {
    assert.ok(i.priezastis && i.priezastis.length > 40, `${i.failas}: išimtis be priežasties`);
    assert.equal(
      neapgaubtasDdl(skaityti(i.failas)),
      i.kiek,
      `${i.failas}: išimtis nebeatitinka tikrovės`
    );
  }
});
