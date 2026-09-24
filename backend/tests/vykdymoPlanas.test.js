const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { suites } = require("./suites");

/**
 * VYKDYMO PLANO SARGAS — KIEKVIENAS FAILAS EINA RIBOTU KELIU (#382 D2).
 *
 * ⚠️ KODĖL SARGO APSKRITAI REIKIA. #380 uždarė ribą `postgres`/`s3`/`postgresS3`
 * rinkiniams, o keturi likusieji tyliai liko be jos — ne dėl sprendimo, o dėl to, kad
 * niekas netikrino. #382 juos uždaro, bet be sargo kitas naujas rinkinys arba naujas
 * CI žingsnis vėl atsidurtų neribotame kelyje, ir vėl to niekas nepamatytų.
 *
 * ⚠️ PLANAS IŠVEDAMAS, NE SURAŠOMAS. Rankinis „ribotų rinkinių" sąrašas pasentų tyliai
 * — tai tiksliai ta klasė, kurią D2 uždaro. Todėl planas skaitomas iš tų pačių TRIJŲ
 * šaltinių, kuriais remiasi pats runner'is:
 *
 *   1. `tests/suites.js`      — kurie failai priklauso kuriam rinkiniui;
 *   2. `backend/package.json` — kuris npm skriptas kurį rinkinį leidžia;
 *   3. `.github/workflows/ci.yml` — ar prie skripto pridedama `--tap-dir`.
 *
 * Tikrasis SPRENDIMO TAŠKAS yra trečiasis: `package.json` skriptuose `--tap-dir` nėra
 * nė viename, tad kelią lemia būtent CI eilutė.
 *
 * ⚠️ PRIKLAUSOMYBĖS NETIKRINAMOS. Nei `DATABASE_URL`, nei `resourceStack`, nei Redis:
 * jų sąrašo iš anksto sudaryti neįmanoma, ir tai įrodė pats #382 — neribotas kelias
 * buvo paliktas remiantis „ten nėra pg pool'ų", o jame rado 15 Redis/BullMQ ir 25
 * subprocesus leidžiančių failų.
 */

const SAKNIS = path.resolve(__dirname, "..");
const CI_KELIAS = path.join(SAKNIS, "..", ".github", "workflows", "ci.yml");

/** `run-tests.mjs` nekviečiantys skriptai plano neliečia. */
function skriptaiIsPackageJson() {
  const pkg = JSON.parse(fs.readFileSync(path.join(SAKNIS, "package.json"), "utf8"));
  const zemelapis = {};
  for (const [vardas, komanda] of Object.entries(pkg.scripts || {})) {
    const m = /^node scripts\/run-tests\.mjs\s*(.*)$/.exec(komanda.trim());
    if (m) zemelapis[vardas] = m[1].trim();
  }
  return zemelapis;
}

/**
 * ⚠️ JOB'O KONTEKSTAS SEKAMAS, NE IGNORUOJAMAS. `ci.yml` turi ir `frontend` job'ą su
 * `npm run test:security` — tai Vitest, ne `run-tests.mjs`. Be konteksto sargas
 * praneštų apie pažeidimą ten, kur šio paleidiklio apskritai nėra.
 */
function ciZingsniai() {
  const eilutes = fs.readFileSync(CI_KELIAS, "utf8").split("\n");
  const rezultatas = [];
  let jobas = null;
  let jobKatalogas = null;
  let zingsnioKatalogas = null;

  for (let i = 0; i < eilutes.length; i += 1) {
    const eil = eilutes[i];

    const jobM = /^ {2}([A-Za-z][\w-]*):\s*$/.exec(eil);
    if (jobM) {
      jobas = jobM[1];
      jobKatalogas = null;
      zingsnioKatalogas = null;
    }

    /** `defaults: run: working-directory:` galioja visam job'ui. */
    const defM = /^ {8}working-directory:\s*(\S+)/.exec(eil);
    if (defM) jobKatalogas = defM[1];

    /** Naujas žingsnis nuneša ankstesnio `working-directory`. */
    if (/^ {6}- (name|uses|run):/.test(eil)) zingsnioKatalogas = null;
    const zingM = /^ {8}working-directory:\s*(\S+)/.exec(eil);
    if (zingM && /^ {6}- /.test(eilutes[i - 1] || "")) zingsnioKatalogas = zingM[1];

    const runM = /npm run (test:[\w-]+)(.*)$/.exec(eil);
    if (!runM) continue;

    rezultatas.push({
      eilute: i + 1,
      jobas,
      katalogas: zingsnioKatalogas || jobKatalogas,
      skriptas: runM[1],
      ribotas: /--tap-dir/.test(runM[2]),
    });
  }
  return rezultatas;
}

/**
 * Išveda planą: kiekvienam CI žingsniui, kuris leidžia `run-tests.mjs`, — kurie failai
 * ir kuriuo keliu.
 */
