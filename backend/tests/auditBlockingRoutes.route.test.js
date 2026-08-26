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
const sessionStoreModulis = require("../utils/sessionStore");
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

test("BLOKUOJANTIS HTTP: atsijungimas su kritusiu auditu IŠVALO cookie ir grąžina 503", async () => {
  /**
   * ⚠️ SĄMONINGAS KONTRAKTO PAKEITIMAS, NE TESTO SUSILPNINIMAS.
   *
   * Ankstesnė versija reikalavo, kad cookie NEBŪTŲ valoma. Tai kūrė TREČIĄ
   * nesutampančią būseną: serveryje sesija JAU atšaukta (`destroy()` pavyko),
   * kliente lieka negaliojantis cookie, o atsakymas sako „nepavyko".
   *
   * Taisyklė abiem #210 keliams viena: sėkmė nedeklaruojama be patvirtinto
   * audito, BET negrįžtamas darbas neatšaukiamas ir nemaskuojamas. Cookie
   * valymas nėra sėkmės deklaravimas - sėkmę deklaruoja `{ ok: true }` su 200.
   *
   * Testas dabar GRIEŽTESNIS: tikrina, kad visos trys būsenos sutampa.
   */
  const login = await prisijungti();
  const cookie = login.headers["set-cookie"][0].split(";")[0];
  const token = decodeURIComponent(cookie.split("=")[1]);

  const res = await suKrentanciuAuditu(() =>
    request(app).post("/api/auth/logout").set("Cookie", cookie)
  );

  /** 1. Klientas sužino, kad audito užfiksuoti nepavyko. */
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "AUDIT_WRITE_FAILED");

  /** 2. Bet jis LIEKA ATSIJUNGĘS - credential'as pašalintas. */
  assert.ok(res.headers["set-cookie"], "cookie valymo antraštė privaloma");
  assert.match(res.headers["set-cookie"][0], /Max-Age=0/, "cookie privalo būti išvalyta");

  /** 3. Ir serveryje sesija realiai atšaukta - trys būsenos sutampa. */
  const sessionStore = require("../utils/sessionStore");
  assert.equal(
    await sessionStore.touch(token),
    null,
    "revokacija įvyko prieš auditą - ji negali būti atšaukta atgal"
  );
});

test("BLOKUOJANTIS HTTP: kai revokacija NEĮVYKO, cookie LIEKA", async () => {
  /**
   * ⚠️ KOMPLEMENTARI PUSĖ - be jos viršutinis testas leistų valyti cookie
   * VISADA, įskaitant kelius, kuriuose sesija tebegalioja.
   *
   * Čia krinta pati saugykla, tad `destroy()` neįvyksta. Cookie privalo likti:
   * ta pati reikšmė kitame procese vis dar autentifikuoja, ir klientas negali
   * manyti, kad atsijungė.
   */
  const login = await prisijungti();
  const cookie = login.headers["set-cookie"][0].split(";")[0];

  const originalusDestroy = sessionStoreModulis.destroy;
  sessionStoreModulis.destroy = async () => {
    throw new Error("saugykla nepasiekiama");
  };

  let res;
  try {
    res = await request(app).post("/api/auth/logout").set("Cookie", cookie);
  } finally {
    sessionStoreModulis.destroy = originalusDestroy;
  }

  assert.equal(res.status, 503);
  assert.equal(res.headers["set-cookie"], undefined, "neįvykus revokacijai cookie valyti negalima");
  assert.equal(
    (await request(app).get("/api/auth/me").set("Cookie", cookie)).status,
    200,
    "sesija tebegalioja - būtent todėl cookie ir lieka"
  );
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

  /** Atskaitos taškas: TAS PATS kvietimas su veikiančiu auditu. */
  const sveikas = await request(app)
    .post("/api/transcribe-jobs")
    .set("Cookie", cookie)
    .field("meetingId", "be-failo");

  _resetAuditCountersForTests();

  const res = await suKrentanciuAuditu(() =>
    request(app).post("/api/transcribe-jobs").set("Cookie", cookie).field("meetingId", "be-failo")
  );

  /**
   * ⚠️ LYGINAMA SU ATSAKYMU PRIEŠ GEDIMĄ, ne su „bet koks 4xx".
   *
   * `status >= 400 && status < 500` praeitų, jei audito gedimas paverstų 400 į
   * 401, 403 ar 404 - t. y. testas nutylėtų būtent tai, ką turi įrodyti:
   * neblokuojantis audito gedimas PAGRINDINĖS operacijos nekeičia. Todėl tas
   * pats kvietimas pirma atliekamas su veikiančiu auditu, ir tikrinamas
   * TIKSLUS sutapimas.
   */
  assert.equal(res.status, sveikas.status, "audito gedimas negali pakeisti statuso");
  assert.deepEqual(res.body, sveikas.body, "audito gedimas negali pakeisti atsakymo turinio");
  assert.equal(res.status, 400, "prielaida: trūkstamas failas yra 400");
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

test("LOGIN: audito gedimas ATŠAUKIA jau sukurtą sesiją (jokių našlaičių)", async () => {
  /**
   * ⚠️ REGRESIJA, KURIĄ ŠIS TESTAS UŽDARO.
   *
   * `sessionStore.create()` įvyksta PRIEŠ `LOGIN_SUCCESS` auditą. Kai auditas
   * krinta, maršrutas grąžina 503 ir cookie neišduoda - bet sesija jau
   * egzistuoja. Be atšaukimo ji liktų GYVA su token'u, kurio niekas negavo:
   * klientas jos revokuoti negali, o per audito gedimo langą pakartotiniai
   * bandymai jų prikauptų (atmintyje - nutekėjimas, PostgreSQL - eilutės iki
   * `expires_at`).
   */
  const sessionStore = require("../utils/sessionStore");

  /**
   * ⚠️ `size()` ČIA NETINKA. Nuo 7.3 revokacija yra LOGINĖ, o `size()`
   * skaičiuoja FIZINES eilutes - jos nemažėja net teisingai atšaukus. Todėl
   * perimamas pats `create()`, kad testas turėtų token'ą, kurio klientas
   * niekada negavo, ir galėtų patikrinti tai, kas realiai svarbu: ar jis dar
   * autentifikuoja.
   */
  const originalusCreate = sessionStore.create;
  let sukurtasToken = null;
  sessionStore.create = async (...args) => {
    const rezultatas = await originalusCreate.apply(sessionStore, args);
    sukurtasToken = rezultatas.token;
    return rezultatas;
  };

  let res;
  try {
    res = await suKrentanciuAuditu(() => prisijungti());
  } finally {
    sessionStore.create = originalusCreate;
  }

  assert.equal(res.status, 503, "prielaida: audito gedimas atmeta prisijungimą");
  assert.equal(res.headers["set-cookie"], undefined, "prielaida: cookie neišduota");
  assert.ok(sukurtasToken, "prielaida: sesija buvo sukurta prieš audito gedimą");

  assert.equal(
    await sessionStore.touch(sukurtasToken),
    null,
    "sesija be savininko privalo būti atšaukta, o ne palikta autentifikuoti"
  );
});

