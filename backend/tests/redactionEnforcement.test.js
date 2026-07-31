const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";

const { REGISTRY } = require("../providers/llm");
const { RedactionError } = require("../providers/llm/RedactingLLMProvider");
const redactionComponent = require("../utils/redactionComponent");
const { generateProtocol } = require("../services/protocolService");

/**
 * GDPR #5: REDAKCIJOS VYKDYMAS REALIAME TIEKĖJO KVIETIMO KELYJE.
 *
 * Skirtumas nuo tests/privacyConfig.test.js: ten įrodoma, kad konfigūracija
 * validuojama. ČIA įrodoma priėmimo kriterijus - kad neredaguoti duomenys
 * FIZIŠKAI nepasiekia išorinio tiekėjo. Testuojama per `generateProtocol`, o ne
 * per fabriką, nes būtent tuo keliu eina IR inline (routes/generate.js), IR
 * BullMQ (queues/processors.js) vykdymas.
 */

const ASMENS_KODAS = "39001010000";
const TRANSCRIPT = `Jonas Jonaitis, asmens kodas ${ASMENS_KODAS}, pristatė ketvirčio ataskaitą ir pasiūlė balsuoti.`;

const VALID_PROTOCOL = JSON.stringify({
  pavadinimas: "Testas",
  data: "2026-01-01",
  dalyviai: ["Jonas"],
  darbotvarke: ["Ataskaita"],
  aptarti_klausimai: [{ klausimas: "Ataskaita", santrauka: "Pristatyta" }],
  nutarimai: ["Patvirtinta"],
  veiksmai: [{ uzduotis: "Parengti", atsakingas: "Jonas", terminas: "2026-02-01" }],
});

/**
 * Netikras IŠORINIS tiekėjas: nežinomas vardas => isExternal() grąžina true.
 *
 * REGISTRY yra bendras modulio lygio objektas, tad įrašas PRIVALO būti pašalintas
 * po testo - kitaip nutekėtų į kitus testus tame pačiame procese (`node --test`
 * kelis failus vykdo bendrai) ir sukurtų sunkiai randamą priklausomybę nuo eilės.
 *
 * @param {import("node:test").TestContext} t
 * @param {(payload: string) => object} [respond]
 */
function registerFakeProvider(t, received, respond) {
  const previous = REGISTRY.fake_external;
  const hadPrevious = Object.prototype.hasOwnProperty.call(REGISTRY, "fake_external");

  REGISTRY.fake_external = class FakeExternalProvider {
    constructor() {
      this.name = "fake_external";
      this.model = "fake-1";
    }
    async generateProtocol(payload) {
      received.push(payload);
      return respond
        ? respond(payload)
        : { rawText: VALID_PROTOCOL, usage: null, truncated: false };
    }
  };

  t.after(() => {
    if (hadPrevious) REGISTRY.fake_external = previous;
    else delete REGISTRY.fake_external;
  });
}

