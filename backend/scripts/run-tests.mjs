#!/usr/bin/env node
/**
 * TESTŲ RINKINIŲ PALEIDIKLIS (#15).
 *
 * Naudojimas:
 *   node scripts/run-tests.mjs                 - numatytieji rinkiniai
 *   node scripts/run-tests.mjs security        - vienas rinkinys
 *   node scripts/run-tests.mjs privacy security
 *   node scripts/run-tests.mjs --list          - ką apima kiekvienas rinkinys
 *   node scripts/run-tests.mjs postgres --tap-dir=/tmp/pg-tap
 *
 * ⚠️ `--tap-dir` PAKEIČIA VYKDYMO BŪDĄ, NE TIK IŠVESTĮ (#155, 7.4f / #231).
 *
 * Be jo visi failai paleidžiami VIENU `node --test <failai>` kvietimu, ir Node
 * 18 duoda plokščią TAP srautą BE failų vardų. Tokiame sraute neįmanoma
 * įrodyti, kad kiekvienas rinkinio failas realiai vykdytas: failas, nutilęs dėl
 * klaidingo importo, atrodo lygiai taip pat, kaip failas, kurio testai praėjo.
 *
 * Su `--tap-dir` kiekvienas failas paleidžiamas ATSKIRU procesu, o jo TAP
 * rašomas į `<dir>/<vardas>.tap`. Atributika tada yra failo vardas, ne srauto
 * turinys, tad ji nepriklauso nuo Node versijos ar reporterio formato.
 *
 * Kaina - prarandamas lygiagretumas tarp failų. Tai sąmoningas mainas: rinkinys
 * mažas, o alternatyva yra silpnesnis įrodymas.
 *
 * Prieš paleisdamas TIKRINA manifesto pilnumą. Testų grupavimas, kuriame naujas
 * failas gali tyliai likti už ribų, duoda blogiausią įmanomą rezultatą: žalią
 * `test:security`, kuris tiesiog nepaleido naujo saugumo testo.
 */

import { readdirSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = join(here, "..");
const testsDir = join(backendRoot, "tests");

const require = createRequire(import.meta.url);
const { suites, defaultSuites } = require(join(testsDir, "suites.js"));

/** Visi realiai egzistuojantys testų failai. */
function discoverTests() {
  return readdirSync(testsDir)
    .filter((name) => name.endsWith(".test.js"))
    .map((name) => name.replace(/\.test\.js$/, ""))
    .sort();
}

/**
 * Manifesto ir tikrovės sutapimas TURI būti abipusis.
 *
 * Nepriskirtas failas reiškia testą, kurio niekas nepaleidžia rinkiniais;
 * nurodytas neegzistuojantis - manifestą, kuris apsimeta dengiantis daugiau, nei
 * dengia. Abu atvejai yra tyli spraga, tad abu stabdo paleidimą.
 */
function verifyManifest(discovered) {
  const assigned = new Set(Object.values(suites).flat());
  const problems = [];

  /**
   * DUBLIKATAI RINKINIUOSE.
   *
   * ⚠️ Paleidiklis juos dedublikuoja (`new Set(...)`), tad dublikatas yra
   * TYLIAI NEKENKSMINGAS — testai vykdomi teisingai, ir niekas nepastebi.
   *
   * Būtent todėl jis prasprūdo į #22.2 peržiūrą: klaidą pamatė žmogus,
   * skaitydamas diff'ą, o ne įrankis. Tyliai nekenksminga klaida vis tiek yra
   * klaida — ji rodo, kad manifestas redaguotas neatidžiai, ir kitas
   * redagavimas gali būti žalingesnis.
   */
  for (const [suiteName, names] of Object.entries(suites)) {
    const seen = new Set();

    for (const name of names) {
      if (seen.has(name)) {
        problems.push(`rinkinyje "${suiteName}" testas "${name}" nurodytas DU kartus`);
      }
      seen.add(name);
    }
  }

  for (const name of discovered) {
    if (!assigned.has(name)) {
      problems.push(`testas "${name}" nepriskirtas jokiam rinkiniui (tests/suites.js)`);
    }
  }

  for (const name of assigned) {
    if (!discovered.includes(name)) {
      problems.push(`manifeste nurodytas neegzistuojantis testas "${name}"`);
    }
  }

  return problems;
}

function resolveFiles(names) {
  return names
    .map((name) => join(testsDir, `${name}.test.js`))
    .filter((path) => existsSync(path));
}

const args = process.argv.slice(2);

/** `--tap-dir=<kelias>` arba `--tap-dir <kelias>`. */
function istrauktiTapDir(argumentai) {
  const suLygybe = argumentai.find((a) => a.startsWith("--tap-dir="));
  if (suLygybe) return { dir: suLygybe.slice("--tap-dir=".length), likutis: argumentai.filter((a) => a !== suLygybe) };

  const i = argumentai.indexOf("--tap-dir");
  if (i === -1) return { dir: null, likutis: argumentai };

  const reiksme = argumentai[i + 1];
  if (!reiksme || reiksme.startsWith("--")) {
    console.error("`--tap-dir` reikalauja katalogo kelio.");
    process.exit(1);
  }
  return { dir: reiksme, likutis: argumentai.filter((_, j) => j !== i && j !== i + 1) };
}

const { dir: tapDir, likutis: rinkiniuArgs } = istrauktiTapDir(args);
const discovered = discoverTests();

const problems = verifyManifest(discovered);
if (problems.length > 0) {
  console.error("Testų manifestas nesutampa su tikrove:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("\nPapildykite tests/suites.js. Naujas testas privalo turėti rinkinį.");
  process.exit(1);
}

if (rinkiniuArgs.includes("--list")) {
  for (const [name, tests] of Object.entries(suites)) {
    console.log(`${name} (${tests.length}):`);
    for (const test of tests) console.log(`  ${test}`);
    console.log();
  }
  process.exit(0);
}

const requested = rinkiniuArgs.length > 0 ? rinkiniuArgs : defaultSuites;

const unknown = requested.filter((name) => !suites[name]);
if (unknown.length > 0) {
  console.error(`Nežinomi rinkiniai: ${unknown.join(", ")}`);
  console.error(`Galimi: ${Object.keys(suites).join(", ")}`);
  process.exit(1);
}

// Dublikatai kai rinkiniai persidengia - failas paleidžiamas kartą.
const files = resolveFiles([...new Set(requested.flatMap((name) => suites[name]))]);

console.log(`Rinkiniai: ${requested.join(", ")} (${files.length} failų)\n`);

if (!tapDir) {
  const result = spawnSync("node", ["--test", ...files], {
    cwd: backendRoot,
    stdio: "inherit",
  });

  process.exit(result.status ?? 1);
}

/**
 * PER-FAILO VYKDYMAS SU ATSKIRU TAP.
 *
 * ⚠️ SENI `.tap` VALOMI PRIEŠ PALEIDIMĄ. Be to praėjusio paleidimo artefaktas
 * liktų kataloge, ir vykdymo tikrintuvas praeitų dėl failo, kuris ŠĮKART nebuvo
 * paleistas apskritai. Tikrinimas, kuris praeina dėl seno įrodymo, blogesnis už
 * jokį - jis atrodo kaip garantija.
 */
mkdirSync(tapDir, { recursive: true });
for (const senas of readdirSync(tapDir).filter((n) => n.endsWith(".tap"))) {
  unlinkSync(join(tapDir, senas));
}

/**
 * D5 — VIENO FAILO LAIKO RIBA IR IŠVESTIES BUFERIS (#380).
 *
 * ⚠️ IŠVESTA IŠ MATAVIMO, NE SPĖTA. Trys žali `main` run'ai (`35651144332`,
 * `35583526448`, `35565366586`): lėčiausi failai — `auditPersistence.integration`
 * **33 s** ir `migrations.integration` **30 s**, visų kitų mediana 1–4 s. Riba 120 s
 * yra ×3,6 nuo išmatuoto MAKSIMUMO: kad duotų netikrą kritimą, runner'is turi suktis
 * dvigubai lėčiau nei blogiausias stebėtas atvejis.
 *
 * ⚠️ RIBA YRA VIENO FAILO, NE VISO RINKINIO. Vienas pakibęs failas kainuoja 120 s
 * vietoj 20 min job timeout'o. Sisteminis gedimas (kabo visi) job'o ribą vis tiek
 * pasiektų — bet tada diagnozė jau nedviprasmiška iš PIRMO `FILE_TIMEOUT`.
 *
 * ⚠️ `maxBuffer` NUSTATOMAS AIŠKIAI. Numatytasis `spawnSync` buferis — 1 MiB, o
 * didžiausia išmatuota TAP sekcija (`artifactMigrationS3.integration`, run
 * `35651144332`) ~267 KB. Atsarga tik ~4×, o KRITĘS failas išveda kartotinai daugiau
 * nei žalias (YAML blokai su `stack`). Viršijus buferį procesas nutraukiamas su
 * `ENOBUFS`, ir be atskyrimo tai atrodytų kaip laiko riba.
 */
const FAILO_RIBA_MS = 120_000;
const FAILO_BUFERIS = 64 * 1024 * 1024;

let bendraBusena = 0;

for (const failas of files) {
  const vardas = failas.slice(failas.lastIndexOf("/") + 1).replace(/\.test\.js$/, "");

  /**
   * ⚠️ REPORTERIS NURODOMAS EKSPLICITIŠKAI, IR `NODE_TEST_CONTEXT` ŠALINAMAS.
   *
   * `node --test` numatytąjį reporterį renkasi pagal aplinką. Paveldėjęs
   * `NODE_TEST_CONTEXT` (jį nustato tėvinis test runner) jis pereina į V8
   * dvejetainį vaiko protokolą, ir vietoj TAP į failą nukrenta binarinis
   * srautas. Tada vykdymo tikrintuvas nemato nė vieno `ok` ir paskelbia
   * neįvykdytą rinkinį - t. y. gedimas atrodo kaip nepaleistas testas.
   *
   * Rasta ne teoriškai: `suiteDerivation.test.js` paleidžia šį paleidiklį, tad
   * pats sukūrė tokį kontekstą.
   */
  const vaikoEnv = { ...process.env };
  delete vaikoEnv.NODE_TEST_CONTEXT;

  const rezultatas = spawnSync(
    "node",
    ["--test", "--test-reporter=tap", "--test-reporter-destination=stdout", failas],
    {
      cwd: backendRoot,
      encoding: "utf8",
      env: vaikoEnv,
      stdio: ["inherit", "pipe", "pipe"],
      timeout: FAILO_RIBA_MS,
      maxBuffer: FAILO_BUFERIS,
      /**
       * ⚠️ `SIGKILL`, NE NUMATYTASIS `SIGTERM`. Pakibęs procesas kabo neatsakančiame
       * `pg` sakinyje arba event loop'e, kurį laiko nutekėjęs klientas; `SIGTERM`
       * tokiu atveju gali būti apdorotas ir proceso nepabaigti, ir riba taptų dar
       * viena vieta, kur laukiama neribotai.
       */
      killSignal: "SIGKILL",
    }
  );

  /**
   * ⚠️ NUTRAUKTAS FAILAS = KRITĘS FAILAS, SU VARDU (#380 R1).
   *
   * `spawnSync` nutraukus procesą GRĄŽINA tai, ką jis spėjo išvesti, tad dalinė
   * išvestis IŠSAUGOMA — ji yra diagnostika: iš jos matyti, kuris testas buvo
   * paskutinis. Prie jos prikabinama TAP eilutė su stabiliu kodu.
   *
   * ⚠️ `ENOBUFS` ATSKIRIAMAS NUO `ETIMEDOUT`. Abu ateina per `rezultatas.error` ir
   * abu nutraukia procesą, bet reiškia priešingus dalykus: pirmas — testas išvedė
   * PER DAUG, antras — nustojo išvesti apskritai. Sulieti juos reikštų siųsti
   * operatorių taisyti ne to.
   */
  const klaidosKodas = rezultatas.error ? rezultatas.error.code : null;
  const perpildytas = klaidosKodas === "ENOBUFS";
  const nutrauktas = !perpildytas && (klaidosKodas === "ETIMEDOUT" || rezultatas.signal === "SIGKILL");

  let zyma = "";
  if (perpildytas) {
    zyma =
      `\nnot ok 0 - FILE_OVERFLOW ${vardas}\n` +
      "  ---\n" +
      "  kodas: 'FILE_OVERFLOW'\n" +
      `  failas: '${vardas}'\n` +
      `  buferis_baitais: ${FAILO_BUFERIS}\n` +
      "  paaiskinimas: 'TAP išvestis viršijo buferį — tai NE laiko riba'\n" +
      "  ...\n";
  } else if (nutrauktas) {
    zyma =
      `\nnot ok 0 - FILE_TIMEOUT ${vardas}\n` +
      "  ---\n" +
      "  kodas: 'FILE_TIMEOUT'\n" +
      `  failas: '${vardas}'\n` +
      `  riba_ms: ${FAILO_RIBA_MS}\n` +
      "  paaiskinimas: 'failas nebaigė per ribą ir buvo nutrauktas; aukščiau — dalinė išvestis'\n" +
      "  ...\n";
  }

  const tap = (rezultatas.stdout ?? "") + (rezultatas.stderr ?? "") + zyma;

  /**
   * ⚠️ RAŠOMA IR TADA, KAI PROCESAS KRITO. Kritęs ar nulūžęs failas duoda TAP be
   * nė vieno `ok` - būtent tai tikrintuvui ir reikia pamatyti. Praleidus rašymą
   * gedimas taptų neatskiriamas nuo nepaleisto failo.
   */
  writeFileSync(join(tapDir, `${vardas}.tap`), tap, "utf8");

  const busenosTekstas = perpildytas
    ? "FILE_OVERFLOW"
    : nutrauktas
      ? `FILE_TIMEOUT po ${FAILO_RIBA_MS} ms`
      : `exit ${rezultatas.status ?? "signal"}`;
  console.log(`───── ${vardas} (${busenosTekstas}) ─────`);
  process.stdout.write(tap);

  /**
   * ⚠️ NUTRAUKTAS FAILAS VIRSTA NENULINE BENDRA BŪSENA. Nutraukus signalu
   * `rezultatas.status` yra `null`, o `null !== 0`, tad `?? 1` duoda 1. CI apskaitos
   * keisti nereikėjo: žingsnis krenta per exit kodą (`ci.yml:213`), o
   * `verify-postgres-suite-ran.mjs` prie to prideda per-failo įrodymą.
   */
  if (rezultatas.status !== 0) bendraBusena = rezultatas.status ?? 1;
  if (rezultatas.status !== 0) bendraBusena = rezultatas.status ?? 1;
}

console.log(`\nTAP išsaugotas: ${tapDir} (${files.length} failų)`);
process.exit(bendraBusena);
