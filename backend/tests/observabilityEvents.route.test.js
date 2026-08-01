const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LLM_PROVIDER = "mock";
process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.DIARIZATION_PROVIDER = "none";
process.env.API_KEY = "";
process.env.LOG_LEVEL = "warn";
process.env.LOG_FORMAT = "json";

const request = require("supertest");
const auditLog = require("../utils/auditLog");
const { recordRejectedUpload, REASONS } = require("../utils/uploadEvents");
const app = require("../server");
app._setReadyForTests();

/**
 * GDPR #17: EKSPORTO IR ĮKĖLIMŲ ĮVYKIAI.
 *
 * Du reikalavimai, kuriuos lengva supainioti:
 *  1. įvykiai turi TURĖTI naudingus metaduomenis (kitaip auditas nieko neatsako);
 *  2. įvykiai NEGALI turėti turinio ar PII.
 *
 * Testai tikrina abu kartu - atskirai kiekvieną patenkinti lengva, o kartu jie
 * ir sudaro reikalavimą.
 */

function captureWarnings(fn) {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => lines.push(args.join(" "));
  try {
    return { result: fn(), lines };
  } finally {
    console.warn = original;
  }
}

test("EKSPORTAS: įvykiai turi STRUKTŪRIZUOTUS variant/format/outcome", async () => {
  const before = auditLog.getAll().length;

  const res = await request(app)
    .post("/api/exports")
    .send({ format: "txt", protocol: { pavadinimas: "Posėdis", data: "2026-01-01" } });

  assert.equal(res.status, 200);

  const entries = auditLog.getAll().slice(before);
  const started = entries.find((e) => e.event === "EXPORT_STARTED");
  const completed = entries.find((e) => e.event === "EXPORT_COMPLETED");

  assert.ok(started && completed);

  // Laukai turi būti FILTRUOJAMI, ne įsprausti į laisvą `details` eilutę.
  assert.equal(completed.format, "txt");
  assert.ok(["original", "redacted"].includes(completed.variant));
  assert.equal(started.outcome, "started");
  assert.equal(completed.outcome, "delivered");

  // Koreliacija ateina automatiškai iš request konteksto.
  assert.ok(completed.requestId, "eksporto įvykis turi turėti requestId");
});

test("EKSPORTAS: nežinomas formatas atmetamas PRIEŠ pradedant (įvykio nėra)", async () => {
  const before = auditLog.getAll().length;

  const res = await request(app)
    .post("/api/exports")
    .send({ format: "nesamas-formatas", protocol: { pavadinimas: "X" } });

  assert.equal(res.status, 400);

  // Eksportas neprasidėjo, tad nėra ko fiksuoti. Tai NE nesėkmės kelio testas -
  // žr. kitą testą.
  const entries = auditLog.getAll().slice(before);
  assert.equal(entries.filter((e) => e.event === "EXPORT_STARTED").length, 0);
});

