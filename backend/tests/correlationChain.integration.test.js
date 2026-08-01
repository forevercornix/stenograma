const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LLM_PROVIDER = "mock";
process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.DIARIZATION_PROVIDER = "none";
process.env.API_KEY = "";
process.env.LOG_LEVEL = "debug";
process.env.LOG_FORMAT = "json";
process.env.RATE_LIMIT_MAX_REQUESTS = "500";

const request = require("supertest");
const auditLog = require("../utils/auditLog");
const jobStore = require("../utils/jobStore");
const app = require("../server");
app._setReadyForTests();

/**
 * GDPR #17 DoD: „Logs correlate request, queue, worker, provider and completion
 * events" ir „Tests verify propagation, redaction and content-free audit events".
 *
 * Ankstesni etapai įrodė KIEKVIENĄ grandį atskirai: ID egzistuoja, keliauja į
 * jobą, atkuriamas worker'yje. Čia įrodoma GRANDINĖ - kad vienas ID realiai
 * sujungia visus etapus viename sraute, ir kad jokiame iš jų nenutekėjo turinys.
 *
 * Skirtumas nėra formalus: kiekviena grandis gali veikti atskirai, o grandinė
 * vis tiek nutrūkti - pvz. jei worker'is konteksto neatkurtų, ID būtų jobo
 * įraše, bet logo eilutėse jo nebūtų.
 */

const SECRET_CODE = "39001010000";
const SECRET_EMAIL = "jonas@imone.lt";
const TRANSCRIPT =
  `Jonas Jonaitis, a.k. ${SECRET_CODE}, el. p. ${SECRET_EMAIL}, ` +
  "pristatė ketvirčio ataskaitą ir pasiūlė balsuoti dėl biudžeto patvirtinimo.";

function captureLogs() {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };

  for (const channel of Object.keys(original)) {
    console[channel] = (...args) => lines.push(args.join(" "));
  }

  return {
    restore: () => Object.assign(console, original),
    raw: () => lines.join("\n"),
    entries: () =>
      lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean),
  };
}

