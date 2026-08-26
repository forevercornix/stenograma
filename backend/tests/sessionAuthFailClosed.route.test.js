const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.API_KEY = "";
process.env.LOG_LEVEL = "error";
process.env.RATE_LIMIT_LOGIN_IP_MAX = "500";
process.env.RATE_LIMIT_LOGIN_ACCOUNT_MAX = "500";
process.env.RATE_LIMIT_MAX_REQUESTS = "500";
process.env.RATE_LIMIT_GENERAL_MAX = "500";
/**
 * ⚠️ NUSTATOMA PRIEŠ `require("../server")`: `READINESS_TIMEOUT_MS` nuskaitomas
 * modulio įkėlimo metu. Trumpa riba reikalinga „kabančio zondo" testui - su
 * numatytomis 2 s jis lėtintų kiekvieną paleidimą.
 */
process.env.READINESS_TIMEOUT_MS = "300";

const { hashPassword } = require("../utils/credentials");

const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
process.env.AUTH_USERS = `admin:administrator:${hashPassword("teisingas-slaptas-1")}:${ADMIN_ID}`;

const request = require("supertest");
const auditLog = require("../utils/auditLog");
const sessionStore = require("../utils/sessionStore");
const memoryStore = require("../utils/sessionStore/memoryStore");
const { hashSessionToken } = require("../utils/sessionStore/tokens");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
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
  try {
    /**
     * ⚠️ VĖLIAVA ČIA SĄMONINGAI NEKEIČIAMA.
     *
     * Ankstesni šio failo testai jau įvykdė atminties režimo kelią, tad
     * `paruosta` gali būti `true`. Sargas privalo suveikti VIS TIEK - nes
     * faktinė saugykla tebėra atmintis, o konfigūracija prašo PostgreSQL.
     * Nustačius vėliavą į `false` rankomis, testas praeitų ir su fail-open
     * realizacija, kuri žiūri tik į vėliavą.
     */
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
  const priesTai = (await auditLog.getAll()).length;
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

  const nauji = (await auditLog.getAll()).slice(priesTai);
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

  const priesTai = (await auditLog.getAll()).length;
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

  const auditas = JSON.stringify((await auditLog.getAll()).slice(priesTai));
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

test("AKTORIUS: authorize.js aktorius seka AUTH_USERS pervadinimą per TIKRĄ HTTP", async () => {
  /**
   * ⚠️ VARDAS NEBEPERSISTINAMAS, TAD JIS PRIVALO ATEITI IŠ `AUTH_USERS`.
   *
   * `middleware/authorize.js resolveIdentity()` naudoja `req.user.username`
   * kaip AUDITO AKTORIŲ. Realizacija, kuri vardą laikytų sesijoje, po
   * pervadinimo rašytų į auditą SENĄ vardą - ir incidento tyrimas remtųsi
   * tapatybe, kurios nebėra.
   *
   * Tikrinamas VISAS kelias: cookie → `sessionStore.touch()` → `req.user` →
   * `resolveIdentity()`. Vienetinė saugyklos patikra įrodytų tik saugyklos
   * semantiką, ne tai, kad produkcinis kelias ja naudojasi (AGENTS.md §9.1).
   */
  const { resolveIdentity } = require("../middleware/authorize");
  const { requireSession } = require("../middleware/sessionAuth");

  const login = await prisijungti();
  const cookie = cookieIs(login);

  const pries = await request(app).get("/api/auth/me").set("Cookie", cookie);
  assert.equal(pries.body.username, "admin", "prielaida: pradinis vardas");

  const senasAuth = process.env.AUTH_USERS;
  try {
    /** TAS PATS `userId`, kitas vardas - tapatybė nesikeičia. */
    process.env.AUTH_USERS = `naujasvardas:administrator:${hashPassword("teisingas-slaptas-1")}:${ADMIN_ID}`;

    const po = await request(app).get("/api/auth/me").set("Cookie", cookie);
    assert.equal(po.status, 200, "pervadinimas nėra revokacijos priežastis");
    assert.equal(po.body.username, "naujasvardas", "req.user.username privalo ateiti iš AUTH_USERS");

    /** Ir tas pats vardas pasiekia autorizacijos aktorių. */
    const req = { headers: { cookie } };
    await requireSession(req, { status: () => ({ json: () => {} }) }, () => {});
    const tapatybe = resolveIdentity(req);

    assert.equal(tapatybe.source, "session");
    assert.equal(tapatybe.actor, "naujasvardas", "audito aktorius seka AUTH_USERS");
    assert.equal(tapatybe.role, "administrator");
  } finally {
    process.env.AUTH_USERS = senasAuth;
  }
});

test("AKTORIUS: ištrintas vartotojas duoda APIBRĖŽTĄ rezultatą, ne `undefined` aktorių", async () => {
  /**
   * ⚠️ `undefined` AKTORIUS AUDITE YRA BLOGIAUSIA IŠEITIS.
   *
   * Vartotojas, dingęs iš `AUTH_USERS`, negali virsti eilute be aktoriaus.
   * Apibrėžtas rezultatas čia yra 401: sesija nutraukiama, `req.user`
   * apskritai nesukuriamas, tad nėra ko įrašyti kaip `undefined`.
   */
  const { resolveIdentity } = require("../middleware/authorize");
  const { requireSession } = require("../middleware/sessionAuth");

  const login = await prisijungti();
  const cookie = cookieIs(login);

  const senasAuth = process.env.AUTH_USERS;
  const senasRaktas = process.env.API_KEY;
  try {
    process.env.API_KEY = "";
    process.env.AUTH_USERS = `kitas:operator:${hashPassword("kitas-1")}:44444444-4444-4444-8444-444444444444`;

    const po = await request(app).get("/api/auth/me").set("Cookie", cookie);
    assert.equal(po.status, 401, "ištrinto vartotojo sesija nutraukiama");
    assert.equal(po.body.code, "SESSION_REQUIRED");

    const req = { headers: { cookie }, apiKeyAuthenticated: false };
    let atmesta = false;
    await requireSession(req, { status: () => ({ json: () => { atmesta = true; } }) }, () => {});

    assert.equal(atmesta, true);
    assert.equal(req.user, undefined, "req.user nesukuriamas - nėra ko paversti undefined aktoriumi");
    assert.equal(resolveIdentity(req), null, "aktorius yra apibrėžtas `null`, ne `undefined` vardas");
  } finally {
    process.env.AUTH_USERS = senasAuth;
    if (senasRaktas === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = senasRaktas;
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * PLIKAS TOKEN'AS: VISOS KETURIOS #181 ĮVARDYTOS ARTEFAKTŲ KLASĖS
 *
 * #181 reikalauja, kad plikas token'as nepatektų į:
 *   1. logus            — dengia `PLIKAS TOKEN'AS: neatsiranda nei audite…`
 *   2. auditą           — tas pats testas
 *   3. klaidų metaduomenis  — žemiau
 *   4. `support-bundle` — žemiau
 *
 * Pirmieji du buvo padengti; likę du - ne, ir uždarymo peržiūra tai įvardijo
 * kaip pervertinimą (PASS vietoj PARTIAL). Šie du testai tą spragą uždaro.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Ar tekste nėra NEI plikojo token'o, NEI jo maišos. */
function beTokeno(tekstas, token, kur) {
  assert.ok(!tekstas.includes(token), `${kur}: plikas token'as nutekėjo`);
  assert.ok(
    !tekstas.includes(hashSessionToken(token)),
    `${kur}: token'o maiša neturi ko veikti už autentikacijos ribos`
  );
}

test("PLIKAS TOKEN'AS: KLAIDŲ ATSAKYMŲ kūnuose ir antraštėse jo nėra", async () => {
  /**
   * ⚠️ KLAIDOS KELIAS YRA TAS, KURIAME PASLAPTIS DAŽNIAUSIAI NUTEKA.
   *
   * Sėkmingas atsakymas token'o neturi savaime; bet klaidų tvarkyklė,
   * „naudingumo dėlei" pridėjusi užklausos kontekstą (antraštes, cookie,
   * `req` santrauką), atiduotų bearer'į klientui - ir, per naršyklės devtools
   * ar klaidų telemetriją, visiems, kas tą atsakymą pamato.
   *
   * Tikrinami VISI keliai, kuriuose užklausa NEŠA token'ą ir gauna klaidą:
   * 401 (revokuota), 503 (saugykla neveikia) trijuose middleware'uose ir
   * bendras 404, kurį formuoja Express, o ne mūsų maršrutas.
   *
   * ⚠️ SĖKMINGO `login` ATSAKYMO ČIA NĖRA SĄMONINGAI: jo `Set-Cookie` neša
   * token'ą pagal apibrėžimą - tai pristatymo kanalas, ne nutekėjimas.
   */
  const { optionalSession } = require("../middleware/sessionAuth");

  const login = await prisijungti();
  const cookie = cookieIs(login);
  const token = decodeURIComponent(cookie.split("=")[1]);

  const atsakymai = [];

  /** 404 su galiojančia cookie - bendras Express kelias, ne mūsų maršrutas. */
  atsakymai.push(["404", await request(app).get("/api/neegzistuojantis").set("Cookie", cookie)]);

  /** 503 iš `requireSession` ir iš `logout`, kai saugykla neveikia. */
  let grazinti = sessionStore._setStoreForTests(krentantiSaugykla());
  try {
    atsakymai.push(["503 requireSession", await request(app).get("/api/auth/me").set("Cookie", cookie)]);
    atsakymai.push(["503 logout", await request(app).post("/api/auth/logout").set("Cookie", cookie)]);
  } finally {
    grazinti();
  }

  /** 401 po revokacijos - ta pati cookie, jau negaliojanti. */
  await request(app).post("/api/auth/logout").set("Cookie", cookie);
  atsakymai.push(["401", await request(app).get("/api/auth/me").set("Cookie", cookie)]);

  for (const [kur, res] of atsakymai) {
    assert.ok(res.status >= 400, `${kur}: prielaida - tai klaidos atsakymas (gauta ${res.status})`);
    beTokeno(JSON.stringify(res.body ?? null), token, `${kur} kūnas`);
    beTokeno(res.text || "", token, `${kur} tekstas`);
    beTokeno(JSON.stringify(res.headers), token, `${kur} antraštės`);
  }

  /**
   * `optionalSession` 503 tikrinamas per middleware TIESIOGIAI - produkciniuose
   * maršrutuose jis šiandien neprijungtas, tad per HTTP jo klaidos kūno
   * pasiekti neįmanoma.
   */
  grazinti = sessionStore._setStoreForTests(krentantiSaugykla());
  try {
    let kunas = null;
    const res = {
      status() {
        return this;
      },
      json(b) {
        kunas = b;
        return this;
      },
    };
    await optionalSession({ headers: { cookie } }, res, () => {});
    beTokeno(JSON.stringify(kunas), token, "503 optionalSession kūnas");
  } finally {
    grazinti();
  }
});

test("PLIKAS TOKEN'AS: SUPPORT-BUNDLE artefaktuose jo nėra", async () => {
  /**
   * ⚠️ KAS ČIA YRA „SUPPORT-BUNDLE".
   *
   * `scripts/doctor.js` savo komentare tai įvardija tiesiogiai: „diagnostikos
   * išvestis keliauja į support-bundle". Jo ataskaita sudaroma iš DVIEJŲ
   * šaltinių - `validateConfig()` ir `runSelfChecks()` - plius statinių eilučių;
   * tas pats `runSelfChecks()` maitina ir `GET /api/health/deep`.
   *
   * ⚠️ SVORIS TENKA PIRMIEMS TRIMS TIKRINIMAMS, NE `doctor` PALEIDIMUI.
   *
   * `validateConfig()`, `runSelfChecks()` ir `/api/health/deep` vykdomi TAME
   * PAČIAME procese, kuriame gyvena sesijų saugykla, tad jie REALIAI galėtų
   * pasiekti sesijos būseną - būtent todėl jų tikrinimas yra prasmingas.
   * `doctor` paleidžiamas atskirame procese ir tėvo atminties nemato; jo
   * patikra fiksuoja būtent tą struktūrinę garantiją ir pagauna regresiją,
   * jei jis kada nors imtų dump'inti aplinkos reikšmes ar sesijų būseną.
   */
  const { validateConfig, runSelfChecks } = require("../utils/startupChecks");

  const login = await prisijungti();
  const cookie = cookieIs(login);
  const token = decodeURIComponent(cookie.split("=")[1]);

  /** Prielaida: sesija GYVA - kitaip tikrintume diagnostiką be ko tikrinti. */
  assert.equal((await request(app).get("/api/auth/me").set("Cookie", cookie)).status, 200);

  const konfig = validateConfig();
  beTokeno(JSON.stringify(konfig), token, "validateConfig()");

  const patikros = await runSelfChecks();
  beTokeno(JSON.stringify(patikros), token, "runSelfChecks()");

  /**
   * ⚠️ DIAGNOSTIKA, PRAŠOMA SU CREDENTIAL'U.
   *
   * Būsena netikrinama sąlyginiu praleidimu (200 ar 503 - abu teisėti);
   * tikrinamas turinys, kad `if (status !== 200) return` neparverstų regresijos
   * praėjimu (AGENTS.md §9.1).
   */
  const deep = await request(app).get("/api/health/deep").set("Cookie", cookie);
  beTokeno(JSON.stringify(deep.body ?? null), token, "/api/health/deep kūnas");
  beTokeno(deep.text || "", token, "/api/health/deep tekstas");
  beTokeno(JSON.stringify(deep.headers), token, "/api/health/deep antraštės");

  /**
   * TIKRAS `npm run doctor` paleidimas. `spawnSync`, ne `execFileSync`:
   * doctor teisėtai baigia su ne nuliniu kodu, kai kokia nors patikra krinta,
   * o mums reikia jo IŠVESTIES, ne baigties kodo.
   */
  const vykdymas = spawnSync(process.execPath, ["scripts/doctor.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, LOG_LEVEL: "error" },
    encoding: "utf8",
    timeout: 120_000,
  });

  assert.equal(vykdymas.error, undefined, `doctor nepasileido: ${vykdymas.error && vykdymas.error.message}`);
  const isvestis = `${vykdymas.stdout || ""}\n${vykdymas.stderr || ""}`;
  assert.ok(isvestis.includes("Stenograma doctor"), "prielaida: doctor realiai sugeneravo ataskaitą");
  beTokeno(isvestis, token, "scripts/doctor.js išvestis");
});

/* ═══════════════════════════════════════════════════════════════════════════
 * READINESS ATSPINDI SESIJŲ AUTORITETO GYVĄ BŪSENĄ
 *
 * #181: „Užklausa atmetama kontroliuojama klaida, o READINESS RODO, kad
 * autentikacijos priklausomybė neveikia."
 *
 * ⚠️ STARTO VĖLIAVA TO NEPADARO. `readiness.sessionReconcile` užsidega kartą
 * per startą; nukritus DB vėliau, kiekviena cookie autentikuota užklausa gauna
 * 503, o `/api/ready` be gyvo zondo toliau sakytų 200 - orkestruotojas
 * konteinerį laikytų sveiku ir siųstų į jį srautą.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Saugykla, kurios zondas krinta; visa kita veikia normaliai. */
function saugyklaSuKritusiuZondu(zondas) {
  return {
    backend: "postgres",
    create: async () => {
      throw new Error("nenaudojama");
    },
    touch: async () => null,
    destroy: async () => false,
    destroyAllForUser: async () => 0,
    destroyAllForUserId: async () => 0,
    sweepExpired: async () => 0,
    size: async () => 0,
    probe: zondas,
  };
}

test("READINESS: veikianti sesijų saugykla → 200 ir sessionStoreReachable=true", async () => {
  const res = await request(app).get("/api/ready");

  assert.equal(res.status, 200);
  assert.equal(res.body.ready, true);
  assert.equal(
    res.body.components.sessionStoreReachable,
    true,
    "atminties režime priklausomybės nėra - zondas visada teigiamas"
  );
});

test("READINESS: nepasiekiama sesijų saugykla → 503, nors visa kita paruošta", async () => {
  /**
   * ⚠️ TIKRINAMA, KAD BŪTENT SESIJŲ SAUGYKLA APVERTĖ SPRENDIMĄ.
   *
   * Be `jobStore`/`jobRunner`/`workerAlive` patikrų testas praeitų ir tada, jei
   * 503 ateitų iš visai kitos priežasties, o naujasis komponentas readiness
   * sprendime nedalyvautų.
   */
  const grazinti = sessionStore._setStoreForTests(
    saugyklaSuKritusiuZondu(async () => {
      throw new Error("connect ETIMEDOUT");
    })
  );
  try {
    const res = await request(app).get("/api/ready");

    assert.equal(res.status, 503, "readiness privalo rodyti, kad autentikacijos priklausomybė neveikia");
    assert.equal(res.body.ready, false);
    assert.equal(res.body.components.sessionStoreReachable, false);

    assert.equal(res.body.components.jobStore, true, "kiti komponentai lieka paruošti");
    assert.equal(res.body.components.jobRunner, true);
    assert.equal(res.body.components.sessionReconcile, true);
    assert.equal(res.body.components.workerAlive, true);
  } finally {
    grazinti();
  }
});

test("READINESS: kabantis zondas NEPAKABINA /api/ready - riba baigtinė", async () => {
  /**
   * ⚠️ READINESS PRIVALO ATSAKYTI VISADA, net kai atsakymas yra „neparuošta".
   *
   * Zondas, kuris niekada neišsisprendžia (tyliai numestas TCP srautas), be
   * `withTimeout` paliktų orkestruotoją laukiantį vietoj aiškaus 503.
   */
  const grazinti = sessionStore._setStoreForTests(
    saugyklaSuKritusiuZondu(() => new Promise(() => {}))
  );
  try {
    const pradzia = Date.now();
    const res = await request(app).get("/api/ready");
    const trukmeMs = Date.now() - pradzia;

    assert.equal(res.status, 503);
    assert.equal(res.body.components.sessionStoreReachable, false);
    assert.ok(trukmeMs < 5000, `readiness privalo grįžti su riba, o ne kabėti (truko ${trukmeMs} ms)`);
  } finally {
    grazinti();
  }
});

test("READINESS: zondas, grąžinęs `false`, taip pat reiškia NEPARUOŠTA", async () => {
  /**
   * Fail-closed reiškia, kad `true` atsiranda TIK po sėkmingo zondo. Realizacija,
   * kuri tikrintų vien išimtis (`try/catch`), praleistų `false` ir paskelbtų
   * konteinerį sveiku.
   */
  const grazinti = sessionStore._setStoreForTests(saugyklaSuKritusiuZondu(async () => false));
  try {
    const res = await request(app).get("/api/ready");
    assert.equal(res.status, 503);
    assert.equal(res.body.components.sessionStoreReachable, false);
  } finally {
    grazinti();
  }
});

test("READINESS: PostgreSQL režimas be baigto suderinimo → NEPARUOŠTA", async () => {
  /**
   * `probe()` privalo remtis IR `isReady()` vėliava: kol startinis suderinimas
   * nebaigtas, sesijų autoritetas nėra paruoštas, net jei DB atsakinėja.
   */
  const buvoUrl = process.env.DATABASE_URL;
  process.env.SESSION_STORE_BACKEND = "postgres";
  process.env.DATABASE_URL = buvoUrl || "postgres://neveikia:1@127.0.0.1:1/none";
  try {
    assert.equal(await sessionStore.probe(), false, "nebaigtas startas = nepasiekiama");

    const res = await request(app).get("/api/ready");
    assert.equal(res.status, 503);
    assert.equal(res.body.components.sessionStoreReachable, false);
  } finally {
    delete process.env.SESSION_STORE_BACKEND;
    if (!buvoUrl) delete process.env.DATABASE_URL;
    assert.equal(await sessionStore.probe(), true, "atminties režimu zondas vėl teigiamas");
  }
});

test("TAPATYBĖ: ištuštintas AUTH_USERS revokuoja sesiją su stabiliu userId", async () => {
  /**
   * ⚠️ CODEX P1 REGRESIJA.
   *
   * Atminties backend'as praleisdavo tapatybės patikrą, kai `AUTH_USERS`
   * tuščias - t. y. kai pašalinamas PASKUTINIS vartotojas. Bendras backend'ų
   * scenarijus tai tikrina abiem realizacijoms; čia papildomai tikrinamas
   * fasado kelias, kuriuo naudojasi produkcija.
   */
  await sessionStore._clearForTests();
  const env = { AUTH_USERS: `admin:administrator:${hashPassword("x")}:${ADMIN_ID}` };
  const { token } = await sessionStore.create(
    { id: ADMIN_ID, username: "admin", role: "administrator" },
    env
  );
  assert.ok(await sessionStore.touch(token, env), "prielaida: sesija galioja");

  assert.equal(
    await sessionStore.touch(token, { AUTH_USERS: "" }),
    null,
    "pašalinus visus vartotojus, sesija privalo būti atmesta"
  );
  assert.notEqual(
    sessionStore._getByTokenForTests(token).revokedAt,
    null,
    "atmetimas privalo būti loginė revokacija, ne vienkartinis `null`"
  );
  await sessionStore._clearForTests();
});

test("TAPATYBĖ: sesija BE userId lieka legacy tolerancijoje", async () => {
  /**
   * #181 leidžia `userId: null` toleranciją TIK atminties backend'ui. Be šio
   * testo F1 pataisymas galėtų tyliai išplisti ir į legacy fixture'us, ir
   * kiekvienas senas testas kristų be aiškios priežasties.
   */
  await sessionStore._clearForTests();
  const { token } = await sessionStore.create({ username: "senas", role: "operator" }, { AUTH_USERS: "" });

  const session = await sessionStore.touch(token, { AUTH_USERS: "" });
  assert.ok(session, "sesija be stabilaus ID netikrinama prieš AUTH_USERS");
  assert.equal(session.userId, null);
  assert.equal(session.username, "senas", "vardas lieka tas, su kuriuo ji sukurta");
  await sessionStore._clearForTests();
});

test("POOL: sesijų jungtis turi BAIGTINES ribas - jungimuisi IR užklausoms", () => {
  /**
   * ⚠️ `connectionTimeoutMillis` VIENAS NEPAKANKA.
   *
   * Jis galioja tik jungties gavimui. `pg` numatytieji `statement_timeout` ir
   * `query_timeout` yra NERIBOTI, tad serveris, priėmęs jungtį ir nustojęs
   * atsakinėti (arba `UPDATE`, laukiantis užrakto), paliktų `touch()` kaboti
   * amžinai - o #181 reikalauja, kad „PostgreSQL NEGALI patikrinti būsenos
   * (timeout, connection, query klaida) → 503". Kabanti užklausa 503 niekada
   * nesukelia.
   *
   * Tikrinami NUSTATYMAI, o ne `new Pool(...)` vidus: pastarasis testui
   * nepasiekiamas, ir vienintelis likęs įrodymas būtų šaltinio teksto paieška.
   * Elgesio pusę - kad riba realiai suveikia - tikrina
   * `sessionPersistence.integration` su `pg_sleep()`.
   */
  const n = sessionStore.sesijuPoolNustatymai({ DATABASE_URL: "postgres://x/y" });

  for (const raktas of ["connectionTimeoutMillis", "statement_timeout", "query_timeout"]) {
    assert.equal(typeof n[raktas], "number", `${raktas} privalo būti skaičius`);
    assert.ok(Number.isFinite(n[raktas]) && n[raktas] > 0, `${raktas} privalo būti baigtinis ir teigiamas`);
  }

  /** Konfigūruojama, bet be tylaus virtimo begalybe prie šiukšlinės reikšmės. */
  const senas = process.env.DB_QUERY_TIMEOUT_MS;
  try {
    process.env.DB_QUERY_TIMEOUT_MS = "1500";
    assert.equal(sessionStore.sesijuPoolNustatymai({ DATABASE_URL: "x" }).query_timeout, 1500);

    process.env.DB_QUERY_TIMEOUT_MS = "abc";
    assert.equal(
      sessionStore.sesijuPoolNustatymai({ DATABASE_URL: "x" }).query_timeout,
      5000,
      "netinkama reikšmė grįžta į saugią numatytąją, o ne į neribotą laukimą"
    );
  } finally {
    if (senas === undefined) delete process.env.DB_QUERY_TIMEOUT_MS;
    else process.env.DB_QUERY_TIMEOUT_MS = senas;
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * PARUOŠTUMO SARGAS PRIEŠ REVOKACIJĄ (Codex P2 #2)
 *
 * ⚠️ FASADAS IKI `init()` RODO Į ATMINTĮ.
 *
 * Sukonfigūravus `SESSION_STORE_BACKEND=postgres`, bet dar nebaigus
 * inicijavimo / suderinimo, `destroy(token)` nueitų į atminties saugyklą,
 * persistentinio token'o nerastų, grąžintų `false` BE klaidos - ir maršrutas
 * išvalytų cookie bei atsakytų `{ ok: true }`. Vartotojui pasakyta
 * „atsijungta", o persistentinė sesija liktų galiojanti VISUOSE procesuose.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Įjungia „sukonfigūruota postgres, bet neinicijuota" būseną ir po savęs sutvarko. */
async function suNeinicijuotuPostgres(veiksmas) {
  const buvoBackend = process.env.SESSION_STORE_BACKEND;
  const buvoUrl = process.env.DATABASE_URL;
  process.env.SESSION_STORE_BACKEND = "postgres";
  process.env.DATABASE_URL = buvoUrl || "postgres://neveikia:1@127.0.0.1:1/none";
  try {
    /**
     * ⚠️ `await`, NE `return veiksmas()`. Be jo `finally` atstatytų aplinką
     * SINCHRONIŠKAI, dar prieš užklausai pasiekiant maršrutą - `isReady()`
     * matytų atminties režimą, testas gautų 200 ir tyliai nieko netikrintų.
     */
    return await veiksmas();
  } finally {
    if (buvoBackend === undefined) delete process.env.SESSION_STORE_BACKEND;
    else process.env.SESSION_STORE_BACKEND = buvoBackend;
    if (!buvoUrl) delete process.env.DATABASE_URL;
  }
}

test("LOGOUT: neinicijuota PostgreSQL saugykla → 503, cookie NEIŠVALOMA", async () => {
  /**
   * ⚠️ REGRESIJOS ESMĖ: token'as NETURI būti melagingai paskelbtas revokuotu.
   *
   * Tikrinama trys dalykai iš karto: statusas, kodas ir tai, kad atsakyme NĖRA
   * cookie valymo antraštės. Be paskutinio patikrinimo realizacija galėtų
   * grąžinti 503 IR vis tiek išvalyti cookie - klientas liktų be credential'o,
   * o serveryje sesija galiotų toliau.
   */
  const login = await prisijungti();
  const cookie = cookieIs(login);

  const res = await suNeinicijuotuPostgres(() =>
    request(app).post("/api/auth/logout").set("Cookie", cookie)
  );

  assert.equal(res.status, 503, "neparuošta saugykla negali atrodyti kaip sėkmingas atsijungimas");
  assert.equal(res.body.code, "SESSION_STORE_UNAVAILABLE");
  assert.equal(res.body.ok, undefined, "atsakyme negali būti sėkmės žymės");
  assert.equal(
    res.headers["set-cookie"],
    undefined,
    "cookie negali būti valoma, kai revokacija neįvyko"
  );

  /** Ir sesija realiai tebegalioja - būtent todėl klientas turi apie tai sužinoti. */
  assert.equal((await request(app).get("/api/auth/me").set("Cookie", cookie)).status, 200);
});

test("LOGOUT: BE cookie lieka IDEMPOTENTINIS net neparuošus saugyklos", async () => {
  /**
   * ⚠️ SARGAS NEGALI SULAUŽYTI IDEMPOTENTIŠKUMO.
   *
   * Atsijungimas be aktyvios sesijos nėra klaida - klientas galėjo jau būti
   * atsijungęs kitame skirtuke. Neturint ko revokuoti, nėra ir ko nepavykti,
   * tad paruoštumas čia nesvarbus. Realizacija, tikrinanti `isReady()` PRIEŠ
   * `if (token)`, šį testą sulaužytų.
   */
  const res = await suNeinicijuotuPostgres(() => request(app).post("/api/auth/logout"));

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.match(res.headers["set-cookie"][0], /Max-Age=0/, "cookie valymas lieka");
});

test("LOGIN: neinicijuota PostgreSQL saugykla → 503, jokios atminties sesijos", async () => {
  /**
   * Ta pati spraga kitame gale: be sargo `create()` sėkmingai sukurtų sesiją
   * ATMINTYJE ir išsiųstų galiojančią cookie, kurios nėra DB - ji neišgyventų
   * restarto ir jos nematytų kitas procesas, nors operatorius eksplicitiškai
   * pasirinko persistentinį režimą.
   */
  const priesTai = await sessionStore.size();

  const res = await suNeinicijuotuPostgres(() =>
    request(app).post("/api/auth/login").send({ username: "admin", password: "teisingas-slaptas-1" })
  );

  assert.equal(res.status, 503);
  assert.equal(res.body.code, "SESSION_STORE_UNAVAILABLE");
  assert.equal(res.headers["set-cookie"], undefined, "cookie negali būti išduota");
  assert.equal(
    await sessionStore.size(),
    priesTai,
    "atminties saugykloje negali atsirasti naujos sesijos"
  );
});

