const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  MATRIX,
  LOCAL,
  EXTERNAL,
  DEPENDS,
  DATA,
  isExternal,
  describeSelection,
} = require("../utils/providerPrivacy");

const transcriptionRegistry = require("../providers/transcription").REGISTRY;
const diarization = require("../providers/diarization");
const llmRegistry = require("../providers/llm").REGISTRY;

/**
 * GDPR #7: privatumo matrica turi apimti KIEKVIENĄ tiekėją.
 *
 * Šie testai sąmoningai lyginami su tikrais registrais ir README - kad pridėjus
 * naują tiekėją ir pamiršus jį klasifikuoti, testas KRISTŲ, o ne tyliai
 * praleistų neaprašytą išorinį servisą.
 */

const EXPECTED_KEYS = {
  transcription: Object.keys(transcriptionRegistry),
  diarization: [...diarization.SPECIAL_MODES, ...Object.keys(diarization.REGISTRY)],
  llm: Object.keys(llmRegistry),
};

for (const [kind, keys] of Object.entries(EXPECTED_KEYS)) {
  test(`privatumo matrica apima visus ${kind} tiekėjus`, () => {
    const described = Object.keys(MATRIX[kind]);

    for (const key of keys) {
      assert.ok(
        described.includes(key),
        `${kind} tiekėjas "${key}" nėra privatumo matricoje (utils/providerPrivacy.js)`
      );
    }

    // Ir atvirkščiai - matricoje neturi būti nebeegzistuojančių tiekėjų.
    for (const key of described) {
      assert.ok(keys.includes(key), `matricoje aprašytas nebeegzistuojantis "${kind}/${key}"`);
    }
  });

  test(`kiekvienas ${kind} įrašas turi pilną klasifikaciją`, () => {
    for (const [name, entry] of Object.entries(MATRIX[kind])) {
      assert.ok(
        [LOCAL, EXTERNAL, DEPENDS].includes(entry.processing),
        `${kind}/${name}: neteisingas processing`
      );
      assert.ok(
        Object.values(DATA).includes(entry.dataSent),
        `${kind}/${name}: neteisinga dataSent kategorija`
      );
      assert.ok(entry.notes && entry.notes.length > 10, `${kind}/${name}: trūksta paaiškinimo`);

      if (entry.processing === EXTERNAL) {
        assert.ok(entry.vendor, `${kind}/${name}: išoriniam tiekėjui privalomas vendor`);
        assert.notEqual(
          entry.dataSent,
          DATA.NONE,
          `${kind}/${name}: išorinis tiekėjas negali siųsti "none"`
        );
      } else if (entry.processing === LOCAL) {
        assert.equal(entry.vendor, null, `${kind}/${name}: lokalus tiekėjas neturi vendor`);
      }
    }
  });
}

test("README turi kiekvieną tiekėją privatumo lentelėje", () => {
  const readme = fs.readFileSync(path.join(__dirname, "..", "..", "README.md"), "utf8");

  const section = readme.slice(readme.indexOf("### Tiekėjų privatumo matrica"));
  assert.ok(section.length > 500, "README trūksta tiekėjų privatumo matricos skyriaus");

  for (const keys of Object.values(EXPECTED_KEYS)) {
    for (const key of keys) {
      assert.ok(
        section.includes(`\`${key}\``),
        `README privatumo lentelėje nėra tiekėjo "${key}"`
      );
    }
  }
});

test("README nedaro nepagrįstų atitikties teiginių apie išorinius tiekėjus", () => {
  const readme = fs.readFileSync(path.join(__dirname, "..", "..", "README.md"), "utf8");

  // Neturi būti teiginių tipo "Claude yra GDPR compliant".
  for (const vendor of ["OpenAI", "Anthropic", "Deepgram", "AssemblyAI", "Azure"]) {
    const bad = new RegExp(`${vendor}[^.\\n]{0,40}(GDPR compliant|atitinka BDAR)`, "i");
    assert.doesNotMatch(readme, bad, `README teigia, kad ${vendor} yra atitinkantis - taip tvirtinti negalima`);
  }
});

test("isExternal: nežinomas tiekėjas laikomas išoriniu (fail-safe)", () => {
  assert.equal(isExternal("llm", "claude"), true);
  assert.equal(isExternal("llm", "mock"), false);
  assert.equal(isExternal("transcription", "faster-whisper-embedded"), false);
  assert.equal(isExternal("llm", "nauja-nezinoma-paslauga"), true);
});

test("describeSelection: pilnai lokali konfigūracija neturi išorinių tiekėjų", () => {
  const result = describeSelection({
    TRANSCRIPTION_PROVIDER: "faster-whisper-embedded",
    DIARIZATION_PROVIDER: "pyannote",
    LLM_PROVIDER: "mock",
  });

  assert.equal(result.anyExternal, false);
  assert.deepEqual(result.externalProviders, []);
});

test("describeSelection: inline diarizacija atskirai neskaičiuojama", () => {
  // inline neturi savo API kvietimo - privatumo poveikis yra transkribavimo tiekėjo.
  const local = describeSelection({
    TRANSCRIPTION_PROVIDER: "faster-whisper-embedded",
    DIARIZATION_PROVIDER: "inline",
    LLM_PROVIDER: "mock",
  });
  assert.equal(local.anyExternal, false);

  const external = describeSelection({
    TRANSCRIPTION_PROVIDER: "deepgram",
    DIARIZATION_PROVIDER: "inline",
    LLM_PROVIDER: "mock",
  });
  assert.equal(external.anyExternal, true);
  assert.deepEqual(
    external.externalProviders.map((item) => item.kind),
    ["transcription"]
  );
});

test("describeSelection: nurodo, kokie duomenys išeina", () => {
  const result = describeSelection({
    TRANSCRIPTION_PROVIDER: "whisper",
    LLM_PROVIDER: "claude",
  });

  const byKind = Object.fromEntries(result.externalProviders.map((item) => [item.kind, item]));

  assert.equal(byKind.transcription.dataSent, DATA.AUDIO);
  assert.equal(byKind.transcription.vendor, "OpenAI");
  assert.equal(byKind.llm.dataSent, DATA.TRANSCRIPT);
  assert.equal(byKind.llm.vendor, "Anthropic");
});
