const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.API_KEY = "";
process.env.LOG_LEVEL = "error";
process.env.RATE_LIMIT_LOGIN_IP_MAX = "500";
process.env.RATE_LIMIT_LOGIN_ACCOUNT_MAX = "500";
process.env.RATE_LIMIT_MAX_REQUESTS = "500";
process.env.RATE_LIMIT_GENERAL_MAX = "500";

const { hashPassword } = require("../utils/credentials");

process.env.AUTH_USERS = `admin:administrator:${hashPassword("teisingas-slaptas-1")},operatorius:operator:${hashPassword(
  "kitas-slaptas-2"
)}`;

const request = require("supertest");
const sessionStore = require("../utils/sessionStore");
const auditLog = require("../utils/auditLog");
const app = require("../server");
app._setReadyForTests();

/**
 * #18 PR1: LOGIN/LOGOUT/ME – VISAS SRAUTAS PER TIKRĄ HTTP.
 */

function extractCookie(res) {
  const raw = res.headers["set-cookie"];
  return raw ? raw[0] : null;
}

test("LOGIN: teisingi duomenys grąžina sesijos cookie ir 200", async () => {
  const res = await request(app).post("/api/auth/login").send({ username: "admin", password: "teisingas-slaptas-1" });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { username: "admin", role: "administrator" });

  const cookie = extractCookie(res);
  assert.ok(cookie, "atsakymas turi nešti sesijos cookie");
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.ok(!/Secure/i.test(cookie), "testinėje aplinkoje (ne production) Secure neturi būti nustatytas");
});

test("LOGIN: neteisingas slaptažodis grąžina 401, ne 200 su tuščiu vartotoju", async () => {
  const res = await request(app).post("/api/auth/login").send({ username: "admin", password: "blogas" });

  assert.equal(res.status, 401);
  assert.equal(res.body.code, "INVALID_CREDENTIALS");
});

test("LOGIN: nežinomas vartotojas grąžina TĄ PATĮ atsakymą kaip blogas slaptažodis", async () => {
  const unknown = await request(app).post("/api/auth/login").send({ username: "nera_tokio", password: "bet-kas" });
  const wrongPassword = await request(app).post("/api/auth/login").send({ username: "admin", password: "blogas" });

  assert.equal(unknown.status, wrongPassword.status);
  assert.deepEqual(unknown.body, wrongPassword.body);
});

test("LOGIN: atsakymas ir auditas NIEKADA nešneša slaptažodžio", async () => {
  const before = auditLog.getAll().length;
  const secret = "labai-slaptas-tekstas-xyz";

  const res = await request(app).post("/api/auth/login").send({ username: "admin", password: secret });

  const serialized = JSON.stringify(res.body) + JSON.stringify(auditLog.getAll().slice(before));
  assert.ok(!serialized.includes(secret), "slaptažodis negali patekti nei į atsakymą, nei į auditą");
});

test("ME: su galiojančia sesija grąžina vartotoją ir rolę", async () => {
  const login = await request(app).post("/api/auth/login").send({ username: "operatorius", password: "kitas-slaptas-2" });
  const cookie = extractCookie(login);

  const me = await request(app).get("/api/auth/me").set("Cookie", cookie);

  assert.equal(me.status, 200);
  assert.deepEqual(me.body, { username: "operatorius", role: "operator" });
});

test("ME: be cookie grąžina vienodą 401", async () => {
  const res = await request(app).get("/api/auth/me");

  assert.equal(res.status, 401);
  assert.equal(res.body.code, "SESSION_REQUIRED");
});

test("ME: su neteisingu/suklastotu cookie grąžina tą patį 401", async () => {
  const forged = await request(app)
    .get("/api/auth/me")
    .set("Cookie", "stenograma_sid=akivaizdziai-suklastota-reiksme");

  assert.equal(forged.status, 401);
  assert.equal(forged.body.code, "SESSION_REQUIRED");
});

