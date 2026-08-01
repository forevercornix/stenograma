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
app._setReadyForTests(); // job route reikalauja readiness (startServer nevyksta testuose)

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

test("IP: REALUS rate limito įvykis logina pseudonimą, ne adresą", async () => {
  /**
   * SVARBU: kviečiam tikrą middleware, o ne imituojam jo turinį.
   *
   * Pirmoji šio testo versija atkartojo handler'io kūną testo viduje ir praėjo
   * net pakeitus produkcinį kodą į žalią `req.ip` - t. y. tikrino savo pačios
   * kopiją, o ne tai, kas realiai vykdoma.
   */
  const lines = [];
  const originalWarn = console.warn;
  const savedFormat = process.env.LOG_FORMAT;
  const savedLevel = process.env.LOG_LEVEL;
  process.env.LOG_FORMAT = "json";
  process.env.LOG_LEVEL = "warn";
  console.warn = (...args) => lines.push(args.join(" "));

  try {
    const payload = { transcript: "Pakankamai ilgas testinis tekstas apie susitikimą, kad praeitų validaciją." };
    // Limitas jau išnaudotas ankstesnio testo - pirma pat užklausa duos 429.
    const res = await request(app).post("/api/generate").send(payload);
    assert.equal(res.status, 429);
  } finally {
    console.warn = originalWarn;
    if (savedFormat === undefined) delete process.env.LOG_FORMAT;
    else process.env.LOG_FORMAT = savedFormat;
    if (savedLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = savedLevel;
  }

  const output = lines.join("\n");

  assert.match(output, /Rate limitas viršytas/, `laukta rate limito įvykio, gauta: ${output}`);
  assert.match(output, /ip_[0-9a-f]{12}/, "klientas turi būti pseudonimas");

  // Testinėje aplinkoje IP yra ::ffff:127.0.0.1 arba ::1 - nė vienas negali
  // patekti į logą žalias.
  assert.ok(!/127\.0\.0\.1/.test(output), "pilnas IPv4 negali patekti į logą");
  assert.ok(!/"client":"::/.test(output), "pilnas IPv6 negali patekti į logą");
});
