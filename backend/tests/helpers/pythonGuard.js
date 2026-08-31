/**
 * PYTHON3 PRIKLAUSANČIŲ TESTŲ SARGAS (#202).
 *
 * Simetriškas `redisGuard.js` ir `postgresGuard.js`: be `python3` testai
 * praleidžiami, o `REQUIRE_PYTHON=1` paverčia praleidimą KLAIDA.
 *
 * ⚠️ KODĖL `REQUIRE_PYTHON`. Be jo CI galėtų likti žalias niekada nepaleidęs nė
 * vieno Python transkribavimo testo - pakaktų, kad iš runner'io image dingtų
 * interpretatorius. Tyliai praleisti testai yra blogiau nei jų nebuvimas: jie
 * sukuria padengimo iliuziją.
 *
 * ⚠️ ŠIANDIEN SPRAGA YRA LATENTINĖ, NE VEIKIANTI. CI logas rodo, kad testai
 * realiai vykdomi (`ok`), nes `ubuntu-latest` turi `python3` iš anksto. Būtent
 * ta neužtikrinta prielaida čia ir šalinama: `actions/setup-python` daro Python
 * eksplicitinį, o `REQUIRE_PYTHON=1` paverčia jo dingimą matomu gedimu.
 *
 * ⚠️ DETEKCIJA YRA ČIA IR TIK ČIA. Iki #202 tą patį `execSync` bloką turėjo du
 * testų failai. Dvi detekcijos yra defektas, o ne trijų eilučių dubliavimas:
 * pasikeitus taisyklei vienoje vietoje, kita tyliai lieka su sena. Antrą
 * autoritetą gaudo tripwire `tests/pythonGuard.test.js`.
 *
 * ⚠️ TIKRINAMAS TIK INTERPRETATORIUS. Testai naudoja mock skriptus
 * (`tests/fixtures/mock_faster_whisper_*.py`), tad tikro `faster-whisper`
 * modelio nereikia - ir jis SĄMONINGAI netikrinamas, kad sargas nevirstų
 * priklausomybių instaliacijos patikra.
 */

const { execSync } = require("child_process");

let pythonAvailable = true;
try {
  execSync("python3 --version", { stdio: "ignore" });
} catch {
  pythonAvailable = false;
}

const REQUIRED = process.env.REQUIRE_PYTHON === "1";

if (REQUIRED && !pythonAvailable) {
  throw new Error(
    "REQUIRE_PYTHON=1 nustatytas, bet python3 aplinkoje nėra. Privalomas testų " +
      "prerequisite neprieinamas: Python priklausantys testai būtų praleisti " +
      "tyliai, o CI liktų žalias jų nepaleidęs. Įdiekite python3 (CI: " +
      "actions/setup-python) arba nuimkite REQUIRE_PYTHON."
  );
}

/**
 * @returns {false | string} `false` - vykdyti; eilutė - praleidimo priežastis.
 */
function skipWithoutPython() {
  return pythonAvailable
    ? false
    : "reikia python3 interpretatoriaus (CI: REQUIRE_PYTHON=1)";
}

module.exports = { pythonAvailable, REQUIRED, skipWithoutPython, hasPython: pythonAvailable };
