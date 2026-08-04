const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LLM_PROVIDER = "claude";

/**
 * Tiekėjų valdysena (#22.2): išorinis tiekėjas neveikia be patvirtinimo.
 *
 * Šis testas tikrina FAIL-CLOSED matricą redakcijos ir eksporto keliuose, tad
 * patvirtinimas čia yra prielaida. Be jo testas tikrintų valdysenos bloką, ne
 * tai, ką turi tikrinti.
 */
process.env.APPROVED_EXTERNAL_PROVIDERS = "claude";
process.env.ANTHROPIC_API_KEY = "sk-ant-testinis";
process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.DIARIZATION_PROVIDER = "none";
process.env.API_KEY = "";
process.env.LOG_LEVEL = "error";
process.env.TRANSCRIPT_DEDUP = "false";

const { REGISTRY } = require("../providers/llm");
const redactionComponent = require("../utils/redactionComponent");
const privacyPolicy = require("../utils/privacyPolicy");
const { generateProtocol } = require("../services/protocolService");
const { buildExport } = require("../services/exportService");

/**
 * FAIL-CLOSED GARANTIJŲ MATRICA (#15).
 *
 * Kiekviena garantija atskirai jau testuojama ten, kur buvo įgyvendinta:
 * `redactionEnforcement` (32 testai), `exportPolicy` (12), `privacyPolicy`,
 * `redactionErrorLeak`. Šis failas jų nedubliuoja - jis tikrina, kad visos
 * jos elgtųsi VIENODAI.
 *
 * Priežastis: fail-closed yra ne funkcija, o savybė, kuri turi galioti
 * kiekviename kelyje. Kai kiekvienas kelias testuojamas atskirai savo faile,
 * lengva nepastebėti, kad vienas iš jų elgiasi kitaip - būtent taip šioje
 * sesijoje ir nutiko su eksporto guard'u, kuris pasitikėjo `redact()` rezultatu,
 * kai LLM kelias jau tikrino artefakto variantą.
 *
 * MATRICA: kiekvienam keliui × kiekvienam gedimo tipui - ar duomenys išsiuntimo
 * NEPASIEKĖ.
 */

const SECRET = "39001010000";
const TRANSCRIPT = `Jonas Jonaitis, a.k. ${SECRET}, pristatė ketvirčio ataskaitą posėdyje.`;

const PROTOCOL = {
  pavadinimas: "Posėdis",
  data: "2026-03-15",
  dalyviai: [`Jonas, a.k. ${SECRET}`],
  darbotvarke: ["Ataskaita"],
  aptarti_klausimai: [],
  nutarimai: [],
  veiksmai: [],
};

const VALID_PROTOCOL = JSON.stringify(PROTOCOL);

/** Gedimo tipai, kurie turi elgtis VIENODAI visuose keliuose. */
const FAILURES = {
  /** Komponento nėra (#4 dar neįdiegtas arba failas dingo). */
  missing: () => {
    const error = new Error("Cannot find module './piiRedaction'");
    error.code = "MODULE_NOT_FOUND";
    throw error;
  },
  /** Komponentas yra, bet krenta vykdymo metu. */
  throws: () => ({
    redact() {
      throw new Error("redakcijos modelis neveikia");
    },
  }),
  /** Komponentas grąžina netinkamą rezultatą. */
  invalid: () => ({ redact: () => undefined }),
};

function withRedaction(kind, fn) {
  redactionComponent._setLoaderForTests(FAILURES[kind]);
  privacyPolicy._resetForTests();

  return (async () => {
    try {
      return await fn();
    } finally {
      redactionComponent._setLoaderForTests(null);
      privacyPolicy._resetForTests();
    }
  })();
}

function installProvider(t, received) {
  const previous = REGISTRY.claude;

  REGISTRY.claude = class {
    constructor() {
      this.name = "claude";
      this.model = "fake";
    }
    async generateProtocol(payload) {
      received.push(payload);
      return { rawText: VALID_PROTOCOL, usage: null, truncated: false };
    }
  };

  t.after(() => {
    REGISTRY.claude = previous;
  });
}

test("MATRICA: LLM kelias uždarosi visais trimis gedimo tipais", async (t) => {
  const received = [];
  installProvider(t, received);

  const saved = process.env.REQUIRE_REDACTION_BEFORE_EXTERNAL;
  process.env.REQUIRE_REDACTION_BEFORE_EXTERNAL = "true";
  t.after(() => {
    if (saved === undefined) delete process.env.REQUIRE_REDACTION_BEFORE_EXTERNAL;
    else process.env.REQUIRE_REDACTION_BEFORE_EXTERNAL = saved;
    privacyPolicy._resetForTests();
  });

  for (const kind of Object.keys(FAILURES)) {
    received.length = 0;

    await assert.rejects(
      () => withRedaction(kind, () => generateProtocol({ transcript: TRANSCRIPT })),
      (e) => {
        // Klaida negali nešti nei transkripcijos, nei PII.
        const serialized = `${e.message} ${e.stack || ""}`;
        assert.ok(!serialized.includes(SECRET), `${kind}: PII klaidos tekste`);
        return true;
      },
      `${kind}: turėjo nutrūkti`
    );

    assert.equal(received.length, 0, `${kind}: tiekėjas NEGALI būti kviečiamas`);
  }
});

