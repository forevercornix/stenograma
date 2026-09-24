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
 * ⚠️ KĄ ŠIS SARGAS REIŠKIA PO #382 D1, IR KO NEBEREIŠKIA.
 *
 * Pašalinus neribotą šaką iš `run-tests.mjs`, riba nebepriklauso nuo `--tap-dir`:
 * kiekvienas failas leidžiamas per `paleistiFaila` bet kuriuo atveju. Todėl šis sargas
 * **nebegina ribos** — ją gina D1 testai failo apačioje, tikrinantys patį runner'į.
 *
 * Kas lieka: `--tap-dir` yra vienintelis būdas IŠSAUGOTI per-failo TAP. Iš jo remiasi
 * `verify-postgres-suite-ran.mjs` (#231) — įrodymas, kad KIEKVIENAS rinkinio failas
 * realiai vykdytas, o ne tyliai praleistas. Šiandien tą katalogą skaito trys žingsniai
 * (`ci.yml:253`, `:340`, `:376`); likusiems keturiems jis rašomas, bet neskaitomas.
 *
 * ⚠️ TAI UŽRAŠOMA, O NE NUTYLIMA: keturiems rinkiniams `--tap-dir` šiandien yra
 * pasiruošimas, ne garantija. Verifikatoriaus išplėtimas jiems — atskiras darbas.
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
const RUNNER_KELIAS = path.join(SAKNIS, "scripts", "run-tests.mjs");
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

    const tapM = /--tap-dir=(\S+)/.exec(runM[2]);

    rezultatas.push({
      eilute: i + 1,
      jobas,
      katalogas: zingsnioKatalogas || jobKatalogas,
      skriptas: runM[1],
      ribotas: Boolean(tapM),
      tapKelias: tapM ? tapM[1] : null,
    });
  }
  return rezultatas;
}

/**
 * `verify-postgres-suite-ran.mjs <katalogas> [rinkinys] [žyma]` kvietimai iš `ci.yml`.
 *
 * ⚠️ IMAMI TIE PATYS ARGUMENTAI, KURIUOS MATO SKRIPTAS. Sargas negali remtis žingsnio
 * PAVADINIMU ar tvarka: būtent tokia patikra praleistų `functional`, verifikuojamą
 * pagal `/tmp/security-tap` — žingsnis egzistuoja, vardas gražus, o įrodymas svetimas.
 */
