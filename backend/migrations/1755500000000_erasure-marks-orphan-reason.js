/**
 * `erasure_marks.reason` ALLOWLIST PRAPLĖTIMAS: `orphan_cleanup` (#155, 7.5a / #183).
 *
 * ⚠️ NAUJAS FAILAS, O NE `1755400000000_erasure-marks.js` REDAGAVIMAS.
 *
 * Ta pati priežastis, kurią fiksuoja pirminė migracija: `node-pg-migrate`
 * praleidžia failą pagal VARDĄ. Papildžius seną `REASONS_FROZEN` sąrašą, šviežia
 * DB gautų platų constraint'ą, o jau migruota liktų su siauru - abi startuotų,
 * bet našlaičio valymas antrojoje kristų `check_violation` klaida RAŠANT ŽYMĄ,
 * t. y. tiksliai tame kelyje, kurį ši reikšmė ir įveda.
 *
 * KODĖL AIBĖ PLEČIASI. `adminCleanupOrphan()` ir `desktopCleanupOrphan()` iki
 * šiol trynė našlaičio pėdsakus NEPALIKDAMI barjero: ištrynimas sėkmingas,
 * žymos nėra, o vėlesnis atkūrimas iš senesnės kopijos tą ID vėl priimtų. Tai ta
 * pati spraga, kurią 7.5a uždaro savininko kelyje.
 *
 * KODĖL NE `operator_cleanup`, kuris jau aibėje - žr. `states.js`
 * `ERASURE_REASON.ORPHAN_CLEANUP`: kelių yra du, ir desktop kelyje operatoriaus
 * privilegija NENAUDOJAMA.
 */

/**
 * ⚠️ AIBĖ VĖL UŽŠALDYTA, NEIMPORTUOJAMA - kaip ir pirminėje migracijoje.
 *
 * `REASONS_FROZEN_V2` yra ŠIO istorijos taško įrašas. Paritetą su `states.js`
 * tikrina `tests/erasureMarks.test.js`, kuris ima NAUJAUSIĄ migraciją,
 * deklaruojančią `REASONS_FROZEN*`, ir papildomai reikalauja, kad ankstesnė
 * aibė būtų šios POAIBIS: allowlist gali tik plėstis, o istorija - nesikeisti.
 */
const REASONS_FROZEN_V2 = [
  "user_request",
  "retention_policy",
  "operator_cleanup",
  "orphan_cleanup",
];

const sarasas = (reiksmes) => reiksmes.map((r) => `'${r}'`).join(", ");

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.dropConstraint("erasure_marks", "erasure_marks_reason_allowed");
  pgm.addConstraint("erasure_marks", "erasure_marks_reason_allowed", {
    check: `reason IN (${sarasas(REASONS_FROZEN_V2)})`,
  });
};

/**
 * ⚠️ `down` GALI KRISTI - IR TAI TEISINGA.
 *
 * Jei DB jau yra `orphan_cleanup` eilučių, siauro constraint'o grąžinimas mes
 * `check_violation`. Alternatyva būtų tas eilutes ištrinti ar reikšmę perrašyti
 * - abu reikštų ištrynimo barjero praradimą arba jo priežasties suklastojimą
 * lentelėje, kurios vienintelė paskirtis yra įrodyti, kas ir kodėl ištrinta.
 *
 * Rollback'as, kuris tyliai sunaikina įrodymą, yra blogesnis už rollback'ą,
 * kuris sustoja ir pareikalauja žmogaus sprendimo.
 */
exports.down = (pgm) => {
  pgm.dropConstraint("erasure_marks", "erasure_marks_reason_allowed");
  pgm.addConstraint("erasure_marks", "erasure_marks_reason_allowed", {
    check: `reason IN (${sarasas(REASONS_FROZEN_V2.filter((r) => r !== "orphan_cleanup"))})`,
  });
};
