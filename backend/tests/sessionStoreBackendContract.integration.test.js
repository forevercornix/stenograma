const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Pool } = require("pg");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { skipWithoutPostgres, testDatabaseUrl, adminDatabaseUrl } = require("./helpers/postgresGuard");
const { sukurtiResursuKruva } = require("./helpers/resourceStack");
const memoryStore = require("../utils/sessionStore/memoryStore");
const { createPostgresStore } = require("../utils/sessionStore/postgresStore");
const { hashSessionToken } = require("../utils/sessionStore/tokens");
const { hashPassword } = require("../utils/credentials");

/**
 * SESIJŲ BACKEND'Ų KONTRAKTO EKVIVALENTUMAS (#155, 7.3).
 *
 * ⚠️ `tests/authFoundation.test.js` TIKRINA TIK ATMINTĮ.
 *
 * Du atskiri keliai be bendro rinkinio išsiskiria tyliai - job store pusėje
 * tai jau įvyko (#155: `tenantId`, `idempotencyKey`, `created_at`, tipų
 * konvertavimas). Sesijų atveju divergencija reikštų, kad autentikacijos
 * semantika priklauso nuo `SESSION_STORE_BACKEND` reikšmės.
 *
 * Adapterio modelis (`{ name, skip, setup }`) laiko išorinių resursų paruošimą
 * ir uždarymą greta, o SCENARIJŲ SĄRAŠAS lieka VIENAS abiem backend'ams.
 *
 * ⚠️ REGISTRUOTAS DVIEJUOSE RINKINIUOSE (`security` ir `postgres`).
 * `security` paleidžia jį kiekviename `npm test` (atminties adapteris),
 * `postgres` - `npm run test:postgres` su tikru `DATABASE_URL`. Failas, likęs
 * tik viename, tikrintų vieną backend'ą iš dviejų.
 *
 * ⚠️ LAIKAS STUMDOMAS EKSPLICITIŠKAI, NE `setTimeout`.
 *
 * Galiojimo scenarijai remiasi tuo, kad terminas jau praėjo. Laukimas realiu
 * laiku darytų testą flaky ir, kas svarbiau, priklausomą nuo to, ar proceso
 * ir DB laikrodžiai sutampa - o šio kontrakto esmė kaip tik yra tai, kad
 * kiekvienas backend'as naudoja SAVO laikrodį. Todėl kiekvienas adapteris
 * pastumia terminus savo pusėje.
 */

const UID_A = "11111111-1111-4111-8111-111111111111";
const UID_B = "22222222-2222-4222-8222-222222222222";

const SLAPTAS = hashPassword("nesvarbu-1");
const AUTH_USERS = `admin:administrator:${SLAPTAS}:${UID_A},petras:operator:${SLAPTAS}:${UID_B}`;

/** Bazinė aplinka: abu vartotojai egzistuoja, langai pakankamai ilgi. */
const ENV = Object.freeze({
  AUTH_USERS,
  SESSION_IDLE_TIMEOUT_MINUTES: "30",
  SESSION_ABSOLUTE_TIMEOUT_HOURS: "12",
});

const ADMIN = Object.freeze({ id: UID_A, username: "admin", role: "administrator" });
const PETRAS = Object.freeze({ id: UID_B, username: "petras", role: "operator" });

/**
 * SCENARIJAI, KURIŲ REZULTATAS TURI SUTAPTI ABIEJUOSE BACKEND'UOSE.
 *
 * Kiekvienas gauna `{ store, env, pastumti, nustatytiVersija }` ir tikrina
 * ELGESĮ, ne realizaciją. `id` naudojamas pilnumo patikroje žemiau.
 */
