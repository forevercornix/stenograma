/**
 * `erasure_marks.last_failure_kind` ALLOWLIST: `executor_lost` (#155, 7.5a / #183).
 *
 * ⚠️ NAUJAS FAILAS, NE SENOS MIGRACIJOS REDAGAVIMAS - ta pati priežastis kaip
 * `1755500000000_erasure-marks-orphan-reason.js`: `node-pg-migrate` praleidžia
 * failą pagal VARDĄ, tad papildžius seną sąrašą jau migruota DB liktų su siauru
 * constraint'u, o `erasure-marks release` joje kristų `check_violation` klaida
 * RAŠANT - tiksliai tame kelyje, kurį ši reikšmė įveda.
 *
 * KODĖL AIBĖ PLEČIASI. Kietai nužudytas procesas (SIGKILL, OOM) palieka
 * `deletion_pending` žymą be vykdytojo. Nuo tada, kai antras kvietėjas gauna
 * 202 pagal `deletion_pending`, tokia žyma reiškia, kad ištrynimas nebeįvyks
 * niekada. `retry` netinka (reikalauja `deletion_failed`), `force-resolve`
 * netinka (tvirtina, kad duomenų nebėra, o po SIGKILL tai NEŽINOMA).
 *
 * `executor_lost` yra vienintelis dalykas, kurį operatorius tikrai žino.
 */

/**
 * ⚠️ AIBĖ UŽŠALDYTA, NEIMPORTUOJAMA - migracija yra istorijos įrašas.
 *
 * Paritetą su `states.js` tikrina `tests/erasureMarks.test.js`: jis ima
 * NAUJAUSIĄ migraciją, deklaruojančią atitinkamą `*_FROZEN` aibę, ir reikalauja,
 * kad kiekviena ankstesnė būtų vėlesnės poaibis.
 */
const FAILURE_KINDS_FROZEN_V2 = [
  "retryable",
  "permanent",
  "already_absent",
  "executor_lost",
];

const sarasas = (reiksmes) => reiksmes.map((r) => `'${r}'`).join(", ");

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.dropConstraint("erasure_marks", "erasure_marks_failure_kind_allowed");
  pgm.addConstraint("erasure_marks", "erasure_marks_failure_kind_allowed", {
    check: `last_failure_kind IS NULL OR last_failure_kind IN (${sarasas(FAILURE_KINDS_FROZEN_V2)})`,
  });
};

/**
 * ⚠️ `down` GALI KRISTI - ir tai teisinga. Jei DB jau yra `executor_lost`
 * eilučių, siauro constraint'o grąžinimas mes `check_violation`. Alternatyva -
 * tas reikšmes perrašyti į `retryable` - suklastotų įrašą: „nepavyko dėl
 * kartotino gedimo" ir „nežinoma, ar bandymas įvyko" yra skirtingi teiginiai.
 */
exports.down = (pgm) => {
  pgm.dropConstraint("erasure_marks", "erasure_marks_failure_kind_allowed");
  pgm.addConstraint("erasure_marks", "erasure_marks_failure_kind_allowed", {
    check:
      "last_failure_kind IS NULL OR last_failure_kind IN (" +
      sarasas(FAILURE_KINDS_FROZEN_V2.filter((k) => k !== "executor_lost")) +
      ")",
  });
};
