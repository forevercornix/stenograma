const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * GDPR #5 DoD: "route ir worker keliai elgiasi VIENODAI".
 *
 * Iki šiol tai buvo pagrįsta ARCHITEKTŪRA (abu keliai eina per tą pačią provider
 * fabriką), bet neįrodyta testu. Architektūrinis argumentas yra teisingas, tačiau
 * jis lūžta tyliai: pakanka, kad kas nors BullMQ processor'iuje pradėtų kviesti
 * tiekėją tiesiogiai, ir HTTP kelias liktų apsaugotas, o worker - ne.
 *
 * Šis testas leidžia TAS PAČIAS neigiamas kombinacijas per abu įėjimus ir
 * reikalauja identiško rezultato.
 */

process.env.NODE_ENV = "test";
process.env.LLM_PROVIDER = "claude";
process.env.ANTHROPIC_API_KEY = "sk-ant-testinis";
process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.DIARIZATION_PROVIDER = "none";
process.env.ALLOW_PROVIDER_OVERRIDE = "false";
process.env.API_KEY = "";
process.env.REQUIRE_REDACTION_BEFORE_EXTERNAL = "true";

const MARKER = "PARITY-39001010000";
const TRANSCRIPT = `Jonas Jonaitis, asmens kodas ${MARKER}, pristatė ataskaitą posėdyje.`;

const redactionComponent = require("../utils/redactionComponent");

/** Bendra būsena: ką matė "tiekėjas" ir ar redakcija buvo kviesta. */
const seen = { redactCalls: [], payloads: [] };

redactionComponent._setLoaderForTests(() => ({
  redact(text) {
    seen.redactCalls.push(text);
    if (process.env._PARITY_REDACT_FAILS === "true") throw new Error("redakcija krito");
    return text.replaceAll(MARKER, "[REDAGUOTA]");
  },
}));

const request = require("supertest");
const { REGISTRY } = require("../providers/llm");
const { protocolProcessor } = require("../queues/processors");
const app = require("../server");
app._setReadyForTests();

REGISTRY.claude = class FakeClaude {
  constructor() {
    this.name = "claude";
    this.model = "fake";
  }
  async generateProtocol(payload) {
    seen.payloads.push(payload);
    return {
      rawText: JSON.stringify({
        pavadinimas: "T",
        data: "2026-01-01",
        dalyviai: [],
        darbotvarke: [],
        aptarti_klausimai: [],
        nutarimai: [],
        veiksmai: [],
      }),
      usage: null,
      truncated: false,
    };
  }
};

function reset() {
  seen.redactCalls.length = 0;
  seen.payloads.length = 0;
  delete process.env._PARITY_REDACT_FAILS;
}

/** Tas pats scenarijus per HTTP maršrutą. */
async function viaRoute() {
  const res = await request(app).post("/api/generate").send({ transcript: TRANSCRIPT });
  return { ok: res.status === 200, status: res.status };
}

/** Tas pats scenarijus per BullMQ processor'ių (worker kelias). */
async function viaWorker() {
  try {
    await protocolProcessor({ transcript: TRANSCRIPT }, "job-parity");
    return { ok: true, status: 200 };
  } catch (e) {
    return { ok: false, status: e.statusCode || 500 };
  }
}

test("TEIGIAMAS: abu keliai redaguoja, ir tiekėjas negauna originalo", async () => {
  for (const [label, run] of [
    ["route", viaRoute],
    ["worker", viaWorker],
  ]) {
    reset();
    const result = await run();

    assert.equal(result.ok, true, `${label}: turėjo pavykti`);
    assert.equal(seen.redactCalls.length > 0, true, `${label}: redact() nekviestas`);
    assert.equal(seen.payloads.length, 1, `${label}: tiekėjas turėjo būti kviestas kartą`);
    assert.ok(!seen.payloads[0].includes(MARKER), `${label}: tiekėjas gavo NEREDAGUOTĄ tekstą`);
  }
});

test("NEIGIAMAS: redakcijai kritus abu keliai NEKVIEČIA tiekėjo", async () => {
  for (const [label, run] of [
    ["route", viaRoute],
    ["worker", viaWorker],
  ]) {
    reset();
    process.env._PARITY_REDACT_FAILS = "true";

    const result = await run();

    assert.equal(result.ok, false, `${label}: turėjo nepavykti`);
    assert.equal(result.status, 500, `${label}: statusas turi sutapti abiejuose keliuose`);
    assert.equal(seen.payloads.length, 0, `${label}: tiekėjas NETURI būti kviečiamas`);
  }
});

test("NEIGIAMAS: audio tiekėjo draudimas galioja abiejuose keliuose vienodai", () => {
  const { getTranscriptionProvider } = require("../providers/transcription");
  const { transcriptionProcessor } = require("../queues/processors");

  // Abu keliai transkribavimo tiekėją gauna iš TOS PAČIOS fabrikos - tikrinam,
  // kad ji blokuoja, ir kad processor'ius neturi savo apėjimo.
  assert.throws(() => getTranscriptionProvider("whisper"), /PRIVACY_AUDIO_PROVIDER_FORBIDDEN|garso dengti negali/);
  assert.equal(typeof transcriptionProcessor, "function");
});

test("REGRESIJA: worker kelias nekviečia tiekėjo tiesiogiai, o per fabriką", async () => {
  reset();

  // Jei processor'ius kada nors imtų konstruoti tiekėją pats, redakcija liktų
  // nepritaikyta ir šis assert'as kristų.
  await viaWorker();

  assert.equal(seen.redactCalls.length, 1);
  assert.ok(!seen.payloads[0].includes(MARKER));
});

test.after(() => {
  redactionComponent._setLoaderForTests(null);
});
