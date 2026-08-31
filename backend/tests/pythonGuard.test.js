const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

/**
 * `pythonGuard` ELGSENOS TESTAI (#202).
 *
 * ⚠️ GUARD ČIA NEIMPORTUOJAMAS. Jis meta klaidą MODULIO ĮKĖLIMO metu, tad
 * `require()` šiame faile susietų testų likimą su aplinka, kurią jie ir turi
 * tirti. Visi keturi atvejai vykdomi ATSKIRUOSE procesuose.
 *
 * ⚠️ IZOLIACIJA - NE PATOGUMAS, O REIKALAVIMAS. `process.env.REQUIRE_PYTHON`,
 * `PATH` ir module cache yra proceso globalai; pakeisti juos vietoje reikštų,
 * kad kiti to paties `node --test` proceso failai gautų svetimą aplinką
 * (AGENTS.md §9.3).
 */

const GUARD = path.join(__dirname, "helpers", "pythonGuard.js");

/**
 * Paleidžia vaiką, kuris įkelia guard'ą ir atspausdina jo sprendimą.
 *
 * ⚠️ `process.execPath`, NE komanda `node`.
 *
 * „Python nėra" atvejis imituojamas išvalant `PATH`. Paleidus vaiką per komandą
 * `node`, tuščias `PATH` reikštų, kad nerandamas pats NODE - testas praeitų dėl
 * visiškai kitos priežasties ir nieko neįrodytų apie python3.
 *
 * ⚠️ APLINKA SUDAROMA SĄMONINGAI, ne `{}` plius du raktai: vaikui reikia ir
 * `HOME`, ir sistemos kintamųjų. Keičiami TIK tie, kurie tiriami.
 */
function paleisti({ pythonYra, reikalaujama }) {
  const env = { ...process.env };

  delete env.REQUIRE_PYTHON;
  if (reikalaujama) env.REQUIRE_PYTHON = "1";

  /**
   * ⚠️ ABI PUSĖS HERMETIŠKOS - IR „YRA", IR „NĖRA".
   *
   * Pirmoji versija `python3` NEBUVIMĄ imitavo (tuščias `PATH`), o BUVIMĄ
   * paveldėjo iš aplinkos. Asimetrija nematoma mašinoje, kurioje Python yra, bet
   * mašinoje be jo teigiami atvejai KRISDAVO - t. y. guard'o testai padarydavo
   * visą suitę priklausomą nuo `python3`, nors #202 principas priešingas:
   * lokaliai be `REQUIRE_PYTHON` Python neturintys testai lieka teisėtai `skip`.
   *
   * Todėl `PATH` visada rodo į laikiną katalogą: teigiamiems atvejams jame
   * padedamas `python3` shim'as, neigiamiems jis lieka tuščias. Tikrinamas
   * guard'o SPRENDIMAS, ne hosto konfigūracija.
   *
   * `/bin/sh`, kurį `execSync` paleidžia absoliučiu keliu, veikia abiem atvejais.
   */
  const laikinas = fs.mkdtempSync(path.join(os.tmpdir(), "stenograma-python-"));
  env.PATH = laikinas;

  if (pythonYra) {
    const shim = path.join(laikinas, "python3");
    fs.writeFileSync(shim, '#!/bin/sh\necho "Python 3.11.0"\n');
    fs.chmodSync(shim, 0o755);
  }

  try {
    return spawnSync(
      process.execPath,
      [
        "-e",
        `const g = require(${JSON.stringify(GUARD)});` +
          `console.log(JSON.stringify({ hasPython: g.hasPython, skip: g.skipWithoutPython() }));`,
      ],
      { env, encoding: "utf8" }
    );
  } finally {
    fs.rmSync(laikinas, { recursive: true, force: true });
  }
}

/* ── 1. python3 YRA · REQUIRE_PYTHON nenustatytas → vykdyti ──────────────── */

test("#202 GUARD: python3 yra, REQUIRE_PYTHON nenustatytas - testai VYKDOMI", () => {
  const r = paleisti({ pythonYra: true, reikalaujama: false });

  assert.equal(r.status, 0, `guard neturi mesti klaidos: ${r.stderr}`);

  const { hasPython, skip } = JSON.parse(r.stdout);
  assert.equal(hasPython, true);
  assert.equal(skip, false, "`false` reiškia „vykdyti“");
});

/* ── 2. python3 YRA · REQUIRE_PYTHON=1 → vykdyti ─────────────────────────── */

