const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * GDPR #4: MARŠRUTO IR WORKER LYGIO ĮRODYMAI.
 *
 * Servisų testai tikrina `generateProtocol()`, bet `protocolVariant` ir
 * `sourceTranscriptVariant` pridedami MARŠRUTO sluoksnyje - tad servisų testai
 * jų apskritai nemato. Ta pati problema ir su worker keliu: #5 parity testas
 * įrodė bendrą enforcement faktą, bet #4 pakeitė artefaktų modelį, kategorijų
 * politiką, `sourceRedactionAudit` ir metaduomenų semantiką.
 *
 * Čia tas pats REALUS transkriptas leidžiamas per abu įėjimus ir tikrinamas
 * identiškas rezultatas - su tikru `utils/piiRedaction.js`, be pakaitalų.
 */

process.env.NODE_ENV = "test";
/**
 * Naudojam TIKRĄ išorinio tiekėjo vardą, o ne išgalvotą.
 *
 * `utils/startupChecks.js` turi savo KNOWN_LLM sąrašą, atskirą nuo
 * `providers/llm` REGISTRY, tad `fake_external` neperpraeitų startup validacijos.
 * `claude` yra išorinis (`isExternal("llm","claude") === true`), o pačią klasę
 * REGISTRY'je pakeičiam netikra - taip testuojam realų enforcement kelią.
 */
process.env.LLM_PROVIDER = "claude";

/**
 * Tiekėjų valdysena (#22.2): išorinis tiekėjas neveikia be eksplicitinio
 * patvirtinimo — nei startup metu, nei fabrike.
 *
 * Testas tikrina REDAKCIJOS elgesį su išoriniu tiekėju, tad patvirtinimas čia
 * yra prielaida, ne tikrinamas dalykas. Be jo serveris apskritai
 * nepasileistų.
 */
process.env.APPROVED_EXTERNAL_PROVIDERS = "claude";
process.env.ANTHROPIC_API_KEY = "sk-ant-testinis";
process.env.REQUIRE_REDACTION_BEFORE_EXTERNAL = "true";
process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.DIARIZATION_PROVIDER = "none";
process.env.TRANSCRIPT_DEDUP = "false";
process.env.API_KEY = "";

const { REGISTRY } = require("../providers/llm");

const request = require("supertest");
const { protocolProcessor } = require("../queues/processors");
const app = require("../server");
app._setReadyForTests();

const ASMENS_KODAS = "39001010000";
const EL_PASTAS = "jonas.jonaitis@imone.lt";
const TRANSCRIPT =
  `Jonas Jonaitis, a.k. ${ASMENS_KODAS}, el. p. ${EL_PASTAS}, ` +
  "pristatė ketvirčio ataskaitą ir pasiūlė balsuoti dėl biudžeto.";

const VALID_PROTOCOL = JSON.stringify({
  pavadinimas: "Posėdis",
  data: "2026-01-01",
  dalyviai: ["Jonas"],
  darbotvarke: ["Ataskaita"],
  aptarti_klausimai: [{ klausimas: "Ataskaita", santrauka: "Pristatyta" }],
  nutarimai: ["Patvirtinta"],
  veiksmai: [{ uzduotis: "Parengti", atsakingas: "Jonas", terminas: "2026-02-01" }],
});

const seen = { payloads: [] };

function installProvider(t, respond) {
  const previous = REGISTRY.claude;

  REGISTRY.claude = class {
    constructor() {
      this.name = "claude";
      this.model = "fake-1";
    }
    async generateProtocol(payload) {
      seen.payloads.push(payload);
      return respond
        ? respond(payload)
        : { rawText: VALID_PROTOCOL, usage: null, truncated: false };
    }
  };

  t.after(() => {
    REGISTRY.claude = previous;
  });
}

function reset() {
  seen.payloads.length = 0;
}

test("ROUTE: /api/generate grąžina ABU variantų laukus", async (t) => {
  reset();
  installProvider(t);

  const res = await request(app).post("/api/generate").send({ transcript: TRANSCRIPT });

  assert.equal(res.status, 200);

  // Šiuos laukus prideda maršrutas, ne servisas - servisų testai jų nemato.
  assert.equal(res.body.protocolVariant, "generated");
  assert.equal(res.body.sourceTranscriptVariant, "redacted");

  assert.equal(res.body.redaction.redactionStatus, "redacted");
  assert.equal(res.body.redaction.outcome, "sent");
  assert.match(res.body.redaction.policyVersion, /^pii-v\d+$/);
  assert.equal(res.body.redaction.redactionStats.PERSONAL_CODE, 1);
  assert.equal(res.body.redaction.redactionStats.EMAIL, 1);

  // Ir tiekėjas tikrai negavo originalo.
  assert.equal(seen.payloads.length, 1);
  assert.ok(!seen.payloads[0].includes(ASMENS_KODAS));
  assert.ok(!seen.payloads[0].includes(EL_PASTAS));
});