test("EKSPORTAS: REALUS nesėkmės kelias turi visus struktūrizuotus laukus", async (t) => {
  /**
   * Ankstesnė šio testo versija siuntė nežinomą formatą - o toks atmetamas dar
   * PRIEŠ `buildExport()`, tad `EXPORT_FAILED` šaka apskritai nebuvo vykdoma.
   * Testas vadinosi „nesėkmingas eksportas", bet tikrino, kad įvykio NĖRA.
   *
   * Kad nesėkmės kelias būtų realiai patikrintas, generavimas turi kristi JAU
   * PO formato validacijos.
   */
  /**
   * Klaida sukeliama REALIU keliu, o ne pakeičiant modulio eksportą: maršrutas
   * `buildExport` destruktūrizuoja importo metu, tad modulio perrašymas jo
   * nepasiekia (pirmoji versija būtent taip ir „praėjo" su 200).
   *
   * Naudojam politikos prieštaravimą: EXPORT_ALLOW_ORIGINAL=false be redakcijos
   * komponento -> `buildExport` meta ExportPolicyError jau PO formato validacijos.
   */
  const redactionComponent = require("../utils/redactionComponent");
  const privacyPolicy = require("../utils/privacyPolicy");

  const savedFlag = process.env.EXPORT_ALLOW_ORIGINAL;
  process.env.EXPORT_ALLOW_ORIGINAL = "false";
  privacyPolicy._resetForTests();
  redactionComponent._setLoaderForTests(() => {
    const error = new Error("Cannot find module './piiRedaction'");
    error.code = "MODULE_NOT_FOUND";
    throw error;
  });

  t.after(() => {
    if (savedFlag === undefined) delete process.env.EXPORT_ALLOW_ORIGINAL;
    else process.env.EXPORT_ALLOW_ORIGINAL = savedFlag;
    redactionComponent._setLoaderForTests(null);
    privacyPolicy._resetForTests();
  });

  const before = auditLog.getAll().length;

  const res = await request(app)
    .post("/api/exports")
    .send({ format: "txt", protocol: { pavadinimas: "Posėdis", data: "2026-01-01" } });

  assert.ok(res.status >= 400, `laukta klaidos, gauta ${res.status}`);

  const failed = auditLog.getAll().slice(before).find((e) => e.event === "EXPORT_FAILED");

  assert.ok(failed, "nesėkmė turi palikti įvykį");
  assert.equal(failed.format, "txt");
  assert.ok(["original", "redacted"].includes(failed.variant));
  assert.equal(failed.outcome, "failed");
  assert.ok(failed.requestId, "koreliacija reikalinga ir nesėkmės kelyje");

  // Variantas turi būti REDACTED - būtent jo reikalavimas ir sukėlė klaidą.
  assert.equal(failed.variant, "redacted");
});

test("ĮKĖLIMAS: atmetimas fiksuojamas BE failo vardo ir turinio", async () => {
  const before = auditLog.getAll().length;

  const { lines } = captureWarnings(() => {});
  void lines;

  const captured = [];
  const originalWarn = console.warn;
  console.warn = (...args) => captured.push(args.join(" "));

  try {
    const res = await request(app)
      .post("/api/transcribe")
      .attach("audio", Buffer.from("tai tikrai ne audio failas"), {
        filename: "Jono Jonaicio pokalbis.wav",
        contentType: "audio/wav",
      });

    assert.equal(res.status, 400);
  } finally {
    console.warn = originalWarn;
  }

  const entries = auditLog.getAll().slice(before);
  const rejected = entries.find((e) => e.event === "UPLOAD_REJECTED");

  assert.ok(rejected, "atmestas įkėlimas turi palikti pėdsaką");
  assert.equal(rejected.outcome, REASONS.SIGNATURE);

  const serialized = JSON.stringify(entries) + captured.join("\n");

  // Failo vardą pateikia vartotojas, ir jame gali būti asmenvardis.
  assert.ok(!serialized.includes("Jono Jonaicio"), "failo vardas negali patekti į auditą ar logą");
  assert.ok(!serialized.includes("tai tikrai ne audio"), "turinys negali patekti");
  assert.ok(!serialized.includes("/tmp/"), "vietinis kelias negali patekti");
});

test("ĮKĖLIMAS: neleidžiamas formatas taip pat fiksuojamas", async () => {
  const before = auditLog.getAll().length;

  const res = await request(app)
    .post("/api/transcribe")
    .attach("audio", Buffer.from("bet kas"), { filename: "dokumentas.pdf", contentType: "application/pdf" });

  assert.equal(res.status, 400);

  const rejected = auditLog.getAll().slice(before).find((e) => e.event === "UPLOAD_REJECTED");
  assert.ok(rejected);
  assert.equal(rejected.outcome, REASONS.FORMAT);
});

