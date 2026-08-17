const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const jobStore = require("../utils/jobStore");
const { OWNER_KIND } = require("../utils/jobStore/common");
const {
  ACCESS_DECISION,
  respondToDenial,
  getAccessActor,
  toAccessInput,
} = require("../utils/jobAccessTransport");

/** Minimalus `res` dublis – tikrinam TIK ką adapteris atsakė. */
function fakeRes() {
  const captured = {};
  return {
    captured,
    status(code) {
      captured.status = code;
      return this;
    },
    json(body) {
      captured.body = body;
      return this;
    },
  };
}

test("#160 ADAPTERIS: store rezultatas → politikos įėjimas", () => {
  assert.equal(toAccessInput(jobStore.FORBIDDEN), "forbidden");
  assert.equal(toAccessInput(null), "missing");
  assert.equal(toAccessInput(undefined), "missing");
  assert.equal(toAccessInput({ id: "x" }), "owned");
});

test("#160 ADAPTERIS: NOT_FOUND → 404 be jokio kodo", () => {
  const res = fakeRes();
  assert.equal(respondToDenial(ACCESS_DECISION.NOT_FOUND, res), true);
  assert.equal(res.captured.status, 404);
  assert.equal(res.captured.body.code, undefined, "404 neturi išduoti priežasties");
});

test("#160 ADAPTERIS: DENIED → 403 su aiškiu kodu", () => {
  const res = fakeRes();
  assert.equal(respondToDenial(ACCESS_DECISION.DENIED, res), true);
  assert.equal(res.captured.status, 403);
  assert.equal(res.captured.body.code, "ADMIN_READ_NOT_ALLOWED");
});

test("#160 ADAPTERIS: teigiami sprendimai NEATSAKO – juos tvarko maršrutas", () => {
  /**
   * Adapteris atsako TIK už neigiamus sprendimus. Jei jis imtų atsakinėti ir
   * už teigiamus, maršrutas negalėtų atskirti override nuo savininko kelio, o
   * šalutinis poveikis nusikeltų į transportą.
   */
  for (const decision of [
    ACCESS_DECISION.OWNER_ACCESS,
    ACCESS_DECISION.ADMIN_DELETE_OVERRIDE,
    ACCESS_DECISION.ADMIN_ORPHAN_CLEANUP,
    ACCESS_DECISION.DESKTOP_ORPHAN_CLEANUP,
  ]) {
    const res = fakeRes();
    assert.equal(respondToDenial(decision, res), false, decision);
    assert.equal(res.captured.status, undefined, `${decision}: neturi atsakyti`);
  }
});

test("#160 ADAPTERIS: aktorius neša IR nuosavybės rūšį, IR rolę", () => {
  /**
   * `isSessionAdmin()` remiasi abiem. Jei adapteris perduotų tik rolę, bendro
   * rakto `administrator` gautų override.
   */
  const sesija = getAccessActor({
    user: { id: "11111111-1111-4111-8111-111111111111" },
    authz: { role: "administrator", source: "session" },
  });
  assert.equal(sesija.ownerKind, OWNER_KIND.USER);
  assert.equal(sesija.role, "administrator");

  const beAuthz = getAccessActor({ user: null });
  assert.equal(beAuthz.role, null, "trūkstamas authz duoda null, ne undefined");
});
