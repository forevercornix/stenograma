const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const jobStore = require("../utils/jobStore");
const { OPERATION, reikiaRezultato } = require("../utils/jobAccessPolicy");
const { resolveJobAccess } = require("../utils/jobAccessTransport");

/**
 * HIDRATACIJA YRA OPERACIJOS SPRENDIMAS (#157, PR-3, Codex P1 #291).
 *
 * ⚠️ GRANDINĖ PRASIDEDA MARŠRUTE, NE SAUGYKLOJE.
 *
 * `resolveJobAccess()` naudoja KIEKVIENAS interaktyvus endpoint'as: `routes/jobs.js`
 * (READ ir DELETE), `routes/transcribeJobs.js` (READ ir DELETE) ir `routes/exports.js`.
 * Praėjusio raundo peržiūra vyko saugyklos metodų lygmenyje ir šio kelio nepamatė —
 * `getOwned()` buvo sutvarkytas viduje, o produkcinis `DELETE` toliau hidratavo.
 *
 * ⚠️ TESTAS SU `removeOwned()` ŠITO NEPADENGTŲ: maršrutas jo nekviečia. Todėl
 * tikrinama, ką operacija PERDUODA saugyklai — saitas su kvietimo vieta, ne
 * tvirtinimas „niekas nekviečia".
 */

function fakeReq(ownerId = "11111111-1111-1111-1111-111111111111") {
  return {
    authz: { role: "user", actor: ownerId },
    session: { user: { id: ownerId, role: "user", username: "t" } },
    user: { id: ownerId },
  };
}

test("politika: `DELETE` rezultato NEREIKALAUJA, `READ` ir `EXPORT` — reikalauja", () => {
  /**
   * ⚠️ `DELETE` rezultato nenaudoja (`lifecycleService.deleteJobArtefacts()` skaito
   * metaduomenis), bet už jį mokėjo — ir krisdavo ties hidratacija BŪTENT tada, kai
   * objektas sugadintas, t. y. tuo atveju, kuriam ištrynimo kelias ir reikalingas.
   */
  assert.equal(reikiaRezultato(OPERATION.DELETE), false);
  assert.equal(reikiaRezultato(OPERATION.READ), true);
  assert.equal(reikiaRezultato(OPERATION.EXPORT), true);

  /** Nežinoma operacija — klaida, ne numatytoji reikšmė. */
  assert.throws(() => reikiaRezultato("kazkas"), TypeError);
});

test("KIEKVIENA operacija perduoda savo sprendimą saugyklai", async (t) => {
  /**
   * ⚠️ SAITAS SU KVIETIMO VIETA. Mutacija: įrašius `{ hydrate: true }` kietai arba
   * pašalinus argumentą — šis testas krenta.
   */
  const originalus = jobStore.get;
  const kvietimai = [];

  jobStore.get = async (scope, nustatymai) => {
    kvietimai.push({ operacija: scope.jobId, nustatymai });
    return null;
  };
  t.after(() => {
    jobStore.get = originalus;
  });

  for (const operacija of [OPERATION.READ, OPERATION.EXPORT, OPERATION.DELETE]) {
    await resolveJobAccess(fakeReq(), operacija, operacija);
  }

  assert.deepEqual(
    kvietimai.map((k) => [k.operacija, k.nustatymai && k.nustatymai.hydrate]),
    [
      [OPERATION.READ, true],
      [OPERATION.EXPORT, true],
      [OPERATION.DELETE, false],
    ],
    "sprendimą priima OPERACIJA, ne kvietėjas"
  );
});
