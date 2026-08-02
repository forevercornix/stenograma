const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LLM_PROVIDER = "mock";
process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.DIARIZATION_PROVIDER = "none";
process.env.API_KEY = "";
process.env.LOG_LEVEL = "error";
process.env.RATE_LIMIT_MAX_REQUESTS = "500";
process.env.RATE_LIMIT_GENERAL_MAX = "500";

const request = require("supertest");
const { validateConfig } = require("../utils/startupChecks");
const { resolveCorsOptions } = require("../utils/securityBaseline");
const { validate, schemas, formatIssues } = require("../middleware/validate");
const app = require("../server");
app._setReadyForTests();

/**
 * #14: CENTRINĖ API SAUGUMO BAZĖ.
 *
 * Esmė nėra „pridėti helmet". Esmė - kad bazė būtų VIENOJE vietoje ir taikoma
 * automatiškai: naujas endpointas turi ją gauti todėl, kad ji registruota prieš
 * maršrutus, o ne todėl, kad kas nors prisiminė ją pridėti.
 */

test("ANTRAŠTĖS: saugumo antraštės nustatomos visiems atsakymams", async () => {
  const res = await request(app).get("/api/health");

  assert.equal(res.headers["x-content-type-options"], "nosniff");
  // CSP nustatoma griežčiausia (`default-src 'none'`), o ne išjungiama: HTML čia
  // nesiunčiamas, tad ji nieko nelaužo, bet apsaugo klaidos puslapius ir bet kokį
  // būsimą HTML atsakymą.
  assert.match(res.headers["content-security-policy"], /default-src 'none'/);
  assert.match(res.headers["content-security-policy"], /frame-ancestors 'none'/);

  // Serverio technologija neturi būti skelbiama - tai nemokama informacija
  // užpuolikui apie žinomas pažeidžiamybes.
  assert.equal(res.headers["x-powered-by"], undefined);
});

test("CORS: allow-list, ne wildcard pagal nutylėjimą", () => {
  const options = resolveCorsOptions({});

  assert.ok(Array.isArray(options.origin), "numatytai turi būti sąrašas, ne `true`");
  assert.deepEqual(options.origin, ["http://localhost:5173"]);
  assert.deepEqual(options.exposedHeaders, ["Content-Disposition", "X-Request-Id"]);
});

test("CORS: kelios kilmės atskiriamos kableliais", () => {
  const options = resolveCorsOptions({ CORS_ORIGIN: "https://a.lt, https://b.lt ,, " });

  assert.deepEqual(options.origin, ["https://a.lt", "https://b.lt"]);
});

test("CORS: wildcard + credentials yra KLAIDA, ne tylus derinys", () => {
  /**
   * Naršyklė tokio derinio ir taip neleistų, bet tyli konfigūracija reikštų,
   * kad administratorius mano turintis apsaugą, kurios nėra - o užklausos
   * tiesiog neveiktų be aiškios priežasties.
   */
  assert.throws(
    () => resolveCorsOptions({ CORS_ORIGIN: "*", CORS_CREDENTIALS: "true" }),
    (e) => e.code === "CORS_UNSAFE_COMBINATION"
  );

  // Wildcard BE credentials leidžiamas - sąmoningas pasirinkimas viešam demo.
  const options = resolveCorsOptions({ CORS_ORIGIN: "*" });

  // LITERALAS, ne `true`: `origin: true` atspindi užklausos Origin antraštę, o
  // atspindėjimas tampa pavojingas vos kam nors įjungus credentials.
  assert.equal(options.origin, "*");
  assert.equal(options.credentials, false);
});

test("KŪNO LIMITAS: per didelis JSON atmetamas", async () => {
  // Numatytas limitas 1 MB: audio eina per multipart, tad JSON gali būti mažas.
  const huge = { transcript: "a".repeat(2 * 1024 * 1024) };

  const res = await request(app).post("/api/generate").send(huge);

  assert.equal(res.status, 413, `laukta 413, gauta ${res.status}`);
});

