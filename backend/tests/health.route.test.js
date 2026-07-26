const test = require("node:test");
const assert = require("node:assert");
const request = require("supertest");
process.env.LLM_PROVIDER = process.env.LLM_PROVIDER || "mock";
const app = require("../server");

// --- /api/ready (readiness vs liveness) ---
test("GET /api/ready - grąžina 503 kol job store/runner neinicijuoti (readiness)", async () => {
  // Testų kontekste (require.main !== module) init nevyksta, tad readiness flag'ai false.
  // Tai patvirtina, kad /api/ready yra READINESS (ne liveness kaip /api/health): jis
  // NErodo "ready", kol job sistema realiai neparuošta.
  const res = await request(app).get("/api/ready");
  assert.equal(res.status, 503);
  assert.equal(res.body.ready, false);
  assert.equal(res.body.components.jobStore, false);
  assert.equal(res.body.components.jobRunner, false);
});

test("GET /api/health - liveness atsako 200 nepriklausomai nuo job sistemos", async () => {
  // /api/health yra LIVENESS - atsako 200 net kai job store/runner dar neinicijuoti
  // (procesas gyvas). Skirtingai nuo /api/ready.
  const res = await request(app).get("/api/health");
  assert.equal(res.status, 200);
});
