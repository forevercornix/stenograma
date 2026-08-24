const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Pool } = require("pg");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { skipWithoutPostgres, testDatabaseUrl, adminDatabaseUrl } = require("./helpers/postgresGuard");
const { sukurtiResursuKruva } = require("./helpers/resourceStack");
const { createPostgresStore } = require("../utils/sessionStore/postgresStore");
const { hashSessionToken } = require("../utils/sessionStore/tokens");
const { hashPassword } = require("../utils/credentials");

/**
 * PERSISTENTINIŲ SESIJŲ GARANTIJOS, KURIŲ ATMINTYJE NĖRA (#155, 7.3).
 *
 * Bendras backend'ų kontraktas gyvena
 * `tests/sessionStoreBackendContract.integration.test.js`. ČIA - tik tai, kas
 * yra PostgreSQL-specifiška ir be tikros DB neįrodoma:
 *
 *  - kad lentelėje NĖRA plikojo token'o;
 *  - kad laiko invariantus vykdo DB, o ne JS;
 *  - kad autentikacija yra VIENA sąlyginė užklausa;
 *  - kad revokacija matoma KITAM procesui;
 *  - kad startinis suderinimas dengia restartą ir yra idempotentinis;
 *  - kad init'as krinta be reikalingų invariantų.
 */

const SKIP = skipWithoutPostgres();

const UID_A = "11111111-1111-4111-8111-111111111111";
const UID_B = "22222222-2222-4222-8222-222222222222";
const SLAPTAS = hashPassword("nesvarbu-1");

const ENV = Object.freeze({
  AUTH_USERS: `admin:administrator:${SLAPTAS}:${UID_A},petras:operator:${SLAPTAS}:${UID_B}`,
  SESSION_IDLE_TIMEOUT_MINUTES: "30",
  SESSION_ABSOLUTE_TIMEOUT_HOURS: "12",
});

const ADMIN = Object.freeze({ id: UID_A, username: "admin", role: "administrator" });
const PETRAS = Object.freeze({ id: UID_B, username: "petras", role: "operator" });

async function nuleistiDb(dbName) {
  const a = new Pool({ connectionString: adminDatabaseUrl() });
  try {
    await a.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } finally {
    await a.end();
  }
}

/**
 * Šviežia migruota DB su savo resursų krūva.
 *
 * ⚠️ KIEKVIENAM TESTUI SAVO PRIEŠDĖLIS. `node --test` failus vykdo
 * lygiagrečiai, o šie testai kuria ir naikina DB - bendras vardas reikštų, kad
 * vienas testas nuleidžia kito bazę viduryje darbo.
 */
