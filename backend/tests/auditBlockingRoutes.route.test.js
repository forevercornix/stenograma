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
const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
process.env.AUTH_USERS = `admin:administrator:${hashPassword("teisingas-slaptas-1")}:${ADMIN_ID}`;

const request = require("supertest");
const auditLog = require("../utils/auditLog");
const { getAuditCounters, _resetAuditCountersForTests } = require("../utils/auditWrite");
const app = require("../server");
app._setReadyForTests();

/**
 * BLOKUOJANČIO AUDITO GEDIMAS PER TIKRĄ HTTP (#155, 7.4a / #210).
 *
 * ⚠️ KODĖL PER MARŠRUTĄ, O NE TIK PER `rasytiAudita()`.
 *
 * Vienetinis testas įrodo politiką, bet ne tai, kad produkcinis kelias ja
 * naudojasi. Jei `routes/auth.js` praleistų `await` arba nutylėtų
 * `AuditWriteError`, vienetiniai testai liktų žali, o prisijungimas be audito
 * įrašo praeitų - būtent ta regresija, dėl kurios #210 egzistuoja.
 */

/**
 * Sentinel tekstas imituoja tai, ką realus backend'as įdėtų į klaidą:
 * prisijungimo eilutę, vartotojo vardą, kelią. Nė vienas jų negali pasiekti
 * kliento.
 */
const SENTINEL = "SENTINEL host=db.internal user=stenograma password=slaptas";

/** Perima TIKRĄ `record()` - produkcinis kelias eina per tą patį modulio objektą. */
function suKrentanciuAuditu(veiksmas) {
  const originalus = auditLog.record;
  auditLog.record = async () => {
    throw new Error(SENTINEL);
  };
  return Promise.resolve(veiksmas()).finally(() => {
    auditLog.record = originalus;
  });
}

function suKabanciuAuditu(ribaMs, veiksmas) {
  const originalus = auditLog.record;
  const senaRiba = process.env.AUDIT_WRITE_TIMEOUT_MS;
  auditLog.record = () => new Promise(() => {});
  process.env.AUDIT_WRITE_TIMEOUT_MS = String(ribaMs);
  return Promise.resolve(veiksmas()).finally(() => {
    auditLog.record = originalus;
    if (senaRiba === undefined) delete process.env.AUDIT_WRITE_TIMEOUT_MS;
    else process.env.AUDIT_WRITE_TIMEOUT_MS = senaRiba;
  });
}

const prisijungti = () =>
  request(app).post("/api/auth/login").send({ username: "admin", password: "teisingas-slaptas-1" });

test("BLOKUOJANTIS HTTP: audito gedimas ATMETA prisijungimą", async () => {
  /** Prielaida: sveikame kelyje prisijungimas veikia. */
  const sveikas = await prisijungti();
  assert.equal(sveikas.status, 200, "prielaida: prisijungimas veikia");

  const res = await suKrentanciuAuditu(() => prisijungti());

  assert.equal(res.status, 503, "sėkmė negali būti deklaruota be patvirtinto audito");
  assert.equal(res.body.code, "AUDIT_WRITE_FAILED");
  assert.equal(res.headers["set-cookie"], undefined, "sesijos cookie negali būti išduota");
});

