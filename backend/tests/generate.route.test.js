const test = require("node:test");
const assert = require("node:assert/strict");

// Env turi būti nustatytas PRIEŠ importuojant app'ą, nes routes/*.js skaito kai kuriuos
// kintamuosius (pvz. ALLOW_PROVIDER_OVERRIDE) modulio įkėlimo metu.
process.env.LLM_PROVIDER = "mock";
process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.ALLOW_PROVIDER_OVERRIDE = "false";
process.env.NODE_ENV = "test";

const request = require("supertest");
const app = require("../server");

test("POST /api/generate - per trumpa transkripcija grąžina 400", async () => {
  const res = await request(app).post("/api/generate").send({ transcript: "trumpa" });
  assert.equal(res.status, 400);
  assert.ok(res.body.error);
});

test("POST /api/generate - validi transkripcija grąžina protokolą su reikiamais laukais (mock provideris)", async () => {
  const res = await request(app)
    .post("/api/generate")
    .send({
      title: "Testinis susitikimas",
      date: "2026-07-09",
      participants: ["Jonas"],
      transcript: "Jonas: Sveiki, pradedam. Reikia parengti ataskaitą iki liepos 20 d.",
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.protocol.pavadinimas, "Testinis susitikimas");
  assert.deepEqual(res.body.protocol.dalyviai, ["Jonas"]);
  assert.equal(res.body.meta.llmProvider, "mock");
  assert.equal(res.body.meta.jsonRepairAttempts, 0);
  assert.ok(Array.isArray(res.body.protocol.veiksmai));
});

test("POST /api/generate - llmProviderOverride atmetamas, jei ALLOW_PROVIDER_OVERRIDE=false", async () => {
  const res = await request(app)
    .post("/api/generate")
    .send({ transcript: "Pakankamai ilgas tekstas testavimui.", llmProviderOverride: "gpt" });

  assert.equal(res.status, 403);
  assert.ok(res.body.error.includes("ALLOW_PROVIDER_OVERRIDE"));
});

test("GET /api/health grąžina aktyvius tiekėjus", async () => {
  const res = await request(app).get("/api/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.llmProvider, "mock");
  assert.equal(res.body.transcriptionProvider, "mock");
});