test("VALIDACIJA: vienas klaidų formatas su path ir code", async () => {
  const res = await request(app).post("/api/exports").send({ format: "txt", protocol: {} });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, "VALIDATION_FAILED");
  assert.ok(Array.isArray(res.body.details));
  assert.ok(res.body.details[0].path);
  assert.ok(res.body.details[0].message);

  // Vidinių detalių atsakyme būti negali.
  const serialized = JSON.stringify(res.body);
  assert.ok(!serialized.includes("at "), "jokio stack trace");
  assert.ok(!serialized.includes("/home/"), "jokių vietinių kelių");
});

test("VALIDACIJA: nežinomi laukai ATMETAMI, ne ignoruojami", async () => {
  /**
   * Tylus ignoravimas reikštų, kad `{ varinat: "original" }` (rašybos klaida)
   * atrodo kaip užklausa be varianto, ir klientas gauna pranešimą apie
   * trūkstamą lauką, kurį ką tik nurodė.
   */
  const res = await request(app)
    .post("/api/exports")
    .send({ variant: "original", format: "txt", protocol: {}, nezinomas: "x" });

  assert.equal(res.status, 400);
  assert.ok(
    res.body.details.some((issue) => /unrecognized|nezinomas/i.test(issue.code + issue.message)),
    `laukta pranešimo apie nežinomą lauką: ${JSON.stringify(res.body.details)}`
  );
});

test("VALIDACIJA: identifikatoriai ribojami formatu ir ilgiu", () => {
  const ok = schemas.identifier.safeParse("job_123.abc:x-1");
  assert.equal(ok.success, true);

  for (const bad of ["", "a".repeat(65), "su tarpu", "kabutės'", "../../etc"]) {
    assert.equal(schemas.identifier.safeParse(bad).success, false, `turėjo būti atmesta: ${bad}`);
  }
});

test("VALIDACIJA: boolean priimamas ir kaip JSON, ir kaip eilutė", () => {
  assert.equal(schemas.flexibleBoolean.parse(true), true);
  assert.equal(schemas.flexibleBoolean.parse("false"), false);
  assert.equal(schemas.flexibleBoolean.safeParse("taip").success, false);
});

test("VALIDACIJA: middleware deda rezultatą į req.validated, ne į req.body", () => {
  /**
   * `req.query` Express 5 yra tik skaitomas, o perrašinėti `req.body` reikštų,
   * kad kitas skaitytojas nebežino, ar mato žalią, ar patikrintą reikšmę.
   */
  const req = { body: { variant: "original", format: "txt", protocol: {} } };
  const res = { status: () => ({ json: () => {} }) };
  let called = false;

  validate({ body: schemas.exportBody })(req, res, () => {
    called = true;
  });

  assert.ok(called);
  assert.equal(req.validated.body.variant, "original");
  assert.deepEqual(req.body, { variant: "original", format: "txt", protocol: {} });
});

test("STARTUP: produkcijoje nesaugi konfigūracija STABDO paleidimą", () => {
  const wildcard = validateConfig({ NODE_ENV: "production", CORS_ORIGIN: "*", API_KEY: "x" });
  assert.ok(wildcard.errors.some((e) => /CORS_ORIGIN/.test(e)));

  const blindProxy = validateConfig({ NODE_ENV: "production", TRUST_PROXY: "true", API_KEY: "x" });
  assert.ok(blindProxy.errors.some((e) => /TRUST_PROXY/.test(e)));

  // Kūrimo aplinkoje tas pats derinys yra patogumas, ne rizika.
  assert.deepEqual(validateConfig({ CORS_ORIGIN: "*" }).errors, []);
});

