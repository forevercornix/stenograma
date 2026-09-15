const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * #324 ACCEPTANCE — SĄMONINGAI KRINTANTIS TESTAS.
 *
 * ⚠️ ŠIS FAILAS YRA LAIKINAS IR PRIVALO BŪTI PAŠALINTAS.
 *
 * Jo vienintelė paskirtis — scenarijus 2: `required-ci` RAUDONAS → merge
 * blokuojamas. Iki aktyvaus ruleset turėjome tik gate elgseną (run
 * `35011861118`), bet ne GitHub merge blokavimą.
 *
 * Kritimas turi būti TRIVIALUS ir nesusijęs su jokia repo garantija: bet kokia
 * tikra patikra čia reikštų, kad matuojame du dalykus vienu metu.
 */
test("#324 ACCEPTANCE: sąmoningai krintantis testas (LAIKINAS)", () => {
  assert.equal(1, 2, "sąmoningas kritimas — #324 scenarijus 2");
});
