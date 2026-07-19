const test = require("node:test");
const assert = require("node:assert/strict");
const MockLLMProvider = require("../providers/llm/MockLLMProvider");
const { buildPrompt } = require("../prompts");

test("MockLLMProvider: ištraukia darbotvarkę/veiksmus iš TIKROS transkripcijos, ne statinio pavyzdžio", async () => {
  const { prompt } = buildPrompt({
    title: "Testinis susitikimas",
    date: "2026-07-09",
    participants: [],
    transcript: "Jonas: Sveiki, pradedam. Reikia parengti ataskaitą iki penktadienio.",
  });

  const { rawText } = await new MockLLMProvider().generateProtocol(prompt);
  const protocol = JSON.parse(rawText);

  assert.equal(protocol.pavadinimas, "Testinis susitikimas");
  assert.deepEqual(protocol.dalyviai, ["Jonas"]);
  // REGRESIJOS TESTAS: meeting_v2.js prompt injection apsaugos tekstas PATS mini
  // '"""' kaip pavyzdį, todėl naivus "pirmas """ ... """ atitikimas" regex
  // anksčiau pagaudavo NETEISINGĄ (instrukcijų) bloką vietoj tikros transkripcijos.
  // Šis testas užtikrina, kad darbotvarkė/veiksmai kilę iš TIKRO pokalbio, o ne
  // iš prompt teksto apie "ignoruok ankstesnes instrukcijas" ir pan.
  assert.ok(protocol.darbotvarke.some((d) => d.includes("Sveiki, pradedam")));
  assert.ok(!protocol.darbotvarke.some((d) => d.includes("DUOMENYS") || d.includes("instrukcij")));
  assert.equal(protocol.veiksmai.length, 1);
  assert.match(protocol.veiksmai[0].uzduotis, /parengti ataskaitą/);
  assert.equal(protocol.veiksmai[0].terminas, "penktadienio");
});

test("MockLLMProvider: veikia identiškai su senu meeting_v1 promptu (be injekcijos apsaugos teksto)", async () => {
  const { prompt } = buildPrompt(
    {
      title: "Senas formatas",
      date: "2026-01-01",
      participants: [],
      transcript: "Asta: Labas. Turime patvirtinti biudžetą iki kovo 1 d.",
    },
    "meeting_v1"
  );

  const { rawText } = await new MockLLMProvider().generateProtocol(prompt);
  const protocol = JSON.parse(rawText);

  assert.equal(protocol.pavadinimas, "Senas formatas");
  assert.ok(protocol.darbotvarke.some((d) => d.includes("Labas")));
});

test("MockLLMProvider: dalyvių sąrašas ištraukiamas iš 'Vardas:' žymų, kai rankomis nenurodyta", async () => {
  const { prompt } = buildPrompt({
    title: "T",
    date: "D",
    participants: [],
    transcript: "Petras: Labas.\nAsta: Sveiki.\nPetras: Tęskime.",
  });
  const { rawText } = await new MockLLMProvider().generateProtocol(prompt);
  const protocol = JSON.parse(rawText);
  assert.deepEqual(protocol.dalyviai, ["Petras", "Asta"]);
});
