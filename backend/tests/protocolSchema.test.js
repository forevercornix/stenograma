const test = require("node:test");
const assert = require("node:assert/strict");
const { validate, tryParse, buildRepairPrompt } = require("../schema/protocolSchema");

test("validate: pilnai validus objektas praeina", () => {
  const obj = {
    pavadinimas: "Test",
    data: "2026-07-09",
    dalyviai: ["Jonas"],
    darbotvarke: ["Punktas"],
    aptarti_klausimai: [{ klausimas: "K", santrauka: "S" }],
    nutarimai: ["N"],
    veiksmai: [{ uzduotis: "U", atsakingas: "A", terminas: "T" }],
  };
  const { valid, errors } = validate(obj);
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test("validate: trūkstamas privalomas laukas nurodomas klaidoje", () => {
  const obj = { pavadinimas: "Test" };
  const { valid, errors } = validate(obj);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("data")));
  assert.ok(errors.some((e) => e.includes("dalyviai")));
});

test("validate: neteisingas tipas masyvo lauke nurodomas klaidoje", () => {
  const obj = {
    pavadinimas: "T",
    data: "D",
    dalyviai: "ne masyvas",
    darbotvarke: [],
    aptarti_klausimai: [],
    nutarimai: [],
    veiksmai: [],
  };
  const { valid, errors } = validate(obj);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('"dalyviai"')));
});

test("validate: veiksmai objektų laukai turi būti string", () => {
  const obj = {
    pavadinimas: "T",
    data: "D",
    dalyviai: [],
    darbotvarke: [],
    aptarti_klausimai: [],
    nutarimai: [],
    veiksmai: [{ uzduotis: 123, atsakingas: "A", terminas: "T" }],
  };
  const { valid, errors } = validate(obj);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("veiksmai[0].uzduotis")));
});

test("tryParse: nuima markdown code-fence žymas prieš parsinant", () => {
  const raw = '```json\n{"pavadinimas":"T","data":"D","dalyviai":[],"darbotvarke":[],"aptarti_klausimai":[],"nutarimai":[],"veiksmai":[]}\n```';
  const { success, data } = tryParse(raw);
  assert.equal(success, true);
  assert.equal(data.pavadinimas, "T");
});

test("tryParse: nevalidus JSON grąžina success=false su klaidos priežastimi", () => {
  const { success, errors } = tryParse("tikrai ne json {");
  assert.equal(success, false);
  assert.ok(errors[0].includes("JSON parse klaida"));
});

test("tryParse: validus JSON, bet trūksta lauko - schema klaida, ne parse klaida", () => {
  const { success, errors } = tryParse('{"pavadinimas":"T"}');
  assert.equal(success, false);
  assert.ok(errors.some((e) => e.includes("Trūksta lauko")));
});

test("buildRepairPrompt: įtraukia klaidas ir originalų atsakymą", () => {
  const prompt = buildRepairPrompt("blogas json", ["Trūksta lauko \"data\""]);
  assert.ok(prompt.includes("blogas json"));
  assert.ok(prompt.includes("Trūksta lauko"));
});