function withEnv(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return (async () => {
    try {
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  })();
}

function withRedactor(redact, fn) {
  redactionComponent._setLoaderForTests(redact ? () => ({ redact }) : null);
  return (async () => {
    try {
      return await fn();
    } finally {
      redactionComponent._setLoaderForTests(null);
    }
  })();
}

const ENFORCED_ENV = {
  LLM_PROVIDER: "fake_external",
  REQUIRE_REDACTION_BEFORE_EXTERNAL: "true",
  TRANSCRIPT_DEDUP: "false",
};

test("redact() iškviečiamas, o išorinis tiekėjas gauna TIK redaguotą payload'ą", async (t) => {
  const received = [];
  const redactCalls = [];
  registerFakeProvider(t, received);

  const redact = (text) => {
    redactCalls.push(text);
    return text.replaceAll(ASMENS_KODAS, "[ASMENS_KODAS]");
  };

  await withEnv(ENFORCED_ENV, () =>
    withRedactor(redact, () => generateProtocol({ transcript: TRANSCRIPT }))
  );

  assert.equal(redactCalls.length > 0, true, "redact() turi būti iškviestas");
  assert.equal(received.length, 1, "tiekėjas turi būti iškviestas vieną kartą");

  // Priėmimo kriterijus: originali eilutė NEPASIEKĖ tiekėjo.
  assert.ok(!received[0].includes(ASMENS_KODAS), "tiekėjas gavo NEREDAGUOTĄ asmens kodą");
  assert.ok(received[0].includes("[ASMENS_KODAS]"), "tiekėjas turi gauti redaguotą tekstą");
});

test("redact() klaidos atveju tiekėjas apskritai NEKVIEČIAMAS (fail-closed)", async (t) => {
  const received = [];
  registerFakeProvider(t, received);

  const redact = () => {
    throw new Error("redakcijos modelis neveikia");
  };

  await assert.rejects(
    () => withEnv(ENFORCED_ENV, () => withRedactor(redact, () => generateProtocol({ transcript: TRANSCRIPT }))),
    (e) => /redakcija nepavyko|REDACTION_FAILED|redakcijos/i.test(e.message)
  );

  assert.equal(received.length, 0, "po redakcijos klaidos tiekėjas negali būti kviečiamas");
});

test("netinkamas redact() rezultatas (undefined) taip pat blokuoja kvietimą", async (t) => {
  const received = [];
  registerFakeProvider(t, received);

  await assert.rejects(
    () =>
      withEnv(ENFORCED_ENV, () =>
        withRedactor(() => undefined, () => generateProtocol({ transcript: TRANSCRIPT }))
      ),
    (e) => /netinkamą rezultatą|REDACTION_FAILED/i.test(e.message)
  );

  assert.equal(received.length, 0);
});

test("REPAIR RETRY payload'as taip pat redaguojamas (antras kvietimas nepraslysta)", async (t) => {
  const received = [];

  // Pirmas atsakymas - blogas JSON, tad protocolService siunčia repair prompt'ą.
  let call = 0;
  registerFakeProvider(t, received, () => {
    call += 1;
    return { rawText: call === 1 ? "ne JSON" : VALID_PROTOCOL, usage: null, truncated: false };
  });

  const redact = (text) => text.replaceAll(ASMENS_KODAS, "[ASMENS_KODAS]");

  await withEnv(ENFORCED_ENV, () =>
    withRedactor(redact, () => generateProtocol({ transcript: TRANSCRIPT }))
  );

  assert.equal(received.length, 2, "turi būti pirmas kvietimas ir repair retry");
  for (const payload of received) {
    assert.ok(!payload.includes(ASMENS_KODAS), "nė vienas payload'as negali turėti asmens kodo");
  }
});

test("LOKALUS tiekėjas neapvyniojamas - redakcija nekviečiama", async () => {
  const redactCalls = [];

  await withEnv({ ...ENFORCED_ENV, LLM_PROVIDER: "mock" }, () =>
    withRedactor(
      (text) => {
        redactCalls.push(text);
        return text;
      },
      () => generateProtocol({ transcript: TRANSCRIPT })
    )
  );

  assert.equal(redactCalls.length, 0, "lokaliam tiekėjui redakcija nereikalinga");
});

test("REGRESIJA: be REQUIRE_REDACTION_BEFORE_EXTERNAL išorinis tiekėjas gauna originalą", async (t) => {
  const received = [];
  registerFakeProvider(t, received);

  await withEnv({ ...ENFORCED_ENV, REQUIRE_REDACTION_BEFORE_EXTERNAL: undefined }, () =>
    withRedactor((text) => text.replaceAll(ASMENS_KODAS, "[ASMENS_KODAS]"), () =>
      generateProtocol({ transcript: TRANSCRIPT })
    )
  );

  // Tai NE saugumo savybė, o esamos elgsenos fiksavimas: vėliava išjungta =
  // niekas nesikeičia. Testas saugo nuo netyčinio redakcijos įjungimo visiems.
  assert.ok(received[0].includes(ASMENS_KODAS));
});

test("įjungta vėliava be #4 modulio: tiekėjas nekviečiamas ir be startup validacijos", async (t) => {
  const received = [];
  registerFakeProvider(t, received);

  await assert.rejects(
    () => withEnv(ENFORCED_ENV, () => generateProtocol({ transcript: TRANSCRIPT })),
    (e) => /redakcijos komponentas nepasiekiamas|missing/i.test(e.message)
  );

  assert.equal(received.length, 0);
});

test("FAKTAS, o ne prognozė: fabrika grąžina apvyniotą tiekėją", async (t) => {
  registerFakeProvider(t, []);
  const { getLLMProvider } = require("../providers/llm");

  await withEnv(ENFORCED_ENV, () =>
    withRedactor((text) => text, async () => {
      const provider = getLLMProvider();
      assert.equal(provider.redactionEnforced, true);
      assert.equal(provider.constructor.name, "RedactingLLMProvider");
      // Proxy laukai audito įrašui neturi dingti po apvyniojimo.
      assert.equal(provider.name, "fake_external");
      assert.equal(provider.model, "fake-1");
    })
  );

  // Lokalus tiekėjas lieka neapvyniotas.
  await withEnv({ ...ENFORCED_ENV, LLM_PROVIDER: "mock" }, () =>
    withRedactor((text) => text, async () => {
      assert.notEqual(getLLMProvider().redactionEnforced, true);
    })
  );
});


/**
 * ---------------------------------------------------------------------------
 * AUDIO KELIAS: runtime override negali apeiti draudimo.
 *
 * Startup validacija mato tik .env. Tiekėją galima pakeisti UŽKLAUSOJE
 * (transcriptionService perduoda override; diarizacijos režimas ateina tiesiai
 * iš užklausos), todėl apsauga privalo būti fabrikoje.
 * ---------------------------------------------------------------------------
 */

const { getTranscriptionProvider } = require("../providers/transcription");
const { getDiarizationProvider } = require("../providers/diarization");

const LOCAL_AUDIO_ENV = {
  REQUIRE_REDACTION_BEFORE_EXTERNAL: "true",
  TRANSCRIPTION_PROVIDER: "faster-whisper-embedded",
  DIARIZATION_PROVIDER: "none",
};

test("lokali .env, bet IŠORINIS transkribavimo override - tiekėjas nesukuriamas", async () => {
  // Su raktais aplinkoje: įrodom, kad blokuoja PRIVATUMO taisyklė, o ne
  // atsitiktinis "trūksta API rakto" - kitaip testas praeitų dėl ne tos priežasties.
  await withEnv({ ...LOCAL_AUDIO_ENV, OPENAI_API_KEY: "sk-test", DEEPGRAM_API_KEY: "dg", AZURE_SPEECH_KEY: "az", AZURE_SPEECH_REGION: "eu", GOOGLE_APPLICATION_CREDENTIALS: "/tmp/x.json" }, async () => {
    for (const external of ["whisper", "deepgram", "azure", "google"]) {
      assert.throws(
        () => getTranscriptionProvider(external),
        (e) => e.code === "PRIVACY_AUDIO_PROVIDER_FORBIDDEN" && /garso dengti negali/.test(e.message),
        `${external} turėjo būti blokuotas`
      );
    }
  });
});

test("lokali .env, bet DEBESŲ diarizacijos override - tiekėjas nesukuriamas", async () => {
  await withEnv(LOCAL_AUDIO_ENV, async () => {
    for (const external of ["pyannote-cloud", "assemblyai"]) {
      assert.throws(
        () => getDiarizationProvider(external),
        (e) => e.code === "PRIVACY_AUDIO_PROVIDER_FORBIDDEN",
        `${external} turėjo būti blokuotas`
      );
    }
  });
});

test("LOKALŪS override variantai praeina (apsauga nėra plataus veikimo blokas)", async () => {
  await withEnv(LOCAL_AUDIO_ENV, async () => {
    assert.ok(getTranscriptionProvider("faster-whisper-embedded"));
    assert.ok(getTranscriptionProvider("mock"));
    assert.ok(getDiarizationProvider("pyannote"));
    assert.equal(getDiarizationProvider("none"), null);
    assert.equal(getDiarizationProvider("inline"), null);
  });
});

test("be vėliavos runtime override nėra ribojamas (esamos elgsenos fiksavimas)", async () => {
  await withEnv(
    { ...LOCAL_AUDIO_ENV, REQUIRE_REDACTION_BEFORE_EXTERNAL: undefined, OPENAI_API_KEY: "sk-test" },
    async () => {
      assert.ok(getTranscriptionProvider("whisper"));
    }
  );
});

test("RedactionError NEPERNEŠA cause.message - redakcijos klaida netampa PII nutekėjimu", async (t) => {
  const received = [];
  registerFakeProvider(t, received);

  const SECRET = "Jonas Jonaitis 39001010000";
  const redact = () => {
    throw new Error(`nepavyko apdoroti: ${SECRET}`);
  };

  let caught;
  await withEnv(ENFORCED_ENV, () =>
    withRedactor(redact, () => generateProtocol({ transcript: TRANSCRIPT }).catch((e) => (caught = e)))
  );

  assert.ok(caught, "klaida turėjo būti mesta");
  const serialized = `${caught.message} ${JSON.stringify(caught)} ${caught.stack || ""}`;
  assert.ok(!serialized.includes(SECRET), "jautrus cause.message negali patekti į klaidą");
  assert.equal(received.length, 0);
});

test("laisvas tekstas cause.code lauke NEPERNEŠAMAS (normalizuojama į null)", () => {
  const dirty = new Error("x");
  dirty.code = "Jonas Jonaitis 39001010000";
  dirty.name = "Error";

  const err = new RedactionError("redakcija nepavyko", dirty);

  assert.equal(err.causeCode, null, "kodo pavidalo neatitinkanti reikšmė turi virsti null");
  assert.equal(err.causeName, "Error");
  assert.ok(!JSON.stringify(err).includes("39001010000"));
});

test("normalus kodas išsaugomas (normalizavimas nėra aklas trynimas)", () => {
  const cause = new Error("x");
  cause.code = "ETIMEDOUT";

  assert.equal(new RedactionError("m", cause).causeCode, "ETIMEDOUT");
});

// PASKUTINIS testas faile SĄMONINGAI: tikrina, kad visi aukščiau esantys
// atstatė REGISTRY. Perkeltas į galą, nes anksčiau buvo vykdomas prieš dalį
// testų ir jų taršos nebūtų pagavęs.
test("REGISTRY po visų testų neturi likti užterštas", () => {
  assert.equal(Object.prototype.hasOwnProperty.call(REGISTRY, "fake_external"), false);
});
