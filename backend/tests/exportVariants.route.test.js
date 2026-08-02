const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LLM_PROVIDER = "mock";
process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.DIARIZATION_PROVIDER = "none";
process.env.API_KEY = "";
process.env.LOG_LEVEL = "error";
// Šis failas siunčia daug užklausų (visi formatai x abu variantai), tad
// numatytas rate limitas jį nutrauktų 429 klaida. Riba skaitoma middleware
// įkėlimo metu, tad turi būti nustatyta PRIEŠ require("../server").
process.env.RATE_LIMIT_MAX_REQUESTS = "500";

const request = require("supertest");
const auditLog = require("../utils/auditLog");
const redactionComponent = require("../utils/redactionComponent");
const privacyPolicy = require("../utils/privacyPolicy");
const app = require("../server");
app._setReadyForTests();

/**
 * GDPR #8 (backend): ORIGINALUS IR REDAGUOTAS EKSPORTAS.
 *
 * Esminis reikalavimas nėra „palaikyti du variantus" - tai lengva. Esminis yra
 * NIEKADA NENUMANYTI ir NIEKADA TYLIAI NEPAKEISTI: „paprašiau redaguoto, gavau
 * originalą" atrodo lygiai taip pat kaip teisingas atsakymas, kol kas nors
 * neperskaito failo.
 */

const ASMENS_KODAS = "39001010000";
const EL_PASTAS = "jonas@imone.lt";

function protocolWithPii() {
  return {
    pavadinimas: "Posėdis",
    data: "2026-03-15",
    dalyviai: [`Jonas Jonaitis, a.k. ${ASMENS_KODAS}`],
    darbotvarke: ["Ataskaita"],
    aptarti_klausimai: [{ klausimas: "Ataskaita", santrauka: `Kontaktas ${EL_PASTAS}` }],
    nutarimai: ["Patvirtinta"],
    veiksmai: [{ uzduotis: "Parengti", atsakingas: "Jonas", terminas: "2026-04-01" }],
  };
}

function withOriginalDisabled(fn) {
  const saved = process.env.EXPORT_ALLOW_ORIGINAL;
  process.env.EXPORT_ALLOW_ORIGINAL = "false";
  privacyPolicy._resetForTests();

  return (async () => {
    try {
      return await fn();
    } finally {
      if (saved === undefined) delete process.env.EXPORT_ALLOW_ORIGINAL;
      else process.env.EXPORT_ALLOW_ORIGINAL = saved;
      privacyPolicy._resetForTests();
    }
  })();
}

test("VARIANTAS PRIVALOMAS: be jo užklausa atmetama, o ne numanoma", async () => {
  const res = await request(app)
    .post("/api/exports")
    .send({ format: "txt", protocol: protocolWithPii() });

  assert.equal(res.status, 400);

  /**
   * Klaidų formatas dabar VIENAS visoms validacijoms (#14): `code` leidžia
   * reaguoti programiškai, `details[].path` - parodyti, kuris laukas blogas.
   */
  assert.equal(res.body.code, "VALIDATION_FAILED");
  assert.ok(
    res.body.details.some((issue) => issue.path === "variant"),
    `laukta nuorodos į variantą, gauta: ${JSON.stringify(res.body.details)}`
  );

  // Stack trace ar vidinių detalių atsakyme būti negali.
  assert.ok(!JSON.stringify(res.body).includes("at "), "jokio stack trace");
});

test("VARIANTAS: nežinoma reikšmė atmetama, ne priartinama prie panašiausios", async () => {
  for (const variant of ["ORIGINALAS", "redaguotas", "orig", "", "true", "null"]) {
    const res = await request(app)
      .post("/api/exports")
      .send({ variant, format: "txt", protocol: protocolWithPii() });

    assert.equal(res.status, 400, `turėjo būti atmesta: ${JSON.stringify(variant)}`);
    assert.equal(res.body.code, "VALIDATION_FAILED");
  }
});

test("ORIGINALAS: grąžinamas neliestas turinys ir vardas su variantu", async () => {
  const res = await request(app)
    .post("/api/exports")
    .send({ variant: "original", format: "txt", protocol: protocolWithPii() });

  assert.equal(res.status, 200);

  // supertest tekstinį atsakymą pateikia per `res.text`, ne `res.body`.
  assert.ok(res.text.includes(ASMENS_KODAS), "originalas turi turėti originalų turinį");
  assert.match(res.headers["content-disposition"], /protokolas_originalas_2026-03-15\.txt/);
});

test("REDAGUOTAS: identifikatoriai pašalinti, vardai lieka", async () => {
  const res = await request(app)
    .post("/api/exports")
    .send({ variant: "redacted", format: "txt", protocol: protocolWithPii() });

  assert.equal(res.status, 200);

  assert.ok(!res.text.includes(ASMENS_KODAS));
  assert.ok(!res.text.includes(EL_PASTAS));
  assert.ok(res.text.includes("[ASMENS_KODAS]"));
  assert.ok(res.text.includes("Jonas Jonaitis"), "vardai yra protokolo turinys");

  assert.match(res.headers["content-disposition"], /protokolas_redaguotas_2026-03-15\.txt/);
});