function verifyKvietimai() {
  const eilutes = fs.readFileSync(CI_KELIAS, "utf8").split("\n");
  const rezultatas = [];
  for (let i = 0; i < eilutes.length; i += 1) {
    /** Komentarų eilutės mini skriptą, bet jo nekviečia. */
    if (/^\s*#/.test(eilutes[i])) continue;
    const m = /verify-postgres-suite-ran\.mjs\s+(\S+)(?:\s+(\S+))?(?:\s+(\S+))?/.exec(eilutes[i]);
    if (!m) continue;
    rezultatas.push({
      eilute: i + 1,
      tapKelias: m[1],
      rinkinys: m[2] || "postgres",
      zyma: m[3] === undefined ? "DATABASE_URL" : m[3],
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

test("#382 D2: kiekvienas CI vykdomas testų žingsnis IŠSAUGO per-failo TAP", () => {
  const planas = isvestiPlana();
  assert.ok(planas.length > 0, "planas tuščias — ar `ci.yml` formatas pasikeitė?");

  const pazeidimai = planas
    .filter((z) => !z.ribotas)
    .map((z) => `ci.yml:${z.eilute} (${z.jobas}) ${z.skriptas} → ${z.failai.length} failų BE per-failo TAP`);

  assert.deepEqual(
    pazeidimai,
    [],
    "kiekvienas `run-tests.mjs` žingsnis privalo turėti `--tap-dir`: be jo per-failo TAP " +
      "nueina į laikiną katalogą ir dingsta, o su juo dingsta ir įrodymas, kad kiekvienas " +
      "failas realiai vykdytas (#231). Riba nuo šito NEPRIKLAUSO — ją gina D1 testai žemiau"
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

/* ══════════════ D1 — RUNNER'YJE NĖRA ŠAKOS BE RIBOS (#382) ══════════════ */

/**
 * ⚠️ PIRMINIS SARGAS YRA ŠIS, NE `ci.yml` PATIKRA.
 *
 * Kol `run-tests.mjs` turėjo antrą šaką (`if (!tapDir)` su `spawnSync`), riba
 * priklausė nuo to, ar KVIETĖJAS pridėjo `--tap-dir`. Tai reiškė, kad kiekvienas naujas
 * kvietėjas — CI žingsnis, npm skriptas, kito testo `execFileSync`, kūrėjo ranka — galėjo
 * ribos netekti tyliai. Pašalinus šaką, riba nustojo priklausyti nuo kvietėjo.
 *
 * Šis testas gina būtent tai: kad šaka negrįžtų.
 */
function runnerioTekstas() {
  return fs.readFileSync(RUNNER_KELIAS, "utf8");
}

test("#382 D1: `run-tests.mjs` neturi vykdymo šakos be ribos", () => {
  const s = runnerioTekstas();

  /**
   * ⚠️ TIKRINAMAS VYKDYMAS, NE ŽODIS. `spawnSync` importas ar paminėjimas komentare
   * nieko nereiškia; reikšmę turi tik `spawnSync(...)` KVIETIMAS, nes tik jis paleidžia
   * procesą aplenkdamas `paleistiFaila`.
   */
  const kvietimai = [...s.matchAll(/(?<![\w.])spawnSync\s*\(/g)];
  assert.deepEqual(
    kvietimai.map((m) => s.slice(0, m.index).split("\n").length),
    [],
    "`run-tests.mjs` nebeturi kviesti `spawnSync` — procesus leidžia tik `paleistiFaila`, " +
      "kuris turi laiko ribą, buferio ribą ir procesų grupės nužudymą (#382 D1)"
  );
});

test("#382 D1: `--tap-dir` nebelemia VYKDYMO būdo, tik TAP vietą", () => {
  /**
   * ⚠️ BE ŠITO ankstesnis testas suderinamas su realizacija, kuri `spawnSync` tiesiog
   * pervadino. Tikrinama savybė: be `--tap-dir` runner'is pasidaro laikiną katalogą ir
   * eina TUO PAČIU keliu, o ne kitu.
   */
  const s = runnerioTekstas();
  assert.match(s, /mkdtempSync\(/, "be `--tap-dir` privalo būti sukuriamas laikinas katalogas");
  assert.match(
    s,
    /await paleistiFaila\(/,
    "vienintelis proceso paleidimo kelias privalo būti `paleistiFaila`"
  );
});

test("#382 D1 SAVIPATIKRA: grąžinta šaka be ribos RANDAMA", () => {
  /**
   * ⚠️ TAS PATS FILTRAS ANT SINTETINIO TEKSTO. Sargas, niekada neradęs pažeidimo, yra
   * nepatikrintas — o čia mutacija vykdoma kiekviename paleidime.
   */
  const rasti = (tekstas) => [...tekstas.matchAll(/(?<![\w.])spawnSync\s*\(/g)].length;

  const svarus = 'const r = await paleistiFaila(failas, env);\nimport { spawn } from "node:child_process";';
  const pazeistas = svarus + '\nif (!tapDir) { const r2 = spawnSync("node", ["--test", ...files]); }';

  assert.equal(rasti(svarus), 0, "švarus runner'is NĖRA pažeidimas");
  assert.equal(rasti(pazeistas), 1, "grąžinta `spawnSync` šaka PRIVALO būti randama");
});

/* ══════════ D2 — 1:1 RYŠYS TARP RINKINIO, TAP IR VARTOTOJO (#402) ══════════ */

/**
 * ⚠️ TRYS PAŽEIDIMŲ RŪŠYS, IR VIEN „VERIFY EGZISTUOJA" NĖRA NĖ VIENOS ATSAKYMAS.
 *
 *   · TRŪKSTAMAS — rinkinys leidžiamas, bet jo TAP niekas neskaito (būtent tai #402
 *     ir rado: 175 failai turėjo įrodymo vietą be vartotojo);
 *   · DUBLIUOTAS — du `verify` tam pačiam katalogui arba du katalogai tam pačiam
 *     rinkiniui: tada neaišku, kuris iš jų yra įrodymas;
 *   · SVETIMAS — `verify … /tmp/security-tap functional`. Žingsnis yra, vardas gražus,
 *     o skaitomas KITO paleidimo katalogas. Patikra „ar yra verify žingsnis" tai
 *     praeitų, ir įrodymas būtų apie ne tą rinkinį (#342 klasė).
 *
 * Todėl lyginamos POROS `(rinkinys, tapKelias)`, o ne buvimas.
 */
function suporuoti() {
  const leidimai = isvestiPlana().filter((z) => z.ribotas);
  const verifai = verifyKvietimai();
  const pazeidimai = [];

  for (const z of leidimai) {
    for (const r of z.rinkiniai) {
      const savi = verifai.filter((v) => v.rinkinys === r);

      if (savi.length === 0) {
        pazeidimai.push(`TRŪKSTA: rinkinys "${r}" (ci.yml:${z.eilute}) neturi \`verify\` žingsnio`);
        continue;
      }
      if (savi.length > 1) {
        pazeidimai.push(
          `DUBLIS: rinkinys "${r}" turi ${savi.length} \`verify\` žingsnius ` +
            `(ci.yml:${savi.map((v) => v.eilute).join(", ")})`
        );
        continue;
      }
      if (savi[0].tapKelias !== z.tapKelias) {
        pazeidimai.push(
          `SVETIMAS: rinkinys "${r}" rašo į ${z.tapKelias} (ci.yml:${z.eilute}), ` +
            `o tikrinamas pagal ${savi[0].tapKelias} (ci.yml:${savi[0].eilute})`
        );
      }
    }
  }

  /** Tas pats klausimas iš kitos pusės: katalogas, kurio niekas nerašo. */
  const rasomi = new Set(leidimai.map((z) => z.tapKelias));
  for (const v of verifyKvietimai()) {
    if (!rasomi.has(v.tapKelias)) {
      pazeidimai.push(
        `SVETIMAS: \`verify\` (ci.yml:${v.eilute}) skaito ${v.tapKelias}, kurio nerašo joks žingsnis`
      );
    }
  }
  return pazeidimai;
}

test("#402 D2: kiekvienas rinkinys turi TIKSLIAI VIENĄ TAP katalogą ir vieną vartotoją", () => {
  assert.deepEqual(
    suporuoti(),
    [],
    "kiekvienas CI leidžiamas `suites.js` rinkinys privalo turėti savo `--tap-dir` ir " +
      "`verify-postgres-suite-ran.mjs`, skaitantį BŪTENT tą katalogą (#402 D2)"
  );
});

test("#402 D2 SAVIPATIKRA: trūkstamas, dubliuotas ir SVETIMAS katalogai randami", () => {
  /**
   * ⚠️ TAS PATS PALYGINIMAS ANT SINTETINIŲ PLANŲ. Sargas, niekada neradęs pažeidimo,
   * yra nepatikrintas; čia mutacija vykdoma kiekviename paleidime, ir visoms TRIMS
   * rūšims atskirai — antraip „randa pažeidimą" galėtų reikšti tik vieną iš jų.
   */
  const poruoti = (leidimai, verifai) => {
    const p = [];
    for (const z of leidimai) {
      const savi = verifai.filter((v) => v.rinkinys === z.rinkinys);
      if (savi.length === 0) p.push("TRŪKSTA " + z.rinkinys);
      else if (savi.length > 1) p.push("DUBLIS " + z.rinkinys);
      else if (savi[0].tapKelias !== z.tapKelias) p.push("SVETIMAS " + z.rinkinys);
    }
    return p;
  };

  const svarus = [
    { rinkinys: "privacy", tapKelias: "/tmp/p" },
    { rinkinys: "functional", tapKelias: "/tmp/f" },
  ];
  const veikiantys = [
    { rinkinys: "privacy", tapKelias: "/tmp/p", eilute: 1 },
    { rinkinys: "functional", tapKelias: "/tmp/f", eilute: 2 },
  ];

  assert.deepEqual(poruoti(svarus, veikiantys), [], "švarus planas NĖRA pažeidimas");

  assert.deepEqual(
    poruoti(svarus, veikiantys.slice(0, 1)),
    ["TRŪKSTA functional"],
    "rinkinys be `verify` PRIVALO būti randamas"
  );

  assert.deepEqual(
    poruoti(svarus, [...veikiantys, { rinkinys: "privacy", tapKelias: "/tmp/p", eilute: 3 }]),
    ["DUBLIS privacy"],
    "du `verify` tam pačiam rinkiniui PRIVALO būti randami"
  );

  /** ⚠️ Būtent šis atvejis praeitų patikrą „ar verify žingsnis egzistuoja". */
  assert.deepEqual(
    poruoti(svarus, [
      veikiantys[0],
      { rinkinys: "functional", tapKelias: "/tmp/security-tap", eilute: 2 },
    ]),
    ["SVETIMAS functional"],
    "`verify`, skaitantis KITO paleidimo katalogą, PRIVALO būti randamas"
  );
});