test("READINESS: Redis operacijos turi ribotą laukimą", () => {
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");

  /**
   * Struktūrinė patikra: elgsenai reikėtų pakibusio Redis. Be timeout'o pakibęs
   * Redis pakabina ir `/api/ready` - orkestruotojas vietoj aiškaus 503 gauna
   * timeout, o konteineris kabo „tikrinamas" būsenoje.
   */
  assert.match(source, /withTimeout\(conn\.ping\(\)/);
  assert.match(source, /withTimeout\(getWorkerStatus\(conn\)/);
  assert.match(source, /READINESS_TIMEOUT_MS/);
});

test("RATE LIMIT: bendra riba taikoma VISIEMS /api maršrutams", () => {
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");

  // Be bendros ribos bazė būtų „ribojama tik tai, ką kas nors prisiminė apriboti".
  assert.match(source, /app\.use\("\/api", generalApiLimiter\)/);
});

test("formatIssues: apkerpa labai ilgą klaidų sąrašą", () => {
  const fake = { issues: Array.from({ length: 100 }, (_, i) => ({ path: [`f${i}`], code: "x", message: "m" })) };

  // Neribotas sąrašas leistų klientui sugeneruoti didelį atsakymą pigia užklausa.
  assert.equal(formatIssues(fake).details.length, 20);
});

test("VALIDACIJA: kliento lauko pavadinimas NEGRĮŽTA atsakyme", async () => {
  /**
   * Zod `unrecognized_keys` pranešimas ĮTRAUKIA kliento pateiktą lauko vardą:
   *   { "Jonas_Jonaitis_39001010000": "x" } → 'Unrecognized key: "Jonas_..."'
   *
   * Perduodant jį pažodžiui, PII grįžtų HTTP atsakyme, patektų į frontend
   * klaidos pranešimą ir galiausiai į logus - per biblioteką atsirastų tas pats
   * nutekėjimas, kurio vengiam visur kitur.
   */
  const hostileKey = `Jonas_Jonaitis_39001010000_${"A".repeat(3000)}`;

  const res = await request(app)
    .post("/api/exports")
    .send({ variant: "original", format: "txt", protocol: {}, [hostileKey]: "x", "<script>": "y" });

  assert.equal(res.status, 400);

  const serialized = JSON.stringify(res.body);

  assert.ok(!serialized.includes("39001010000"), "PII iš lauko vardo negali grįžti");
  assert.ok(!serialized.includes("<script>"), "HTML iš lauko vardo negali grįžti");
  assert.ok(!serialized.includes("AAAA"), "ilgas kliento tekstas negali grįžti");

  // Atsakymo dydis lieka ribotas net esant kelių kilobaitų įvesčiai.
  assert.ok(serialized.length < 2000, `atsakymas per didelis: ${serialized.length} B`);

  // Bet klientas vis tiek sužino, KAS negerai.
  assert.equal(res.body.details[0].code, "unrecognized_keys");
  assert.match(res.body.details[0].message, /neleidžiamų laukų/);
});

test("VALIDACIJA: nesaugus path segmentas pakeičiamas žymeniu", () => {
  const { safePath } = require("../middleware/validate");

  assert.equal(safePath(["protocol", "dalyviai", 0]), "protocol.dalyviai.0");
  assert.equal(safePath(["<script>alert(1)</script>"]), "[laukas]");
  assert.equal(safePath(["a".repeat(100)]), "[laukas]");

  // Gilus kelias apkerpamas - jis irgi gali būti kliento valdomas.
  assert.equal(safePath(Array(20).fill("a")).split(".").length, 8);
});

test("READINESS: withTimeout realiai nutraukia pakibusį pažadą", async () => {
  /**
   * Struktūrinė patikra įrodo, kad kvietimas apvyniotas; ši - kad apvalkalas
   * veikia. Be jos „timeout yra" reikštų tik „tekstas faile yra".
   */
  const withTimeout = app._withTimeoutForTests;

  const started = Date.now();
  await assert.rejects(
    () => withTimeout(new Promise(() => {}), 30, "testas"),
    /Readiness timeout/
  );

  const elapsed = Date.now() - started;
  assert.ok(elapsed < 500, `turėjo nutrūkti greitai, užtruko ${elapsed} ms`);

  // Sėkmingas pažadas praeina nepaliestas.
  assert.equal(await withTimeout(Promise.resolve("ok"), 1000, "testas"), "ok");
});

test("KONFIGŪRACIJA: netinkamos skaitinės reikšmės STABDO paleidimą", () => {
  const { requirePositiveInt, requireBodyLimit } = require("../utils/securityBaseline");

  for (const bad of ["abc", "-1", "0", "1.5"]) {
    assert.throws(
      () => requirePositiveInt({ X: bad }, "X", 100),
      (e) => e.code === "SECURITY_CONFIG_INVALID",
      `turėjo būti atmesta: ${bad}`
    );
  }

  // Nenustatyta reikšmė - numatytoji, ne klaida.
  assert.equal(requirePositiveInt({}, "X", 100), 100);
  assert.equal(requireBodyLimit({}, "1mb"), "1mb");

  assert.throws(() => requireBodyLimit({ JSON_BODY_LIMIT: "nesamone" }, "1mb"), (e) => e.code === "SECURITY_CONFIG_INVALID");
  assert.equal(requireBodyLimit({ JSON_BODY_LIMIT: "500kb" }, "1mb"), "500kb");
});

test("CORS: kilmės tikrinamos kaip kilmės, ne kaip bet koks tekstas", () => {
  for (const bad of ["ne-urlas", "javascript:alert(1)", "https://a.lt/path", "https://u:p@a.lt", "*,https://a.lt"]) {
    assert.throws(
      () => resolveCorsOptions({ CORS_ORIGIN: bad }),
      (e) => e.code === "CORS_ORIGIN_INVALID",
      `turėjo būti atmesta: ${bad}`
    );
  }

  // Normalizuojama į kilmę (be pabaigos brūkšnio).
  assert.deepEqual(resolveCorsOptions({ CORS_ORIGIN: "https://a.lt:8443" }).origin, ["https://a.lt:8443"]);
});

test("STARTUP: netinkamos saugumo nuostatos matomos PALEIDŽIANT", () => {
  const cases = [
    { CORS_ORIGIN: "javascript:alert(1)" },
    { JSON_BODY_LIMIT: "nesamone" },
    { READINESS_TIMEOUT_MS: "abc" },
    { RATE_LIMIT_GENERAL_MAX: "0" },
  ];

  for (const env of cases) {
    const { errors } = validateConfig(env);
    assert.ok(errors.length > 0, `turėjo duoti startup klaidą: ${JSON.stringify(env)}`);
  }
});

test("REGRESIJA: `jobId: null` yra teisėta būsena, ne validacijos klaida", async () => {
  /**
   * Rasta per E2E: įklijuoto teksto sraute transkribavimo jobo apskritai nėra,
   * ir frontend siunčia `jobId: null`. Griežta schema jį atmetė, tad eksportas
   * lūžo 400 klaida - o `npm test` to nepagavo, nes visi backend testai `jobId`
   * arba praleisdavo, arba siuntė eilutę.
   *
   * Reikalauti lauko PRALEIDIMO reikštų, kad klientas turi žinoti mūsų vidinę
   * taisyklę, o `undefined` vs `null` skirtumas JSON'e dar ir nestabilus.
   */
  const res = await request(app)
    .post("/api/exports")
    .send({ variant: "redacted", format: "txt", protocol: { pavadinimas: "P" }, jobId: null });

  assert.equal(res.status, 200, `jobId: null turi būti priimtas, gauta ${res.status}`);
});

test("REGRESIJA: netinkamas jobId vis tiek atmetamas", () => {
  // `null` leidžiamas, bet tai nereiškia, kad tikrinimo nebeliko.
  for (const bad of ["su tarpu", "a".repeat(65), "../../etc", 42, {}]) {
    assert.equal(
      schemas.exportBody.safeParse({ variant: "redacted", format: "txt", protocol: {}, jobId: bad }).success,
      false,
      `turėjo būti atmesta: ${JSON.stringify(bad)}`
    );
  }
});

/**
 * ---------------------------------------------------------------------------
 * #14 PR2: VALIDACIJA VISUOSE MARŠRUTUOSE.
 * ---------------------------------------------------------------------------
 */

test("PARAMS: netinkamas jobId atmetamas prieš pasiekiant saugyklą", async () => {
  /**
   * Anksčiau `req.params.id` keliaudavo tiesiai į `jobStore.get()`. Saugykla su
   * tuo susitvarko, bet tikrinti prie ribos pigiau ir aiškiau - klientas gauna
   * validacijos klaidą, o ne 404 apie „nerastą" jobą, kurio ID iš viso negalimas.
   */
  for (const bad of ["../../etc/passwd", "a".repeat(100), "su tarpu"]) {
    const res = await request(app).get(`/api/jobs/${encodeURIComponent(bad)}`);

    assert.equal(res.status, 400, `turėjo būti atmesta: ${bad}`);
    assert.equal(res.body.code, "VALIDATION_FAILED");
  }
});

test("PARAMS: galiojantis ID praeina (validacija nėra aklas blokas)", async () => {
  const res = await request(app).get("/api/jobs/job_123-abc");

  // 404 reiškia, kad validaciją praėjo ir jobas tiesiog neegzistuoja.
  assert.equal(res.status, 404);
});

test("MULTIPART: laukai konvertuojami iš eilučių", () => {
  /**
   * `diarize=true` per multipart yra TEKSTAS. Iki šiol maršrutas tikrino
   * `req.body.diarize === "true" || req.body.diarize === true` rankomis - viena
   * tokia patikra maršrute, kita kitur, ir jos ilgainiui išsiskirdavo.
   */
  const parsed = schemas.transcribeBody.parse({ diarize: "true", numSpeakers: "3", language: "lt" });

  assert.equal(parsed.diarize, true);
  assert.equal(parsed.numSpeakers, 3);
  assert.equal(typeof parsed.numSpeakers, "number");

  // JSON pavidalas veikia identiškai - klientui nereikia žinoti skirtumo.
  assert.deepEqual(schemas.transcribeBody.parse({ diarize: true, numSpeakers: 3 }), {
    diarize: true,
    numSpeakers: 3,
  });
});

test("AUDIO URL: tik http/https, ne bet koks `url()`", () => {
  /**
   * `z.string().url()` praleidžia `javascript:`, `file:` ir `data:`. Šis URL
   * keliauja į transkribavimo tiekėją, tad schemų sąrašas turi būti baltas.
   */
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "data:audio/wav;base64,AAA", "ne-urlas"]) {
    assert.equal(
      schemas.transcribeBody.safeParse({ audioUrl: bad }).success,
      false,
      `turėjo būti atmesta: ${bad}`
    );
  }

  assert.equal(schemas.transcribeBody.safeParse({ audioUrl: "https://a.lt/f.wav" }).success, true);
});