test("VISI FORMATAI elgiasi vienodai abiem variantais", async () => {
  for (const format of ["txt", "csv", "docx"]) {
    const original = await request(app)
      .post("/api/exports")
      .send({ variant: "original", format, protocol: protocolWithPii() });

    const redacted = await request(app)
      .post("/api/exports")
      .send({ variant: "redacted", format, protocol: protocolWithPii() });

    assert.equal(original.status, 200, `${format}: originalas`);
    assert.equal(redacted.status, 200, `${format}: redaguotas`);

    // DOCX yra dvejetainis - tikrinam patį buferį, nes teksto lygio patikra
    // jį tyliai praleistų.
    // DOCX ateina kaip buferis, txt/csv - kaip tekstas.
    const redactedBytes = redacted.text || Buffer.from(redacted.body).toString("latin1");
    assert.ok(!redactedBytes.includes(ASMENS_KODAS), `${format}: redaguotame liko asmens kodas`);

    assert.match(original.headers["content-disposition"], /_originalas_/);
    assert.match(redacted.headers["content-disposition"], /_redaguotas_/);
  }
});

test("PRIVACY-FIRST: originalas uždraudžiamas, redaguotas VEIKIA", async () => {
  await withOriginalDisabled(async () => {
    const original = await request(app)
      .post("/api/exports")
      .send({ variant: "original", format: "txt", protocol: protocolWithPii() });

    assert.equal(original.status, 403, "uždraustas variantas nėra serverio klaida");
    assert.match(original.body.error, /EXPORT_ALLOW_ORIGINAL/);

    const redacted = await request(app)
      .post("/api/exports")
      .send({ variant: "redacted", format: "txt", protocol: protocolWithPii() });

    assert.equal(redacted.status, 200, "redaguotas variantas turi likti prieinamas");
  });
});

test("PAKEITIMO DRAUDIMAS: uždraudus originalą jis NEPAKEIČIAMAS redaguotu", async () => {
  /**
   * Patogiausias elgesys būtų „negali gauti originalo - štai redaguotas".
   * Būtent jis ir draudžiamas: vartotojas gautų kitokį dokumentą nei prašė ir
   * to nepastebėtų, kol nepradėtų juo remtis.
   */
  await withOriginalDisabled(async () => {
    const res = await request(app)
      .post("/api/exports")
      .send({ variant: "original", format: "txt", protocol: protocolWithPii() });

    assert.equal(res.status, 403);
    assert.equal(res.headers["content-disposition"], undefined, "jokio failo grąžinti negalima");
  });
});

test("FAIL-CLOSED: nesant redakcijos komponento originalas NEGRĄŽINAMAS", async (t) => {
  redactionComponent._setLoaderForTests(() => {
    const error = new Error("Cannot find module './piiRedaction'");
    error.code = "MODULE_NOT_FOUND";
    throw error;
  });
  t.after(() => redactionComponent._setLoaderForTests(null));

  const res = await request(app)
    .post("/api/exports")
    .send({ variant: "redacted", format: "txt", protocol: protocolWithPii() });

  assert.ok(res.status >= 400, "trūkstamas redaguotas turinys turi duoti klaidą");

  const body = JSON.stringify(res.body);
  assert.ok(!body.includes(ASMENS_KODAS), "originalas negali nutekėti per klaidos atsakymą");
});

test("AUDITAS fiksuoja PRAŠYTĄ variantą, ne išvestą iš politikos", async () => {
  const before = auditLog.getAll().length;

  await request(app)
    .post("/api/exports")
    .send({ variant: "redacted", format: "csv", protocol: protocolWithPii() });

  const completed = auditLog.getAll().slice(before).find((e) => e.event === "EXPORT_COMPLETED");

  assert.ok(completed);
  assert.equal(completed.variant, "redacted");
  assert.equal(completed.format, "csv");
  assert.equal(completed.outcome, "delivered");
});

test("FAILO VARDAS generuojamas serveryje: jokio traversal ar valdymo simbolių", () => {
  const { exportFilename } = require("../services/exportService");

  const hostile = exportFilename("protokolas", "original", "../../etc/passwd", "txt");
  assert.equal(hostile, "protokolas_originalas_.._.._etc_passwd.txt");
  assert.ok(!hostile.includes("/"), "kelio skirtukų būti negali");

  for (const date of ["2026-03-15\u0000", "a\nb", 'kabutes"ir\'', "%2e%2e%2f"]) {
    const name = exportFilename("protokolas", "redacted", date, "docx");
    assert.match(name, /^[A-Za-z0-9_.-]+$/, `netinkamas vardas: ${name}`);
    assert.ok(name.startsWith("protokolas_redaguotas_"));
  }
});