const SCENARIJAI = [
  {
    id: "kuria-ir-autentifikuoja",
    kodel: "create() grąžina { session, token }, o touch(token) atkuria tapatybę",
    async run({ store, env }) {
      const { session, token } = await store.create(ADMIN, env);

      assert.match(session.id, /^[0-9a-f-]{36}$/, "id yra uuid surogatas");
      assert.notEqual(token, session.id, "cookie reikšmė negali būti DB pirminis raktas");
      assert.notEqual(token, hashSessionToken(token), "cookie reikšmė negali būti maiša");

      const touched = await store.touch(token, env);
      assert.equal(touched.userId, UID_A);
      assert.equal(touched.role, "administrator");
      assert.equal(touched.username, "admin", "vardas išvedamas iš AUTH_USERS");
      assert.equal(touched.id, session.id);
    },
  },
  {
    id: "nezinomas-tokenas",
    kodel: "neegzistuojantis token'as niekada neautentifikuoja",
    async run({ store, env }) {
      assert.equal(await store.touch("visai-kitas-tokenas", env), null);
      assert.equal(await store.touch("", env), null);
      assert.equal(await store.touch(null, env), null);
    },
  },
  {
    id: "idle-langas",
    kodel: "neveiklumo langas baigia sesiją, nors absoliutus dar galioja",
    async run({ store, env, pastumti }) {
      const { token } = await store.create(ADMIN, env);
      assert.ok(await store.touch(token, env), "prielaida: šviežia sesija galioja");

      /** TIK neveiklumo langas į praeitį; absoliutus lieka ateityje. */
      await pastumti(token, { idleSekundes: -5 });

      assert.equal(await store.touch(token, env), null, "idle timeout privalo nutraukti sesiją");
      assert.equal(await store.touch(token, env), null, "pasibaigusi sesija negali atgyti pakartotinai");
    },
  },
  {
    id: "absoliutus-langas",
    kodel: "absoliutus langas baigia sesiją NEPRIKLAUSOMAI nuo aktyvumo",
    async run({ store, env, pastumti }) {
      const { token } = await store.create(ADMIN, env);

      /** Aktyvumas: kelis kartus paliečiam, tad idle langas nuolat pratęsiamas. */
      for (let i = 0; i < 3; i++) assert.ok(await store.touch(token, env));

      await pastumti(token, { absoliutusSekundes: -5 });

      assert.equal(
        await store.touch(token, env),
        null,
        "nuolat naudojama sesija vis tiek privalo baigtis pagal absoliutų langą"
      );
    },
  },
  {
    id: "touch-pratesia-tik-idle",
    kodel: "touch pratęsia neveiklumo langą, bet NE absoliutų",
    async run({ store, env, pastumti, perskaityti }) {
      const { session, token } = await store.create(ADMIN, env);
      const pradinisAbsoliutus = session.expiresAt;

      /**
       * ⚠️ ANKSTESNĖ ŠIO TIKRINIMO VERSIJA BUVO TUŠČIA.
       *
       * Ji lygino `paskutinis.idleExpiresAt >= session.idleExpiresAt`. Atminties
       * backend'e `create()` ir `touch()` grąžina TĄ PATĮ objektą, tad tai buvo
       * `x >= x` - teisinga net tada, kai `touch()` neveiklumo lango apskritai
       * nebepratęsia. PostgreSQL pusėje `>=` irgi praeitų, jei abu kvietimai
       * pataikytų į tą pačią sekundę.
       *
       * Dabar terminas dirbtinai pastumiamas į ARTIMĄ ateitį, nuskaitomas iš
       * saugyklos kaip SKALIARAS ir reikalaujamas GRIEŽTAI didesnis - tad
       * `idle_expires_at` atnaujinimo pašalinimas iš bet kurio backend'o šį
       * scenarijų sulaužo.
       */
      await pastumti(token, { idleSekundes: 5 });
      const priesTai = (await perskaityti(token)).idleExpiresAt;

      const paskutinis = await store.touch(token, env);
      assert.ok(paskutinis, "prielaida: sesija dar galioja");

      const poTo = (await perskaityti(token)).idleExpiresAt;
      assert.ok(
        poTo > priesTai,
        `touch() privalo pratęsti neveiklumo langą (buvo ${priesTai}, tapo ${poTo})`
      );

      /** Absoliutus langas nepajuda nė po kelių kvietimų. */
      assert.equal(paskutinis.expiresAt, pradinisAbsoliutus);
      for (let i = 0; i < 2; i++) {
        const dar = await store.touch(token, env);
        assert.equal(
          dar.expiresAt,
          pradinisAbsoliutus,
          "absoliutus langas negali slinkti - kitaip aktyvi sesija niekada nepasibaigtų"
        );
      }
    },
  },
  {
    id: "konfiguruojami-langai",
    kodel: "sumažinta reikšmė trumpina ATITINKAMĄ langą ir nepaliečia kito",
    async run({ store, env }) {
      const bazinis = await store.create(ADMIN, env);

      const trumpasIdle = { ...env, SESSION_IDLE_TIMEOUT_MINUTES: "1" };
      const suTrumpuIdle = await store.create(ADMIN, trumpasIdle);
      assert.ok(
        suTrumpuIdle.session.idleExpiresAt < bazinis.session.idleExpiresAt,
        "SESSION_IDLE_TIMEOUT_MINUTES privalo trumpinti neveiklumo langą"
      );
      assert.ok(
        suTrumpuIdle.session.expiresAt - bazinis.session.expiresAt > -60_000,
        "idle nuostata negali paliesti absoliutaus lango"
      );

      const trumpasAbsoliutus = { ...env, SESSION_ABSOLUTE_TIMEOUT_HOURS: "1" };
      const suTrumpuAbs = await store.create(ADMIN, trumpasAbsoliutus);
      assert.ok(
        suTrumpuAbs.session.expiresAt < bazinis.session.expiresAt,
        "SESSION_ABSOLUTE_TIMEOUT_HOURS privalo trumpinti absoliutų langą"
      );
      assert.ok(
        suTrumpuAbs.session.idleExpiresAt - bazinis.session.idleExpiresAt > -60_000,
        "absoliuti nuostata negali paliesti neveiklumo lango"
      );
    },
  },
  {
    id: "revokacija-atsijungiant",
    kodel: "destroy(token) atima galiojimą iš TOS PAČIOS cookie",
    async run({ store, env }) {
      const { token } = await store.create(ADMIN, env);
      assert.ok(await store.touch(token, env));

      assert.equal(await store.destroy(token), true);
      assert.equal(await store.touch(token, env), null, "revokuota cookie negali autentifikuoti");

      assert.equal(await store.destroy(token), false, "antra revokacija nieko nebekeičia");
    },
  },
  {
    id: "revokacija-pagal-userId",
    kodel: "destroyAllForUserId liečia TIK nurodytą tapatybę",
    async run({ store, env }) {
      const a1 = await store.create(ADMIN, env);
      const a2 = await store.create(ADMIN, env);
      const b = await store.create(PETRAS, env);

      assert.equal(await store.destroyAllForUserId(UID_A), 2);

      assert.equal(await store.touch(a1.token, env), null);
      assert.equal(await store.touch(a2.token, env), null);
      assert.ok(await store.touch(b.token, env), "kito vartotojo sesija nepaliesta");

      assert.equal(await store.destroyAllForUserId(UID_A), 0, "pakartojimas idempotentinis");
    },
  },
  {
    id: "vartotojas-pasalintas-runtime",
    kodel: "AUTH_USERS pašalinus vartotoją, sesija nutrūksta BE restarto",
    async run({ store, env }) {
      const { token } = await store.create(ADMIN, env);
      assert.ok(await store.touch(token, env));

      const beAdmin = { ...env, AUTH_USERS: `petras:operator:${SLAPTAS}:${UID_B}` };
      assert.equal(await store.touch(token, beAdmin), null, "pašalintas vartotojas nebeautentifikuoja");

      /** Fail-closed IR revokacija: grąžinus vartotoją, sesija NEATGYJA. */
      assert.equal(await store.touch(token, env), null, "revokuota sesija negali atgyti");
    },
  },
  {
    id: "auth-users-istustintas",
    kodel: "pašalinus PASKUTINĮ vartotoją, sesija su stabiliu userId nebeautentifikuoja",
    async run({ store, env }) {
      /**
       * ⚠️ REGRESIJA, KURIĄ ŠIS SCENARIJUS UŽDARO (Codex peržiūra, P1).
       *
       * Atminties backend'as tapatybės patikrą praleisdavo, kai `AUTH_USERS`
       * TUŠČIAS - t. y. būtent tada, kai atliekamas stipriausias įmanomas
       * prieigos atėmimas: pašalinamas paskutinis vartotojas. Sesija toliau
       * autentifikuodavo su savo įrašytu vardu ir role, o PostgreSQL ją
       * atmesdavo. Du backend'ai išsiskirdavo revokacijos kelyje - tiksliai
       * ten, kur skirtumo kaina didžiausia.
       *
       * Tuščias vartotojų sąrašas reiškia „tokio vartotojo nebėra", ne
       * „netikrinam".
       */
      const { token } = await store.create(ADMIN, env);
      assert.ok(await store.touch(token, env), "prielaida: sesija galioja");

      const tuscias = { ...env, AUTH_USERS: "" };
      assert.equal(
        await store.touch(token, tuscias),
        null,
        "pašalinus visus vartotojus, sesija privalo būti atmesta"
      );

      /** Ir tai loginė revokacija: grąžinus AUTH_USERS, sesija NEATGYJA. */
      assert.equal(await store.touch(token, env), null, "revokuota sesija negali atgyti");
    },
  },
  {
    id: "role-pazeminta-runtime",
    kodel: "rolės pažeminimas AUTH_USERS nutraukia sesiją su senu snapshot'u",
    async run({ store, env }) {
      const { token } = await store.create(ADMIN, env);
      assert.ok(await store.touch(token, env));

      const pazemintas = {
        ...env,
        AUTH_USERS: `admin:operator:${SLAPTAS}:${UID_A},petras:operator:${SLAPTAS}:${UID_B}`,
      };
      assert.equal(await store.touch(token, pazemintas), null, "sena rolė negali toliau autorizuoti");
    },
  },
  {
    id: "vardas-is-auth-users",
    kodel: "pervadinimas AUTH_USERS keičia vardą, bet NE tapatybę",
    async run({ store, env }) {
      const { token } = await store.create(ADMIN, env);

      const pervadintas = {
        ...env,
        AUTH_USERS: `naujasvardas:administrator:${SLAPTAS}:${UID_A},petras:operator:${SLAPTAS}:${UID_B}`,
      };
      const session = await store.touch(token, pervadintas);

      assert.ok(session, "pervadinimas nėra revokacijos priežastis");
      assert.equal(session.username, "naujasvardas", "vardas yra AUTH_USERS rodinys");
      assert.equal(session.userId, UID_A, "tapatybė nesikeičia");
    },
  },
  {
    id: "nezinomas-schema-formatas",
    kodel: "nepalaikomas schemaVersion atmetamas ir NEPRATĘSIA lango",
    async run({ store, env, nustatytiVersija, perskaityti }) {
      const { token } = await store.create(ADMIN, env);
      assert.ok(await store.touch(token, env));

      for (const bloga of [0, -1, 2]) {
        await nustatytiVersija(token, bloga);
        const priesTai = await perskaityti(token);

        assert.equal(await store.touch(token, env), null, `versija ${bloga} turėjo būti atmesta`);

        const poTo = await perskaityti(token);
        assert.equal(
          poTo.idleExpiresAt,
          priesTai.idleExpiresAt,
          "nežinomo formato eilutė neturi būti net paliesta"
        );
      }
    },
  },
  {
    id: "retencija-aktyvi-nesalinama",
    kodel: "aktyvi nepasibaigusi sesija NEŠALINAMA",
    async run({ store, env }) {
      const { token } = await store.create(ADMIN, env);
      await store.sweepExpired(env);
      assert.ok(await store.touch(token, env), "aktyvi sesija privalo išlikti");
    },
  },
  {
    id: "retencija-pasibaigusi-salinama",
    kodel: "pasibaigusi sesija šalinama, o valymas idempotentiškas",
    async run({ store, env, pastumti, arYra }) {
      const { token } = await store.create(ADMIN, env);
      await pastumti(token, { absoliutusSekundes: -5 });

      assert.equal(await store.sweepExpired(env), 1);
      assert.equal(await arYra(token), false, "pasibaigusi eilutė privalo dingti");
      assert.equal(await store.sweepExpired(env), 0, "antras paleidimas = 0 pakeitimų");
    },
  },
  {
    id: "retencija-revokuota-nepasibaigusi-nesalinama",
    kodel: "revokuota, bet dar nepasibaigusi sesija SAUGOMA iki savo expires_at",
    async run({ store, env, arYra }) {
      /**
       * ⚠️ BE ŠIO SCENARIJAUS `DELETE WHERE revoked_at IS NOT NULL` PRAEITŲ.
       *
       * Tada prarastume galimybę atsakyti, ar cookie buvo ATŠAUKTA, ar jos
       * niekada nebuvo - abu atvejai atrodytų vienodai.
       */
      const { token } = await store.create(ADMIN, env);
      assert.equal(await store.destroy(token), true);

      assert.equal(await store.sweepExpired(env), 0, "revokacija viena savaime nešalina");
      assert.equal(await arYra(token), true, "revokuota eilutė lieka iki savo expires_at");
      assert.equal(await store.touch(token, env), null, "bet ji NEAUTENTIFIKUOJA");
    },
  },
  {
    id: "retencija-revokuota-ir-pasibaigusi-salinama",
    kodel: "revokuota IR pasibaigusi sesija šalinama kartu su pasibaigusiomis",
    async run({ store, env, pastumti, arYra }) {
      const { token } = await store.create(ADMIN, env);
      assert.equal(await store.destroy(token), true);
      await pastumti(token, { absoliutusSekundes: -5 });

      assert.equal(await store.sweepExpired(env), 1);
      assert.equal(await arYra(token), false);
    },
  },
  {
    id: "retencija-neveikli-nerevokuota-salinama",
    kodel: "neveikli, bet NEREVOKUOTA sesija šalinama - kitaip pamesta cookie kauptųsi",
    async run({ store, env, pastumti, arYra }) {
      const { token } = await store.create(ADMIN, env);
      await pastumti(token, { idleSekundes: -5 });

      assert.equal(await store.sweepExpired(env), 1);
      assert.equal(await arYra(token), false);
    },
  },
];