async function paruostiDb(priesdelis) {
  const resursai = sukurtiResursuKruva();
  try {
    const url = testDatabaseUrl(priesdelis);
    const dbName = new URL(url).pathname.slice(1);

    const admin = new Pool({ connectionString: adminDatabaseUrl() });
    const uzdarytiAdmin = resursai.registruoti("admin pool", () => admin.end());
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
    resursai.registruoti("laikina DB", () => nuleistiDb(dbName));
    await uzdarytiAdmin();

    execFileSync("npx", ["node-pg-migrate", "up"], {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, DATABASE_URL: url },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const pool = new Pool({ connectionString: url });
    resursai.registruoti("darbinis pool", () => pool.end());

    return { url, pool, resursai, store: createPostgresStore(pool) };
  } catch (klaida) {
    await resursai.isvalyti(klaida);
    throw klaida;
  }
}

test("PERSISTENCIJA: lentelėje NĖRA plikojo token'o - tik jo maiša", { skip: SKIP }, async () => {
  /**
   * ⚠️ NUTEKĖJIMAS NETURI VIRSTI AKTYVIŲ SESIJŲ PERĖMIMU.
   *
   * Tikrinamas VISAS eilutės turinys, ne vien `token_hash` stulpelis:
   * realizacija, kuri token'ą „dėl patogumo" įrašytų į kokį nors kitą lauką,
   * siaurą patikrą praeitų.
   */
  const ctx = await paruostiDb("session_hash_only");
  try {
    const { token } = await ctx.store.create(ADMIN, ENV);

    const { rows } = await ctx.pool.query(`SELECT to_jsonb(s) AS eilute FROM sessions s`);
    assert.equal(rows.length, 1);

    const tekstas = JSON.stringify(rows[0].eilute);
    assert.ok(!tekstas.includes(token), "plikas token'as negali būti lentelėje");
    assert.ok(tekstas.includes(hashSessionToken(token)), "maiša privalo būti - pagal ją vyksta paieška");

    /** Ir atvirkščiai: pagal plikąjį token'ą DB nieko neranda. */
    const { rows: pagalPlika } = await ctx.pool.query(
      `SELECT 1 FROM sessions WHERE token_hash = $1`,
      [token]
    );
    assert.equal(pagalPlika.length, 0);
  } finally {
    await ctx.resursai.isvalyti();
  }
});

test("DB INVARIANTAI: keturi laiko CHECK'ai atmeta pažeidžiančias eilutes", { skip: SKIP }, async () => {
  /**
   * ⚠️ EILUTĖS RAŠOMOS APEINANT STORE'Ą.
   *
   * Per `create()` tokių reikšmių įrašyti neįmanoma, tad testas tikrintų JS,
   * ne DB. Būtent DB yra paskutinė riba, jei kada nors atsirastų antras
   * rašytojas (migracija, atkūrimas, rankinis taisymas).
   */
  const ctx = await paruostiDb("session_invariants");
  try {
    const bazine = {
      id: crypto.randomUUID(),
      token_hash: hashSessionToken("x"),
      user_id: UID_A,
      role: "administrator",
    };

    const atvejai = [
      {
        constraint: "sessions_expires_after_created",
        laikai: "now(), now() - interval '1 hour', now() + interval '1 hour', NULL, NULL",
        kodel: "absoliutus terminas prieš sukūrimą",
      },
      {
        constraint: "sessions_idle_after_created",
        laikai: "now(), now() + interval '1 hour', now() - interval '1 hour', NULL, NULL",
        kodel: "neveiklumo terminas prieš sukūrimą",
      },
      {
        constraint: "sessions_last_seen_after_created",
        laikai: "now(), now() + interval '1 hour', now() + interval '1 hour', now() - interval '1 hour', NULL",
        kodel: "paskutinis naudojimas prieš sukūrimą",
      },
      {
        constraint: "sessions_revoked_after_created",
        laikai: "now(), now() + interval '1 hour', now() + interval '1 hour', NULL, now() - interval '1 hour'",
        kodel: "revokacija prieš sukūrimą",
      },
    ];

    for (const atvejis of atvejai) {
      await assert.rejects(
        () =>
          ctx.pool.query(
            `INSERT INTO sessions
               (id, token_hash, user_id, role, created_at, expires_at, idle_expires_at, last_seen_at, revoked_at, schema_version)
             VALUES ($1, $2, $3, $4, ${atvejis.laikai}, 1)`,
            [crypto.randomUUID(), hashSessionToken(atvejis.constraint), bazine.user_id, bazine.role]
          ),
        (e) => e.constraint === atvejis.constraint,
        `${atvejis.kodel}: turėjo suveikti ${atvejis.constraint}`
      );
    }

    /** Teisėta eilutė su `NULL` laukais PRAEINA - constraint'ai neatmeta legalaus atvejo. */
    await ctx.pool.query(
      `INSERT INTO sessions
         (id, token_hash, user_id, role, created_at, expires_at, idle_expires_at, last_seen_at, revoked_at, schema_version)
       VALUES ($1, $2, $3, $4, now(), now() + interval '1 hour', now() + interval '1 hour', NULL, NULL, 1)`,
      [bazine.id, bazine.token_hash, bazine.user_id, bazine.role]
    );
  } finally {
    await ctx.resursai.isvalyti();
  }
});

test("DB INVARIANTAI: `token_hash` unikalus - dvi sesijos su ta pačia maiša negalimos", { skip: SKIP }, async () => {
  const ctx = await paruostiDb("session_unique");
  try {
    const maisa = hashSessionToken("tas-pats");
    const irasas = (id) =>
      ctx.pool.query(
        `INSERT INTO sessions
           (id, token_hash, user_id, role, created_at, expires_at, idle_expires_at, schema_version)
         VALUES ($1, $2, $3, 'administrator', now(), now() + interval '1 hour', now() + interval '1 hour', 1)`,
        [id, maisa, UID_A]
      );

    await irasas(crypto.randomUUID());
    await assert.rejects(() => irasas(crypto.randomUUID()), /duplicate key|unique/i);
  } finally {
    await ctx.resursai.isvalyti();
  }
});

test("ATOMIŠKUMAS: sėkminga autentikacija yra VIENA sesijų užklausa", { skip: SKIP }, async () => {
  /**
   * ⚠️ DVI UŽKLAUSOS (skaitymas + mutacija) YRA NESĖKMĖ.
   *
   * Tarp `findByToken()` ir `touch()` atsiranda revokacijos TOCTOU langas:
   * kitas procesas gali nustatyti `revoked_at`, o pirmasis vis tiek
   * autorizuos pasenusį snapshot'ą.
   *
   * Skaičiuojama ties DRAIVERIO RIBA (`pool.query`), ne ties store'o metodu -
   * kitaip patikra nematytų, kiek SQL sakinių realiai išsiųsta.
   */
  const ctx = await paruostiDb("session_one_query");
  try {
    const { token } = await ctx.store.create(ADMIN, ENV);

    const originalus = ctx.pool.query.bind(ctx.pool);
    const uzklausos = [];
    ctx.pool.query = (...args) => {
      uzklausos.push(String(args[0]));
      return originalus(...args);
    };

    const session = await ctx.store.touch(token, ENV);
    ctx.pool.query = originalus;

    assert.ok(session, "prielaida: sesija galioja");
    assert.equal(
      uzklausos.length,
      1,
      `autentikacija privalo būti viena sąlyginė operacija, o ne ${uzklausos.length} užklausos`
    );
    assert.match(uzklausos[0], /UPDATE sessions/i);
    assert.match(uzklausos[0], /revoked_at IS NULL/i, "revokacija tikrinama TAME PAČIAME sakinyje");
    assert.match(uzklausos[0], /expires_at > now\(\)/i, "absoliutus langas - tame pačiame sakinyje");
    assert.match(uzklausos[0], /idle_expires_at > now\(\)/i, "neveiklumo langas - tame pačiame sakinyje");
  } finally {
    await ctx.resursai.isvalyti();
  }
});

test("LENKTYNĖS: revokacija tarp dviejų procesų suveikia IŠ KARTO", { skip: SKIP }, async () => {
  /**
   * ⚠️ DU ATSKIRI POOL'AI = DU PROCESAI.
   *
   * Revokacijos rezultatas negali priklausyti nuo proceso lokalios atminties ar
   * cache. Testas deterministinis: revokacija įvykdoma PRIEŠ antrojo proceso
   * `touch()`, tad rezultatas nepriklauso nuo planavimo.
   */
  const ctx = await paruostiDb("session_two_procs");
  const antras = new Pool({ connectionString: ctx.url });
  ctx.resursai.registruoti("antro proceso pool", () => antras.end());
  try {
    const storeA = ctx.store;
    const storeB = createPostgresStore(antras);

    const { token } = await storeA.create(ADMIN, ENV);
    assert.ok(await storeB.touch(token, ENV), "prielaida: abu procesai mato tą pačią sesiją");

    /** Atsijungimas viename procese. */
    assert.equal(await storeA.destroy(token), true);

    assert.equal(await storeB.touch(token, ENV), null, "kitas procesas privalo iš karto atsisakyti cookie");
  } finally {
    await ctx.resursai.isvalyti();
  }
});

test("RESTARTAS: ta pati cookie po `restarto` atkuria req.user duomenis", { skip: SKIP }, async () => {
  /**
   * „Restartas" imituojamas NAUJU store'u ir NAUJU pool'u: proceso atmintyje
   * nelieka nieko, tad sesija gali ateiti tik iš DB.
   */
  const ctx = await paruostiDb("session_restart");
  try {
    const { token } = await ctx.store.create(ADMIN, ENV);

    const pooolPoRestarto = new Pool({ connectionString: ctx.url });
    ctx.resursai.registruoti("pool po restarto", () => pooolPoRestarto.end());
    const poRestarto = createPostgresStore(pooolPoRestarto);

    const session = await poRestarto.touch(token, ENV);
    assert.ok(session, "sesija privalo išgyventi restartą");
    assert.equal(session.userId, UID_A);
    assert.equal(session.role, "administrator");
    assert.equal(session.username, "admin");
  } finally {
    await ctx.resursai.isvalyti();
  }
});

test("SUDERINIMAS: vartotojo pašalinimas + restartas revokuoja sesiją", { skip: SKIP }, async () => {
  const ctx = await paruostiDb("session_reconcile_del");
  try {
    const { token } = await ctx.store.create(ADMIN, ENV);

    /** Restartas su AUTH_USERS be `admin`. */
    const beAdmin = { ...ENV, AUTH_USERS: `petras:operator:${SLAPTAS}:${UID_B}` };
    const rezultatas = await ctx.store.reconcile(beAdmin);

    assert.equal(rezultatas.revokuota, 1);
    assert.equal(await ctx.store.touch(token, beAdmin), null);

    /** ⚠️ Revokacija LOGINĖ - eilutė lieka iki savo `expires_at`. */
    const { rows } = await ctx.pool.query(
      `SELECT revoked_at FROM sessions WHERE token_hash = $1`,
      [hashSessionToken(token)]
    );
    assert.equal(rows.length, 1, "revokacija nėra ištrynimas");
    assert.notEqual(rows[0].revoked_at, null);

    /** IDEMPOTENTIŠKUMAS: pakartotinis startas nieko naujo nerevokuoja. */
    assert.equal((await ctx.store.reconcile(beAdmin)).revokuota, 0);
  } finally {
    await ctx.resursai.isvalyti();
  }
});

test("SUDERINIMAS: rolės sumažinimas + restartas revokuoja sesiją", { skip: SKIP }, async () => {
  const ctx = await paruostiDb("session_reconcile_role");
  try {
    const adminas = await ctx.store.create(ADMIN, ENV);
    const operatorius = await ctx.store.create(PETRAS, ENV);

    const pazemintas = {
      ...ENV,
      AUTH_USERS: `admin:operator:${SLAPTAS}:${UID_A},petras:operator:${SLAPTAS}:${UID_B}`,
    };
    const rezultatas = await ctx.store.reconcile(pazemintas);

    assert.equal(rezultatas.revokuota, 1, "revokuojama TIK pasikeitusi sesija");
    assert.equal(await ctx.store.touch(adminas.token, pazemintas), null, "sena rolė nebeautorizuoja");
    assert.ok(await ctx.store.touch(operatorius.token, pazemintas), "nepakitusi sesija nepaliesta");
  } finally {
    await ctx.resursai.isvalyti();
  }
});

test("SUDERINIMAS: klaida ciklo viduryje NEPASKELBIA sėkmės, o kartojimas užbaigia", { skip: SKIP }, async () => {
  /**
   * ⚠️ SĖKMĖ YRA VISAS CIKLAS, NE DALINĖ BŪSENA.
   *
   * Nutrūkus viduryje, klaida keliama į viršų - `server.js` tada nekviečia
   * `listen()`, o `sessionReconcile` readiness netampa `true`. Jau atliktos
   * revokacijos gali likti committed, nes operacija IDEMPOTENTINĖ.
   *
   * Klaida injektuojama ties DRAIVERIO RIBA po pirmos partijos, tad tikrinama
   * būtent ciklo, o ne vieno sakinio elgsena.
   */
  const ctx = await paruostiDb("session_reconcile_fail");
  try {
    for (let i = 0; i < 5; i++) await ctx.store.create(ADMIN, ENV);

    const beAdmin = { ...ENV, AUTH_USERS: `petras:operator:${SLAPTAS}:${UID_B}` };

    const originalus = ctx.pool.query.bind(ctx.pool);
    let kvietimai = 0;
    ctx.pool.query = (...args) => {
      kvietimai += 1;
      /** Pirma partija (SELECT + UPDATE) praeina, antras SELECT krinta. */
      if (kvietimai === 3) return Promise.reject(new Error("ryšys nutrūko ties 2-a partija"));
      return originalus(...args);
    };

    await assert.rejects(
      () => ctx.store.reconcile(beAdmin, { batchSize: 2 }),
      /ryšys nutrūko/,
      "nutrūkęs suderinimas privalo mesti, ne grąžinti dalinį rezultatą"
    );

    ctx.pool.query = originalus;

    /** Dalis jau revokuota - tai leidžiama. Svarbu, kad kartojimas užbaigtų. */
    const antras = await ctx.store.reconcile(beAdmin, { batchSize: 2 });
    const { rows } = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM sessions WHERE revoked_at IS NULL`
    );
    assert.equal(rows[0].n, 0, "pakartotinis suderinimas privalo užbaigti likusią dalį");
    assert.ok(antras.revokuota > 0);

    /** Ir dar kartą - jau be pakeitimų. */
    assert.equal((await ctx.store.reconcile(beAdmin)).revokuota, 0);
  } finally {
    await ctx.resursai.isvalyti();
  }
});

test("SUDERINIMAS: keyset apima VISAS sesijas, kai partijų daugiau nei viena", { skip: SKIP }, async () => {
  /**
   * ⚠️ `OFFSET` ČIA BŪTŲ TYLI SPRAGA.
   *
   * Revokuotos eilutės iškrenta iš filtro, tad `OFFSET 2` po pirmos partijos
   * praleistų dvi nepatikrintas sesijas - dalinė aprėptis atrodytų kaip
   * sėkmingas suderinimas.
   */
  const ctx = await paruostiDb("session_reconcile_keyset");
  try {
    for (let i = 0; i < 7; i++) await ctx.store.create(ADMIN, ENV);

    const beAdmin = { ...ENV, AUTH_USERS: `petras:operator:${SLAPTAS}:${UID_B}` };
    const rezultatas = await ctx.store.reconcile(beAdmin, { batchSize: 2 });

    assert.equal(rezultatas.revokuota, 7, "visos sesijos privalo būti patikrintos");
    const { rows } = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM sessions WHERE revoked_at IS NULL`
    );
    assert.equal(rows[0].n, 0);
  } finally {
    await ctx.resursai.isvalyti();
  }
});

