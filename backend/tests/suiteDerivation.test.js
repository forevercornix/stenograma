const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { suites, isvestiPostgresRinkini, importuotiModuliai } = require("./suites");

/**
 * PostgreSQL RINKINIO IŠVEDIMAS IR VYKDYMO ĮRODYMAS (#155, 7.4f / #231).
 *
 * ⚠️ RANKINIS SĄRAŠAS ČIA BUVO NEMATOMA SPRAGA.
 *
 * Naujas integracinis testas, kurio kas nors nepridėtų ranka, niekada nebūtų
 * paleistas su tikra DB. Ir tai NEBŪTŲ pastebėta: failas priklauso `privacy` ar
 * `security` rinkiniui, tad manifesto pilnumo patikra tyli, `npm test` žalias, o
 * vienintelis trūkstamas dalykas - vykdymas prieš PostgreSQL.
 */

const TESTU_KATALOGAS = __dirname;

function failoTurinys(vardas) {
  return fs.readFileSync(path.join(TESTU_KATALOGAS, vardas), "utf8");
}

function visiTestuFailai() {
  return fs.readdirSync(TESTU_KATALOGAS).filter((f) => f.endsWith(".test.js"));
}

test("IŠVEDIMAS: rinkinys sutampa su faktine `postgresGuard` priklausomybe", () => {
  /**
   * Round-trip: išvedimo funkcija ir nepriklausomas skenavimas privalo duoti tą
   * pačią aibę. Skirtumas reikštų, kad išvedimas sugedo (pvz. pasikeitė importo
   * forma), o rinkinys tyliai susitraukė.
   */
  const nepriklausomai = visiTestuFailai()
    .filter((f) => importuotiModuliai(failoTurinys(f)).some((k) => k.endsWith("postgresGuard")))
    .map((f) => f.replace(/\.test\.js$/, ""))
    .sort();

  assert.deepEqual(suites.postgres, nepriklausomai, "išvestas rinkinys išsiskyrė su realybe");
  assert.deepEqual(isvestiPostgresRinkini(), nepriklausomai);
  assert.ok(nepriklausomai.length >= 9, "rinkinys negali tyliai susitraukti");
});

test("SKENAVIMAS: komentaro ir literalo atpažinimas - teisinga TVARKA", () => {
  /**
   * ⚠️ ŠIS TESTAS EGZISTUOJA DĖL DVIEJŲ SKIRTINGŲ KLAIDŲ.
   *
   * Pirma versija kartojo tą patį regex, kurį tikrino - tautologija. Antra
   * versija regex'ą pakeitė grandine „nuimk komentarus, tada literalus", ir ta
   * TVARKA neteisinga iš principo: komentaro ir literalo atpažinimas yra
   * tarpusavyje priklausomas (#233 Codex raundas 2, #1).
   *
   * Abi kryptys buvo REALIOS, ne teorinės:
   *   - eilutė `'// require("…postgresGuard")'` įtraukė `suiteDerivation` į
   *     postgres rinkinį - failas pateko ten dėl savo paties testo duomenų;
   *   - `const marker = '//'; require('…postgresGuard')` prarastų TIKRĄ importą,
   *     ir realus PostgreSQL testas tyliai iškristų iš CI.
   *
   * Todėl tikrinamos abi kryptys, ir sintetiniai atvejai yra tie patys, kurie
   * skenerį klaidino.
   */
  const atvejai = [
    /** ── TURI būti rasta ─────────────────────────────────────────────────── */
    ["paprastas importas", 'require("./helpers/postgresGuard");', true],
    ["tarpai aplink", 'require ( "./helpers/postgresGuard" );', true],
    ["viengubos kabutės", "require('../helpers/postgresGuard')", true],
    ["destrukturizuotas", 'const { a } = require("./helpers/postgresGuard");', true],
    ["po eilutės su `//` VIDUJE", "const marker = '//'; require('./helpers/postgresGuard');", true],
    ["po regex su kabutėmis", 'const re = /["\']/; require("./helpers/postgresGuard");', true],
    ["po dalybos", "const p = a / b; require(\"./helpers/postgresGuard\");", true],
    ["šabloninė eilutė", "require(`./helpers/postgresGuard`)", true],

    /** ── NEGALI būti rasta ───────────────────────────────────────────────── */
    ["eilutės komentaras", '// require("./helpers/postgresGuard");', false],
    ["blokinis komentaras", '/* require("./helpers/postgresGuard"); */', false],
    ["JSDoc paminėjimas", '/**\n * Naudokite require("./postgresGuard").\n */', false],
    ["komentaras EILUTĖS viduje", 'const t = \'// require("./helpers/postgresGuard");\';', false],
    ["importas eilutės viduje", 'const t = "require(\'./helpers/postgresGuard\')";', false],
    ["svetimas modulis", 'require("./helpers/redisGuard");', false],
  ];

  for (const [pavadinimas, saltinis, laukiama] of atvejai) {
    const rasta = importuotiModuliai(saltinis).some((k) => k.endsWith("postgresGuard"));
    assert.equal(rasta, laukiama, `${pavadinimas}: skeneris atsakė neteisingai`);
  }

  /** URL eilutėje neturi nuplėšti tos pačios eilutės kodo. */
  assert.deepEqual(
    importuotiModuliai('const u = "https://pavyzdys.lt"; require("./helpers/postgresGuard");'),
    ["./helpers/postgresGuard"],
    "`//` eilutės viduje nėra komentaras - importas po jos privalo išlikti"
  );
});

