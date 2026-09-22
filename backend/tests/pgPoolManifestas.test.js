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