test("ROUTE: be enforcement šaltinio variantas yra `original`", async (t) => {
  reset();
  installProvider(t);

  const saved = process.env.REQUIRE_REDACTION_BEFORE_EXTERNAL;
  delete process.env.REQUIRE_REDACTION_BEFORE_EXTERNAL;
  require("../utils/privacyPolicy")._resetForTests();

  try {
    const res = await request(app).post("/api/generate").send({ transcript: TRANSCRIPT });

    assert.equal(res.status, 200);
    assert.equal(res.body.protocolVariant, "generated");
    assert.equal(res.body.sourceTranscriptVariant, "original");
    assert.equal(res.body.redaction, undefined, "be redakcijos metaduomenų būti negali");
  } finally {
    process.env.REQUIRE_REDACTION_BEFORE_EXTERNAL = saved;
    require("../utils/privacyPolicy")._resetForTests();
  }
});

test("PARITY: route ir worker duoda IDENTIŠKĄ redakcijos rezultatą", async (t) => {
  installProvider(t);

  reset();
  const routeRes = await request(app).post("/api/generate").send({ transcript: TRANSCRIPT });
  const routePayloads = [...seen.payloads];

  reset();
  const workerRes = await protocolProcessor({ transcript: TRANSCRIPT }, "job-parity-4");
  const workerPayloads = [...seen.payloads];

  // Tiekėjas abiem keliais gavo TĄ PATĮ redaguotą tekstą.
  assert.deepEqual(workerPayloads, routePayloads);
  for (const payload of [...routePayloads, ...workerPayloads]) {
    assert.ok(!payload.includes(ASMENS_KODAS));
    assert.ok(!payload.includes(EL_PASTAS));
  }

  // Ir ta pati statistika iš tos pačios užšaldytos politikos.
  assert.deepEqual(workerRes.redaction.redactionStats, routeRes.body.redaction.redactionStats);
  assert.equal(workerRes.redaction.policyVersion, routeRes.body.redaction.policyVersion);
  assert.equal(workerRes.redaction.purpose, "source_transcript");
});

test("PARITY: repair retry abiejuose keliuose išsaugo ŠALTINIO metaduomenis", async (t) => {
  let call = 0;
  installProvider(t, () => {
    call += 1;
    return { rawText: call % 2 === 1 ? "ne JSON" : VALID_PROTOCOL, usage: null, truncated: false };
  });

  reset();
  call = 0;
  const routeRes = await request(app).post("/api/generate").send({ transcript: TRANSCRIPT });
  assert.equal(seen.payloads.length, 2, "route: pradinis + repair");
  assert.equal(routeRes.body.redaction.redactionStats.PERSONAL_CODE, 1);

  reset();
  call = 0;
  const workerRes = await protocolProcessor({ transcript: TRANSCRIPT }, "job-parity-repair");
  assert.equal(seen.payloads.length, 2, "worker: pradinis + repair");
  assert.equal(workerRes.redaction.redactionStats.PERSONAL_CODE, 1);

  // Nė vienas iš keturių payload'ų negali turėti PII.
  for (const payload of seen.payloads) {
    assert.ok(!payload.includes(ASMENS_KODAS));
  }
});

test("PARITY: redakcijos klaida blokuoja ABU kelius vienodai", async (t) => {
  installProvider(t);

  const redactionComponent = require("../utils/redactionComponent");
  redactionComponent._setLoaderForTests(() => ({
    redact() {
      throw new Error("redakcijos modelis neveikia");
    },
  }));
  t.after(() => redactionComponent._setLoaderForTests(null));

  reset();
  const routeRes = await request(app).post("/api/generate").send({ transcript: TRANSCRIPT });
  assert.equal(routeRes.status, 500);

  reset();
  await assert.rejects(() => protocolProcessor({ transcript: TRANSCRIPT }, "job-parity-fail"));

  assert.equal(seen.payloads.length, 0, "nė vienas kelias negali kviesti tiekėjo");
});
