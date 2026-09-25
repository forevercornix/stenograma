const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

/**
 * `s3Guard` VARDŲ KONTRAKTAS (#405, P2).
 *
 * ⚠️ KODĖL VAIKINIAI PROCESAI, O NE `delete process.env.X` + `require`.
 *
 * Sargas sprendžia MODULIO KRAUVIMO metu, o `require` kešuoja rezultatą: antras
 * kvietimas tame pačiame procese grąžintų pirmojo verdiktą ir testas matuotų
 * kešą, ne sargą. Kiekviena konfigūracija tikrinama ŠVARIAME procese su
 * eksplicitine aplinka - tad ir paveldėtas CI kintamasis rezultato nekeičia.
 *
 * ⚠️ KĄ ŠIS FAILAS GINA. Iki #405 P2 senas vardas buvo TYLUS: `REQUIRE_MINIO=1`
 * be `S3_ENDPOINT` praeidavo, rinkinys praleisdavo save, o job'as likdavo
 * žalias. Alias'as to nespręstų - jis grąžintų du priimamus vardus, t. y. #290
 * gedimą. Sprendimas: senas vardas nebeveikia kaip trigeris, bet sustabdo.
 */

const SARGAS = path.join(__dirname, "helpers", "s3Guard.js");

/** Paleidžia sargą ŠVARIOJE aplinkoje ir grąžina tai, ką matytų testas. */
function kraunantSarga(aplinka) {
  const rezultatas = spawnSync(
    process.execPath,
    [
      "-e",
      'const g = require(process.argv[1]);' +
        'process.stdout.write(JSON.stringify({ praleisti: g.skipWithoutS3() }));',
      SARGAS,
    ],
    { env: { PATH: process.env.PATH, ...aplinka }, encoding: "utf8", timeout: 20000 }
  );

  return {
    kodas: rezultatas.status,
    stdout: rezultatas.stdout || "",
    stderr: rezultatas.stderr || "",
  };
}

test("SENAS VARDAS: `REQUIRE_MINIO=1` be `S3_ENDPOINT` → KLAIDA, ne tylus praleidimas", () => {
  const r = kraunantSarga({ REQUIRE_MINIO: "1" });

  assert.notEqual(r.kodas, 0, `laukta ne nulinio kodo, gauta ${r.kodas}; stdout: ${r.stdout}`);
  assert.match(r.stderr, /PASENĘ vardai \(REQUIRE_MINIO\)/);
  assert.match(r.stderr, /REQUIRE_S3=1/, "pranešimas privalo pasakyti NAUJĄ vardą");
  assert.match(r.stderr, /S3_ENDPOINT=/, "pranešimas privalo pasakyti, ką eksportuoti");
});

test("SENAS VARDAS: `MINIO_ENDPOINT` be `REQUIRE_S3` → KLAIDA", () => {
  const r = kraunantSarga({ MINIO_ENDPOINT: "http://localhost:9000" });

  assert.notEqual(r.kodas, 0, `laukta ne nulinio kodo, gauta ${r.kodas}; stdout: ${r.stdout}`);
  assert.match(r.stderr, /PASENĘ vardai \(MINIO_ENDPOINT\)/);
});

/**
 * ⚠️ TAI NE TAS PATS, KAS PIRMAS TESTAS. Pirmas rodo, kad senas vardas
 * nebetyli; šis - kad jis NEVEIKIA KAIP TRIGERIS net tada, kai visa kita
 * aplinka tvarkinga. Be jo alias'as galėtų grįžti nepastebėtas.
 */
test("SENAS VARDAS NEĮJUNGIA rinkinio: `REQUIRE_MINIO=1` + `S3_ENDPOINT` → KLAIDA", () => {
  const r = kraunantSarga({ REQUIRE_MINIO: "1", S3_ENDPOINT: "http://localhost:8333" });

  assert.notEqual(r.kodas, 0, "senas vardas NEGALI veikti kaip įjungimo trigeris");
  assert.match(r.stderr, /PASENĘ vardai \(REQUIRE_MINIO\)/);
  assert.doesNotMatch(r.stdout, /praleisti/, "sargas neturi pasiekti normalaus kelio");
});

test("KONTROLĖ: `REQUIRE_S3=1` + `S3_ENDPOINT` veikia kaip iki šiol", () => {
  const r = kraunantSarga({ REQUIRE_S3: "1", S3_ENDPOINT: "http://localhost:8333" });

  assert.equal(r.kodas, 0, `sargas krito be reikalo: ${r.stderr}`);
  assert.deepEqual(JSON.parse(r.stdout), { praleisti: false });
});

test("KONTROLĖ: `REQUIRE_S3=1` be `S3_ENDPOINT` tebekrenta (#157 sargas nepakeistas)", () => {
  const r = kraunantSarga({ REQUIRE_S3: "1" });

  assert.notEqual(r.kodas, 0);
  assert.match(r.stderr, /REQUIRE_S3=1 nustatytas, bet S3_ENDPOINT nėra/);
});

test("KONTROLĖ: švari aplinka - praleidimas TEISĖTAS, ne klaida", () => {
  const r = kraunantSarga({});

  assert.equal(r.kodas, 0, `švari aplinka neturi kristi: ${r.stderr}`);
  const { praleisti } = JSON.parse(r.stdout);
  assert.equal(typeof praleisti, "string", "be `S3_ENDPOINT` grąžinama praleidimo priežastis");
  assert.match(praleisti, /S3_ENDPOINT/);
});
