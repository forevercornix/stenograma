const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");

/**
 * IŠTRINTŲ TESTŲ SARGO ELGSENOS TESTAI (#237).
 *
 * ⚠️ FIXTURES HERMETIŠKOS - TAI REIKALAVIMAS, NE PATOGUMAS.
 *
 * #202 sargo testai `python3` BUVIMĄ paveldėjo iš mašinos, o NEBUVIMĄ imitavo.
 * Asimetrija nematoma ten, kur Python yra, bet mašinoje be jo krisdavo VISA
 * suitė - t. y. sargo testai padarė repo priklausomą nuo aplinkos, kurią pats
 * sargas ir turėjo valdyti. Rado tik išorinė peržiūra.
 *
 * Todėl kiekvienas scenarijus čia susikuria SAVO git repozitoriją laikiname
 * kataloge:
 *
 *   - `HOME`, `GIT_CONFIG_GLOBAL` ir `GIT_CONFIG_SYSTEM` nukreipiami taip, kad
 *     hosto git konfigūracija neturėtų jokios įtakos;
 *   - `user.name`/`user.email`/`commit.gpgsign` perduodami per `-c`, tad
 *     mašina be `~/.gitconfig` veikia lygiai taip pat;
 *   - `GITHUB_BASE_REF` iš aplinkos ŠALINAMAS - kitaip tikras CI paleidimas
 *     nutekintų savo bazę į fixture ir testas tikrintų ne tai, ką skelbia;
 *   - jokios priklausomybės nuo repozitorijos istorijos ar checkout gylio.
 *
 * `git` PRIVALO būti - tai kietoji viso checkout'o priklausomybė. Jo nebuvimas
 * duoda GARSIĄ klaidą, ne tylų `skip`: tylus praleidimas čia būtų tas pats
 * defektas, kurį sargas ir taiso.
 *
 * ── Ką šis failas dengia be scenarijų ─────────────────────────────────────
 *
 * Tris teiginius apie REPOZITORIJĄ, ne apie fixture:
 *   1. sargas klasifikuoja KIEKVIENĄ repo testų failą (skenavimo aprėptis);
 *   2. lekseris nesutrinka nė viename repo faile (kryžminė patikra);
 *   3. sargas įjungtas į `ci.yml` ŽINGSNIO apimtimi, o ne „kažkur faile".
 */

const SARGAS = path.join(__dirname, "..", "scripts", "check-deleted-tests.mjs");
const REPO = path.join(__dirname, "..", "..");
const CI = path.join(REPO, ".github", "workflows", "ci.yml");

/* ══════════════════════════════════════════════════════════════════════════
 * FIXTURE INFRASTRUKTŪRA
 * ══════════════════════════════════════════════════════════════════════════ */

const GIT_C = [
  "-c", "user.email=sargas@testas.invalid",
  "-c", "user.name=Sargo testas",
  "-c", "commit.gpgsign=false",
  "-c", "init.defaultBranch=main",
];

