const test = require("node:test");
const assert = require("node:assert/strict");
const { groundingCheck, checkOverlap } = require("../utils/groundingCheck");

test("checkOverlap: aukštas persidengimas su transkripcija -> verified=true", () => {
  const transcript = "petras parengs pasiūlymą dėl rinkodaros biudžeto iki penktadienio".toLowerCase();
  const { verified, overlapRatio } = checkOverlap("Petras parengs pasiūlymą dėl biudžeto", transcript);
  assert.equal(verified, true);
  assert.ok(overlapRatio >= 0.5);
});

test("checkOverlap: veiksmas, kurio transkripcijoje apskritai nėra -> verified=false", () => {
  const transcript = "labas, pradedam susitikima, aptarkime biudžetą".toLowerCase();
  const { verified, overlapRatio } = checkOverlap("Reikia nusipirkti raketą į mėnulį iki antradienio", transcript);
  assert.equal(verified, false);
  assert.ok(overlapRatio < 0.5);
});

test("checkOverlap: tuščias/labai trumpas laukas laikomas verified (nėra ką tikrinti)", () => {
  const { verified } = checkOverlap("", "bet koks tekstas");
  assert.equal(verified, true);
});

test("groundingCheck: prideda _grounding kiekvienam veiksmui, neliečia kitų laukų", () => {
  const protocol = {
    pavadinimas: "T",
    data: "D",
    dalyviai: ["Jonas"],
    darbotvarke: [],
    aptarti_klausimai: [],
    nutarimai: [],
    veiksmai: [
      { uzduotis: "Parengti ataskaitą iki penktadienio", atsakingas: "Jonas", terminas: "penktadienis" },
      { uzduotis: "Sugalvotas faktas apie ateivius iš kosmoso", atsakingas: "Nenurodyta", terminas: "Nenurodyta" },
    ],
  };
  const transcript = "Jonas: Aš parengsiu ataskaitą iki penktadienio.";

  const result = groundingCheck(protocol, transcript);

  assert.equal(result.pavadinimas, "T");
  assert.equal(result.veiksmai.length, 2);
  assert.ok(result.veiksmai[0]._grounding.verified);
  assert.ok(!result.veiksmai[1]._grounding.verified);
});

test("groundingCheck: be transkripcijos ar veiksmų grąžina protokolą nepakeistą", () => {
  const protocol = { veiksmai: [] };
  assert.deepEqual(groundingCheck(protocol, ""), protocol);
  assert.deepEqual(groundingCheck(null, "tekstas"), null);
});