test("SKENAVIMAS: šis failas PATS neturi patekti į postgres rinkinį", () => {
  /**
   * ⚠️ REGRESIJOS SARGAS TIKRAM ĮVYKIUI.
   *
   * `2f1f9c3` metu šis failas į `suites.postgres` PATEKO - jame yra sintetinių
   * eilučių su `postgresGuard`, o skeneris jas palaikė importais. Pasekmė nėra
   * kosmetinė: failas atsidurtų postgres CI žingsnyje, o rinkinys, kurio narystė
   * turi būti išvedama iš tikros priklausomybės, imtų remtis testo duomenimis.
   */
  assert.ok(
    !suites.postgres.includes("suiteDerivation"),
    "šiame faile tikro `postgresGuard` importo nėra - rinkinyje jo būti negali"
  );

  assert.ok(
    !importuotiModuliai(failoTurinys("suiteDerivation.test.js")).some((k) =>
      k.endsWith("postgresGuard")
    ),
    "skeneris šiame faile importo rasti negali"
  );
});

test("IŠVEDIMAS: `suites.js` nebeturi rankinio postgres sąrašo", () => {
  /**
   * ⚠️ TRIPWIRE (AGENTS.md §9.2). Grąžinus literalų masyvą, išvedimas taptų
   * dekoracija: rinkinys vėl priklausytų nuo to, ką kas nors prisiminė įrašyti.
   */
  const src = fs.readFileSync(path.join(TESTU_KATALOGAS, "suites.js"), "utf8");

  assert.match(src, /const postgres = isvestiPostgresRinkini\(\)/, "rinkinys privalo būti išvedamas");

  /**
   * ⚠️ IR SKENERIS. Grįžus prie neapdoroto teksto regex'o, elgesio testas
   * aukščiau liktų žalias - jis tikrina `importuotiModuliai()`, ne iškvietimo
   * vietą. Ši eilutė yra tripwire (§9.2), ne elgesio įrodymas.
   */
  assert.match(
    src,
    /importuotiModuliai\(turinys\)/,
    "išvedimas privalo eiti per skenerį, ne per neapdorotą tekstą"
  );
  assert.doesNotMatch(
    src,
    /const postgres = \[/,
    "rankinis postgres masyvas grąžintas - išvedimas nebegalioja"
  );
});

test("APSAUGA: kiekvienas `pg` naudojantis testas yra postgres rinkinyje", () => {
  /**
   * ⚠️ SAUGO NUO NAUJO PG TESTO, PAMIRŠUSIO GUARD'Ą.
   *
   * Išvedimo kriterijus yra `postgresGuard` importas. Testas, kuris jungiasi
   * prie DB, bet guard'o nepasiima, iškristų iš rinkinio - ir dar blogiau, be
   * guard'o jis su `REQUIRE_POSTGRES=1` net nepraneštų apie trūkstamą
   * `DATABASE_URL`.
   *
   * Išimtys privalo turėti PRIEŽASTĮ. Tuščias sąrašas būtų geriau, bet
   * `new Pool()` be prisijungimo yra teisėtas naudojimas.
   */
  const ISIMTYS = [
    {
      failas: "auditStoreFields.test.js",
      kodel:
        "kuria `new Pool()` tik tam, kad patikrintų `error` klausytojo registraciją " +
        "ir pool'o nustatymus - prie DB nesijungia",
    },
    {
      failas: "drRestorePreconditions.test.js",
      kodel:
        "jungiasi prie SĄMONINGAI nepasiekiamo adreso (127.0.0.1:1): serverio jam " +
        "NEREIKIA, o ryšio gedimas ir yra tikrinamas rezultatas - kiekvienas DR sargas " +
        "privalo kristi dėl ryšio, ne dėl konfigūracijos (#250). Įtraukus jį į " +
        "`postgres` rinkinį patikra vyktų tik CI'uje, t. y. kaip tik ten, kur ji " +
        "turi būti nebereikalinga",
    },
  ];

  const naudojaPg = visiTestuFailai().filter((f) =>
    importuotiModuliai(failoTurinys(f)).includes("pg")
  );

  for (const failas of naudojaPg) {
    const vardas = failas.replace(/\.test\.js$/, "");
    if (suites.postgres.includes(vardas)) continue;

    const isimtis = ISIMTYS.find((i) => i.failas === failas);
    assert.ok(
      isimtis,
      `${failas} naudoja \`pg\`, bet nėra postgres rinkinyje. Pridėkite ` +
        "`postgresGuard` importą arba įrašykite išimtį su priežastimi."
    );
    assert.ok(isimtis.kodel.length > 20, `${failas}: išimtis be priežasties`);
  }

  /** Ir atvirkščiai: išimtis, kurios failo nebėra, yra pasenusi. */
  for (const isimtis of ISIMTYS) {
    assert.ok(
      naudojaPg.includes(isimtis.failas),
      `${isimtis.failas} išimtyje, bet \`pg\` nebenaudoja - įrašą pašalinkite`
    );
  }
});

const SKRIPTAS = path.join(TESTU_KATALOGAS, "..", "scripts", "verify-postgres-suite-ran.mjs");
const PALEIDIKLIS = path.join(TESTU_KATALOGAS, "..", "scripts", "run-tests.mjs");

/** Laikinas katalogas su per-failo TAP; `turinys` - `{failoVardas: tapTekstas}`. */
function suTapKatalogu(turinys, veiksmas) {
  const katalogas = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "stenograma-pg-tap-"));
  try {
    for (const [vardas, tekstas] of Object.entries(turinys)) {
      fs.writeFileSync(path.join(katalogas, `${vardas}.tap`), tekstas, "utf8");
    }
    return veiksmas(katalogas);
  } finally {
    fs.rmSync(katalogas, { recursive: true, force: true });
  }
}