/** Aplinka be hosto git konfigūracijos ir be CI kintamųjų. */
function svariAplinka(dir) {
  const env = { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  delete env.GITHUB_BASE_REF;
  delete env.GITHUB_HEAD_REF;
  return env;
}

function gitas(dir, args) {
  const r = spawnSync("git", [...GIT_C, ...args], { cwd: dir, encoding: "utf8", env: svariAplinka(dir) });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} krito (${r.status}):\n${r.stderr || r.error?.message}`);
  }
  return r.stdout;
}

function rasyti(dir, failai) {
  for (const [kelias, turinys] of Object.entries(failai)) {
    const pilnas = path.join(dir, kelias);
    if (turinys === null) {
      fs.rmSync(pilnas, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(pilnas), { recursive: true });
    fs.writeFileSync(pilnas, turinys);
  }
}

/** `test("a")\ntest("b")...` - trumpiklis fixture turiniui. */
function testai(...pavadinimai) {
  return `${pavadinimai.map((p) => `test(${JSON.stringify(p)}, () => {});`).join("\n")}\n`;
}

/**
 * Sukuria repozitoriją: `main` = bazė, `darbas` = head.
 *
 * `commitai` - masyvas `{ failai, zinute }`; jų daugiau nei vienas reikalingas
 * įrodyti, kad bazė imama iš `merge-base`, o ne iš `HEAD^`.
 */
function scenarijus(baze, commitai) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stenograma-237-"));

  gitas(dir, ["init", "-q"]);
  rasyti(dir, baze);
  gitas(dir, ["add", "-A"]);
  gitas(dir, ["commit", "-q", "-m", "bazė"]);
  gitas(dir, ["checkout", "-q", "-b", "darbas"]);

  for (const { failai, zinute } of commitai) {
    rasyti(dir, failai);
    gitas(dir, ["add", "-A"]);
    gitas(dir, ["commit", "-q", "--allow-empty", "-m", zinute]);
  }

  return dir;
}

function paleisti(dir, args = ["--base", "main"]) {
  const r = spawnSync(process.execPath, [SARGAS, "--repo", dir, ...args], {
    encoding: "utf8",
    env: svariAplinka(dir),
  });
  return { kodas: r.status, isvestis: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Paleidžia scenarijų ir garantuotai sutvarko laikiną katalogą. */
function suScenarijumi(baze, commitai, tikrinimas, args) {
  const dir = scenarijus(baze, commitai);
  try {
    tikrinimas(paleisti(dir, args), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const A = "backend/tests/alfa.test.js";
const B = "backend/tests/beta.test.js";

/* ══════════════════════════════════════════════════════════════════════════
 * 0. PRIELAIDOS
 * ══════════════════════════════════════════════════════════════════════════ */

test("#237 PRIELAIDA: `git` yra - jo nebuvimas duoda GARSIĄ klaidą, ne tylų skip", () => {
  const r = spawnSync("git", ["--version"], { encoding: "utf8" });
  assert.equal(
    r.status,
    0,
    "šio failo testai matuoja git elgseną; tylus `skip` be git būtų padengimo iliuzija (AGENTS.md §9.1)"
  );
});

test("#237 SAVIPATIKRA vykdoma PRIEŠ repozitoriją ir yra atskirai paleidžiama", () => {
  const r = spawnSync(process.execPath, [SARGAS, "--self-test"], { encoding: "utf8" });

  assert.equal(r.status, 0, `savipatikra krito:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /Savipatikra: \d+ scenarij/, "savipatikra privalo pranešti apie save");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 1. PAŠALINIMO APTIKIMAS
 * ══════════════════════════════════════════════════════════════════════════ */

test("#237 DoD1: vieno testo pašalinimas be override SULAUŽO CI ir testas ĮVARDIJAMAS", () => {
  suScenarijumi(
    { [A]: testai("pirmas", "antras", "trecias") },
    [{ failai: { [A]: testai("pirmas", "trecias") }, zinute: "refaktoringas" }],
    ({ kodas, isvestis }) => {
      assert.equal(kodas, 1, `laukta exit 1, gauta ${kodas}:\n${isvestis}`);
      assert.match(isvestis, /TESTAI PAŠALINTI BE OVERRIDE/);
      assert.match(isvestis, /js:antras/, "pašalinto testo VARDAS privalo būti išvestyje");
      assert.match(isvestis, /alfa\.test\.js/, "privalo būti nurodytas bazės failas");
    }
  );
});

