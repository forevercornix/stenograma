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

test("VYKDYMO ĮRODYMAS: skriptas atmeta TAP, kuriame testai PRALEISTI", () => {
  /**
   * ⚠️ TAI PAGRINDINĖ 7.4f CI GARANTIJA.
   *
   * `npm run test:postgres` grąžina 0 ir tada, kai kiekvienas testas praleido
   * save dėl trūkstamo `DATABASE_URL`. Skriptas skaito TAP ir reikalauja
   * NEPRALEISTO `ok` kiekvienam rinkinio failui.
   *
   * Testuojamas pats skriptas su sintetiniu TAP - taip garantija patikrinama
   * BE duomenų bazės. Realų vykdymą CI atlieka su `REQUIRE_POSTGRES=1`.
   */
  const skriptas = path.join(TESTU_KATALOGAS, "..", "scripts", "verify-postgres-suite-ran.mjs");
  const tmp = path.join(require("node:os").tmpdir(), `pg-tap-${process.pid}`);

  const paleisti = (tapTurinys) => {
    fs.writeFileSync(tmp, tapTurinys, "utf8");
    try {
      const isvestis = execFileSync("node", [skriptas, tmp], { encoding: "utf8" });
      return { kodas: 0, isvestis };
    } catch (e) {
      return { kodas: e.status, isvestis: (e.stderr || "") + (e.stdout || "") };
    } finally {
      fs.unlinkSync(tmp);
    }
  };

  /** ── Viskas praleista: turi KRISTI ─────────────────────────────────────── */
  const praleista = suites.postgres
    .map((t, i) => `ok ${i + 1} - ${t}.test.js # SKIP reikia DATABASE_URL`)
    .join("\n");

  const blogas = paleisti(praleista);
  assert.notEqual(blogas.kodas, 0, "vien praleidimai NEGALI būti laikomi sėkme");
  assert.match(blogas.isvestis, /NEBUVO realiai įvykdytas/);

  /** ── Visi realiai įvykdyti: turi PRAEITI ───────────────────────────────── */
  const ivykdyti = suites.postgres
    .map((t, i) => `# Subtest: /repo/backend/tests/${t}.test.js\nok ${i + 1} - ${t}.test.js`)
    .join("\n");

  const geras = paleisti(ivykdyti);
  assert.equal(geras.kodas, 0, `pilnai įvykdytas rinkinys turi praeiti: ${geras.isvestis}`);
  assert.match(geras.isvestis, /visi \d+ failai realiai įvykdyti/);

  /** ── Vienas trūkstamas: turi KRISTI ir ĮVARDYTI, kuris ─────────────────── */
  const truksta = suites.postgres
    .slice(1)
    .map((t, i) => `ok ${i + 1} - ${t}.test.js`)
    .join("\n");

  const dalinis = paleisti(truksta);
  assert.notEqual(dalinis.kodas, 0, "trūkstamas failas privalo kristi");
  assert.match(
    dalinis.isvestis,
    new RegExp(suites.postgres[0].replace(/\./g, "\\.")),
    "pranešime turi būti įvardytas KURIS failas neįvykdytas"
  );
});
