const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { ArtifactStoreError, paruostiReiksme, patikrintiRakta } = require("../utils/artifactStore/validation");
const jobRunner = require("../queues/jobRunner");

/**
 * ARTEFAKTŲ KLAIDŲ KLASIFIKAVIMAS IR NEATKARTOJAMUMAS (#157, PR-2).
 *
 * ⚠️ KODĖL TAI ATSKIRAS TESTAS.
 *
 * Kontraktinis rinkinys tikrina, KAD reikšmė atmetama. Čia tikrinama, kas su ta
 * klaida nutinka TOLIAU: ar ji atpažįstama kaip domeninė, ar neša savo kodą ir
 * ar pažymėta kaip neatkartojama. Be to struktūrinis atmetimas virstų
 * `internal_error`, o BullMQ jį kartotų `attempts` kartų - kiekvienas bandymas
 * yra pilnas transkribavimas arba LLM kvietimas (#153 pamoka).
 */

test("STRUKTŪRINIS ATMETIMAS pažymėtas kaip neatkartojamas", () => {
  const NUL = String.fromCharCode(0);

  const atvejai = [
    ["Date (prototipo toJSON)", () => paruostiReiksme({ d: new Date(0) })],
    ["NUL tekste", () => paruostiReiksme({ t: `a${NUL}b` })],
    ["ciklinė nuoroda", () => paruostiReiksme((() => { const o = {}; o.s = o; return o; })())],
    ["BigInt", () => paruostiReiksme({ n: BigInt(1) })],
    ["blogas raktas", () => patikrintiRakta("results/../x")],
  ];

  for (const [vardas, veiksmas] of atvejai) {
    let klaida = null;
    try {
      veiksmas();
    } catch (e) {
      klaida = e;
    }

    assert.ok(klaida instanceof ArtifactStoreError, `${vardas}: privalo būti domeninė klaida`);
    assert.equal(klaida.neatkartojama, true, `${vardas}: pakartojimas duotų tą patį rezultatą`);
  }
});

test("KLASIFIKATORIUS: artefakto klaida neša SAVO kodą, ne `internal_error`", () => {
  const klaida = new ArtifactStoreError("nesaugotina", "ARTIFACT_VALUE_UNSUPPORTED", {
    neatkartojama: true,
  });

  assert.equal(jobRunner._classifyError(klaida, "testas").errorCode, "ARTIFACT_VALUE_UNSUPPORTED");

  /**
   * ⚠️ IR PER `cause`. `UnrecoverableError` originalią klaidą perduoda būtent taip
   * (`workers/index.js:359-366`), tad be šios šakos completion kelyje kodas
   * dingtų kaip tik ten, kur jo reikia.
   */
  const suvyniota = new Error("gaubianti");
  suvyniota.cause = klaida;
  assert.equal(jobRunner._classifyError(suvyniota, "testas").errorCode, "ARTIFACT_VALUE_UNSUPPORTED");

  const nerasta = new ArtifactStoreError("nėra", "ARTIFACT_NOT_FOUND");
  assert.equal(
    jobRunner._classifyError(nerasta, "testas").errorCode,
    "ARTIFACT_NOT_FOUND",
    "dingęs objektas ir nesaugotina reikšmė yra SKIRTINGI atvejai"
  );
});

test("KONTROLĖ: svetima klaida ir toliau `internal_error`", () => {
  /**
   * Be jos ankstesnis testas praeitų ir tada, jei klasifikatorius KIEKVIENĄ
   * klaidą imtų grąžinti su jos `code` lauku.
   */
  assert.equal(jobRunner._classifyError(new Error("kažkas"), "testas").errorCode, "internal_error");

  const svetima = new Error("su kodu");
  svetima.code = "ENOENT";
  assert.equal(jobRunner._classifyError(svetima, "testas").errorCode, "internal_error");
});