test("#237 DoD2: keli pašalinti - VIENA klaida su VISAIS vardais ir failais", () => {
  suScenarijumi(
    { [A]: testai("a1", "a2"), [B]: testai("b1", "b2") },
    [{ failai: { [A]: testai("a1"), [B]: testai("b1") }, zinute: "valymas" }],
    ({ kodas, isvestis }) => {
      assert.equal(kodas, 1);

      for (const vardas of ["js:a2", "js:b2"]) {
        assert.ok(isvestis.includes(vardas), `trūksta ${vardas}:\n${isvestis}`);
      }
      assert.match(isvestis, /alfa\.test\.js/);
      assert.match(isvestis, /beta\.test\.js/);

      /** „Viena klaida", ne po vieną kiekvienam: antraštė rodoma vieną kartą. */
      const antrasčių = isvestis.split("TESTAI PAŠALINTI BE OVERRIDE").length - 1;
      assert.equal(antrasčių, 1, "klaida privalo būti pranešta VIENĄ kartą su pilnu sąrašu");
      assert.match(isvestis, /PAŠALINTA ĮVARDYTŲ TESTŲ: 2/, "skaičius turi lydėti sąrašą, ne pakeisti jį");
    }
  );
});

test("#237 DoD6: `test(...)` -> `test.skip(...)` pranešamas kaip PAŠALINIMAS", () => {
  suScenarijumi(
    { [A]: testai("pirmas", "antras") },
    [
      {
        failai: { [A]: 'test("pirmas", () => {});\ntest.skip("antras", () => {});\n' },
        zinute: "laikinai išjungiam",
      },
    ],
    ({ kodas, isvestis }) => {
      assert.equal(kodas, 1, `\`.skip\` konversija privalo lūžti:\n${isvestis}`);
      assert.match(isvestis, /js:antras/);
    }
  );
});

test("#237 DoD14: VISIŠKAI ištrintas failas pagaunamas (bazės ∪ head sąjunga)", () => {
  /**
   * ⚠️ TAI ATVEJIS, KURĮ PRALEISTŲ SKENAVIMAS TIK PER CHECKOUT'Ą.
   *
   * Head'o medyje failo NEBĖRA, tad `fs.readdir`/`git ls-files` jo nemato.
   * Bazės pusė privalo ateiti iš `git ls-tree` + `git show`, kitaip ištrynus
   * visą failą sargas praneštų „viskas gerai".
   */
  suScenarijumi(
    { [A]: testai("a1", "a2"), [B]: testai("b1") },
    [{ failai: { [B]: null }, zinute: "nereikalingas failas" }],
    ({ kodas, isvestis }) => {
      assert.equal(kodas, 1, `ištrintas failas privalo lūžti:\n${isvestis}`);
      assert.match(isvestis, /js:b1/);
      assert.match(isvestis, /beta\.test\.js/);
    }
  );
});