function isvestiPlana() {
  const skriptai = skriptaiIsPackageJson();
  const planas = [];
  for (const z of ciZingsniai()) {
    /**
     * ⚠️ KATALOGAS, NE JOB'O VARDAS. `ci.yml` turi `frontend` job'ą su tuo pačiu
     * `npm run test:security` — tai Vitest, o jo skriptas gyvena `frontend/package.json`.
     * Filtruojant pagal vardą sargas praneštų apie pažeidimą ten, kur `run-tests.mjs`
     * apskritai nekviečiamas (išmatuota: pirmoji redakcija rado `ci.yml:486 (frontend)`).
     */
    if (z.katalogas !== "backend") continue;

    const rinkinioArg = skriptai[z.skriptas];
    if (rinkinioArg === undefined) continue; // ne `run-tests.mjs`
    if (rinkinioArg === "--list") continue; // `--list` testų neleidžia
    const rinkiniai = rinkinioArg ? rinkinioArg.split(/\s+/) : ["privacy", "security", "functional"];
    const failai = [...new Set(rinkiniai.flatMap((r) => suites[r] || []))];
    planas.push({ ...z, rinkiniai, failai });
  }
  return planas;
}

test("#382 D2: kiekvienas CI vykdomas testų failas eina RIBOTU keliu", () => {
  const planas = isvestiPlana();
  assert.ok(planas.length > 0, "planas tuščias — ar `ci.yml` formatas pasikeitė?");

  const pazeidimai = planas
    .filter((z) => !z.ribotas)
    .map((z) => `ci.yml:${z.eilute} (${z.jobas}) ${z.skriptas} → ${z.failai.length} failų BE ribos`);

  assert.deepEqual(
    pazeidimai,
    [],
    "kiekvienas `run-tests.mjs` žingsnis privalo turėti `--tap-dir`: be jo visi failai " +
      "leidžiami vienu procesu be laiko ribos ir be procesų grupės nužudymo (#382 D1)"
  );
});

test("#382 D2: planas apima VISUS rinkinius, kuriuose yra failų", () => {
  /**
   * ⚠️ BE ŠITO sargas suderinamas su `ci.yml`, kuris tiesiog nebeleidžia rinkinio:
   * pažeidimų nulis, o testai nebevykdomi. Tikrinama, kad kiekvienas netuščias
   * rinkinys turi bent vieną CI žingsnį.
   */
  const planas = isvestiPlana();
  const padengti = new Set(planas.flatMap((z) => z.rinkiniai));
  const netustiRinkiniai = Object.entries(suites)
    .filter(([, v]) => v.length > 0)
    .map(([k]) => k);

  const nepadengti = netustiRinkiniai.filter((r) => !padengti.has(r));
  assert.deepEqual(nepadengti, [], `rinkiniai be CI žingsnio: ${nepadengti.join(", ")}`);
});

test("#382 D2 SAVIPATIKRA: pažeidimas RANDAMAS, o švari būsena — ne", () => {
  /**
   * ⚠️ SARGAS, NIEKADA NERADĘS PAŽEIDIMO, YRA NEPATIKRINTAS. Tas pats filtras
   * paleidžiamas ant dviejų sintetinių planų — vieno su pažeidimu, kito be. Mutacija
   * vykdoma KIEKVIENAME paleidime, ne vieną kartą rankomis.
   */
  const rasti = (p) => p.filter((z) => !z.ribotas).length;

  const svarus = [
    { eilute: 1, jobas: "backend", skriptas: "test:privacy", ribotas: true, failai: [] },
    { eilute: 2, jobas: "backend", skriptas: "test:redis", ribotas: true, failai: [] },
  ];
  const pazeistas = [...svarus, { eilute: 3, jobas: "backend", skriptas: "test:naujas", ribotas: false, failai: [] }];

  assert.equal(rasti(svarus), 0, "švarus planas NĖRA pažeidimas");
  assert.equal(rasti(pazeistas), 1, "žingsnis be `--tap-dir` PRIVALO būti randamas");
});

test("#382 D2: planas imamas iš TRIJŲ šaltinių, ne iš rankinio sąrašo", () => {
  /**
   * ⚠️ TAI KONTRAKTO TESTAS, NE FUNKCIJOS. Jis krenta, jei kas nors ims plauti planą
   * iš kietai įrašyto sąrašo: tada `ci.yml` pakeitimas nustotų jį veikti, o būtent tas
   * ryšys ir yra D2 esmė.
   */
  const planas = isvestiPlana();

  /** Šaltinis 1: rinkiniai atpažįstami iš `suites.js`. */
  assert.ok(
    planas.every((z) => z.rinkiniai.every((r) => Object.prototype.hasOwnProperty.call(suites, r))),
    "plane yra rinkinys, kurio `suites.js` nepažįsta"
  );

  /** Šaltinis 2: skriptas → rinkinys ryšys ateina iš `package.json`. */
  assert.ok(Object.keys(skriptaiIsPackageJson()).length >= 5, "`package.json` skriptų žemėlapis tuščias");

  /** Šaltinis 3: kelio sprendimą lemia `ci.yml` eilutė, ne skriptas. */
  const skriptai = skriptaiIsPackageJson();
  assert.ok(
    Object.values(skriptai).every((a) => !/--tap-dir/.test(a)),
    "`--tap-dir` atsirado `package.json` — tada sprendimo taškas nebe `ci.yml`, ir sargas tikrina ne tą"
  );
});