test("SANITIZACIJA: backend'o klaidos tekstas NEPATENKA į HTTP atsakymą", async () => {
  /**
   * ⚠️ TIKRINAMAS VISAS ATSAKYMAS, ne vien `error` laukas.
   *
   * Realizacija, grąžinanti `error.message` bet kuriame lauke ar antraštėje,
   * atiduotų prisijungimo eilutę ir slaptažodį klientui. Tikrinamas ir
   * `stack`, nes Express numatytasis klaidų kelias jį įdeda.
   */
  const res = await suKrentanciuAuditu(() => prisijungti());

  const visas = `${JSON.stringify(res.body)}\n${res.text || ""}\n${JSON.stringify(res.headers)}`;

  assert.ok(!visas.includes("SENTINEL"), "sentinel tekstas nutekėjo į atsakymą");
  assert.ok(!visas.includes("db.internal"), "prisijungimo informacija nutekėjo");
  assert.ok(!visas.includes("slaptas"), "slaptažodis nutekėjo");
  assert.ok(!/at\s+\w+\s+\(/.test(visas), "stack trace nutekėjo");

  /** Klientas VIS TIEK gauna naudingą, neutralų pranešimą. */
  assert.ok(res.body.error && res.body.error.length > 10, "atsakymas turi turėti neutralų paaiškinimą");
});

test("BLOKUOJANTIS HTTP: timeout atmeta prisijungimą per RIBOTĄ laiką", async () => {
  const pradzia = Date.now();

  const res = await suKabanciuAuditu(100, () => prisijungti());

  const trukmeMs = Date.now() - pradzia;
  assert.equal(res.status, 503, "kabantis auditas negali praleisti prisijungimo");
  assert.equal(res.body.code, "AUDIT_WRITE_FAILED");
  assert.ok(trukmeMs < 5000, `užklausa neturi užstrigti (truko ${trukmeMs} ms)`);
  assert.ok(!`${JSON.stringify(res.body)}`.includes("SENTINEL"));
});

test("BLOKUOJANTIS HTTP: atsijungimas su kritusiu auditu NEIŠVALO cookie", async () => {
  /**
   * Ta pati logika kaip 7.3 revokacijos kelyje: jei negalim patvirtinti audito,
   * negalim ir pasakyti „atsijungta". Cookie valymas tokiu atveju paliktų
   * klientą be credential'o, o serveryje sesija liktų.
   */
  const login = await prisijungti();
  const cookie = login.headers["set-cookie"][0].split(";")[0];

  const res = await suKrentanciuAuditu(() =>
    request(app).post("/api/auth/logout").set("Cookie", cookie)
  );

  assert.equal(res.status, 503);
  assert.equal(res.body.code, "AUDIT_WRITE_FAILED");
  assert.equal(res.headers["set-cookie"], undefined, "cookie negali būti valoma");
});

test("NEBLOKUOJANTIS HTTP: audito gedimas NENUMUŠA užklausos, bet DIDINA skaitiklį", async () => {
  /**
   * `/api/auth/me` neaudituoja, tad neblokuojantį kelią tikrinam per įkėlimo
   * atmetimą (`UPLOAD_REJECTED`), kuris yra job gyvavimo ciklo šeimoje.
   *
   * ⚠️ TIKRINAMA, KAD OPERACIJA IŠLIKO. Realizacija, kuri neblokuojantį gedimą
   * paverstų 500, sulaužytų #210 „užklausa nekrenta" reikalavimą.
   */
  /**
   * ⚠️ PRISIJUNGIAM PRIEŠ SUGADINDAMI AUDITĄ. Pats prisijungimas rašo
   * BLOKUOJANTĮ `LOGIN_SUCCESS`; su kritusiu backend'u jis teisėtai duotų 503,
   * ir įkėlimo kelio testas niekada nepasiektų.
   */
  const login = await prisijungti();
  assert.equal(login.status, 200, "prielaida: prisijungimas veikia");
  const cookie = login.headers["set-cookie"][0].split(";")[0];

  _resetAuditCountersForTests();

  const res = await suKrentanciuAuditu(() =>
    request(app).post("/api/transcribe-jobs").set("Cookie", cookie).field("meetingId", "be-failo")
  );

  assert.ok(res.status >= 400 && res.status < 500, `laukiamas kliento klaidos atsakymas, gauta ${res.status}`);
  assert.ok(!JSON.stringify(res.body).includes("SENTINEL"), "audito klaida negali nutekėti");
  assert.equal(
    getAuditCounters().auditWriteFailures,
    1,
    "neblokuojantis gedimas privalo būti matomas skaitikliu, ne nutylėtas"
  );
});

test("unhandledRejection: HTTP keliai su kritusiu auditu jo nesukelia", async () => {
  const pagauti = [];
  const handler = (p) => pagauti.push(p);
  process.on("unhandledRejection", handler);

  try {
    const login = await prisijungti();
    const cookie = login.headers["set-cookie"][0].split(";")[0];

    await suKrentanciuAuditu(async () => {
      await prisijungti();
      await request(app).post("/api/transcribe-jobs").set("Cookie", cookie).field("meetingId", "be-failo");
    });

    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(pagauti, [], `unhandledRejection suveikė ${pagauti.length} kartus`);
  } finally {
    process.off("unhandledRejection", handler);
  }
});

test("ADMIN: override audito gedimas duoda SANITIZUOTĄ 503, ne Express numatytąjį 500", async () => {
  /**
   * ⚠️ REGRESIJA, KURIĄ ŠIS TESTAS UŽDARO.
   *
   * `adminDeleteJob()` / `adminCleanupOrphan()` meta `AuditWriteError`, o
   * DELETE maršrutai neturėjo `catch`; repo neturi ir globalaus Express klaidų
   * handlerio. Klientas gaudavo Express numatytąjį 500/HTML vietoj
   * dokumentuoto `503 AUDIT_WRITE_FAILED`, o ne produkcijoje atsakyme galėjo
   * atsirasti pirminė backend'o klaida iš stack trace.
   *
   * Tikrinamas administracinis kelias: `ADMIN_ACCESS_DENIED` rašomas dar
   * `assertSessionAdmin()` metu, tad audito gedimas pasiekia maršrutą net
   * neegzistuojančiam job'ui.
   */
  const login = await prisijungti();
  const cookie = login.headers["set-cookie"][0].split(";")[0];

  const res = await suKrentanciuAuditu(() =>
    request(app).delete("/api/jobs/00000000-0000-4000-8000-000000000000").set("Cookie", cookie)
  );

  /**
   * ⚠️ JOKIŲ SĄLYGINIŲ ASSERCIJŲ (AGENTS.md §9.1).
   *
   * `if (res.status === 503) { ... }` paverstų 500/HTML atsakymą PRAĖJIMU -
   * t. y. testas nutylėtų būtent tą regresiją, kurią turi gaudyti.
   */
  assert.equal(res.status, 503, "audito gedimas privalo duoti dokumentuotą 503, ne Express numatytąjį 500");
  assert.equal(res.body.code, "AUDIT_WRITE_FAILED");

  const visas = `${JSON.stringify(res.body)}\n${res.text || ""}\n${JSON.stringify(res.headers)}`;
  assert.ok(!visas.includes("SENTINEL"), "sentinel tekstas nutekėjo į atsakymą");
  assert.ok(!visas.includes("db.internal"), "prisijungimo informacija nutekėjo");
  assert.ok(!visas.includes("slaptas"), "slaptažodis nutekėjo");
  assert.ok(!/at\s+\w+\s+\(/.test(visas), "stack trace nutekėjo");
});

