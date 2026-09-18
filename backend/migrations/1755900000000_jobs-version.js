/**
 * OPTIMISTIC LOCKING: `jobs.version` (#155, 7.5b / #184).
 *
 * ⚠️ KODĖL ATSKIRAS STULPELIS, O NE `updated_at`.
 *
 * `updated_at` yra `timestamptz`, tad du rašymai toje pačioje mikrosekundėje
 * (o PostgreSQL `now()` transakcijoje yra PASTOVUS) gauna VIENODĄ reikšmę.
 * CAS su `WHERE updated_at = $1` tokiu atveju praleistų abu — tyliai. Monotoniškas
 * sveikasis skaičius tos klasės neturi.
 *
 * ⚠️ `DEFAULT 1`, NE `DEFAULT 0`. Esamos eilutės po migracijos gauna galiojančią
 * pradinę reikšmę, o `newJob()` naujoms nustato tą pačią `1` — viena reikšmė,
 * vienodai visiems trims backend'ams. Nulis būtų blogesnis ne dėl estetikos:
 * `expectedVersion` patikros JS pusėje neišvengiamai susiduria su `0` FALSY
 * semantika, ir „versija nurodyta" tyliai virstų „nenurodyta".
 *
 * ⚠️ `jobs_version_positive` REGISTRUOJAMAS `REQUIRED_JOB_CONSTRAINTS` SĄRAŠE.
 *
 * Sprendimas sąmoningas, ne automatinis. `migrations.integration.test.js`
 * reikalauja, kad tas sąrašas apimtų VISUS migracijų sukurtus `jobs`
 * constraint'us, o `utils/jobStore/index.js` readiness pagal jį krenta starte.
 * Vadinasi pasirinkimas dvejetainis: arba constraint IR įrašas sąraše, arba nė
 * vieno. Pasirinkta pirma — DB lygmens `version >= 1` pašalina falsy-nulio klasę
 * ten, kur jos JS patikra nepasiektų (rankinis `UPDATE`, atkūrimas iš kopijos).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn("jobs", {
    version: { type: "integer", notNull: true, default: 1 },
  });

  pgm.addConstraint("jobs", "jobs_version_positive", {
    check: "version >= 1",
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint("jobs", "jobs_version_positive");
  pgm.dropColumn("jobs", "version");
};