/** Bendras vykdytojas - tas pats abiem adapteriams. */
async function paleisti(ctx, adapterName) {
  const rezultatai = [];
  for (const scenarijus of SCENARIJAI) {
    await ctx.isvalyti();
    try {
      await scenarijus.run(ctx);
      rezultatai.push({ id: scenarijus.id, ok: true });
    } catch (klaida) {
      klaida.message = `[${adapterName}] ${scenarijus.id} (${scenarijus.kodel}): ${klaida.message}`;
      throw klaida;
    }
  }
  return rezultatai;
}

/** Laikinos DB nuleidimas per atskirą admin jungtį. */
async function nuleistiDb(dbName) {
  const a = new Pool({ connectionString: adminDatabaseUrl() });
  try {
    await a.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } finally {
    await a.end();
  }
}

const ADAPTERIAI = [
  {
    name: "memory",
    skip: false,
    async setup() {
      const store = memoryStore;
      const irasas = (token) => memoryStore._getByTokenForTests(token);
      return {
        store,
        env: { ...ENV },
        isvalyti: () => memoryStore._clearForTests(),
        pastumti: async (token, { idleSekundes, absoliutusSekundes }) => {
          if (idleSekundes === undefined && absoliutusSekundes === undefined) {
            throw new Error("pastumti(): reikia bent vieno termino");
          }
          const s = irasas(token);
          if (idleSekundes !== undefined) s.idleExpiresAt = Date.now() + idleSekundes * 1000;
          if (absoliutusSekundes !== undefined) s.expiresAt = Date.now() + absoliutusSekundes * 1000;
        },
        nustatytiVersija: async (token, v) => {
          irasas(token).schemaVersion = v;
        },
        perskaityti: async (token) => {
          const s = irasas(token);
          return s && { idleExpiresAt: s.idleExpiresAt, expiresAt: s.expiresAt, revokedAt: s.revokedAt };
        },
        arYra: async (token) => irasas(token) !== null,
        cleanup: async () => memoryStore._clearForTests(),
      };
    },
  },
  {
    name: "postgres",
    skip: skipWithoutPostgres(),
    async setup() {
      /**
       * ⚠️ RESURSAI REGISTRUOJAMI IŠ KARTO PO SUKŪRIMO (#180 P2-A).
       *
       * Jei `setup()` kristų prieš grąžindamas kontekstą, kvietėjo `finally`
       * niekada neįvyktų ir jau sukurti resursai nutekėtų.
       */
      const resursai = sukurtiResursuKruva();
      try {
        const url = testDatabaseUrl("session_contract");
        const dbName = new URL(url).pathname.slice(1);
        const admin = new Pool({ connectionString: adminDatabaseUrl() });
        const uzdarytiAdmin = resursai.registruoti("admin pool", () => admin.end());
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        await admin.query(`CREATE DATABASE "${dbName}"`);
        resursai.registruoti("laikina DB", () => nuleistiDb(dbName));
        /** ⚠️ Uždaroma PER KRŪVOS RANKENĄ - kitaip `isvalyti()` uždarytų antrą kartą. */
        await uzdarytiAdmin();

        execFileSync("npx", ["node-pg-migrate", "up"], {
          cwd: path.resolve(__dirname, ".."),
          env: { ...process.env, DATABASE_URL: url },
          stdio: ["ignore", "pipe", "pipe"],
        });

        const pool = new Pool({ connectionString: url });
        resursai.registruoti("darbinis pool", () => pool.end());

        const eilute = async (token) => {
          const { rows } = await pool.query(
            `SELECT expires_at, idle_expires_at, revoked_at FROM sessions WHERE token_hash = $1`,
            [hashSessionToken(token)]
          );
          return rows[0] || null;
        };

        return {
          store: createPostgresStore(pool),
          env: { ...ENV },
          isvalyti: () => pool.query("DELETE FROM sessions"),
          /**
           * ⚠️ TERMINAI STUMIAMI DB LAIKRODŽIU (`now()`), ne `Date.now()`.
           *
           * Kitaip testas remtųsi prielaida, kad proceso ir DB laikrodžiai
           * sutampa - o ši realizacija kaip tik sąmoningai naudoja DB laiką.
           */
          pastumti: async (token, { idleSekundes, absoliutusSekundes }) => {
            /**
             * ⚠️ BE ŠIOS PATIKROS TUŠČIAS KVIETIMAS SUKURTŲ SQL, KURIS
             * `created_at` skaičiuotų iš `$1` (token maišos). Klaida ateitų iš
             * draiverio ir atrodytų kaip realizacijos, o ne testo paruošimo,
             * problema.
             */
            if (idleSekundes === undefined && absoliutusSekundes === undefined) {
              throw new Error("pastumti(): reikia bent vieno termino");
            }
            const sets = [];
            const args = [hashSessionToken(token)];
            if (idleSekundes !== undefined) {
              args.push(idleSekundes);
              sets.push(`idle_expires_at = now() + make_interval(secs => $${args.length}::double precision)`);
            }
            if (absoliutusSekundes !== undefined) {
              args.push(absoliutusSekundes);
              sets.push(`expires_at = now() + make_interval(secs => $${args.length}::double precision)`);
            }
            /**
             * ⚠️ `created_at` TRAUKIAMAS KARTU. `sessions_expires_after_created`
             * ir `sessions_idle_after_created` reikalauja, kad terminas būtų PO
             * sukūrimo; pastūmus tik terminą, constraint'as teisėtai atmestų
             * eilutę, ir testas kristų dėl paruošimo, ne dėl tikrinamo elgesio.
             */
            sets.push(`created_at = LEAST(created_at, now() + make_interval(secs => $${args.length}::double precision) - interval '1 second')`);
            await pool.query(`UPDATE sessions SET ${sets.join(", ")} WHERE token_hash = $1`, args);
          },
          nustatytiVersija: async (token, v) =>
            pool.query(`UPDATE sessions SET schema_version = $2 WHERE token_hash = $1`, [
              hashSessionToken(token),
              v,
            ]),
          perskaityti: async (token) => {
            const r = await eilute(token);
            return (
              r && {
                idleExpiresAt: r.idle_expires_at.getTime(),
                expiresAt: r.expires_at.getTime(),
                revokedAt: r.revoked_at ? r.revoked_at.getTime() : null,
              }
            );
          },
          arYra: async (token) => (await eilute(token)) !== null,
          cleanup: async () => resursai.isvalyti(),
        };
      } catch (klaida) {
        await resursai.isvalyti(klaida);
        throw klaida;
      }
    },
  },
];

