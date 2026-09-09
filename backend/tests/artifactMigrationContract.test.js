const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { BUSENA, PRIEZASTIS, KANDIDATAI_SQL } = require("../utils/artifactMigration");

process.env.NODE_ENV = "test";

/**
 * MIGRACIJOS KONTRAKTAS BE DB (#157, PR-6).
 *
 * ⚠️ KODĖL ATSKIRAS FAILAS NUO `artifactMigration.integration`.
 *
 * Ta pati priežastis kaip `pgDumpBackupContract` ir `postRestoreReconcileContract`:
 * čia tikrinama tai, kam DB nereikia, ir tikrinama per sekundes. Klausimai, į
 * kuriuos atsako šis failas, yra apie SUTAPIMĄ tarp kodo ir migracijos — o toks
 * nesutapimas yra tylus: abi pusės startuoja, ir tik konkreti eilutė kada nors
 * krinta su `23514`.
 */

const MIGRACIJA = path.join(__dirname, "..", "migrations", "1756600000000_artifact-migration-progress.js");

/** Migracijos tekstas skaitomas, o ne importuojamas — ji yra istorijos įrašas. */
function migracijosSaltinis() {
  return fs.readFileSync(MIGRACIJA, "utf8");
}

/**
 * Išrenka užšaldytą masyvą iš migracijos APIBRĖŽTIES.
 *
 * ⚠️ IŠRENKAMA, NE IMPORTUOJAMA. Importas paverstų abi puses viena, ir testas
 * tikrintų, ar konstanta lygi pati sau. Būtent to nesutapimo, kurį šis testas
 * gina, tada nebūtų kaip padaryti — nei aptikti.
 */
function uzsaldytaAibe(vardas) {
  const saltinis = migracijosSaltinis();
  const m = saltinis.match(new RegExp(`const ${vardas} = \\[([\\s\\S]*?)\\];`));
  assert.ok(m, `migracijoje nerasta \`${vardas}\` apibrėžtis`);

  return [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]).sort();
}

test("PARITETAS: `BUSENA` aibė sutampa su migracijos `BUSENOS_FROZEN`", () => {
  /**
   * ⚠️ AIBĖ LYGINAMA, NE GREP'INAMA (ta pati #157 PR-4 pamoka su `committed`).
   *
   * Pašalinus reikšmę iš vienos pusės, žodis lieka komentare, tad `includes()`
   * praeitų. Lyginamos AIBĖS: ir trūkstama, ir perteklinė reikšmė yra defektai.
   */
  assert.deepEqual(Object.values(BUSENA).sort(), uzsaldytaAibe("BUSENOS_FROZEN"));
});

test("PARITETAS: `PRIEZASTIS` aibė sutampa su migracijos `PRIEZASTYS_FROZEN`", () => {
  assert.deepEqual(Object.values(PRIEZASTIS).sort(), uzsaldytaAibe("PRIEZASTYS_FROZEN"));
});

test("KONTROLĖ: išrinkimas tikrai kažką randa", () => {
  /**
   * Sugedęs `uzsaldytaAibe()` (pakeitus migracijos formatavimą) grąžintų tuščią
   * masyvą, ir abu ankstesni testai kristų — bet jei kristų ABI pusės vienodai,
   * jie praeitų tuščiai teisingi. Todėl netuštumas tvirtinamas atskirai.
   */
  assert.ok(uzsaldytaAibe("BUSENOS_FROZEN").length >= 2);
  assert.ok(uzsaldytaAibe("PRIEZASTYS_FROZEN").length >= 4);
  assert.ok(Object.values(BUSENA).length >= 2);
});

test("ATRANKA praleidžia `failed` tik tada, kai to prašoma", () => {
  /**
   * ⚠️ TIKRINAMAS SQL TEKSTAS, IR TAI SĄMONINGAS KOMPROMISAS.
   *
   * Elgesį įrodo `artifactMigration.integration`; čia tikrinama, kad sąlyga
   * apskritai NEDINGO — atrankos užklausa yra vieta, kur „idempotencija" gyvena,
   * ir jos praradimas neduotų nė vienos klaidos: migracija tiesiog kartotų tą
   * patį darbą kas paleidimą.
   */
  assert.match(KANDIDATAI_SQL, /storage_type = 'inline'/);
  assert.match(KANDIDATAI_SQL, /payload IS NOT NULL/);
  assert.match(KANDIDATAI_SQL, /artifact_migration_progress/);
  assert.match(KANDIDATAI_SQL, /busena = 'failed'/);
});

test("STRUKTŪRINĖ SARGYBA: CLI neturi savo orkestracijos", () => {
  /**
   * Ta pati taisyklė ir tas pats precedentas kaip `dr-restore.mjs` (#250 D2):
   * operatoriaus kelias kviečia procedūrą, o ne kartoja ją. Antras
   * egzempliorius reikštų, kad testuojama viena versija, o paleidžiama kita.
   */
  const cli = fs.readFileSync(path.join(__dirname, "..", "scripts", "migrate-artifacts.mjs"), "utf8");

  assert.ok(cli.includes("artifactMigration"), "CLI privalo kviesti procedūrą iš modulio");
  assert.ok(
    !/UPDATE\s+job_results/i.test(cli),
    "CLI turi savo reference switch — orkestracija išsiskyrė"
  );
  assert.ok(
    !/attemptRegistry/.test(cli),
    "CLI tiesiogiai liečia registrą — tvarka turi gyventi VIENOJE vietoje"
  );
});
