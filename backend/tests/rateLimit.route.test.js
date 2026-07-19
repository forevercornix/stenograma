const test = require("node:test");
const assert = require("node:assert/strict");

// RATE_LIMIT_MAX_REQUESTS skaitomas VIENĄ kartą middleware/rateLimiter.js įkėlimo
// metu, todėl turi būti nustatytas PRIEŠ require("../server").
process.env.RATE_LIMIT_WINDOW_MINUTES = "15";
process.env.RATE_LIMIT_MAX_REQUESTS = "2";
process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.LLM_PROVIDER = "mock";
process.env.DIARIZATION_PROVIDER = "none";
process.env.ALLOW_PROVIDER_OVERRIDE = "false";
process.env.API_KEY = "";
process.env.NODE_ENV = "test";

const request = require("supertest");
const app = require("../server");

test("rate limiting: 3-ia užklausa per langą (limitas=2) grąžina 429", async () => {
  const payload = { transcript: "Pakankamai ilgas testinis tekstas apie susitikimą, kad praeitų validaciją." };

  const r1 = await request(app).post("/api/generate").send(payload);
  const r2 = await request(app).post("/api/generate").send(payload);
  const r3 = await request(app).post("/api/generate").send(payload);

  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r3.status, 429);
  assert.match(r3.body.error, /Per daug užklausų/);
});

test("REGRESIJOS TESTAS (rastas realiai naudojant, ne teoriškai): GET /api/jobs/:id polling turi NEPRIKLAUSOMĄ, žymiai laisvesnį limitą nei POST /api/generate", async () => {
  // Sukuriame jobą (tai vis dar POST, kuriam limitas=2 jau beveik išnaudotas
  // ankstesnio testo - bet svarbu čia yra GET pusė žemiau).
  const createRes = await request(app)
    .post("/api/jobs")
    .send({ transcript: "Pakankamai ilgas testinis tekstas apie susitikimą, kad praeitų validaciją." });
  const jobId = createRes.body.jobId || "nesamas-bet-nesvarbu-siam-testui";

  // Prieš pataisymą ŠIS ciklas (10 GET užklausų) būtų atsitrenkęs į TĄ PATĮ
  // RATE_LIMIT_MAX_REQUESTS=2 limitą kaip POST /api/generate aukščiau - realiame
  // naudojime tai reiškė, kad bet koks >1 minutės trukmės jobas neišvengiamai
  // gautų 429 iš paties polling proceso, NE dėl piktnaudžiavimo.
  let sawRateLimitOnPoll = false;
  for (let i = 0; i < 10; i++) {
    const pollRes = await request(app).get(`/api/jobs/${jobId}`);
    if (pollRes.status === 429) sawRateLimitOnPoll = true;
  }
  assert.equal(sawRateLimitOnPoll, false, "GET /api/jobs/:id NETURI būti ribojamas ta pačia griežta riba kaip POST /api/generate");
});