for (const adapter of ADAPTERIAI) {
  test(
    `SESIJŲ KONTRAKTAS: ${adapter.name} vykdo bendrą scenarijų rinkinį`,
    { skip: adapter.skip },
    async () => {
      const ctx = await adapter.setup();
      try {
        const rezultatai = await paleisti(ctx, adapter.name);

        /**
         * ⚠️ PILNUMAS TIKRINAMAS PAGAL `id`, NE PAGAL SKAIČIŲ.
         *
         * Skaičiaus patikra praeitų pervadinus scenarijų arba pakeitus vieną
         * kitu; sąrašo palyginimas įvardija, kurio trūksta.
         */
        assert.deepEqual(
          rezultatai.map((r) => r.id),
          SCENARIJAI.map((s) => s.id),
          `${adapter.name} privalo įvykdyti VISUS bendrus scenarijus`
        );
      } finally {
        await ctx.cleanup();
      }
    }
  );
}

test("KONTRAKTAS: abu backend'ai deklaruoja tą patį viešą paviršių", () => {
  /**
   * ⚠️ SCENARIJAI TIKRINA ELGESĮ, BET NE METODO BUVIMĄ.
   *
   * Backend'as, praradęs `destroyAllForUser`, scenarijų rinkinio nesulaužytų
   * (jis šio metodo nekviečia), o `authFoundation` suderinamumo kelias
   * kristų tik atskirai. Paviršiaus paritetas tikrinamas eksplicitiškai.
   */
  const pgStore = createPostgresStore({ query: async () => ({ rows: [], rowCount: 0 }) });
  const KONTRAKTAS = [
    "create",
    "touch",
    "destroy",
    "destroyAllForUser",
    "destroyAllForUserId",
    "sweepExpired",
    "size",
    /**
     * ⚠️ NE #181 kliento kontrakto dalis, o readiness afordansas: `/api/ready`
     * kviečia jį VIENODAI abiem backend'ams, kad nereikėtų šakoti pagal
     * `backend` reikšmę - toks šakojimas palieka vieną režimą nepatikrintą.
     */
    "probe",
  ];

  for (const metodas of KONTRAKTAS) {
    assert.equal(typeof memoryStore[metodas], "function", `memory: trūksta ${metodas}`);
    assert.equal(typeof pgStore[metodas], "function", `postgres: trūksta ${metodas}`);
  }

  assert.equal(memoryStore.backend, "memory");
  assert.equal(pgStore.backend, "postgres");
});

test("KONTRAKTAS: scenarijų sąrašas yra VIENAS ir be dublikatų", () => {
  const ids = SCENARIJAI.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "dublikuotas scenarijaus id paslėptų vieną iš jų");
  assert.ok(ids.length >= 16, "rinkinys negali tyliai susitraukti");
  for (const s of SCENARIJAI) {
    assert.ok(s.kodel && s.kodel.length > 10, `${s.id}: scenarijus be paaiškinimo`);
  }
});