test("#237: Python testo pašalinimas pagaunamas (`def test_*`)", () => {
  const PY = "whisper-server/test_serveris.py";

  suScenarijumi(
    { [PY]: "def test_pirmas(client):\n    assert True\n\ndef test_antras(client):\n    assert True\n" },
    [{ failai: { [PY]: "def test_pirmas(client):\n    assert True\n" }, zinute: "valymas" }],
    ({ kodas, isvestis }) => {
      assert.equal(kodas, 1, `Python pašalinimas privalo lūžti:\n${isvestis}`);
      assert.match(isvestis, /py:test_antras/);
    }
  );
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. KLAIDINGŲ TEIGINIŲ NEBUVIMAS
 * ══════════════════════════════════════════════════════════════════════════ */

test("#237: nepakitusi testų aibė PRAEINA", () => {
  suScenarijumi(
    { [A]: testai("pirmas", "antras") },
    [{ failai: { "backend/utils/kazkas.js": "module.exports = {};\n" }, zinute: "nesusijęs pakeitimas" }],
    ({ kodas, isvestis }) => {
      assert.equal(kodas, 0, `nepakitusi aibė NETURI lūžti:\n${isvestis}`);
      assert.match(isvestis, /Testų nepašalinta/);
    }
  );
});

test("#237 DoD4: failo pervadinimas NĖRA klaidingas masinis trynimas", () => {
  /**
   * ⚠️ ŠIS ATVEJIS IR YRA PRIEŽASTIS, KODĖL MULTIAIBĖ GLOBALI.
   *
   * Palyginimas per failą praneštų VISUS `alfa` testus kaip ištrintus, ir
   * kiekvienas rename PR reikalautų override. Įprastai naudojamas override
   * nieko nebegina - tai būdas, kuriuo toks sargas miršta.
   */
  const turinys = testai("pirmas", "antras", "trecias");

  suScenarijumi(
    { [A]: turinys },
    [{ failai: { [A]: null, [B]: turinys }, zinute: "pervadinimas" }],
    ({ kodas, isvestis }) => {
      assert.equal(kodas, 0, `pervadinimas NETURI lūžti:\n${isvestis}`);
    }
  );
});

test("#237 DoD4: nepakitusio testo PERKĖLIMAS tarp failų NĖRA pašalinimas", () => {
  suScenarijumi(
    { [A]: testai("lieka", "keliauja"), [B]: testai("b1") },
    [{ failai: { [A]: testai("lieka"), [B]: testai("b1", "keliauja") }, zinute: "perkėlimas" }],
    ({ kodas, isvestis }) => {
      assert.equal(kodas, 0, `perkėlimas NETURI lūžti:\n${isvestis}`);
    }
  );
});

test("#237 DoD7: du vienodo pavadinimo testai NESUPLAKAMI (multiaibė)", () => {
  /** Vienas iš dviejų pašalintas: aibė to nepamatytų, multiaibė mato. */
  suScenarijumi(
    { [A]: testai("tas pats"), [B]: testai("tas pats") },
    [{ failai: { [B]: "" }, zinute: "vieno iš dviejų šalinimas" }],
    ({ kodas, isvestis }) => {
      assert.equal(kodas, 1, `vienas iš dviejų vienodų privalo būti pastebėtas:\n${isvestis}`);
      assert.match(isvestis, /js:tas pats/);
    }
  );
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. BAZĖS NUSTATYMAS
 * ══════════════════════════════════════════════════════════════════════════ */

test("#237 DoD3: bazė imama iš `git merge-base`, o NE iš `HEAD^`", () => {
  /**
   * ⚠️ MUTACIJOS ĮRODYMAS.
   *
   * Trynimas įvyksta PIRMAME šakos commit'e, o po jo eina antras, testų
   * neliečiantis. `HEAD^` tada rodo į commit'ą, kuriame testo JAU nebėra, ir
   * prielaida „bazė = HEAD^" duotų ŽALIĄ rezultatą.
   *
   * Todėl šis testas krinta, jei kas nors pakeistų bazės nustatymą į `HEAD^`.
   */
  suScenarijumi(
    { [A]: testai("pirmas", "antras") },
    [
      { failai: { [A]: testai("pirmas") }, zinute: "trynimas PIRMAME commit'e" },
      { failai: { "README.md": "nesusiję\n" }, zinute: "antras commit'as be testų" },
    ],
    ({ kodas, isvestis }) => {
      assert.equal(kodas, 1, `merge-base bazė privalo matyti pirmą commit'ą:\n${isvestis}`);
      assert.match(isvestis, /js:antras/);
      assert.match(isvestis, /git merge-base/, "išvestis privalo įvardyti, kaip bazė gauta");
    }
  );
});

test("#237 DoD10: neišspręsta bazė - FAIL-CLOSED (exit 2), ne tylus praėjimas", () => {
  suScenarijumi(
    { [A]: testai("pirmas") },
    [{ failai: { [A]: "" }, zinute: "viską ištrinam" }],
    ({ kodas, isvestis }) => {
      assert.equal(kodas, 2, `neišspręsta bazė privalo duoti exit 2, gauta ${kodas}:\n${isvestis}`);
      assert.match(isvestis, /fail-closed/i);
      assert.match(isvestis, /fetch-depth/, "pranešimas privalo įvardyti seklaus checkout'o priežastį");
      assert.doesNotMatch(isvestis, /Testų nepašalinta/, "sargas NEGALI pranešti sėkmės neišsprendęs bazės");
    },
    ["--base", "nera-tokios-sakos"]
  );
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. OVERRIDE
 * ══════════════════════════════════════════════════════════════════════════ */

test("#237 DoD8/9: override su turininga priežastimi LEIDŽIA ir yra GARSIAI matomas", () => {
  suScenarijumi(
    { [A]: testai("pirmas", "antras") },
    [
      {
        failai: { [A]: testai("pirmas") },
        zinute: "test: kontrakto perrašymas\n\nTESTŲ ŠALINIMAS: testą pakeitė platesnis kontraktinis rinkinys",
      },
    ],
    ({ kodas, isvestis }) => {
      assert.equal(kodas, 0, `galiojantis override privalo leisti:\n${isvestis}`);

      assert.match(isvestis, /SARGAS PERRAŠYTAS/, "override privalo būti pažymėtas EKSPLICITIŠKAI");
      assert.match(isvestis, /platesnis kontraktinis rinkinys/, "priežastis privalo būti atkartota");
      assert.match(isvestis, /js:antras/, "pašalinti vardai privalo likti matomi IR su override");
      assert.match(isvestis, /alfa\.test\.js/, "paveikti failai privalo likti matomi");
    }
  );
});

test("#237 DoD16: override be turinio ATMETAMAS ir atmetimas paaiškinamas", () => {
  for (const bloga of ["", "   ", "...", "<priežastis>"]) {
    suScenarijumi(
      { [A]: testai("pirmas", "antras") },
      [{ failai: { [A]: testai("pirmas") }, zinute: `fix: kažkas\n\nTESTŲ ŠALINIMAS: ${bloga}` }],
      ({ kodas, isvestis }) => {
        assert.equal(kodas, 1, `override "${bloga}" NETURI būti priimtas:\n${isvestis}`);
        assert.doesNotMatch(isvestis, /SARGAS PERRAŠYTAS/);
        assert.match(isvestis, /override ATMESTAS/, `atmetimas privalo būti paaiškintas ("${bloga}")`);
      }
    );
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 5. NEATPAŽINTOS (RUNTIME SUDARYTOS) DEKLARACIJOS
 * ══════════════════════════════════════════════════════════════════════════ */

test("#237 DoD18: dingusi runtime sudaryta deklaracija - ATSKIRAS pranešimas, ne „nerastas vardas”", () => {
  /**
   * ⚠️ PRANEŠIMAS PRIVALO SKIRTIS NUO ĮVARDYTO PAŠALINIMO.
   *
   * Gavęs tokį patį tekstą, recenzentas ieškotų PAVADINIMO, kurio nėra - jis
   * sudaromas vykdymo metu. Todėl tikrinamas ne tik lūžimas, bet ir tai, kad
   * pranešimas paaiškina, kodėl vardo nebus.
   */
  const sablonai = "test(`a ${x}`, () => {});\ntest(`b ${y}`, () => {});\n";

  suScenarijumi(
    { [A]: sablonai },
    [{ failai: { [A]: "test(`a ${x}`, () => {});\n" }, zinute: "vieno scenarijaus šalinimas" }],
    ({ kodas, isvestis }) => {
      assert.equal(kodas, 1, `dingusi neatpažinta deklaracija privalo lūžti:\n${isvestis}`);

      assert.match(isvestis, /DINGO NEATPAŽINTŲ DEKLARACIJŲ: 1/);
      assert.match(isvestis, /VYKDYMO METU/, "pranešimas privalo paaiškinti, kodėl vardo nėra");
      assert.match(isvestis, /alfa\.test\.js: bazė 2 -> head 1/, "privalo rodyti per-failo pjūvį");
      assert.doesNotMatch(isvestis, /PAŠALINTA ĮVARDYTŲ TESTŲ/, "tai NE įvardytas pašalinimas");
    }
  );
});

test("#237: šabloninio pavadinimo pavertimas STATINIU - vienintelis teisėtas atvejis, paaiškintas išvestyje", () => {
  /**
   * ⚠️ FIXTURE, NE PASTABA.
   *
   * Tai VIENINTELIS teisėtas scenarijus, kur neatpažintų mažėja, o įvardytų
   * daugėja tiek pat. Be šio testo pirmas toks PR atrodytų kaip sargo gedimas,
   * ir kitas žmogus „pataisytų" veikiantį sargą.
   *
   * Elgesys pinamas SĄMONINGAI: sargas VIS TIEK praneša (fail-closed), bet
   * išvestis privalo pasakyti, kaip konversiją atskirti nuo trynimo, ir
   * pateikti skaičių, kurį galima palyginti.
   */
  suScenarijumi(
    { [A]: "test(`X ${a}`, () => {});\n" },
    [{ failai: { [A]: testai("X a") }, zinute: "pavadinimas paverstas statiniu" }],
    ({ kodas, isvestis }) => {
      assert.equal(kodas, 1, `konversija taip pat pranešama - fail-closed:\n${isvestis}`);

      assert.match(isvestis, /DINGO NEATPAŽINTŲ DEKLARACIJŲ: 1/);
      assert.doesNotMatch(isvestis, /PAŠALINTA ĮVARDYTŲ TESTŲ/, "joks įvardytas testas nedingo");

      assert.match(
        isvestis,
        /pavertimas\s+statiniu/,
        "išvestis privalo įvardyti konversiją kaip teisėtą paaiškinimą"
      );
      assert.match(
        isvestis,
        /pridėta naujų įvardytų identitetų: 1/,
        "recenzentui reikia skaičiaus, kurį galima palyginti su dingusiu"
      );
    }
  );
});

/* ══════════════════════════════════════════════════════════════════════════
 * 6. TEIGINIAI APIE REPOZITORIJĄ (ne apie fixture)
 * ══════════════════════════════════════════════════════════════════════════ */

/** Visi git sekami failai - `git ls-files`, tad `.gitignore` gerbiamas. */
function repoFailai() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean);
}

test("#237 DoD12/19: sargas klasifikuoja KIEKVIENĄ repo testų failą, visos keturios grupės netuščios", async () => {
  /**
   * ⚠️ NEPRIKLAUSOMAS, PLATESNIS ATPAŽINTUVAS.
   *
   * Kandidatu laikomas BET KOKS kodo failas, kurio vardas turi „test" arba
   * „spec". Tai sąmoningai platesnė taisyklė nei sargo `grupuoti()`: jei jos
   * sutaptų, testas tik pakartotų sargo prielaidą.
   *
   * Kiekviena išimtis įvardijama POIMENIUI. Naujas testų failo šablonas
   * (pvz. `*.test.ts`, naujas katalogas) be sargo atnaujinimo sulaužo šį testą,
   * o ne lieka tyliai neskenuojamas - #197 spraga buvo BŪTENT tokia.
   */
  const { grupuoti } = await import(`file://${SARGAS}`);

  const NE_TESTAI = new Set([
    /** Paleidiklis, ne testas. */
    "backend/scripts/run-tests.mjs",
    /** Pats sargas. */
    "backend/scripts/check-deleted-tests.mjs",
  ]);

  const KODO_PLETINYS = /\.(?:js|jsx|ts|tsx|mjs|cjs|py)$/;

  /**
   * ⚠️ ŽODŽIO RIBA BŪTINA, ir tai rasta realiai.
   *
   * Be jos `backend/utils/costEstimate.js` tampa „kandidatu" - `cosTESTimate`
   * turi poeilutę „test". Tai tiksliai ta klaidingų teiginių klasė, dėl kurios
   * #197 skeneris davė 55 melagingus radinius: pasitikinti, neteisinga išvestis
   * iš pernelyg laisvo šablono.
   */
  const PANASU_I_TESTA = /(?:^|[^A-Za-z])(?:tests?|specs?)(?:[^A-Za-z]|$)/i;

  const nepadengti = [];
  const grupes = new Map();

  for (const failas of repoFailai()) {
    const vardas = failas.split("/").pop();
    if (!KODO_PLETINYS.test(vardas)) continue;
    if (!PANASU_I_TESTA.test(vardas)) continue;
    if (NE_TESTAI.has(failas)) continue;

    const g = grupuoti(failas);
    if (!g) {
      nepadengti.push(failas);
      continue;
    }
    grupes.set(g.grupe, (grupes.get(g.grupe) ?? 0) + 1);
  }

  assert.deepEqual(
    nepadengti,
    [],
    "šie failai atrodo kaip testai, bet sargas jų NESKENUOJA - tylus dalinis skenavimas yra #237 gedimo režimas"
  );

  /** Keturi runneriai, kiekvienas su deletable testais - #237 „Coverage of test file shapes". */
  for (const grupe of [
    "node --test · backend",
    "Vitest · frontend",
    "Playwright · frontend/e2e",
    "pytest · pyannote-server",
    "pytest · whisper-server",
  ]) {
    assert.ok(
      (grupes.get(grupe) ?? 0) > 0,
      `grupė "${grupe}" tuščia - arba dingo testai, arba sargas nustojo ją matyti`
    );
  }
});

test("#237 DoD17: lekseris nesutrinka nė viename repo testų faile (kryžminė patikra)", async () => {
  /**
   * ⚠️ TIKRINAMOS DVI KRYPTYS.
   *
   * 1. Nė vienas failas neduoda parsinimo klaidos - t. y. lekseris tikrai
   *    apdoroja visas repo formas (ekranuotos kabutės, daugiaeiliai kvietimai,
   *    regex su kabutėmis viduje, lietuviški identifikatoriai).
   * 2. Lekserio rastų deklaracijų skaičius SUTAMPA su nepriklausomu žaliu
   *    eilutiniu šablonu. Nesutapimas reikštų desinchronizaciją - tylią,
   *    pasitikinčią, neteisingą išvestį.
   *
   * IŠIMTIS: šis failas ir pats sargas turi `test(` eilučių LITERALUOSE
   * (fixtures). Ten žalias šablonas skaičiuoja daugiau nei lekseris, ir tai
   * teisinga - būtent tokių eilučių lekseris ir NETURI užskaityti.
   */
  const { grupuoti, skenuoti } = await import(`file://${SARGAS}`);

  const SU_FIXTURE_LITERALAIS = new Set(["backend/tests/deletedTestsGuard.test.js"]);

  const ZALIAS_JS = /^[ \t]*(?:test|it)(?:\.(?:skip|only|todo))?[ \t]*\(/gm;
  const ZALIAS_PY = /^[ \t]*(?:async[ \t]+)?def[ \t]+test_/gm;

  const klaidos = [];
  const nesutapimai = [];
  let failuTikrinta = 0;

  for (const failas of repoFailai()) {
    const g = grupuoti(failas);
    if (!g) continue;

    failuTikrinta += 1;
    const src = fs.readFileSync(path.join(REPO, failas), "utf8");
    const r = skenuoti(failas, src);

    if (r.klaida) {
      klaidos.push(`${failas}: ${r.klaida}`);
      continue;
    }
    if (SU_FIXTURE_LITERALAIS.has(failas)) continue;

    const sablonas = g.kalba === "py" ? ZALIAS_PY : ZALIAS_JS;
    sablonas.lastIndex = 0;
    let zalias = 0;
    while (sablonas.exec(src) !== null) zalias += 1;

    const lekseris = r.deklaracijos.length + r.neatpazinti;
    if (lekseris !== zalias) nesutapimai.push(`${failas}: lekseris ${lekseris} vs eilutinis ${zalias}`);
  }

  assert.ok(failuTikrinta > 100, `tikrinta tik ${failuTikrinta} failų - skenavimas įtartinai siauras`);
  assert.deepEqual(klaidos, [], "lekseris neapdoroja repo esamų formų");
  assert.deepEqual(nesutapimai, [], "lekseris ir eilutinis šablonas nesutampa - galima desinchronizacija");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 7. CI ĮJUNGIMAS - ŽINGSNIO APIMTIMI
 * ══════════════════════════════════════════════════════════════════════════ */

/** Job'o tekstas: nuo jo antraštės iki kitos dviejų tarpų įtraukos antraštės. */
function jobas(ci, vardas) {
  const eilutes = ci.split("\n");
  const nuo = eilutes.findIndex((e) => e === `  ${vardas}:`);
  if (nuo === -1) return null;

  let iki = eilutes.length;
  for (let i = nuo + 1; i < eilutes.length; i += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(eilutes[i])) {
      iki = i;
      break;
    }
  }
  return eilutes.slice(nuo, iki).join("\n");
}

/** Žingsniai atskirai: `      - ` yra žingsnio pradžios įtrauka. */
function zingsniai(jobasTekstas) {
  return jobasTekstas.split(/\n {6}- /).slice(1);
}

test("#237 DoD20: sargas įjungtas į `ci.yml` ŽINGSNIO apimtimi, ne „kažkur faile”", () => {
  /**
   * ⚠️ #202 PAMOKA, PAKARTOTA ČIA SĄMONINGAI.
   *
   * Ten testas įrodinėjo, kad vėliava YRA `ci.yml`. Perkėlus ją į nesusijusį
   * job'ą testas liko ŽALIAS, nors vėliava nebegynė nieko. „Yra kažkur" nėra
   * įrodymas, kad „veikia ten, kur reikia".
   *
   * Todėl visi trys teiginiai siejami su TUO PAČIU job'u:
   *   1. job'as egzistuoja;
   *   2. jo žingsnis paleidžia BŪTENT sargo skriptą;
   *   3. TO PATIES job'o checkout gilinamas - be `fetch-depth: 0`
   *      `git merge-base` krinta, ir fail-closed sargas sulaužytų KIEKVIENĄ PR.
   */
  const ci = fs.readFileSync(CI, "utf8");
  const tekstas = jobas(ci, "deleted-tests");

  assert.ok(tekstas, "`ci.yml` neturi job'o `deleted-tests` - sargas nepaleidžiamas PR metu");

  const ž = zingsniai(tekstas);

  assert.ok(
    ž.some((z) => z.includes("check-deleted-tests.mjs")),
    "nė vienas `deleted-tests` job'o žingsnis nepaleidžia sargo skripto"
  );

  assert.ok(
    ž.some((z) => /uses:\s*actions\/checkout/.test(z) && /fetch-depth:\s*0/.test(z)),
    "`deleted-tests` checkout privalo turėti `fetch-depth: 0` TAME PAČIAME žingsnyje - " +
      "be istorijos `git merge-base` krinta ir sargas sulaužo kiekvieną PR"
  );

  /** Politikos reikalavimai naujam job'ui (`scripts/check-workflow-policy.mjs`). */
  assert.match(tekstas, /timeout-minutes:/, "job'as be `timeout-minutes` kabotų iki 6 val. numatytosios ribos");
  assert.ok(
    ž.some((z) => /uses:\s*actions\/checkout/.test(z) && /persist-credentials:\s*false/.test(z)),
    "checkout be `persist-credentials: false` paliktų `GITHUB_TOKEN` git konfigūracijoje"
  );
});

test("#237: sargas paleidžiamas per `npm run`, ne tik tiesioginiu keliu", () => {
  /**
   * Skriptas be `package.json` įrašo yra skriptas, kurio niekas nekviečia -
   * ta pati klasė kaip `verify-postgres-suite-ran.mjs` iki #231.
   */
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

  const irasas = Object.entries(pkg.scripts ?? {}).find(([, k]) => k.includes("check-deleted-tests.mjs"));

  assert.ok(irasas, "`backend/package.json` neturi skripto, paleidžiančio `check-deleted-tests.mjs`");
});