function paleistiTikrintuva(katalogas) {
  try {
    return { kodas: 0, isvestis: execFileSync("node", [SKRIPTAS, katalogas], { encoding: "utf8" }) };
  } catch (e) {
    return { kodas: e.status, isvestis: (e.stderr || "") + (e.stdout || "") };
  }
}

/** Sveikas TAP: keli įvykdyti testai, jokių praleidimų. */
const SVEIKAS_TAP = ["TAP version 13", "ok 1 - pirmas", "ok 2 - antras", "# pass 2"].join("\n");

function sveikasKatalogas(perrasymai = {}) {
  const turinys = {};
  for (const testas of suites.postgres) turinys[testas] = SVEIKAS_TAP;
  return { ...turinys, ...perrasymai };
}

test("VYKDYMO ĮRODYMAS: reikalaujama nepraleisto `ok` KIEKVIENAM rinkinio failui", () => {
  /**
   * ⚠️ TAI PAGRINDINĖ 7.4f CI GARANTIJA (#231, DoD 14).
   *
   * `test:postgres` grąžina 0 ir tada, kai kiekvienas testas praleido save dėl
   * trūkstamo `DATABASE_URL`. Tikrintuvas tokią būseną atmeta.
   *
   * ⚠️ KRITERIJUS YRA PER FAILĄ, IR TAI ESMINGA. Tarpinė versija tikrino tik
   * „rinkinyje yra bent vienas įvykdytas testas" - failas, nutilęs dėl klaidingo
   * importo, ją praeidavo, jei kiti sukasi. Per-failo TAP (`--tap-dir`) tą
   * spragą uždaro: atributika yra failo vardas, ne srauto turinys, tad ji
   * nepriklauso nuo Node versijos ar reporterio formato.
   *
   * ⚠️ JOKIO `RegExp` IŠ KINTAMŲJŲ (CodeQL). Failų vardai lyginami
   * `.includes()` - konstruoti šabloną iš vardo su `replace(/\./g, "\\.")`
   * reikštų nepilną ekranavimą, o čia jo apskritai nereikia.
   */

  /** ── Visi failai realiai įvykdyti: PRAEINA ─────────────────────────────── */
  const geras = suTapKatalogu(sveikasKatalogas(), paleistiTikrintuva);
  assert.equal(geras.kodas, 0, `sveikas rinkinys turi praeiti: ${geras.isvestis}`);
  assert.ok(geras.isvestis.includes("realiai įvykdyti"), geras.isvestis);

  /** ── Vieno failo TAP NĖRA: KRINTA ir ĮVARDIJA, kurio ───────────────────── */
  const dingesFailas = suites.postgres[0];
  const beFailo = sveikasKatalogas();
  delete beFailo[dingesFailas];

  const truksta = suTapKatalogu(beFailo, paleistiTikrintuva);
  assert.notEqual(truksta.kodas, 0, "nepaleistas failas NEGALI būti laikomas sėkme");
  assert.ok(
    truksta.isvestis.includes(dingesFailas),
    `pranešime turi būti įvardytas KURIS failas neįvykdytas: ${truksta.isvestis}`
  );
  assert.ok(truksta.isvestis.includes("NEBUVO paleistas"), truksta.isvestis);

  /** ── Vieno failo testai praleisti dėl DB: KRINTA ───────────────────────── */
  const praleistas = suites.postgres[suites.postgres.length - 1];
  const suPraleidimu = sveikasKatalogas({
    [praleistas]: ["TAP version 13", "ok 1 - testas # SKIP reikia DATABASE_URL su tikru Postgres"].join("\n"),
  });

  const suSkip = suTapKatalogu(suPraleidimu, paleistiTikrintuva);
  assert.notEqual(suSkip.kodas, 0, "net vieno failo praleidimas dėl DB reiškia neįvykdytą rinkinį");
  assert.ok(suSkip.isvestis.includes(praleistas), suSkip.isvestis);
  assert.ok(suSkip.isvestis.includes("DATABASE_URL"), "pranešime turi būti priežastis");

  /** ── Failas nulūžo importo metu (TAP be nė vieno `ok`): KRINTA ─────────── */
  const nulužes = suTapKatalogu(
    sveikasKatalogas({
      [praleistas]: ["TAP version 13", "not ok 1 - Error: Cannot find module", "# fail 1"].join("\n"),
    }),
    paleistiTikrintuva
  );

  assert.notEqual(nulužes.kodas, 0, "nulūžęs failas be `ok` NEGALI praeiti");
  assert.ok(nulužes.isvestis.includes(praleistas), nulužes.isvestis);

  /** ── APVALKALAS (`describe`) NĖRA įvykdytas testas ────────────────────── */
  /**
   * ⚠️ TAI NE FORMATO SMULKMENA (#233 Codex raundas 2, #4).
   *
   * Kai failas naudoja `describe()`, o visi vaikai praleisti dėl priežasties,
   * nesusijusios su DB, Node vis tiek išveda `ok N - <suite>` su `type: 'suite'`
   * ir BE `# SKIP`. Skaičiuojant `ok` eilutes toks apvalkalas atrodo kaip
   * įvykdytas testas, ir visiškai praleistas failas praeina patikrą - tiksliai
   * tas „failas nutyla, o kiti sukasi" režimas, dėl kurio kriterijus ir buvo
   * grąžintas į per-failo lygį.
   */
  const suApvalkalu = [
    "TAP version 13",
    "    ok 1 - vaikas A # SKIP reikia REDIS_URL",
    "    ok 2 - vaikas B # SKIP reikia REDIS_URL",
    "    1..2",
    "ok 1 - apvalkalas",
    "  ---",
    "  duration_ms: 4.3",
    "  type: 'suite'",
    "  ...",
  ].join("\n");

  const tikApvalkalas = suTapKatalogu(sveikasKatalogas({ [praleistas]: suApvalkalu }), paleistiTikrintuva);

  assert.notEqual(
    tikApvalkalas.kodas,
    0,
    "`describe` apvalkalas be įvykdytų vaikų NEGALI būti laikomas vykdymu"
  );
  assert.ok(tikApvalkalas.isvestis.includes(praleistas), tikApvalkalas.isvestis);

  /** Bet apvalkalas su TIKRAI įvykdytu vaiku - teisėtas. */
  const apvalkalasSuVaiku = [
    "TAP version 13",
    "    ok 1 - realus vaikas",
    "    1..1",
    "ok 1 - apvalkalas",
    "  ---",
    "  type: 'suite'",
    "  ...",
  ].join("\n");

  assert.equal(
    suTapKatalogu(sveikasKatalogas({ [praleistas]: apvalkalasSuVaiku }), paleistiTikrintuva).kodas,
    0,
    "apvalkalas su įvykdytu vaiku privalo praeiti - skaičiuojami vaikai, ne apvalkalas"
  );

  /** ── Praleidimas dėl KITOS priežasties (Redis) nekliudo ────────────────── */
  const kitasSkip = suTapKatalogu(
    sveikasKatalogas({
      [praleistas]: ["TAP version 13", "ok 1 - realus", "ok 2 - kitas # SKIP reikia REDIS_URL"].join("\n"),
    }),
    paleistiTikrintuva
  );

  assert.equal(kitasSkip.kodas, 0, "praleidimas ne dėl DB yra teisėtas - klausimas siauras");
});