async function waitForJob(jobId, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const job = await jobStore.get(jobId);
    if (job && ["completed", "failed"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Jobas ${jobId} nebaigtas per ${timeoutMs} ms`);
}

test("GRANDINĖ: vienas requestId sujungia queued → processing → provider → completed", async () => {
  const requestId = "grandines-testas-1";
  const capture = captureLogs();

  let jobId;
  try {
    const res = await request(app)
      .post("/api/jobs")
      .set("x-request-id", requestId)
      .send({ transcript: TRANSCRIPT });

    assert.equal(res.status, 202);
    jobId = res.body.jobId;

    await waitForJob(jobId);
  } finally {
    capture.restore();
  }

  const mine = capture.entries().filter((entry) => entry.requestId === requestId);

  assert.ok(mine.length >= 3, `laukta bent 3 grandžių, gauta ${mine.length}`);

  const stages = mine.map((entry) => entry.data && entry.data.stage).filter(Boolean);

  // Kiekviena grandis privalo pasirodyti - ir visos su TUO PAČIU ID.
  for (const stage of ["queued", "processing", "provider", "completed"]) {
    assert.ok(stages.includes(stage), `trūksta grandies "${stage}". Rasta: ${stages.join(", ")}`);
  }

  // Etapai eina teisinga tvarka: eilė prieš vykdymą, vykdymas prieš pabaigą.
  assert.ok(stages.indexOf("queued") < stages.indexOf("processing"));
  assert.ok(stages.indexOf("processing") < stages.indexOf("completed"));
});

test("GRANDINĖ: jobo ID matomas visose grandyse, ne tik pirmoje", async () => {
  const requestId = "grandines-testas-2";
  const capture = captureLogs();

  let jobId;
  try {
    const res = await request(app)
      .post("/api/jobs")
      .set("x-request-id", requestId)
      .send({ transcript: TRANSCRIPT });

    jobId = res.body.jobId;
    await waitForJob(jobId);
  } finally {
    capture.restore();
  }

  const withJob = capture
    .entries()
    .filter((entry) => entry.requestId === requestId && entry.data && entry.data.jobId === jobId);

  // Be jobId grandyse tektų spėlioti, KURIS jobas, kai jų vyksta keli lygiagrečiai.
  assert.ok(withJob.length >= 3, `jobId turi būti bent 3 grandyse, rasta ${withJob.length}`);
});

test("TURINYS: nė vienoje grandyje nėra transkripcijos ar PII", async () => {
  const requestId = "grandines-testas-3";
  const capture = captureLogs();

  try {
    const res = await request(app)
      .post("/api/jobs")
      .set("x-request-id", requestId)
      .send({ transcript: TRANSCRIPT });

    await waitForJob(res.body.jobId);
  } finally {
    capture.restore();
  }

  const output = capture.raw();

  assert.ok(!output.includes(SECRET_CODE), "asmens kodas negali patekti į logus");
  assert.ok(!output.includes(SECRET_EMAIL), "el. paštas negali patekti į logus");
  assert.ok(!output.includes("pristatė ketvirčio ataskaitą"), "transkripcijos turinys negali patekti");
  assert.ok(!output.includes("Jonas Jonaitis"), "dalyvių vardai neturi patekti į logus");
});

test("AUDITAS: įrašai susieti su tuo pačiu requestId ir be turinio", async () => {
  const requestId = "grandines-testas-4";
  const before = auditLog.getAll().length;

  const res = await request(app)
    .post("/api/jobs")
    .set("x-request-id", requestId)
    .send({ transcript: TRANSCRIPT });

  await waitForJob(res.body.jobId);

  const entries = auditLog.getAll().slice(before);
  const mine = entries.filter((entry) => entry.requestId === requestId);

  assert.ok(mine.length >= 1, "audito įrašai turi nešti requestId");

  const serialized = JSON.stringify(entries);
  assert.ok(!serialized.includes(SECRET_CODE));
  assert.ok(!serialized.includes(SECRET_EMAIL));
  assert.ok(!serialized.includes("pristatė ketvirčio ataskaitą"));
});

test("GRANDINĖ: nesėkmė taip pat fiksuojama su tuo pačiu ID", async (t) => {
  /**
   * Nesėkmės kelias tiriamas dažniausiai - jei jis vienintelis be koreliacijos,
   * observability neveikia būtent tada, kai jos reikia.
   */
  const { REGISTRY } = require("../providers/llm");
  const previous = REGISTRY.mock;

  REGISTRY.mock = class {
    constructor() {
      this.name = "mock";
      this.model = "mock";
    }
    async generateProtocol() {
      throw new Error("dirbtinė tiekėjo klaida");
    }
  };
  t.after(() => {
    REGISTRY.mock = previous;
  });

  const requestId = "grandines-testas-5";
  const capture = captureLogs();

  try {
    const res = await request(app)
      .post("/api/jobs")
      .set("x-request-id", requestId)
      .send({ transcript: TRANSCRIPT });

    const job = await waitForJob(res.body.jobId);
    assert.equal(job.status, "failed");
  } finally {
    capture.restore();
  }

  const mine = capture.entries().filter((entry) => entry.requestId === requestId);
  const stages = mine.map((entry) => entry.data && entry.data.stage).filter(Boolean);

  assert.ok(stages.includes("queued"));
  assert.ok(stages.includes("failed"), `nesėkmė turi turėti savo grandį. Rasta: ${stages.join(", ")}`);

  // Ir klaidos kelyje turinys taip pat nenutekėjo.
  assert.ok(!capture.raw().includes(SECRET_CODE));
});

test("IZOLIACIJA: du lygiagretūs srautai nesumaišo savo ID", async () => {
  const capture = captureLogs();

  let first;
  let second;
  try {
    [first, second] = await Promise.all([
      request(app).post("/api/jobs").set("x-request-id", "srautas-A").send({ transcript: TRANSCRIPT }),
      request(app).post("/api/jobs").set("x-request-id", "srautas-B").send({ transcript: TRANSCRIPT }),
    ]);

    await Promise.all([waitForJob(first.body.jobId), waitForJob(second.body.jobId)]);
  } finally {
    capture.restore();
  }

  const entries = capture.entries();
  const jobsOfA = new Set(
    entries.filter((e) => e.requestId === "srautas-A" && e.data?.jobId).map((e) => e.data.jobId)
  );
  const jobsOfB = new Set(
    entries.filter((e) => e.requestId === "srautas-B" && e.data?.jobId).map((e) => e.data.jobId)
  );

  // AsyncLocalStorage kontekstas neturi „nutekėti" tarp lygiagrečių užklausų -
  // priešingu atveju koreliacija būtų blogesnė nei jokios: ji meluotų.
  assert.deepEqual([...jobsOfA], [first.body.jobId]);
  assert.deepEqual([...jobsOfB], [second.body.jobId]);
});

test("GRANDINĖ: transkripcijos kelias turi TUOS PAČIUS etapus", async () => {
  /**
   * Anksčiau `provider` etapas buvo tik protokolo (LLM) kelyje, o integraciniai
   * testai siuntė tik `POST /api/jobs`. Transkripcijos grandinėje liko skylė
   * būtent ten, kur laikas praleidžiamas ilgiausiai - ir jos niekas nematė,
   * nes DoD tikrinom vienu keliu.
   */
  const requestId = "transkripcijos-grandine-1";
  const capture = captureLogs();

  let jobId;
  try {
    const wav = Buffer.alloc(2048);
    wav.write("RIFF", 0, "ascii");
    wav.write("WAVEfmt ", 8, "ascii");

    const res = await request(app)
      .post("/api/transcribe-jobs")
      .set("x-request-id", requestId)
      .attach("audio", wav, { filename: "posedis.wav", contentType: "audio/wav" });

    assert.equal(res.status, 202);
    jobId = res.body.jobId;

    await waitForJob(jobId);
  } finally {
    capture.restore();
  }

  const mine = capture.entries().filter((entry) => entry.requestId === requestId);
  const stages = mine.map((entry) => entry.data && entry.data.stage).filter(Boolean);

  for (const stage of ["queued", "processing", "provider", "completed"]) {
    assert.ok(stages.includes(stage), `trūksta grandies "${stage}". Rasta: ${stages.join(", ")}`);
  }

  // Tiekėjo įvykis turi pasakyti, KOKIO TIPO tiekėjas kviestas.
  const provider = mine.find((entry) => entry.data && entry.data.stage === "provider");
  assert.equal(provider.data.providerType, "transcription");
  assert.equal(provider.data.jobId, jobId, "tiekėjo įvykis turi nešti jobId");
});

test("PROVIDER įvykis neša jobId IR paskirtį (ne tik requestId)", async () => {
  const requestId = "provider-metaduomenys-1";
  const capture = captureLogs();

  let jobId;
  try {
    const res = await request(app)
      .post("/api/jobs")
      .set("x-request-id", requestId)
      .send({ transcript: TRANSCRIPT });

    jobId = res.body.jobId;
    await waitForJob(jobId);
  } finally {
    capture.restore();
  }

  const providers = capture
    .entries()
    .filter((entry) => entry.requestId === requestId && entry.data && entry.data.stage === "provider");

  assert.ok(providers.length >= 1);

  for (const event of providers) {
    // Viena užklausa gali sukurti kelis darbus - vien requestId tada nebeatsako,
    // KURIAM iš jų priklauso tiekėjo kvietimas.
    assert.equal(event.data.jobId, jobId, "tiekėjo įvykis be jobId nekoreliuoja darbo lygyje");
    assert.equal(event.data.providerType, "llm");
    assert.ok(event.data.purpose, "paskirtis (šaltinis ar repair) turi būti matoma");
  }
});

test("REPAIR RETRY: antras tiekėjo kvietimas turi SAVO įvykį", async (t) => {
  /**
   * Repair yra antras realus tiekėjo kvietimas ir kainuoja tiek pat, kiek
   * pirmasis. Be atskiro įvykio jis grandinėje nematomas, o laiko sąnaudos
   * atrodo kaip vieno lėto kvietimo.
   */
  const { REGISTRY } = require("../providers/llm");
  const previous = REGISTRY.mock;

  let call = 0;
  const VALID = JSON.stringify({
    pavadinimas: "T",
    data: "2026-01-01",
    dalyviai: [],
    darbotvarke: [],
    aptarti_klausimai: [],
    nutarimai: [],
    veiksmai: [],
  });

  REGISTRY.mock = class {
    constructor() {
      this.name = "mock";
      this.model = "mock";
    }
    async generateProtocol() {
      call += 1;
      return { rawText: call === 1 ? "ne JSON" : VALID, usage: null, truncated: false };
    }
  };
  t.after(() => {
    REGISTRY.mock = previous;
  });

  const requestId = "repair-grandine-1";
  const capture = captureLogs();

  try {
    const res = await request(app)
      .post("/api/jobs")
      .set("x-request-id", requestId)
      .send({ transcript: TRANSCRIPT });

    await waitForJob(res.body.jobId);
  } finally {
    capture.restore();
  }

  const purposes = capture
    .entries()
    .filter((entry) => entry.requestId === requestId && entry.data && entry.data.stage === "provider")
    .map((entry) => entry.data.purpose);

  assert.deepEqual(purposes, ["source_transcript", "repair_prompt"]);
});
