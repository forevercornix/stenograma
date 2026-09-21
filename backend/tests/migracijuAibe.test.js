const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { iki } = require("./helpers/migracijuAibe");

/**
 * MIGRACIJŲ POAIBIS PAGAL TVARKĄ (#376 Codex P2 #3).
 *
 * ⚠️ BE DUOMENŲ BAZĖS SĄMONINGAI. Klausimas yra „kurie failai patenka į rinkinį",
 * ne „ką daro PostgreSQL". Grynos funkcijos testas leidžia paleisti ir mutaciją
 * lokaliai, o ne laukti CI — tad sargas apsaugotas ten pat, kur gyvena.
 */

const VIENO_ADRESO_MIGRACIJA = "1756700000000_job-result-attempts-vienas-adresas.js";

test("#376 R3: būsima migracija NEPATENKA į „iki #375\" rinkinį", () => {
  /**
   * ⚠️ TAI VIENINTELIS ATVEJIS, SKIRIANTIS TVARKĄ NUO VARDO.
   *
   * Senoji forma (`f !== VIENO_ADRESO_MIGRACIJA`) šalino VIENĄ failą. Su
   * šiandieniniu repo ji duoda tą patį atsakymą — būtent todėl yda ir liko
   * nepastebėta. Skirtumas matomas tik tada, kai sąraše YRA failas PO #375.
   */
  const busimas = "1756800000000_kazkas-naujo.js";
  const visos = [
    "1756500000000_job-result-attempts-karantinas.js",
    "1756600000000_artifact-migration-progress.js",
    VIENO_ADRESO_MIGRACIJA,
    busimas,
  ];

  const rinkinys = iki(visos, VIENO_ADRESO_MIGRACIJA);

  assert.equal(
    rinkinys.includes(busimas),
    false,
    "⚠️ po #375 einanti migracija NEGALI patekti į „iki #375\" katalogą — `checkOrder` tada atmestų #375"
  );
  assert.equal(rinkinys.includes(VIENO_ADRESO_MIGRACIJA), false, "pati #375 irgi neįeina");
  assert.deepEqual(rinkinys, [
    "1756500000000_job-result-attempts-karantinas.js",
    "1756600000000_artifact-migration-progress.js",
  ]);
});

test("#376 R3: rinkinys surikiuotas ir nepriklauso nuo įvesties tvarkos", () => {
  /**
   * `readdirSync` tvarkos negarantuoja, o `checkOrder` reikalauja būtent jos.
   * Funkcija rikiuoja pati, tad kvietėjui to prisiminti nereikia.
   */
  const visos = ["1756600000000_b.js", "1756400000000_a.js", "1756500000000_c.js"];
  assert.deepEqual(iki(visos, "1756600000000_b.js"), [
    "1756400000000_a.js",
    "1756500000000_c.js",
  ]);
});

test("#376 R3: įvestis nemodifikuojama", () => {
  /** Kvietėjas tą patį sąrašą naudoja ir `assert.ok(visos.includes(...))` patikrai. */
  const visos = ["1756600000000_b.js", "1756400000000_a.js"];
  const kopija = [...visos];
  iki(visos, "1756600000000_b.js");
  assert.deepEqual(visos, kopija, "`sort()` vietoje sugadintų kvietėjo masyvą");
});

test("#376 R3: prielaida apie repo — #375 migracija yra ir nėra paskutinė amžinai", () => {
  /**
   * ⚠️ ŠIS TESTAS RIŠA GRYNĄ FUNKCIJĄ SU TIKRU REPO.
   *
   * Be jo `iki()` galėtų būti teisinga, o `VIENO_ADRESO_MIGRACIJA` konstanta —
   * pasenusi, ir fixture rinkinys tyliai taptų tuščias.
   */
  const katalogas = path.resolve(__dirname, "..", "migrations");
  const visos = fs
    .readdirSync(katalogas)
    .filter((f) => f.endsWith(".js"))
    .sort();

  assert.ok(visos.includes(VIENO_ADRESO_MIGRACIJA), "#375 migracija privalo egzistuoti");

  const rinkinys = iki(visos, VIENO_ADRESO_MIGRACIJA);
  assert.ok(rinkinys.length > 0, "„iki #375\" rinkinys negali būti tuščias");
  assert.equal(
    rinkinys.every((f) => f < VIENO_ADRESO_MIGRACIJA),
    true,
    "kiekvienas rinkinio failas privalo būti PRIEŠ #375"
  );
});