test("#202 GUARD: python3 yra, REQUIRE_PYTHON=1 - testai VYKDOMI, be klaidos", () => {
  const r = paleisti({ pythonYra: true, reikalaujama: true });

  assert.equal(r.status, 0, `su esamu python3 vėliava neturi nieko keisti: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).skip, false);
});

/* ── 3. python3 NĖRA · REQUIRE_PYTHON nenustatytas → skip su priežastimi ─── */

test("#202 GUARD: python3 nėra, REQUIRE_PYTHON nenustatytas - SKIP su aiškia priežastimi", () => {
  const r = paleisti({ pythonYra: false, reikalaujama: false });

  assert.equal(r.status, 0, `be vėliavos guard neturi kristi: ${r.stderr}`);

  const { hasPython, skip } = JSON.parse(r.stdout);
  assert.equal(hasPython, false, "tuščiame PATH kataloge python3 neturi būti randamas");
  assert.equal(typeof skip, "string", "praleidimo priežastis privalo būti tekstas");
  assert.match(skip, /python3/, "priežastis turi įvardyti, KO trūksta");
  assert.match(skip, /REQUIRE_PYTHON/, "ir kaip praleidimą paversti klaida");
});

/* ── 4. python3 NĖRA · REQUIRE_PYTHON=1 → hard fail su aiškia klaida ─────── */

test("#202 GUARD: python3 nėra, REQUIRE_PYTHON=1 - HARD FAIL su priskiriama klaida", () => {
  /**
   * ⚠️ TIKRINAMAS TEKSTAS, NE VIEN NE-NULINIS EXIT KODAS.
   *
   * Generinis `ENOENT`, `TypeError` ar child-process stack trace irgi duotų
   * ne-nulinį kodą, bet nepasakytų, KAS neveikia. Klaida privalo įvardyti
   * `REQUIRE_PYTHON=1`, `python3` ir kad tai privalomas prerequisite - kitaip
   * gedimas atrodys kaip nesusijęs rinkinio lūžis.
   */
  const r = paleisti({ pythonYra: false, reikalaujama: true });

  assert.notEqual(r.status, 0, "guard PRIVALO kristi");

  const klaida = `${r.stderr}`;
  assert.match(klaida, /REQUIRE_PYTHON=1/, "klaida turi įvardyti vėliavą");
  assert.match(klaida, /python3/, "ir trūkstamą įrankį");
  assert.match(klaida, /prerequisite/i, "ir kad tai privalomas testų prerequisite");
});

/* ── 5. VIENAS AUTORITETAS (tripwire) ───────────────────────────────────── */

test("#202 VIENAS AUTORITETAS: python3 detekcijos nėra už guard'o ribų", () => {
  /**
   * ⚠️ ŠABLONAS SĄMONINGAI PLATESNIS NEI `python3 --version`.
   *
   * Antra detekcija, parašyta kiek kitaip (`spawnSync("python3", ["-V"])`,
   * `execFileSync("python3", ...)`), pro siaurą šabloną prasmuktų - ta pati
   * klasė kaip skeneris, ieškantis `.test.jsx` ir praleidžiantis `.test.js`.
   * Todėl gaudomas BET KOKS proceso paleidimas su `python`/`python3`.
   *
   * Dvi detekcijos yra defektas, ne trijų eilučių dubliavimas: pasikeitus
   * taisyklei vienoje vietoje, kita tyliai lieka su sena.
   */
  const KELIAS = /(exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(\s*["'`][^"'`]*python3?\b/;

  const pažeidimai = [];

  for (const failas of fs.readdirSync(__dirname)) {
    if (!failas.endsWith(".test.js")) continue;
    if (failas === path.basename(__filename)) continue;

    const eilutes = fs.readFileSync(path.join(__dirname, failas), "utf8").split("\n");

    eilutes.forEach((e, i) => {
      if (KELIAS.test(e)) pažeidimai.push(`${failas}:${i + 1}: ${e.trim()}`);
    });
  }

  assert.deepEqual(
    pažeidimai,
    [],
    "python3 prieinamumą sprendžia TIK `helpers/pythonGuard.js`:\n" + pažeidimai.join("\n")
  );
});

/* ── 6. SAVIPATIKRA: ar tripwire apskritai ką nors gaudo ─────────────────── */

test("#202 TRIPWIRE SAVIPATIKRA: šablonas atpažįsta ir kitaip užrašytą detekciją", () => {
  /**
   * Patikra, kuri niekada nieko nerado, neatskiriama nuo neveikiančios.
   * Tikrinamos ir platesnės formos, kurių siauras `python3 --version` šablonas
   * nepagautų.
   */
  const KELIAS = /(exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(\s*["'`][^"'`]*python3?\b/;

  const turiPagauti = [
    'execSync("python3 --version", { stdio: "ignore" });',
    'spawnSync("python3", ["-V"]);',
    "execFileSync('python', ['--version']);",
    'const r = spawn(`python3`);',
  ];

  for (const e of turiPagauti) {
    assert.ok(KELIAS.test(e), `šablonas privalo pagauti: ${e}`);
  }

  const neturiPagauti = [
    'const DELAY_SCRIPT = path.join(__dirname, "fixtures", "mock_faster_whisper_delay.py");',
    'assert.match(err.message, /ar Python įdiegtas/);',
    'const provider = new Provider({ pythonBin: "/neegzistuoja/python3" });',
  ];

  for (const e of neturiPagauti) {
    assert.ok(!KELIAS.test(e), `šablonas NETURI gaudyti: ${e}`);
  }
});