test("FORMATUI TINKAMAS ekranavimas: CSV formulės neutralizuojamos", async () => {
  /**
   * CSV eksportuoja TIK veiksmų lentelę, tad HTML iš pavadinimo į jį nepatenka -
   * pirmoji šio testo versija to nežinojo ir tikrino ne tą failą.
   *
   * Tikras CSV pavojus yra formulių injekcija: `=CMD()` atidarius Excel'yje
   * taptų vykdoma formule.
   */
  const hostile = protocolWithPii();
  hostile.veiksmai = [{ uzduotis: "=CMD()", atsakingas: "@SUM(1)", terminas: "+1+1" }];

  const res = await request(app)
    .post("/api/exports")
    .send({ variant: "original", format: "csv", protocol: hostile });

  assert.equal(res.status, 200);

  const rows = res.text.split("\r\n").slice(1).filter(Boolean);
  for (const row of rows) {
    for (const cell of row.split(",")) {
      const value = cell.replace(/^"|"$/g, "");
      assert.ok(!/^[=+\-@]/.test(value), `langelis prasideda formule: ${cell}`);
    }
  }

  // Turinys neturi dingti - tik nustoti būti vykdomas.
  assert.ok(res.text.includes("CMD()"));
});

test("HTML transkripcijoje lieka TEKSTU tekstiniame eksporte", async () => {
  const hostile = protocolWithPii();
  hostile.pavadinimas = "<script>alert(1)</script>";
  hostile.nutarimai = ['<img src=x onerror="alert(1)">'];

  const res = await request(app)
    .post("/api/exports")
    .send({ variant: "original", format: "txt", protocol: hostile });

  assert.equal(res.status, 200);

  // TXT yra grynas tekstas: žymėjimas išlieka matomas, bet niekada nevykdomas.
  // Saugų atvaizdavimą naršyklėje užtikrina frontend (žr. RedactionXss.test.jsx).
  assert.ok(res.text.includes("<script>"));
  assert.equal(res.headers["content-type"], "text/plain; charset=utf-8");
});

test("BENDRAS VALIDATORIUS: variantas parsinamas vienoje vietoje", () => {
  /**
   * Kol maršrutas vienas, atskiras helperis atrodo perteklinis. Bet variantų
   * logika jau dabar yra dviejose vietose (maršrutas ir eksporto servisas), o
   * pridėjus dar vieną endpointą trečia kopija atsirastų tyliai - ir skirtųsi.
   */
  const { parseRequestedVariant, REQUESTABLE_VARIANTS } = require("../utils/redactedArtefact");

  assert.equal(parseRequestedVariant("original"), "original");
  assert.equal(parseRequestedVariant("REDACTED"), "redacted");
  assert.equal(parseRequestedVariant("  redacted  "), "redacted");

  // NIEKO NENUMANO: nežinoma reikšmė -> null, o ne artimiausia panaši.
  for (const bad of ["originalas", "redaguotas", "orig", "", null, undefined, 42, {}]) {
    assert.equal(parseRequestedVariant(bad), null, `turėjo būti null: ${JSON.stringify(bad)}`);
  }

  // `generated` apibūdina tai, ką sistema PAGAMINO - prašyti jo negalima.
  assert.equal(parseRequestedVariant("generated"), null);
  assert.deepEqual(REQUESTABLE_VARIANTS, ["original", "redacted"]);
});

test("FAILO VARDAS: lietuviškos raidės TRANSLITERUOJAMOS, ne išmetamos", () => {
  const { exportFilename } = require("../services/exportService");

  // Aklas [^A-Za-z0-9] filtras „posėdžio_protokolas" paverstų į
  // „pos_d_io_protokolas" - failas taptų nebeskaitomas be aiškios priežasties.
  assert.equal(
    exportFilename("posėdžio_protokolas", "redacted", "2026-03-15", "docx"),
    "posedzio_protokolas_redaguotas_2026-03-15.docx"
  );
  assert.equal(
    exportFilename("ataskaitų_sąrašas", "original", "2026-03-15", "csv"),
    "ataskaitu_sarasas_originalas_2026-03-15.csv"
  );

  // Saugumo riba nepasikeitė: viskas kita vis tiek valoma.
  const hostile = exportFilename("ąčę", "original", "../../etc/passwd", "txt");
  assert.match(hostile, /^[A-Za-z0-9_.-]+$/);
  assert.ok(hostile.startsWith("ace_originalas_"));
});

test("CORS: failo vardo ir requestId antraštės EKSPONUOJAMOS klientui", async () => {
  /**
   * Rasta per E2E: naršyklė cross-origin užklausoje `Content-Disposition`
   * neperskaito, jei jos nėra `Access-Control-Expose-Headers`. Pasekmė buvo
   * TYLI - serverio sugeneruotas vardas dingdavo, o klientas nusileisdavo į
   * atsarginį `eksportas_redacted.docx`. Vietiniame nginx proxy diegime to
   * nesimato (tas pats originas), tad defektas gyveno tik ten, kur frontend ir
   * backend atskirti.
   */
  const res = await request(app)
    .post("/api/exports")
    .set("Origin", "http://localhost:5173")
    .send({ variant: "redacted", format: "txt", protocol: protocolWithPii() });

  assert.equal(res.status, 200);

  const exposed = (res.headers["access-control-expose-headers"] || "").toLowerCase();

  assert.ok(exposed.includes("content-disposition"), "be to failo vardas neprieinamas klientui");
  assert.ok(exposed.includes("x-request-id"), "be to koreliacijos ID klientui nematomas");
});
