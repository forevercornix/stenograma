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
const sessionStore = require("../utils/sessionStore");
const memoryStore = require("../utils/sessionStore/memoryStore");
const { hashSessionToken } = require("../utils/sessionStore/tokens");
const app = require("../server");
app._setReadyForTests();

/**
 * SESIJŲ GEDIMO SEMANTIKA PER TIKRĄ HTTP (#155, 7.3).
 *
 * ⚠️ KRITERIJUS YRA DRAUDIMAS, NE REIKALAVIMAS.
 *
 * `middleware/sessionAuth.js` iki 7.3 neturėjo `try/catch` aplink `touch()`,
 * tad išimtis virsdavo 500 - elgesys jau beveik teisingas. Tvarkant tą 500
 * lengva pridėti `catch { return null; }`, ir gedimas taptų TYLIU
 * neautorizavimu, neatskiriamu nuo „sesijos nėra". Būtent tai čia ir
 * neleidžiama: atsakymas privalo SKIRTIS nuo 401.
 */

function prisijungti() {
  return request(app).post("/api/auth/login").send({ username: "admin", password: "teisingas-slaptas-1" });
}

function cookieIs(res) {
  return res.headers["set-cookie"][0].split(";")[0];
}

/** Saugykla, kurios KIEKVIENAS kelias krinta - imituoja neprieinamą PostgreSQL. */
function krentantiSaugykla(klaida = new Error("connect ETIMEDOUT")) {
  const mesti = async () => {
    throw klaida;
  };
  return {
    backend: "postgres",
    create: mesti,
    touch: mesti,
    destroy: mesti,
    destroyAllForUser: mesti,
    destroyAllForUserId: mesti,
    sweepExpired: mesti,
    size: mesti,
  };
}

test("GEDIMAS: requireSession su galiojančia sesija ir kritusia saugykla → 503, NE 401", async () => {
  const login = await prisijungti();
  const cookie = cookieIs(login);

  /** Prielaida: ta pati cookie veikianti saugykla autentifikuoja. */
  const veikia = await request(app).get("/api/auth/me").set("Cookie", cookie);
  assert.equal(veikia.status, 200, "prielaida: sesija galioja");

  const grazinti = sessionStore._setStoreForTests(krentantiSaugykla());
  try {
    const res = await request(app).get("/api/auth/me").set("Cookie", cookie);

    assert.equal(res.status, 503, "DB gedimas negali virsti 401 'nėra sesijos'");
    assert.equal(res.body.code, "SESSION_STORE_UNAVAILABLE");
    assert.notEqual(res.body.code, "SESSION_REQUIRED", "atsakymas privalo skirtis nuo neprisijungusio kliento");
  } finally {
    grazinti();
  }
});

test("GEDIMAS: 401 ir 503 atsakymai LIEKA atskiri (be cookie - vis tiek 401)", async () => {
  /**
   * Be šio testo realizacija galėtų „išspręsti" viršutinį reikalavimą
   * grąžindama 503 VISADA - tada 401 dingtų, o klientas nebeatskirtų
   * neprisijungusio vartotojo nuo gedimo.
   */
  const res = await request(app).get("/api/auth/me");
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "SESSION_REQUIRED");
});

test("GEDIMAS: optionalSession su cookie ir kritusia saugykla → 503, NE anoniminis vykdymas", async () => {
  /**
   * ⚠️ ANONIMINIS VYKDYMAS ČIA YRA BLOGIAUSIAS REZULTATAS.
   *
   * `optionalSession` „sėkmingai" tęstų su `req.user = null`, ir autentifikuota
   * užklausa būtų nukreipta į KITĄ autorizacijos šaką - be klaidos, be logo,
   * be jokio ženklo, kad tapatybė buvo prarasta dėl DB gedimo.
   *
   * Testuojamas middleware TIESIOGIAI, o ne per maršrutą: `optionalSession`
   * šiandien produkciniuose maršrutuose neprijungtas, tad kelias per HTTP
   * tikrintų maršrutų sąrašą, ne middleware kontraktą.
   */
  const { optionalSession } = require("../middleware/sessionAuth");

  const login = await prisijungti();
  const cookie = cookieIs(login);

  const grazinti = sessionStore._setStoreForTests(krentantiSaugykla());
  try {
    const atsakymas = { status: null, body: null };
    const res = {
      status(kodas) {
        atsakymas.status = kodas;
        return this;
      },
      json(kunas) {
        atsakymas.body = kunas;
        return this;
      },
    };
    let tesiama = false;

    await optionalSession({ headers: { cookie } }, res, () => {
      tesiama = true;
    });

    assert.equal(tesiama, false, "gedimo atveju užklausa NEGALI tęstis anonimiškai");
    assert.equal(atsakymas.status, 503);
    assert.equal(atsakymas.body.code, "SESSION_STORE_UNAVAILABLE");
  } finally {
    grazinti();
  }
});

