const test = require("node:test");
const assert = require("node:assert");
const request = require("supertest");
process.env.LLM_PROVIDER = process.env.LLM_PROVIDER || "mock";
const app = require("../server");

test.afterEach(() => app._setReadyForTests(true));

// --- /api/ready (readiness vs liveness) ---
test("GET /api/ready - grąžina 503 kol job store/runner neinicijuoti (readiness)", async () => {
  // Aiškiai nustatom readiness=false (kiti testų failai gali būti nustatę true - readiness
  // yra globalus objektas, tad izoliuojam būseną čia).
  app._setReadyForTests(false);
  const res = await request(app).get("/api/ready");
  assert.equal(res.status, 503);
  assert.equal(res.body.ready, false);
  assert.equal(res.body.components.jobStore, false);
  assert.equal(res.body.components.jobRunner, false);
  app._setReadyForTests(true); // atkuriam, kad netrukdytų kitiems
});

test("GET /api/ready - grąžina 200 kai job sistema paruošta", async () => {
  app._setReadyForTests(true);
  const res = await request(app).get("/api/ready");
  assert.equal(res.status, 200);
  assert.equal(res.body.ready, true);
});

test("GET /api/health - liveness atsako 200 nepriklausomai nuo job sistemos", async () => {
  // /api/health yra LIVENESS - atsako 200 net kai job store/runner neinicijuoti.
  app._setReadyForTests(false);
  const res = await request(app).get("/api/health");
  assert.equal(res.status, 200);
  app._setReadyForTests(true);
});
