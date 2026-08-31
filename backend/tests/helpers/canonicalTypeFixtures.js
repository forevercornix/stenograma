const { KANONINIAI_LAUKAI } = require("../../utils/jobStore/common");

/**
 * KANONINIŲ LAUKŲ TEKSTINĖS ĮVESTYS (#205, 7.2c).
 *
 * ⚠️ BENDROS DVIEM TESTŲ FAILAMS. Pariteto matrica vykdoma prieš memory ir
 * Redis (`jobStoreTypeNormalization.test.js`) bei prieš tikrą PostgreSQL
 * (`postgresStore.integration.test.js`). Du atskiri sąrašai ilgainiui
 * išsiskirtų, ir vienas backend'as būtų tikrinamas kitomis reikšmėmis nei kiti -
 * tai ta pati klasė, kurią #205 šalina.
 *
 * ⚠️ `schemaVersion` NEDALYVAUJA patch'ų matricoje: `applyPatch()` jį laiko
 * NEKINTAMU (#158), tad per `update()` jo reikšmės pakeisti neįmanoma. Jo
 * normalizavimas tikrinamas atskirai - per `restoreRecord()` ir
 * `deserialize()`. Išimtis eksplicitinė, kad nebūtų tyli.
 */
const NEDALYVAUJA_PATCHUOSE = new Set(["schemaVersion"]);

const IVESTYS = Object.freeze({
  audio_cleanup_pending: ["false", "true"],
  deletion_pending: ["false", "true"],
  /**
   * ⚠️ TIK `"false"`. `progressKnown: true` reikalauja ir progreso reikšmių -
   * `jobs_progress_known` CHECK PostgreSQL'e atmestų `progress_known = true` su
   * `NULL` stulpeliais. Tikrinama būtent ta reikšmė, dėl kurios #154 lūžo.
   */
  progressKnown: ["false"],
  attempt_count: ["0", "3"],
  audio_cleanup_attempts: ["0", "3"],
  deletion_attempts: ["0", "3"],
});

/** Neleistinos / neaiškios reikšmės - elgesys privalo sutapti visuose backend'uose. */
const NELEISTINOS = Object.freeze(["maybe", "abc", "3.7", "1", ""]);

/**
 * Laukai, dalyvaujantys patch'ų matricoje, IŠVESTI iš kanoninės aibės.
 *
 * ⚠️ Rankinis sąrašas čia atkartotų būtent tą problemą, kurią #205 taiso:
 * naujas kanoninis laukas be įvesčių privalo SULAUŽYTI testą, o ne tyliai
 * likti nepatikrintas.
 */
function patchLaukai() {
  return KANONINIAI_LAUKAI.filter((laukas) => !NEDALYVAUJA_PATCHUOSE.has(laukas));
}

module.exports = { IVESTYS, NELEISTINOS, NEDALYVAUJA_PATCHUOSE, patchLaukai };