test("VYKDYMO ĮRODYMAS: vienas bendras TAP ATMETAMAS, ne interpretuojamas", () => {
  /**
   * ⚠️ REGRESIJOS SARGAS. Ankstesnė versija priiminėjo vieną bendrą TAP failą ir
   * bandė iš jo atpažinti failų vardus - to Node 18 plokščiame sraute nėra, tad
   * tikrinimas arba krisdavo visada, arba (antroji versija) įrodydavo mažiau,
   * nei reikalauja #231.
   *
   * Grąžinus tokį iškvietimą tikrintuvas privalo AIŠKIAI atsisakyti, o ne
   * pabandyti ir tyliai praleisti.
   */
  const tmp = path.join(require("node:os").tmpdir(), `stenograma-bendras-tap-${process.pid}`);
  fs.writeFileSync(tmp, "TAP version 13\nok 1 - kažkas\n", "utf8");

  try {
    const res = paleistiTikrintuva(tmp);

    assert.equal(res.kodas, 2, "bendras TAP failas yra naudojimo klaida, ne testų kritimas");
    assert.ok(res.isvestis.includes("nėra katalogas"), res.isvestis);
    assert.ok(res.isvestis.includes("failų atributikos"), "pranešimas turi paaiškinti KODĖL");
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("PALEIDIKLIS: `--tap-dir` rašo TAP kiekvienam failui ir IŠVALO senus", () => {
  /**
   * ⚠️ SENŲ ARTEFAKTŲ VALYMAS YRA SAUGUMO SAVYBĖ, NE TVARKINGUMAS.
   *
   * Be jo praėjusio paleidimo `.tap` liktų kataloge, ir vykdymo tikrintuvas
   * praeitų dėl failo, kuris ŠĮKART nebuvo paleistas apskritai. Tikrinimas,
   * praeinantis dėl seno įrodymo, blogesnis už jokį - jis atrodo kaip garantija.
   *
   * ⚠️ NAUDOJAMAS `redis` RINKINYS, NE `postgres`. Savybė yra paleidiklio, ne
   * konkretaus rinkinio; `redis` mažesnis ir be DB praeina per kelias sekundes.
   */
  const katalogas = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "stenograma-tap-dir-"));
  const senas = path.join(katalogas, "seno-paleidimo-artefaktas.tap");

  try {
    fs.writeFileSync(senas, "TAP version 13\nok 1 - senas melas\n", "utf8");

    execFileSync("node", [PALEIDIKLIS, "redis", `--tap-dir=${katalogas}`], {
      encoding: "utf8",
      cwd: path.join(TESTU_KATALOGAS, ".."),
    });

    assert.ok(!fs.existsSync(senas), "senas `.tap` privalo būti pašalintas PRIEŠ paleidimą");

    for (const testas of suites.redis) {
      const kelias = path.join(katalogas, `${testas}.tap`);
      assert.ok(fs.existsSync(kelias), `trūksta TAP failo: ${testas}`);
      assert.ok(fs.readFileSync(kelias, "utf8").includes("TAP version"), `${testas}: TAP tuščias`);
    }
  } finally {
    fs.rmSync(katalogas, { recursive: true, force: true });
  }
});
