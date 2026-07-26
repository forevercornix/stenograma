const test = require("node:test");
const assert = require("node:assert/strict");

// Sąmoningai konfigūruojame LLM_PROVIDER=claude BE ANTHROPIC_API_KEY, kad
// išprovokuotume tikrą vidinę (500) klaidą ir patikrintume, jog klientas
// gauna tik neutralų pranešimą, o ne "trūksta ANTHROPIC_API_KEY" ar kitą
// vidinę detalę.
process.env.LLM_PROVIDER = "claude";
delete process.env.ANTHROPIC_API_KEY;
process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.ALLOW_PROVIDER_OVERRIDE = "false";
process.env.API_KEY = "";
process.env.NODE_ENV = "test";
// Nauja startup validacija (utils/startupChecks.js) šią sąmoningai sugadintą
// konfigūraciją dabar TEISINGAI pagauna dar prieš startą - bet šis testas
// tikrina būtent RUNTIME klaidos sanitizaciją (kas nutinka, jei bloga
// konfigūracija vis dėlto prasprūdo), todėl validaciją čia apeiname.
process.env.SKIP_CONFIG_VALIDATION = "true";

const request = require("supertest");
const app = require("../server");
app._setReadyForTests(); // job route reikalauja readiness (startServer nevyksta testuose)

test("POST /api/generate - vidinė tiekėjo klaida (trūkstamas raktas) NEATSKLEIDŽIA raktų/konfigūracijos detalių klientui", async () => {
  const res = await request(app)
    .post("/api/generate")
    .send({ transcript: "Pakankamai ilgas testinis tekstas apie susitikimą, kad praeitų validaciją." });

  assert.equal(res.status, 500);
  assert.ok(!res.body.error.includes("ANTHROPIC_API_KEY"));
  assert.ok(!res.body.error.toLowerCase().includes("apikey"));
  assert.match(res.body.error, /Vidinė serverio klaida/);
});

test("POST /api/jobs - vidinė klaida FONE apdorojant taip pat sanitizuojama GET /api/jobs/:id atsakyme", async () => {
  const createRes = await request(app)
    .post("/api/jobs")
    .send({ transcript: "Pakankamai ilgas testinis tekstas apie susitikimą, kad praeitų validaciją." });
  assert.equal(createRes.status, 202);

  let job;
  for (let i = 0; i < 20; i++) {
    const pollRes = await request(app).get(`/api/jobs/${createRes.body.jobId}`);
    job = pollRes.body;
    if (job.status === "completed" || job.status === "failed") break;
    await new Promise((r) => setTimeout(r, 50));
  }

  assert.equal(job.status, "failed");
  assert.ok(!job.error.includes("ANTHROPIC_API_KEY"));
  assert.match(job.error, /Vidinė serverio klaida/);
});
