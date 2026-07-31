const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
// protocolService nuskaito šią vėliavą MODULIO ĮKĖLIMO metu, tad nustatoma
// PRIEŠ require - kitaip override kelias grąžintų 403 ir testas tikrintų ne tai.
process.env.ALLOW_PROVIDER_OVERRIDE = "true";

const { getLLMProvider } = require("../providers/llm");
const { getTranscriptionProvider } = require("../providers/transcription");
const { getDiarizationProvider, isKnownDiarizationMode } = require("../providers/diarization");
const { generateProtocol } = require("../services/protocolService");

/**
 * REGRESIJA (CodeQL: js/unvalidated-dynamic-method-call).
 *
 * REGISTRY yra objekto literalas, tad paveldi Object.prototype. `REGISTRY[name]`
 * ir `name in REGISTRY` grąžindavo teigiamą rezultatą prototipo nariams:
 *
 *   getLLMProvider("constructor")     -> new Object(config), NE tiekėjas
 *   "constructor" in REGISTRY         -> true (override whitelist apeinamas)
 *
 * Praktinė žala: 500 su nesuprantama klaida vietoj aiškaus 400, ir tiekėjo
 * whitelist'as, kuris praleidžia ne tiekėją. Tikrinama hasOwnProperty.
 */

const PROTOTYPE_NAMES = [
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "__proto__",
  "isPrototypeOf",
];

test("LLM fabrika atmeta prototipo narius kaip nežinomus tiekėjus", () => {
  for (const name of PROTOTYPE_NAMES) {
    assert.throws(
      () => getLLMProvider(name),
      /Nežinomas LLM_PROVIDER|Nekorektiška/,
      `"${name}" neturi būti laikomas tiekėju`
    );
  }
});

test("transkribavimo fabrika atmeta prototipo narius", () => {
  for (const name of PROTOTYPE_NAMES) {
    assert.throws(() => getTranscriptionProvider(name), /Nežinomas TRANSCRIPTION_PROVIDER|Nekorektiška/);
  }
});

test("diarizacijos fabrika atmeta prototipo narius", () => {
  for (const name of PROTOTYPE_NAMES) {
    assert.throws(() => getDiarizationProvider(name), /Nežinomas DIARIZATION_PROVIDER|Nekorektiška/);
  }
});

test("isKnownDiarizationMode nelaiko prototipo narių žinomu režimu", () => {
  for (const name of PROTOTYPE_NAMES) {
    assert.equal(isKnownDiarizationMode(name), false, `"${name}" neturi būti žinomas režimas`);
  }

  // Sveikatos patikra: tikri režimai vis dar atpažįstami.
  assert.equal(isKnownDiarizationMode("none"), true);
  assert.equal(isKnownDiarizationMode("mock"), true);
});

test("provider override whitelist'as atmeta 'constructor' su aiškiu 400, ne 500", async () => {
  await assert.rejects(
    () =>
      generateProtocol({
        transcript: "Pakankamai ilga transkripcija testui, kad praeitų validaciją.",
        llmProviderOverride: "constructor",
      }),
    (e) => e.statusCode === 400 && /Nežinomas LLM tiekėjas/.test(e.message)
  );
});

test("tikri tiekėjai po pataisymo veikia (apsauga nėra aklas blokas)", () => {
  assert.ok(getLLMProvider("mock"));
  assert.ok(getTranscriptionProvider("mock"));
  assert.ok(getDiarizationProvider("mock"));
  assert.equal(getDiarizationProvider("none"), null);
});
