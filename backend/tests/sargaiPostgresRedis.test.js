const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

/**
 * `postgresGuard` IR `redisGuard` ELGSENOS ĮRODYMAS (#410, D3).
 *
 * ⚠️ KODĖL ŠIE DU, IR KODĖL TIK ŠIE.
 *
 * #410 §0.3 išmatavo visus 20 `tests/helpers/` failų pagal vieną kriterijų:
 * *sugadinus elgseną, ar koks nors ESAMAS testas kristų?* Septyni yra sargai ar
 * gyvavimo ciklo mechanizmai; keturi iš jų įrodymą jau turi:
 *
 *     s3Guard        s3Sargas.test.js              (#408)
 *     pythonGuard    pythonGuard.test.js           (#202)
 *     resourceStack  resursuKruva.test.js          (#380)
 *     auditStoreSeam erasureReplayContract 10, 11  (išmatuota mutacija: seam'ą
 *                    padarius no-op, abu testai krinta)
 *
 * Be įrodymo liko `postgresGuard` (33 testų failai), `redisGuard` (9) ir
 * `raceInjection` (1). Pirmieji du — čia; `raceInjection` iškeltas į atskirą issue
 * (kita forma: netikras pool'as ir laiko riba), kartu su jo §12.1 teiginiu.
 *
 * ⚠️ KĄ TIKSLIAI GINA ŠIS FAILAS. Abu sargai sprendžia, ar 42 testų failai apskritai
 * vykdomi. Jei kuris tyliai nustotų veikti — imtų praleisti rinkinį arba nustotų
 * kristi be URL — visi juos naudojantys testai liktų ŽALI, o CI praneštų sėkmę
 * nepaleidęs nė vieno. Tiksliai tokia spraga rasta #405: `REQUIRE_MINIO=1` be
 * endpoint'o praleisdavo rinkinį ir baigdavosi žaliai.
 *
 * ⚠️ VAIKINIAI PROCESAI, NE `delete process.env.X` + `require`. Sargas sprendžia
 * MODULIO KRAUVIMO metu, o `require` kešuoja rezultatą: antras kvietimas tame
 * pačiame procese grąžintų pirmojo verdiktą, ir testas matuotų kešą, ne sargą.
 * Aplinka perduodama EKSPLICITIŠKAI, tad paveldėtas CI kintamasis (CI'e
 * `DATABASE_URL` realiai yra) rezultato nekeičia.
 */

const SARGAI = [
  {
    vardas: "postgresGuard",
    kelias: path.join(__dirname, "helpers", "postgresGuard.js"),
    veliava: "REQUIRE_POSTGRES",
    url: "DATABASE_URL",
    reiksme: "postgres://postgres:postgres@localhost:5432/postgres",
    praleidimoZyma: /DATABASE_URL/,
    klaidosZyma: /REQUIRE_POSTGRES=1 nustatytas, bet DATABASE_URL nėra/,
    skipVardas: "skipWithoutPostgres",
  },
  {
    vardas: "redisGuard",
    kelias: path.join(__dirname, "helpers", "redisGuard.js"),
    veliava: "REQUIRE_REDIS",
    url: "REDIS_URL",
    reiksme: "redis://localhost:6379",
    praleidimoZyma: /REDIS_URL/,
    klaidosZyma: /REQUIRE_REDIS=1 nustatytas, bet REDIS_URL nėra/,
    skipVardas: "skipWithoutRedis",
  },
];

/** Paleidžia sargą ŠVARIAME procese ir grąžina tai, ką matytų jį importuojantis testas. */
function kraunantSarga(sargas, aplinka) {
  const r = spawnSync(
    process.execPath,
    [
      "-e",
      "const g = require(process.argv[1]);" +
        "process.stdout.write(JSON.stringify({" +
        "  praleisti: g[process.argv[2]](), required: g.REQUIRED, turi: g.hasPostgres ?? g.hasRedis" +
        "}));",
      sargas.kelias,
      sargas.skipVardas,
    ],
    { env: { PATH: process.env.PATH, ...aplinka }, encoding: "utf8", timeout: 20000 }
  );

  return { kodas: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

for (const sargas of SARGAI) {
  /* ── 1. vėliavėlė + URL ─────────────────────────────────────────────── */
  test(`${sargas.vardas}: ${sargas.veliava}=1 SU ${sargas.url} - rinkinys VYKDOMAS`, () => {
    const r = kraunantSarga(sargas, { [sargas.veliava]: "1", [sargas.url]: sargas.reiksme });

    assert.equal(r.kodas, 0, `sargas krito be reikalo: ${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout), { praleisti: false, required: true, turi: true });
  });

  /* ── 2. vėliavėlė BE URL — fail-closed ──────────────────────────────── */
  test(`${sargas.vardas}: ${sargas.veliava}=1 BE ${sargas.url} - KLAIDA, ne tylus praleidimas`, () => {
    const r = kraunantSarga(sargas, { [sargas.veliava]: "1" });

    assert.notEqual(r.kodas, 0, `laukta ne nulinio kodo, gauta ${r.kodas}; stdout: ${r.stdout}`);
    assert.match(r.stderr, sargas.klaidosZyma);
    assert.match(r.stderr, /praleisti tyliai|CI liktų žalias/);
  });

  /* ── 3. be vėliavėlės SU URL ────────────────────────────────────────── */
  test(`${sargas.vardas}: be ${sargas.veliava} su ${sargas.url} - VYKDOMAS, be klaidos`, () => {
    const r = kraunantSarga(sargas, { [sargas.url]: sargas.reiksme });

    assert.equal(r.kodas, 0, `sargas krito be reikalo: ${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout), { praleisti: false, required: false, turi: true });
  });

  /* ── 4. be vėliavėlės BE URL — teisėtas praleidimas ─────────────────── */
  test(`${sargas.vardas}: be ${sargas.veliava} be ${sargas.url} - praleidimas TEISĖTAS`, () => {
    const r = kraunantSarga(sargas, {});

    assert.equal(r.kodas, 0, `švari aplinka neturi kristi: ${r.stderr}`);

    const { praleisti, required, turi } = JSON.parse(r.stdout);
    assert.equal(required, false);
    assert.equal(turi, false);
    assert.equal(typeof praleisti, "string", "praleidimas privalo turėti PRIEŽASTĮ, ne `true`");
    assert.match(praleisti, sargas.praleidimoZyma, "priežastis privalo įvardyti trūkstamą kintamąjį");
  });
}

/**
 * ⚠️ KRYŽMINĖ PATIKRA: sargai NESUPLAKAMI. Be jos abu testų rinkiniai praeitų ir
 * tada, jei `redisGuard` imtų skaityti `DATABASE_URL` — o būtent tokia klaida
 * (vieno sargo vėliava valdo kitą rinkinį) yra tyli pagal konstrukciją.
 */
test("KRYŽMINĖ PATIKRA: svetimas URL sargo NEĮJUNGIA", () => {
  for (const sargas of SARGAI) {
    const svetimas = SARGAI.find((s) => s !== sargas);
    const r = kraunantSarga(sargas, { [svetimas.url]: svetimas.reiksme });

    assert.equal(r.kodas, 0, `${sargas.vardas} krito dėl svetimo kintamojo: ${r.stderr}`);
    assert.equal(
      JSON.parse(r.stdout).turi,
      false,
      `${sargas.vardas} priėmė ${svetimas.url} kaip savo`
    );
  }
});