test("LOGOUT: revokuoja sesiją - PO logout ta pati cookie nebegalioja", async () => {
  const login = await request(app).post("/api/auth/login").send({ username: "admin", password: "teisingas-slaptas-1" });
  const cookie = extractCookie(login);

  const beforeLogout = await request(app).get("/api/auth/me").set("Cookie", cookie);
  assert.equal(beforeLogout.status, 200);

  const logout = await request(app).post("/api/auth/logout").set("Cookie", cookie);
  assert.equal(logout.status, 200);

  const afterLogout = await request(app).get("/api/auth/me").set("Cookie", cookie);
  assert.equal(afterLogout.status, 401, "revokuota sesija negali likti galiojanti");
});

test("LOGOUT: be aktyvios sesijos yra idempotentinis (ne klaida)", async () => {
  const res = await request(app).post("/api/auth/logout");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
});

test("VALIDACIJA: trūkstamas laukas duoda 400 su vienu formatu, ne 500", async () => {
  const res = await request(app).post("/api/auth/login").send({ username: "admin" });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, "VALIDATION_FAILED");
});

test("VALIDACIJA: nežinomi laukai atmetami (nuoseklu su #14 politika)", async () => {
  const res = await request(app)
    .post("/api/auth/login")
    .send({ username: "admin", password: "x", extra: "netikėtas laukas" });

  assert.equal(res.status, 400);
});

test("RATE LIMIT: struktūra rodo DU nepriklausomus limiterius", async () => {
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "../middleware/rateLimiter.js"), "utf8");

  assert.match(source, /loginIpLimiter/);
  assert.match(source, /loginAccountLimiter/);
  assert.match(source, /ipKeyGenerator/, "IPv6-saugus raktų generavimas (express-rate-limit) turi būti naudojamas");
});

test("LOGIN: vartotojo vardo paieška NEJAUTRI didžiosioms raidėms (sąmoningas patogumas)", async () => {
  // verifyCredentials() normalizuoja vardą prieš ieškant - vartotojas, įvedęs
  // "Admin" ar "ADMIN", turi prisijungti taip pat, kaip įvedęs "admin".
  // Saugomas vardas visada lowercase (USERNAME_PATTERN), bet PAIEŠKA - ne.
  for (const variant of ["Admin", "ADMIN", "admin"]) {
    const res = await request(app).post("/api/auth/login").send({ username: variant, password: "teisingas-slaptas-1" });
    assert.equal(res.status, 200, `variantas "${variant}" turėjo prisijungti`);
    assert.equal(res.body.username, "admin", "grąžintas vardas visada normalizuotas");
  }
});

/**
 * ---------------------------------------------------------------------------
 * REVIEW PATAISYMAI: rate-limit apėjimas, sugadinta cookie, sesijų sweep.
 * ---------------------------------------------------------------------------
 */