test("ĮKĖLIMAS: MIME rodomas tik jei atitinka MIME formą", () => {
  const before = auditLog.getAll().length;

  const captured = [];
  const originalWarn = console.warn;
  console.warn = (...args) => captured.push(args.join(" "));

  try {
    recordRejectedUpload(REASONS.FORMAT, {
      route: "/api/transcribe",
      mimetype: "<script>alert(1)</script>" + "A".repeat(300),
    });
  } finally {
    console.warn = originalWarn;
  }

  const output = JSON.stringify(auditLog.getAll().slice(before)) + captured.join("\n");

  assert.ok(!output.includes("<script>"), "laisvas kliento tekstas negali patekti");
  assert.ok(output.includes("unknown"), "neatpažįstamas MIME pakeičiamas žymeniu");
});

test("ĮKĖLIMAS: įvykis susiejamas su jobId, kad GDPR ištrynimas jį pasiektų", async () => {
  auditLog.clear();

  const captured = [];
  const originalWarn = console.warn;
  console.warn = (...args) => captured.push(args.join(" "));

  try {
    recordRejectedUpload(REASONS.SIGNATURE, { route: "/api/transcribe", jobId: "job-erasure-test" });
  } finally {
    console.warn = originalWarn;
  }

  // Nesusietas įvykis būtų neištrinamas įrašas apie asmens veiksmą.
  assert.equal(await auditLog.removeBySubjectIdentifier("job-erasure-test"), 1);
});

test("ĮKĖLIMAS: trūkstamas failas TAIP PAT fiksuojamas (abu maršrutai)", async () => {
  // `missing_file` priežastis buvo apibrėžta, bet niekur nekviečiama - dalis
  // atmestų bandymų likdavo be pėdsako, nors mechanizmas deklaruotas bendras.
  for (const route of ["/api/transcribe", "/api/transcribe-jobs"]) {
    const before = auditLog.getAll().length;

    const res = await request(app).post(route).send({});
    assert.equal(res.status, 400, `${route} turėjo grąžinti 400`);

    const rejected = auditLog.getAll().slice(before).find((e) => e.event === "UPLOAD_REJECTED");

    assert.ok(rejected, `${route}: trūkstamas failas turi palikti įvykį`);
    assert.equal(rejected.outcome, REASONS.MISSING);
    assert.equal(rejected.route, route);
  }
});

test("ĮKĖLIMAS: MIME ir dydžio metaduomenys realiai užpildomi", async () => {
  const before = auditLog.getAll().length;

  const res = await request(app)
    .post("/api/transcribe")
    .attach("audio", Buffer.from("bet kas"), { filename: "x.pdf", contentType: "application/pdf" });

  assert.equal(res.status, 400);

  const rejected = auditLog.getAll().slice(before).find((e) => e.event === "UPLOAD_REJECTED");

  // Pirmoji versija perduodavo `err.field ? undefined : undefined` - visada
  // undefined, tad audite likdavo mime=unknown. MIME dabar išsaugomas
  // fileFilter'yje, PRIEŠ atmetimą.
  assert.equal(rejected.mime, "application/pdf");
  assert.equal(rejected.route, "/api/transcribe");
});

test("ĮKĖLIMAS: per didelis failas fiksuoja LIMITĄ, ne tariamą dydį", () => {
  const before = auditLog.getAll().length;

  const captured = [];
  const originalWarn = console.warn;
  console.warn = (...args) => captured.push(args.join(" "));

  try {
    recordRejectedUpload(REASONS.TOO_LARGE, {
      route: "/api/transcribe",
      mimetype: "audio/wav",
      limitBytes: 50 * 1024 * 1024,
    });
  } finally {
    console.warn = originalWarn;
  }

  const rejected = auditLog.getAll().slice(before).find((e) => e.event === "UPLOAD_REJECTED");

  // Faktinio dydžio multer nežino (nutraukia skaitymą peržengęs ribą), tad
  // sąžiningiau fiksuoti limitą nei apsimesti, kad žinom dydį.
  assert.equal(rejected.limitBytes, 50 * 1024 * 1024);
  assert.equal(rejected.sizeBytes, null);
  assert.equal(typeof rejected.limitBytes, "number", "dydis turi likti skaičiumi, ne tekstu");
});