test("SCHEMOS ATITINKA SERVISO PARAŠĄ, ne mūsų atmintį", () => {
  /**
   * Rasta rašant šį PR: pirmoji `protocolJobBody` versija neįtraukė `title`,
   * `date`, `participants` ir `segments` - o juos naudoja `generateProtocol()`
   * ir siunčia frontend. Griežtas režimas būtų atmetęs teisėtas užklausas.
   *
   * Testas lygina schemą su REALIU serviso parašu, kad neatitikimas iškiltų
   * čia, o ne produkcijoje.
   */
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "../services/protocolService.js"), "utf8");

  const signature = source.match(/async function generateProtocol\(\{([^}]*)\}/);
  assert.ok(signature, "nepavyko perskaityti generateProtocol parašo");

  const serviceFields = signature[1]
    .split(",")
    .map((part) => part.trim().split(/[:=]/)[0].trim())
    .filter(Boolean);

  /**
   * Tikrinamos ABI schemos: `/api/generate` ir `/api/jobs` maitina TĄ PATĮ
   * servisą, tad praleistas laukas viename kelyje yra toks pat gedimas kaip
   * kitame. Pirmoji šio testo versija tikrino tik `generateBody`, ir mutacija,
   * pašalinusi laukus iš `protocolJobBody`, praėjo nepastebėta.
   */
  /**
   * Serverio įterpiami laukai į schemas NEĮEINA sąmoningai.
   *
   * `/api/jobs` kelyje `jobId` sukuria serveris ir prideda processor'ius
   * (`{ ...payload, jobId }`) - klientas jo siųsti negali ir neturi. Įtraukus jį
   * į schemą, klientas galėtų primesti svetimą jobo ID audito įrašams.
   */
  const serverInjected = { protocolJobBody: ["jobId"], generateBody: [] };

  for (const [name, schema] of [
    ["generateBody", schemas.generateBody],
    ["protocolJobBody", schemas.protocolJobBody],
  ]) {
    const schemaFields = Object.keys(schema.shape);

    for (const field of serviceFields) {
      if (serverInjected[name].includes(field)) continue;

      // `promptVersionOverride` servise atitinka `promptVersion` schemoje.
      const alias = field === "promptVersionOverride" ? "promptVersion" : field;

      assert.ok(
        schemaFields.includes(alias),
        `${name}: servisas naudoja "${field}", bet schema jo nepriima - ` +
          "griežtas režimas atmestų teisėtą užklausą"
      );
    }
  }
});