test("RATE LIMIT: account limiteris realiai riboja PO normalizacijos (HTTP lygiu)", async () => {
  /**
   * Realus elgesio testas: siunčiam kelis variantus to paties vardo su
   * skirtingu registru/tarpais ir tikrinam, kad jie DALINASI TĄ PATĮ limitą,
   * o ne kiekvienas gauna savo.
   *
   * Naudojam mažą laikiną limitą per aplinkos kintamąjį, kad testas būtų
   * greitas ir determinuotas.
   *
   * VALYMAS `finally` BLOKE: jei assertion žemiau kristų, be `finally`
   * env kintamieji ir require.cache liktų pakeisti, ir VĖLESNI testai
   * gautų neteisingą limitą arba pasenusį serverio modulį.
   */
  delete require.cache[require.resolve("../middleware/rateLimiter")];
  delete require.cache[require.resolve("../routes/auth")];
  delete require.cache[require.resolve("../server")];

  process.env.RATE_LIMIT_LOGIN_ACCOUNT_MAX = "3";
  process.env.RATE_LIMIT_LOGIN_IP_MAX = "500"; // IP limitą darom plačiu, kad netrukdytų šiam testui

  try {
    const request2 = require("supertest");
    const freshApp = require("../server");
    freshApp._setReadyForTests();

    const variants = ["admin", "ADMIN", " admin", "admin ", "admin\t"];
    const statuses = [];

    for (const variant of variants) {
      const res = await request2(freshApp).post("/api/auth/login").send({ username: variant, password: "blogas" });
      statuses.push(res.status);
    }

    // Su limitu=3, ketvirtas ir penktas bandymas TO PATIES vardo variantais
    // turi būti apriboti - jei jie būtų skirtingi raktai, visi 5 praeitų kaip 401.
    assert.ok(statuses.slice(3).some((s) => s === 429), `variantai turėjo dalintis limitą, gauta: ${statuses.join(",")}`);
  } finally {
    delete process.env.RATE_LIMIT_LOGIN_ACCOUNT_MAX;
    delete process.env.RATE_LIMIT_LOGIN_IP_MAX;
    delete require.cache[require.resolve("../middleware/rateLimiter")];
    delete require.cache[require.resolve("../routes/auth")];
    delete require.cache[require.resolve("../server")];
  }
});

test("RATE LIMIT: IP limiteris veikia NEPRIKLAUSOMAI nuo vardo turinio", async () => {
  /**
   * Būtent tai, ko trūko prieš pataisymą: be IP-only limito atakuotojas,
   * kiekvieną kartą siunčiantis NAUJĄ vardą, niekada nepasiektų to paties
   * account rakto ir praktiškai apeitų limitą visiškai.
   */
  delete require.cache[require.resolve("../middleware/rateLimiter")];
  delete require.cache[require.resolve("../routes/auth")];
  delete require.cache[require.resolve("../server")];

  process.env.RATE_LIMIT_LOGIN_IP_MAX = "3";
  process.env.RATE_LIMIT_LOGIN_ACCOUNT_MAX = "500";

  try {
    const request2 = require("supertest");
    const freshApp = require("../server");
    freshApp._setReadyForTests();

    const statuses = [];
    for (let i = 0; i < 5; i += 1) {
      // KIEKVIENĄ kartą NAUJAS vardas - jei apsaugotume tik pagal account raktą,
      // visi 5 praeitų kaip 401.
      const res = await request2(freshApp).post("/api/auth/login").send({ username: `vardas${i}`, password: "blogas" });
      statuses.push(res.status);
    }

    assert.ok(statuses.some((s) => s === 429), `IP limitas turėjo suveikti nepaisant skirtingų vardų: ${statuses.join(",")}`);
  } finally {
    delete process.env.RATE_LIMIT_LOGIN_IP_MAX;
    delete process.env.RATE_LIMIT_LOGIN_ACCOUNT_MAX;
    delete require.cache[require.resolve("../middleware/rateLimiter")];
    delete require.cache[require.resolve("../routes/auth")];
    delete require.cache[require.resolve("../server")];
  }
});

test("COOKIE: sugadintas procentinis kodavimas duoda 401, NE 500", async () => {
  /**
   * `decodeURIComponent(\"%E0%A4%A\")` meta neišgautą `URIError`. Be
   * try/catch klientas gautų vidinę klaidą vietoj deklaruoto vienodo 401.
   */
  const res = await request(app).get("/api/auth/me").set("Cookie", "stenograma_sid=%E0%A4%A");

  assert.equal(res.status, 401, "sugadinta cookie turi duoti 401, ne 500");
  assert.equal(res.body.code, "SESSION_REQUIRED");
});

test("COOKIE: kitos sugadintos procentinio kodavimo formos irgi fail-closed", async () => {
  for (const malformed of ["%", "%1", "%zz", "%E0%A4"]) {
    const res = await request(app).get("/api/auth/me").set("Cookie", `stenograma_sid=${malformed}`);
    assert.equal(res.status, 401, `"${malformed}" turėjo duoti 401`);
  }
});