test("MATRICA: eksporto kelias uždarosi tais pačiais trimis tipais", async (t) => {
  const saved = process.env.EXPORT_ALLOW_ORIGINAL;
  process.env.EXPORT_ALLOW_ORIGINAL = "false";
  t.after(() => {
    if (saved === undefined) delete process.env.EXPORT_ALLOW_ORIGINAL;
    else process.env.EXPORT_ALLOW_ORIGINAL = saved;
    privacyPolicy._resetForTests();
  });

  for (const kind of Object.keys(FAILURES)) {
    await assert.rejects(
      () => withRedaction(kind, () => buildExport(PROTOCOL, "txt", "redacted")),
      (e) => {
        assert.ok(!String(e.message).includes(SECRET), `${kind}: PII klaidos tekste`);
        return true;
      },
      `${kind}: eksportas turėjo nutrūkti`
    );
  }
});

test("MATRICA: nė vienas kelias NEGRĄŽINA originalo kaip atsarginio varianto", async (t) => {
  /**
   * Svarbiausias testas visame faile.
   *
   * „Redakcija nepavyko, tad grąžinu originalą" yra patogiausias įmanomas
   * elgesys ir tiksliai tas, kurio negalima leisti: vartotojas gautų
   * neredaguotą dokumentą, manydamas, kad gavo redaguotą.
   */
  const received = [];
  installProvider(t, received);

  const savedLlm = process.env.REQUIRE_REDACTION_BEFORE_EXTERNAL;
  const savedExport = process.env.EXPORT_ALLOW_ORIGINAL;
  process.env.REQUIRE_REDACTION_BEFORE_EXTERNAL = "true";
  process.env.EXPORT_ALLOW_ORIGINAL = "false";

  t.after(() => {
    if (savedLlm === undefined) delete process.env.REQUIRE_REDACTION_BEFORE_EXTERNAL;
    else process.env.REQUIRE_REDACTION_BEFORE_EXTERNAL = savedLlm;
    if (savedExport === undefined) delete process.env.EXPORT_ALLOW_ORIGINAL;
    else process.env.EXPORT_ALLOW_ORIGINAL = savedExport;
    privacyPolicy._resetForTests();
  });

  for (const kind of Object.keys(FAILURES)) {
    // LLM: tiekėjas negavo NIEKO.
    received.length = 0;
    await withRedaction(kind, () => generateProtocol({ transcript: TRANSCRIPT }).catch(() => {}));
    assert.equal(received.length, 0, `${kind}: LLM gavo duomenis po redakcijos gedimo`);

    // Eksportas: failo nėra, o ne yra su originalu.
    let file = null;
    await withRedaction(kind, () =>
      buildExport(PROTOCOL, "txt", "redacted")
        .then((result) => {
          file = result;
        })
        .catch(() => {})
    );
    assert.equal(file, null, `${kind}: eksportas grąžino failą po redakcijos gedimo`);
  }
});

test("MATRICA: veikiant komponentui abu keliai PRALEIDŽIA (apsauga nėra aklas blokas)", async (t) => {
  const received = [];
  installProvider(t, received);

  const savedLlm = process.env.REQUIRE_REDACTION_BEFORE_EXTERNAL;
  const savedExport = process.env.EXPORT_ALLOW_ORIGINAL;
  process.env.REQUIRE_REDACTION_BEFORE_EXTERNAL = "true";
  process.env.EXPORT_ALLOW_ORIGINAL = "false";
  privacyPolicy._resetForTests();

  t.after(() => {
    if (savedLlm === undefined) delete process.env.REQUIRE_REDACTION_BEFORE_EXTERNAL;
    else process.env.REQUIRE_REDACTION_BEFORE_EXTERNAL = savedLlm;
    if (savedExport === undefined) delete process.env.EXPORT_ALLOW_ORIGINAL;
    else process.env.EXPORT_ALLOW_ORIGINAL = savedExport;
    privacyPolicy._resetForTests();
  });

  // Su TIKRU komponentu - ne pakaitalu.
  await generateProtocol({ transcript: TRANSCRIPT });
  const file = await buildExport(PROTOCOL, "txt", "redacted");

  assert.equal(received.length, 1);
  assert.ok(!received[0].includes(SECRET), "tiekėjas negavo asmens kodo");
  assert.ok(!file.buffer.toString("utf8").includes(SECRET), "eksporte nėra asmens kodo");

  // Turinys nedingo - tik identifikatoriai.
  assert.ok(received[0].includes("Jonas Jonaitis"));
  assert.ok(file.buffer.toString("utf8").includes("[ASMENS_KODAS]"));
});
