const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { suites, isvestiPostgresRinkini } = require("./suites");

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
    .filter((f) => /require\((["'])[^"']*postgresGuard\1\)/.test(failoTurinys(f)))
    .map((f) => f.replace(/\.test\.js$/, ""))
    .sort();

  assert.deepEqual(suites.postgres, nepriklausomai, "išvestas rinkinys išsiskyrė su realybe");
  assert.deepEqual(isvestiPostgresRinkini(), nepriklausomai);
  assert.ok(nepriklausomai.length >= 9, "rinkinys negali tyliai susitraukti");
});

test("IŠVEDIMAS: `suites.js` nebeturi rankinio postgres sąrašo", () => {
  /**
   * ⚠️ TRIPWIRE (AGENTS.md §9.2). Grąžinus literalų masyvą, išvedimas taptų
   * dekoracija: rinkinys vėl priklausytų nuo to, ką kas nors prisiminė įrašyti.
   */
  const src = fs.readFileSync(path.join(TESTU_KATALOGAS, "suites.js"), "utf8");

  assert.match(src, /const postgres = isvestiPostgresRinkini\(\)/, "rinkinys privalo būti išvedamas");
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
  ];

  const naudojaPg = visiTestuFailai().filter((f) => /require\((["'])pg\1\)/.test(failoTurinys(f)));

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

test("VYKDYMO ĮRODYMAS: skriptas atmeta TAP su praleidimais dėl DB", () => {
  /**
   * ⚠️ TAI PAGRINDINĖ 7.4f CI GARANTIJA.
   *
   * `npm run test:postgres` grąžina 0 ir tada, kai kiekvienas testas praleido
   * save dėl trūkstamo `DATABASE_URL`. Skriptas skaito TAP ir tokią būseną
   * atmeta.
   *
   * ⚠️ GRANULIARUMO RIBA. Pirmoji versija reikalavo `ok` KIEKVIENAM rinkinio
   * failui, bet Node 18 `node --test <failai>` duoda PLOKŠČIĄ TAP be failų
   * vardų - ta versija krisdavo visada, ir CI kritimas buvo jos pačios klaida.
   * Dabar tikrinama tai, ką formatas leidžia įrodyti ir kas atitinka tikrąjį
   * gedimo režimą: praleidimų dėl DB nėra, ir įvykdytų testų yra.
   *
   * ⚠️ JOKIO `RegExp` (CodeQL). Ankstesnė versija konstravo šabloną iš failo
   * vardo su `replace(/\./g, "\\.")` - toks ekranavimas dengia tik taškus, o
   * bet kuris kitas metasimbolis liktų neekranuotas. Čia pakanka eilučių
   * lyginimo, tad `RegExp` atsisakoma visiškai, o ne taisomas ekranavimas.
   */
  const skriptas = path.join(TESTU_KATALOGAS, "..", "scripts", "verify-postgres-suite-ran.mjs");
  const tmp = path.join(require("node:os").tmpdir(), `pg-tap-${process.pid}`);

  const paleisti = (tapTurinys) => {
    fs.writeFileSync(tmp, tapTurinys, "utf8");
    try {
      return { kodas: 0, isvestis: execFileSync("node", [skriptas, tmp], { encoding: "utf8" }) };
    } catch (e) {
      return { kodas: e.status, isvestis: (e.stderr || "") + (e.stdout || "") };
    } finally {
      fs.unlinkSync(tmp);
    }
  };

  const PRALEIDIMO_PRIEZASTIS = "# SKIP reikia DATABASE_URL su tikru Postgres";

  /** ── Viskas praleista dėl DB: turi KRISTI ──────────────────────────────── */
  const praleista = ["TAP version 13"]
    .concat(suites.postgres.map((_, i) => `ok ${i + 1} - koks nors testas ${PRALEIDIMO_PRIEZASTIS}`))
    .join("\n");

  const blogas = paleisti(praleista);
  assert.notEqual(blogas.kodas, 0, "vien praleidimai NEGALI būti laikomi sėkme");
  assert.ok(blogas.isvestis.includes("NEBUVO realiai įvykdytas"), blogas.isvestis);
  assert.ok(blogas.isvestis.includes("DATABASE_URL"), "pranešime turi būti priežastis");

  /** ── Realiai įvykdyta: turi PRAEITI ────────────────────────────────────── */
  const ivykdyti = ["TAP version 13"]
    .concat(suites.postgres.map((_, i) => `ok ${i + 1} - realus testas`))
    .join("\n");

  const geras = paleisti(ivykdyti);
  assert.equal(geras.kodas, 0, `įvykdytas rinkinys turi praeiti: ${geras.isvestis}`);
  assert.ok(geras.isvestis.includes("realiai įvykdyta"), geras.isvestis);

  /** ── MIŠRUS: dalis įvykdyta, dalis praleista dėl DB - vis tiek KRINTA ──── */
  const misrus = [
    "TAP version 13",
    "ok 1 - realus testas",
    `ok 2 - kitas testas ${PRALEIDIMO_PRIEZASTIS}`,
  ].join("\n");

  const dalinis = paleisti(misrus);
  assert.notEqual(dalinis.kodas, 0, "net vienas praleidimas dėl DB reiškia neįvykdytą rinkinį");

  /** ── Praleidimas dėl KITOS priežasties (Redis) nekliudo ────────────────── */
  const kitasSkip = [
    "TAP version 13",
    "ok 1 - realus testas",
    "ok 2 - redis testas # SKIP reikia REDIS_URL su tikru Redis",
  ].join("\n");

  assert.equal(
    paleisti(kitasSkip).kodas,
    0,
    "praleidimas ne dėl DB yra teisėtas - klausimas siauras"
  );

  /** ── Tuščias TAP: KRINTA ───────────────────────────────────────────────── */
  assert.notEqual(paleisti("TAP version 13").kodas, 0, "tuščias TAP nėra sėkmė");
});