test("GEDIMAS: optionalSession BE cookie tęsiasi su req.user = null (kontraktas nepakeistas)", async () => {
  const { optionalSession } = require("../middleware/sessionAuth");

  const grazinti = sessionStore._setStoreForTests(krentantiSaugykla());
  try {
    const req = { headers: {} };
    let tesiama = false;
    await optionalSession(req, { status: () => ({ json: () => {} }) }, () => {
      tesiama = true;
    });

    assert.equal(tesiama, true, "be credential'o gedimas nėra vartotojo problema");
    assert.equal(req.user, null);
  } finally {
    grazinti();
  }
});

test("GEDIMAS: authenticate NEKRENTA į API_KEY šaką, kai sesijos patikrinti negalima", async () => {
  /**
   * ⚠️ FALLBACK PRIELAIDA YRA „cookie yra, bet NEGALIOJA".
   *
   * Gedimo metu ji neteisinga. Leidus kristi toliau, sesija autentifikuotas
   * vartotojas su galiojančiu bendru raktu tyliai virstų `API_KEY` tapatybe -
   * kita role ir kitu audito aktoriumi, dėl infrastruktūros gedimo.
   */
  const authenticate = require("../middleware/authenticate");

  const login = await prisijungti();
  const cookie = cookieIs(login);

  const senasRaktas = process.env.API_KEY;
  process.env.API_KEY = "bendras-raktas";
  const grazinti = sessionStore._setStoreForTests(krentantiSaugykla());
  try {
    const atsakymas = { status: null, body: null };
    const res = {
      status(k) {
        atsakymas.status = k;
        return this;
      },
      json(b) {
        atsakymas.body = b;
        return this;
      },
    };
    const req = {
      headers: { cookie },
      header: (v) => (v === "x-api-key" ? "bendras-raktas" : undefined),
      path: "/api/jobs",
    };
    let tesiama = false;

    await authenticate(req, res, () => {
      tesiama = true;
    });

    assert.equal(tesiama, false, "gedimas negali praleisti užklausos rakto teisėmis");
    assert.equal(atsakymas.status, 503);
    assert.equal(req.apiKeyAuthenticated, undefined, "rakto šaka neturėjo būti pasiekta");
  } finally {
    grazinti();
    if (senasRaktas === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = senasRaktas;
  }
});

test("PARUOŠTUMAS: PostgreSQL režimas be baigto suderinimo → 503, ne autentikacija", async () => {
  /**
   * ⚠️ VIEN READINESS MIDDLEWARE NEPAKANKA.
   *
   * `authRoute` prijungtas `server.js` BE `requireJobSystemReady`, tad
   * `/api/auth/me` landa į sesijų saugyklą tiesiogiai. Sargas gyvena
   * `sessionStore.isReady()`, kad kiekvienas sesiją liečiantis kelias matytų
   * tą patį atsakymą.
   */
  const login = await prisijungti();
  const cookie = cookieIs(login);

  process.env.SESSION_STORE_BACKEND = "postgres";
  process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://neveikia:1@127.0.0.1:1/none";
  const buvoUrl = process.env.DATABASE_URL;
  sessionStore._setReadyForTests(false);
  try {
    assert.equal(sessionStore.isReady(), false, "prielaida: autoritetas dar nepasiruošęs");

    const res = await request(app).get("/api/auth/me").set("Cookie", cookie);
    assert.equal(res.status, 503);
    assert.equal(res.body.code, "SESSION_STORE_UNAVAILABLE");
  } finally {
    sessionStore._setReadyForTests(false);
    delete process.env.SESSION_STORE_BACKEND;
    if (!buvoUrl) delete process.env.DATABASE_URL;
    assert.equal(sessionStore.isReady(), true, "atminties režimu autoritetas visada paruoštas");
  }
});

test("LOGIN: sesijos įrašymo klaida → NĖRA Set-Cookie, o auditas žymi NESĖKMĘ", async () => {
  /**
   * ⚠️ TVARKA SVARBI. `routes/auth.js` kviečia `create()`, tada
   * `setSessionCookie()`, tada rašo auditą. Realizacija, siunčianti cookie
   * PRIEŠ patvirtintą įrašymą, paliktų klientą su token'u, kurio saugykloje
   * nėra - vartotojas atrodytų prisijungęs iki pirmos užklausos.
   */
  const priesTai = auditLog.getAll().length;
  const grazinti = sessionStore._setStoreForTests(krentantiSaugykla());
  let res;
  try {
    res = await prisijungti();
  } finally {
    grazinti();
  }

  assert.equal(res.status, 503);
  assert.equal(res.body.code, "SESSION_STORE_UNAVAILABLE");
  assert.equal(res.headers["set-cookie"], undefined, "dalinė sesija negali palikti galiojančios cookie");

  const nauji = auditLog.getAll().slice(priesTai);
  const login = nauji.find((e) => e.event === "LOGIN_FAILED");
  assert.ok(login, "nesėkmingas prisijungimas privalo patekti į auditą");
  assert.equal(login.result, "failure", "auditas privalo žymėti NESĖKMĘ, ne sėkmę");
  /** `outcome` audite trumpinamas iki 20 simbolių - reikšmė parinkta tilpti. */
  assert.equal(login.outcome, "store_unavailable");
  assert.ok(
    !nauji.some((e) => e.event === "LOGIN_SUCCESS"),
    "sėkmės įrašo su nesukurta sesija būti negali"
  );
});

test("LOGIN: PostgreSQL režime tapatybė be stabilaus userId nesukuria sesijos", async () => {
  /**
   * `sessions.user_id` yra `NOT NULL`, tad PostgreSQL režimas NEGALI kurti
   * sesijos be stabilaus ID. Rezultatas - fail-closed login'as, ne eilutė be
   * tapatybės ir ne 500 iš draiverio.
   */
  const { SessionIdentityError } = require("../utils/sessionStore/postgresStore");

  const grazinti = sessionStore._setStoreForTests({
    backend: "postgres",
    create: async () => {
      throw new SessionIdentityError("nėra userId");
    },
    touch: async () => null,
    destroy: async () => false,
    destroyAllForUser: async () => 0,
    destroyAllForUserId: async () => 0,
    sweepExpired: async () => 0,
    size: async () => 0,
  });
  let res;
  try {
    res = await prisijungti();
  } finally {
    grazinti();
  }

  assert.equal(res.status, 500);
  assert.equal(res.body.code, "IDENTITY_UNAVAILABLE");
  assert.equal(res.headers["set-cookie"], undefined);
});

test("LOGOUT: ta pati cookie po atsijungimo NEBEAUTENTIFIKUOJA", async () => {
  /**
   * ⚠️ REGRESIJA, KURIĄ ŠIS TESTAS GAUDO.
   *
   * Iki 7.3 cookie reikšmė buvo `session.id`. Palikus `destroy(sessionId)`
   * nepakeistą, atsijungimas TYLIAI nustotų veikti: `destroy()` gautų token'ą,
   * ieškotų pagal `id`, nerastų eilutės, grąžintų `false`, o cookie liktų
   * galiojanti - vartotojas manytų, kad atsijungė.
   */
  const login = await prisijungti();
  const cookie = cookieIs(login);

  assert.equal((await request(app).get("/api/auth/me").set("Cookie", cookie)).status, 200);

  const logout = await request(app).post("/api/auth/logout").set("Cookie", cookie);
  assert.equal(logout.status, 200);

  const po = await request(app).get("/api/auth/me").set("Cookie", cookie);
  assert.equal(po.status, 401, "revokuota cookie negali autentifikuoti");
  assert.equal(po.body.code, "SESSION_REQUIRED");
});

test("LOGOUT: revokacijos klaida NEVIRSTA 'atsijungta'", async () => {
  const login = await prisijungti();
  const cookie = cookieIs(login);

  const grazinti = sessionStore._setStoreForTests(krentantiSaugykla());
  let res;
  try {
    res = await request(app).post("/api/auth/logout").set("Cookie", cookie);
  } finally {
    grazinti();
  }

  assert.equal(res.status, 503, "neįvykusi revokacija negali atrodyti kaip sėkmingas atsijungimas");
  assert.equal(res.body.code, "SESSION_STORE_UNAVAILABLE");

  /** Sesija tebegalioja - būtent todėl klientas ir turi apie tai sužinoti. */
  assert.equal((await request(app).get("/api/auth/me").set("Cookie", cookie)).status, 200);
});

test("PLIKAS TOKEN'AS: neatsiranda nei audite, nei loguose - IR sėkmėje, IR nesėkmėje", async () => {
  /**
   * ⚠️ REIKALAVIMAS BE TESTO YRA DEKLARACIJA.
   *
   * Perimama TIKRA logerio išvestis (`process.stdout/stderr.write`) ir audito
   * žurnalas, o tikrinamas KONKRETUS šios sesijos token'as - ne šablonas.
   * Tikrinami abu keliai: sėkmingas `touch()` ir nesėkmingas (revokuota cookie),
   * nes klaidos kelias yra būtent tas, kuriame paslaptis dažniausiai patenka į
   * diagnostiką.
   */
  const surinkta = [];
  const originalus = { out: process.stdout.write, err: process.stderr.write };
  const perimti = (srautas, raktas) => {
    srautas.write = (chunk, ...rest) => {
      surinkta.push(String(chunk));
      return originalus[raktas].call(srautas, chunk, ...rest);
    };
  };

  const priesTai = auditLog.getAll().length;
  const senasLygis = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "debug";

  let token;
  try {
    perimti(process.stdout, "out");
    perimti(process.stderr, "err");

    const login = await prisijungti();
    const cookie = cookieIs(login);
    token = decodeURIComponent(cookie.split("=")[1]);

    /** Sėkmingas kelias. */
    await request(app).get("/api/auth/me").set("Cookie", cookie);
    /** Nesėkmingas kelias: revokuojam ir bandom dar kartą. */
    await request(app).post("/api/auth/logout").set("Cookie", cookie);
    await request(app).get("/api/auth/me").set("Cookie", cookie);
  } finally {
    process.stdout.write = originalus.out;
    process.stderr.write = originalus.err;
    if (senasLygis === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = senasLygis;
  }

  const logai = surinkta.join("\n");
  assert.ok(token && token.length > 20, "prielaida: token'as gautas");
  assert.ok(!logai.includes(token), "plikas token'as negali patekti į logus");

  const auditas = JSON.stringify(auditLog.getAll().slice(priesTai));
  assert.ok(!auditas.includes(token), "plikas token'as negali patekti į auditą");
  assert.ok(
    !auditas.includes(hashSessionToken(token)),
    "net maiša audite būtų nereikalingas sesijos koreliacijos kanalas"
  );
});

test("STARTUP: SESSION_STORE_BACKEND validuojamas, o `postgres` reikalauja DATABASE_URL", () => {
  /**
   * ⚠️ NEŽINOMA REIKŠMĖ PRAEITŲ KONFIGŪRACIJOS PATIKRĄ IR KRISTŲ VĖLIAU.
   *
   * `startupChecks` iki 7.3 tikrino sesijų timeout'us, bet nė vieno backend'o
   * jungiklio: klaida būtų atėjusi inicijavimo metu - su prastesniu pranešimu
   * ir po to, kai dalis sistemos jau pakilusi.
   */
  const { validateConfig } = require("../utils/startupChecks");

  for (const bloga of ["redis", "Postgres", "postgresql", "1", "true"]) {
    const { errors } = validateConfig({ SESSION_STORE_BACKEND: bloga });
    assert.ok(
      errors.some((e) => /SESSION_STORE_BACKEND/.test(e)),
      `turėjo atmesti reikšmę: ${bloga}`
    );
  }

  const beUrl = validateConfig({ SESSION_STORE_BACKEND: "postgres" });
  assert.ok(
    beUrl.errors.some((e) => /SESSION_STORE_BACKEND=postgres/.test(e) && /DATABASE_URL/.test(e)),
    "eksplicitinis postgres be DATABASE_URL turi stabdyti startą"
  );

  const geras = validateConfig({ SESSION_STORE_BACKEND: "postgres", DATABASE_URL: "postgres://x/y" });
  assert.deepEqual(geras.errors.filter((e) => /SESSION_STORE_BACKEND/.test(e)), []);

  const atmintis = validateConfig({ SESSION_STORE_BACKEND: "memory" });
  assert.deepEqual(atmintis.errors.filter((e) => /SESSION_STORE_BACKEND/.test(e)), []);
});

test("JUNGIKLIS: vien DATABASE_URL sesijų režimo NEKEIČIA", () => {
  /**
   * ⚠️ TAI ATSKIRAS JUNGIKLIS NUO `JOB_STORE_BACKEND`.
   *
   * `DATABASE_URL` gali būti įvestas dėl migracijų, audito (7.4) ar bet kurios
   * kitos #155 dalies. Sujungus sprendimus, job metaduomenų barjero
   * atidarymas automatiškai perjungtų ir AUTENTIKACIJĄ.
   */
  const { resolveSessionBackend } = require("../utils/sessionStore/backendSelection");

  assert.equal(resolveSessionBackend({ DATABASE_URL: "postgres://x/y" }), "memory");
  assert.equal(resolveSessionBackend({ DATABASE_URL: "postgres://x/y", JOB_STORE_BACKEND: "postgres" }), "memory");
  assert.equal(
    resolveSessionBackend({ DATABASE_URL: "postgres://x/y", SESSION_STORE_BACKEND: "postgres" }),
    "postgres"
  );
  assert.throws(() => resolveSessionBackend({ SESSION_STORE_BACKEND: "postgres" }), /DATABASE_URL/);
  assert.throws(() => resolveSessionBackend({ SESSION_STORE_BACKEND: "sqlite" }), /nežinomas/);
});

test("DINAMIŠKAI: vartotojo pašalinimas iš AUTH_USERS BE restarto nutraukia sesiją", async () => {
  /**
   * ⚠️ STARTINIS SUDERINIMAS DENGIA TIK RESTARTĄ.
   *
   * Vartotojas, ištrintas ar pažemintas RUNTIME metu, su galiojančia sesija
   * toliau autorizuotų užklausas SENA role iki kito restarto - privilegijų
   * eskalavimas. Testuojama atminties backend'e, nes ta pati `patikrintiTapatybe()`
   * taisyklė yra bendra abiem keliams (`utils/sessionStore/common.js`).
   */
  await memoryStore._clearForTests();
  const env = {
    AUTH_USERS: `admin:administrator:${hashPassword("x")}:${ADMIN_ID}`,
  };
  const { token } = await memoryStore.create(
    { id: ADMIN_ID, username: "admin", role: "administrator" },
    env
  );

  assert.ok(await memoryStore.touch(token, env), "prielaida: sesija galioja");

  /** Vartotojas pašalinamas - be jokio restarto. */
  const beVartotojo = { AUTH_USERS: `kitas:operator:${hashPassword("y")}:44444444-4444-4444-8444-444444444444` };
  assert.equal(await memoryStore.touch(token, beVartotojo), null, "pašalintas vartotojas nebeautentifikuoja");

  /** Įrašas pažymėtas revokuotu - kitaip ta pati cookie bandytų vėl kitą sekundę. */
  assert.notEqual(memoryStore._getByTokenForTests(token).revokedAt, null);
  await memoryStore._clearForTests();
});

test("DINAMIŠKAI: rolės pažeminimas BE restarto nutraukia sesiją", async () => {
  await memoryStore._clearForTests();
  const env = { AUTH_USERS: `admin:administrator:${hashPassword("x")}:${ADMIN_ID}` };
  const { token } = await memoryStore.create(
    { id: ADMIN_ID, username: "admin", role: "administrator" },
    env
  );
  assert.ok(await memoryStore.touch(token, env));

  const pazemintas = { AUTH_USERS: `admin:operator:${hashPassword("x")}:${ADMIN_ID}` };
  assert.equal(
    await memoryStore.touch(token, pazemintas),
    null,
    "sesijos rolės snapshot'as nebeatitinka AUTH_USERS - fail-closed"
  );
  await memoryStore._clearForTests();
});

test("VARDAS: `req.user.username` išvedamas iš AUTH_USERS, ne iš persistuoto lauko", async () => {
  /**
   * ⚠️ AUDITO AKTORIUS. Vardą naudoja keturios vietos, tarp jų `setActor()`.
   * Nustojus jį persistinti, jis privalo ateiti iš `AUTH_USERS` pagal
   * `user_id` - kitaip pervadinimas paliktų audite seną vardą.
   */
  await memoryStore._clearForTests();
  const senas = { AUTH_USERS: `admin:administrator:${hashPassword("x")}:${ADMIN_ID}` };
  const { token } = await memoryStore.create(
    { id: ADMIN_ID, username: "admin", role: "administrator" },
    senas
  );

  const naujas = { AUTH_USERS: `naujasvardas:administrator:${hashPassword("x")}:${ADMIN_ID}` };
  const session = await memoryStore.touch(token, naujas);

  assert.ok(session, "pervadinimas nėra revokacijos priežastis - tapatybė ta pati");
  assert.equal(session.username, "naujasvardas", "vardas turi ateiti iš AUTH_USERS pagal user_id");
  assert.notEqual(session.username, undefined, "aktorius audite negali būti undefined");
  await memoryStore._clearForTests();
});