test("INIT: schema be sesijų invariantų NUTRAUKIA startą", { skip: SKIP }, async () => {
  /**
   * ⚠️ LENTELĖS BUVIMO NEPAKANKA.
   *
   * DB su dalimi migracijų lentelę turi, o invariantų - ne, ir readiness
   * paskelbtų saugyklą pasiruošusia. Tas pats modelis kaip
   * `REQUIRED_JOB_CONSTRAINTS` (#155, 7.2a).
   */
  const ctx = await paruostiDb("session_init_guard");
  const sessionStore = require("../utils/sessionStore");
  const senasBackend = process.env.SESSION_STORE_BACKEND;
  const senasUrl = process.env.DATABASE_URL;
  try {
    await ctx.pool.query(`ALTER TABLE sessions DROP CONSTRAINT sessions_idle_after_created`);

    process.env.SESSION_STORE_BACKEND = "postgres";
    process.env.DATABASE_URL = ctx.url;
    await sessionStore.shutdown();

    await assert.rejects(
      () => sessionStore.init(),
      /trūksta invariantų.*sessions_idle_after_created/s,
      "pasenusi schema privalo nutraukti startą, ne būti paskelbta pasiruošusia"
    );

    /** ⚠️ Po nesėkmės jungtys uždarytos - kitaip integraciniai testai kabotų. */
    assert.equal(sessionStore.isReady(), false);
  } finally {
    await sessionStore.shutdown();
    if (senasBackend === undefined) delete process.env.SESSION_STORE_BACKEND;
    else process.env.SESSION_STORE_BACKEND = senasBackend;
    if (senasUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = senasUrl;
    await ctx.resursai.isvalyti();
  }
});

test("INIT: veikianti DB su pilna schema paruošia PostgreSQL backend'ą", { skip: SKIP }, async () => {
  const ctx = await paruostiDb("session_init_ok");
  const sessionStore = require("../utils/sessionStore");
  const senasBackend = process.env.SESSION_STORE_BACKEND;
  const senasUrl = process.env.DATABASE_URL;
  const senasAuth = process.env.AUTH_USERS;
  try {
    process.env.SESSION_STORE_BACKEND = "postgres";
    process.env.DATABASE_URL = ctx.url;
    process.env.AUTH_USERS = ENV.AUTH_USERS;
    await sessionStore.shutdown();

    await sessionStore.init();
    assert.equal(sessionStore.backend, "postgres");

    /** ⚠️ Iki suderinimo autoritetas NĖRA paruoštas - readiness barjeras. */
    assert.equal(sessionStore.isReady(), false, "init vienas neatidaro srauto");

    const suderinimas = await sessionStore.reconcile();
    assert.equal(suderinimas.backend, "postgres");
    assert.equal(sessionStore.isReady(), true);

    const { token } = await sessionStore.create(ADMIN);
    assert.ok(await sessionStore.touch(token), "fasadas privalo kalbėti su PostgreSQL, ne su atmintimi");
  } finally {
    await sessionStore.shutdown();
    if (senasBackend === undefined) delete process.env.SESSION_STORE_BACKEND;
    else process.env.SESSION_STORE_BACKEND = senasBackend;
    if (senasUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = senasUrl;
    if (senasAuth === undefined) delete process.env.AUTH_USERS;
    else process.env.AUTH_USERS = senasAuth;
    await ctx.resursai.isvalyti();
  }
});

test("INIT: neveikianti DB su eksplicitiniu postgres NUTRAUKIA startą (be fallback)", { skip: SKIP }, async () => {
  const sessionStore = require("../utils/sessionStore");
  const senasBackend = process.env.SESSION_STORE_BACKEND;
  const senasUrl = process.env.DATABASE_URL;
  const senasTimeout = process.env.DB_CONNECT_TIMEOUT_MS;
  try {
    process.env.SESSION_STORE_BACKEND = "postgres";
    process.env.DATABASE_URL = "postgres://nera:nera@127.0.0.1:1/nera";
    process.env.DB_CONNECT_TIMEOUT_MS = "300";
    await sessionStore.shutdown();

    await assert.rejects(() => sessionStore.init(), /ECONNREFUSED|timeout|connect/i);
    assert.equal(sessionStore.isReady(), false, "fallback į atmintį draudžiamas");
  } finally {
    await sessionStore.shutdown();
    if (senasBackend === undefined) delete process.env.SESSION_STORE_BACKEND;
    else process.env.SESSION_STORE_BACKEND = senasBackend;
    if (senasUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = senasUrl;
    if (senasTimeout === undefined) delete process.env.DB_CONNECT_TIMEOUT_MS;
    else process.env.DB_CONNECT_TIMEOUT_MS = senasTimeout;
  }
});

test("SUDERINAMUMAS: destroyAllForUser išverčia vardą į user_id, o nežinomas vardas KRINTA", { skip: SKIP }, async () => {
  /**
   * ⚠️ TYLUS `0` BŪTŲ NEGALIMAS.
   *
   * Jis atrodytų kaip „vartotojas neturėjo sesijų", o realiai reikštų
   * neįvykusią revokaciją. Pasirinktas #181 variantas (1): revokacija per
   * `loadUsers(env)` → `user_id`; vardas, kurio `AUTH_USERS` nepažįsta, yra
   * apibrėžta klaida.
   */
  const ctx = await paruostiDb("session_legacy_user");
  try {
    const a = await ctx.store.create(ADMIN, ENV);
    const b = await ctx.store.create(PETRAS, ENV);

    assert.equal(await ctx.store.destroyAllForUser("admin", ENV), 1);
    assert.equal(await ctx.store.touch(a.token, ENV), null);
    assert.ok(await ctx.store.touch(b.token, ENV), "kito vartotojo sesija nepaliesta");

    await assert.rejects(
      () => ctx.store.destroyAllForUser("nezinomas", ENV),
      /AUTH_USERS/,
      "nežinomas vardas negali tyliai grąžinti 0"
    );
  } finally {
    await ctx.resursai.isvalyti();
  }
});

test("TAPATYBĖ: PostgreSQL sesija be stabilaus user_id NESUKURIAMA", { skip: SKIP }, async () => {
  const ctx = await paruostiDb("session_identity");
  try {
    for (const bloga of [{ username: "admin", role: "administrator" }, { id: null, username: "a", role: "operator" }, { id: "ne-uuid", username: "a", role: "operator" }]) {
      await assert.rejects(
        () => ctx.store.create(bloga, ENV),
        (e) => e.code === "IDENTITY_UNAVAILABLE",
        `tapatybė ${JSON.stringify(bloga)} turėjo būti atmesta`
      );
    }

    const { rows } = await ctx.pool.query(`SELECT count(*)::int AS n FROM sessions`);
    assert.equal(rows[0].n, 0, "nė viena dalinė eilutė negali likti");
  } finally {
    await ctx.resursai.isvalyti();
  }
});

test("LAIKAS: terminai skaičiuojami DB laikrodžiu, ne proceso", { skip: SKIP }, async () => {
  /**
   * ⚠️ DU LAIKO ŠALTINIAI SULAUŽYTŲ SPRENDIMĄ.
   *
   * `touch()` tikrina `expires_at > now()` DB laikrodžiu. Jei terminai rašomi
   * proceso laikrodžiu, tas pats sprendimas remiasi dviem šaltiniais, ir jų
   * poslinkis nutrauks sesijas anksčiau ar vėliau nei nustatyta.
   *
   * Tikrinama lyginant įrašytą `created_at` su DB `now()`, o ne su
   * `Date.now()`: jei reikšmė būtų atėjusi iš proceso, ji būtų nutolusi nuo DB
   * laiko tiek, kiek laikrodžiai skiriasi. Skirtumo ribos pakanka, kad testas
   * kristų prie realaus poslinkio, bet ne dėl užklausos trukmės.
   */
  const ctx = await paruostiDb("session_clock");
  try {
    await ctx.store.create(ADMIN, ENV);

    const { rows } = await ctx.pool.query(
      `SELECT
         extract(epoch FROM (now() - created_at)) AS skirtumas_s,
         extract(epoch FROM (expires_at - created_at)) AS absoliutus_s,
         extract(epoch FROM (idle_expires_at - created_at)) AS idle_s
       FROM sessions`
    );
    const r = rows[0];

    assert.ok(Math.abs(Number(r.skirtumas_s)) < 5, "created_at privalo ateiti iš DB laikrodžio");
    assert.ok(Math.abs(Number(r.absoliutus_s) - 12 * 3600) < 2, "absoliutus langas = 12 val.");
    assert.ok(Math.abs(Number(r.idle_s) - 30 * 60) < 2, "neveiklumo langas = 30 min.");
  } finally {
    await ctx.resursai.isvalyti();
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * PASTUMTAS PROCESO LAIKRODIS (#181, „VIENAS LAIKO ŠALTINIS: DB LAIKRODIS")
 *
 * ⚠️ KODĖL ANKSTESNIO `LAIKAS:` TESTO NEPAKAKO.
 *
 * Jis lygino `now() - created_at < 5 s`. CI runner'is ir `postgres` konteineris
 * dalijasi to paties host'o laikrodžiu, tad ta patikra praeitų IR tada, jei
 * terminai būtų skaičiuojami `Date.now()` proceso pusėje - t. y. ji neatskyrė
 * dviejų šaltinių ir nebuvo atspari mutacijai.
 *
 * Šie trys testai laikrodžius IŠSKIRIA dirbtinai: proceso `Date.now()`
 * pastumiamas, o DB laikrodis lieka tikras. Realizacija, rašanti terminus
 * proceso laiku, iškart duoda kitokias reikšmes.
 *
 * ⚠️ `Date.now` KEIČIAMAS TIK APLINK TIKRINAMĄ KVIETIMĄ ir grąžinamas
 * `finally` bloke - kitaip pastumtas laikrodis nutekėtų į `pg` vidinius
 * timeout'us ir `node:test` apskaitą.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Įvykdo `veiksmas()` su pastumtu proceso laikrodžiu ir VISADA jį atstato. */
async function suPastumtuLaikrodziu(poslinkisMs, veiksmas) {
  const tikras = Date.now;
  Date.now = () => tikras.call(Date) + poslinkisMs;
  try {
    return await veiksmas();
  } finally {
    Date.now = tikras;
  }
}

const VALANDA_S = 3600;

test("LAIKAS: procesas su PIRMYN pastumtu laikrodžiu - terminai lieka DB laiko", { skip: SKIP }, async () => {
  /**
   * Proceso laikrodis pastumtas +24 val. Realizacija su `Date.now()` įrašytų
   * `expires_at = dabar + 24 val + 12 val`, t. y. sesija galiotų 36 valandas
   * vietoj 12 - absoliutus langas taptų trigubai ilgesnis, o niekas to
   * nepastebėtų, nes eilutė atrodo tvarkinga.
   */
  const ctx = await paruostiDb("session_clock_fwd");
  try {
    const sukurta = await suPastumtuLaikrodziu(24 * VALANDA_S * 1000, () =>
      ctx.store.create(ADMIN, ENV)
    );
    const tikrasDabar = Date.now();

    const { rows } = await ctx.pool.query(
      `SELECT extract(epoch FROM (created_at - now()))      AS sukurta_s,
              extract(epoch FROM (expires_at - now()))      AS absoliutus_s,
              extract(epoch FROM (idle_expires_at - now())) AS idle_s
         FROM sessions`
    );
    const r = rows[0];

    assert.ok(
      Math.abs(Number(r.sukurta_s)) < 10,
      `created_at privalo būti DB dabartis, o ne +24 val (gauta ${r.sukurta_s} s)`
    );
    assert.ok(
      Math.abs(Number(r.absoliutus_s) - 12 * VALANDA_S) < 10,
      `absoliutus langas privalo likti 12 val., ne 36 (gauta ${Number(r.absoliutus_s) / VALANDA_S} val.)`
    );
    assert.ok(
      Math.abs(Number(r.idle_s) - 30 * 60) < 10,
      `neveiklumo langas privalo likti 30 min. (gauta ${Number(r.idle_s) / 60} min.)`
    );

    /** Ir grąžinamas objektas neša DB laiką, ne proceso. */
    assert.ok(
      Math.abs(sukurta.session.createdAt - tikrasDabar) < 10_000,
      "create() grąžintas createdAt privalo ateiti iš DB eilutės"
    );
  } finally {
    await ctx.resursai.isvalyti();
  }
});

test("LAIKAS: procesas su ATGAL pastumtu laikrodžiu - sesija VIS TIEK galioja", { skip: SKIP }, async () => {
  /**
   * ⚠️ TAI TIKSLIAI #181 ĮVARDYTAS TESTAS: „sesija, sukurta procesui su
   * pastumtu laikrodžiu, galioja pagal DB laiką".
   *
   * Proceso laikrodis pastumtas −2 val., o neveiklumo langas yra 30 min.
   * Realizacija su `Date.now()` įrašytų `idle_expires_at = dabar − 2 val +
   * 30 min = dabar − 1,5 val`, t. y. sesija gimtų JAU PASIBAIGUSI, ir
   * vartotojas būtų atjungtas iš karto po prisijungimo.
   */
  const ctx = await paruostiDb("session_clock_back");
  try {
    const { token } = await suPastumtuLaikrodziu(-2 * VALANDA_S * 1000, () =>
      ctx.store.create(ADMIN, ENV)
    );

    const session = await ctx.store.touch(token, ENV);

    assert.ok(
      session,
      "sesija privalo galioti pagal DB laikrodį, nepaisant pastumto proceso laikrodžio"
    );
    assert.equal(session.userId, UID_A);
  } finally {
    await ctx.resursai.isvalyti();
  }
});

test("LAIKAS: create() ir touch() naudoja TĄ PATĮ šaltinį", { skip: SKIP }, async () => {
  /**
   * ⚠️ DU ŠALTINIAI SULAUŽYTŲ SPRENDIMĄ NET JEI KIEKVIENAS ATSKIRAI ATRODYTŲ
   * TEISINGAS.
   *
   * `create()` vykdomas su +6 val., `touch()` - su −6 val. pastumtu procesu.
   * Jei bent vienas iš jų remtųsi proceso laikrodžiu, `last_seen_at` arba
   * naujas `idle_expires_at` nutoltų 6 valandas nuo DB dabarties, ir
   * neveiklumo langas nustotų reikšti 30 minučių.
   */
  const ctx = await paruostiDb("session_clock_same");
  try {
    const { token } = await suPastumtuLaikrodziu(6 * VALANDA_S * 1000, () =>
      ctx.store.create(ADMIN, ENV)
    );
    const session = await suPastumtuLaikrodziu(-6 * VALANDA_S * 1000, () =>
      ctx.store.touch(token, ENV)
    );

    assert.ok(session, "prielaida: sesija galioja");

    const { rows } = await ctx.pool.query(
      `SELECT extract(epoch FROM (last_seen_at - now()))                AS matyta_s,
              extract(epoch FROM (idle_expires_at - last_seen_at))      AS idle_langas_s,
              extract(epoch FROM (expires_at - created_at))             AS abs_langas_s
         FROM sessions`
    );
    const r = rows[0];

    assert.ok(
      Math.abs(Number(r.matyta_s)) < 10,
      `touch() last_seen_at privalo būti DB dabartis (gauta ${r.matyta_s} s)`
    );
    assert.ok(
      Math.abs(Number(r.idle_langas_s) - 30 * 60) < 10,
      `neveiklumo langas nuo last_seen_at privalo būti 30 min. (gauta ${Number(r.idle_langas_s) / 60} min.)`
    );
    assert.ok(
      Math.abs(Number(r.abs_langas_s) - 12 * VALANDA_S) < 10,
      "absoliutus langas nuo created_at privalo likti 12 val."
    );
  } finally {
    await ctx.resursai.isvalyti();
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * ATSKIRI NODE PROCESAI (#181, „LOGOUT / REVOKACIJA YRA GLOBALI")
 *
 * ⚠️ DU POOL'AI VIENAME PROCESE NĖRA DU PROCESAI.
 *
 * `LENKTYNĖS:` testas aukščiau naudoja dvi saugyklas viename Node procese.
 * Modulio lygio cache (kurio šiandien nėra) jį apeitų nepastebėtas. #181
 * reikalauja „du procesai ARBA restartas, ne vien įrašas DB yra", tad čia
 * paleidžiami TIKRI atskiri `node` procesai su savo moduliais, savo atmintimi
 * ir savo jungtimis.
 *
 * Šviežias procesas, skaitantis sesiją, kurios jis pats nekūrė, kartu yra ir
 * RESTARTO įrodymas: proceso atmintyje nėra nieko, iš ko sesiją būtų galima
 * atkurti.
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Vaiko skriptas: `touch` arba `destroy` per TIKRĄ produkcinę saugyklą.
 *
 * ⚠️ `process.exitCode` NENUSTATOMAS net klaidos atveju - kitaip `execFileSync`
 * mestų, ir testas praneštų apie proceso kritimą vietoj to, ką vaikas realiai
 * atsakė. Rezultatas visada grąžinamas per `stdout`.
 */
const VAIKO_SKRIPTAS = `
const { Pool } = require("pg");
const { createPostgresStore } = require("./utils/sessionStore/postgresStore");

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const store = createPostgresStore(pool);
    if (process.env.VEIKSMAS === "destroy") {
      const ok = await store.destroy(process.env.SESIJOS_TOKENAS);
      process.stdout.write("DESTROY:" + String(ok));
      return;
    }
    const s = await store.touch(process.env.SESIJOS_TOKENAS);
    process.stdout.write(s ? "OK:" + s.userId + ":" + s.role : "NULL");
  } finally {
    await pool.end();
  }
})().catch((e) => process.stdout.write("KLAIDA:" + e.message));
`;

function kitameProcese(url, token, veiksmas = "touch") {
  return execFileSync(process.execPath, ["-e", VAIKO_SKRIPTAS], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      DATABASE_URL: url,
      SESIJOS_TOKENAS: token,
      VEIKSMAS: veiksmas,
      AUTH_USERS: ENV.AUTH_USERS,
      SESSION_IDLE_TIMEOUT_MINUTES: ENV.SESSION_IDLE_TIMEOUT_MINUTES,
      SESSION_ABSOLUTE_TIMEOUT_HOURS: ENV.SESSION_ABSOLUTE_TIMEOUT_HOURS,
      NODE_ENV: "test",
      LOG_LEVEL: "error",
    },
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

test("GLOBALI REVOKACIJA: ATSKIRAS Node procesas nustoja priimti tą pačią cookie", { skip: SKIP }, async () => {
  const ctx = await paruostiDb("session_kiti_procesai");
  try {
    const { token } = await ctx.store.create(ADMIN, ENV);

    /**
     * 1. RESTARTO ATITIKMUO: procesas, kuris sesijos NEKŪRĖ ir jos atmintyje
     *    neturi, ją randa ir autentifikuoja.
     */
    assert.equal(
      kitameProcese(ctx.url, token),
      `OK:${UID_A}:administrator`,
      "šviežias procesas privalo atkurti sesiją iš DB"
    );

    /** 2. Atsijungimas VIENAME procese (šiame). */
    assert.equal(await ctx.store.destroy(token), true);

    /**
     * 3. KITAS šviežias procesas jos nebepriima. Proceso lokalus cache čia
     *    padėti negalėtų - vaikas paleidžiamas iš naujo ir bendros atminties
     *    su tėvu neturi.
     */
    assert.equal(
      kitameProcese(ctx.url, token),
      "NULL",
      "revokacija privalo galioti visuose procesuose, ne tik tame, kuris ją atliko"
    );
  } finally {
    await ctx.resursai.isvalyti();
  }
});

test("GLOBALI REVOKACIJA: ATSKIRAME procese atlikta revokacija matoma ir čia", { skip: SKIP }, async () => {
  /**
   * Priešinga kryptis. Be jos testas įrodytų tik tai, kad vaikas mato tėvo
   * revokaciją - bet ne tai, kad tėvas mato vaiko, o būtent taip atrodo
   * atsijungimas kitoje replikoje.
   */
  const ctx = await paruostiDb("session_kiti_procesai_atv");
  try {
    const { token } = await ctx.store.create(ADMIN, ENV);
    assert.ok(await ctx.store.touch(token, ENV), "prielaida: sesija galioja");

    assert.equal(kitameProcese(ctx.url, token, "destroy"), "DESTROY:true");

    assert.equal(
      await ctx.store.touch(token, ENV),
      null,
      "kitame procese atlikta revokacija privalo galioti iš karto"
    );
  } finally {
    await ctx.resursai.isvalyti();
  }
});

