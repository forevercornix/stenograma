const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { execFileSync } = require("child_process");
const { Pool } = require("pg");

const {
  skipWithoutPostgres,
  testDatabaseUrl,
  adminDatabaseUrl,
} = require("./helpers/postgresGuard");

const auditLog = require("../utils/auditLog");
const auditStore = require("../utils/auditStore");
const tombstones = require("../utils/deletionTombstones");
const {
  LOCK_NAMESPACE,
  probeBarrierWithClient,
} = require("../utils/deletionTombstones/postgresStore");
const { createPostgresStore } = require("../utils/auditStore/postgresStore");
const { rasytiAudita, AuditWriteError } = require("../utils/auditWrite");
const { pgJungtiesNustatymai } = require("../utils/pgConnection");

/**
 * AUDITO IŠTRYNIMO GALUTINUMAS — ATOMIŠKUMAS IR RAW ĮRODYMAS (#155, 7.4e / #216).
 *
 * ⚠️ TIKRA PostgreSQL BŪTINA. Čia tikrinama tai, ko negalima patikrinti mock'u:
 * `pg_advisory_xact_lock` serializacija tarp audito `INSERT` ir `erasure_marks`
 * žymos, ir eilučių NEBUVIMAS lentelėje po ištrynimo.
 *
 * ⚠️ GALUTINIS ĮRODYMAS PER RAW `SELECT`, NE `getAll()`.
 *
 * Filtruojanti realizacija (`getAll()`, kuris praleidžia pažymėtus subjektus)
 * praeitų kiekvieną fasado patikrą, o našlaitės eilutės liktų DB. Todėl
 * kiekvienas scenarijus baigiasi tiesiogine užklausa į `audit_log`.
 *
 * Elgsenos keliai (ALLOW / BLOCK / CHECK FAILED, inline subjektas, HTTP
 * atvaizdavimas) gyvena `auditErasureFinality.test.js` — jiems DB nereikia.
 */

const DB_URL = testDatabaseUrl("audit-finality");
const DRUSKA = "7f3a9c1e5b2d4a6f8c0e1d3b5a7f9c2e4d6b8a0c2e4f6a8c0e2d4b6a8f0c2e4d";
const DRUSKOS_ID = "2026-09";

async function vykdyti(url, sql) {
  const p = new Pool({ connectionString: url });
  try {
    await p.query(sql);
  } finally {
    await p.end();
  }
}

/**
 * Laukia, kol KAŽKAS realiai laukia advisory lock'o.
 *
 * ⚠️ NE `sleep`. Testas turi būti deterministinis: lenktynių įrodymas, remiantis
 * laiku, praeitų ir tada, kai serializacijos nėra. `pg_locks` rodo FAKTĄ - lock'o
 * prašoma ir jis dar nesuteiktas.
 */
async function laukiantUzrakto(pool, kiekMs = 5000) {
  const iki = Date.now() + kiekMs;

  while (Date.now() < iki) {
    const { rows } = await pool.query(
      "SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted LIMIT 1"
    );
    if (rows.length) return true;
    await new Promise((r) => setTimeout(r, 20));
  }

  throw new Error("audito rašymas taip ir nepradėjo laukti advisory lock'o - serializacijos nėra");
}

test("auditErasureFinality", { skip: skipWithoutPostgres() }, async (t) => {
  const vardas = new URL(DB_URL).pathname.replace(/^\//, "");

  await vykdyti(adminDatabaseUrl(), `DROP DATABASE IF EXISTS "${vardas}" WITH (FORCE)`);
  await vykdyti(adminDatabaseUrl(), `CREATE DATABASE "${vardas}"`);

  execFileSync("npx", ["node-pg-migrate", "up"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, DATABASE_URL: DB_URL },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const aplinka = {
    AUDIT_BACKEND: "postgres",
    DATABASE_URL: DB_URL,
    AUDIT_ID_SALT: DRUSKA,
    AUDIT_ID_SALT_ID: DRUSKOS_ID,
  };

  await auditStore.shutdown().catch(() => {});
  await tombstones.shutdown().catch(() => {});
  await auditStore.init(aplinka);
  await tombstones.init(aplinka);

  /** Nepriklausoma jungtis — RAW įrodymui ir antrai „instancijai". */
  const rawPool = new Pool({ connectionString: DB_URL });

  t.after(async () => {
    await rawPool.end().catch(() => {});
    await auditStore.shutdown().catch(() => {});
    await tombstones.shutdown().catch(() => {});
    await vykdyti(adminDatabaseUrl(), `DROP DATABASE IF EXISTS "${vardas}" WITH (FORCE)`);
  });

  t.beforeEach(async () => {
    await rawPool.query("TRUNCATE audit_log, erasure_marks");
  });

  /** RAW: kiek eilučių lentelėje priklauso šiam subjektui? */
  async function rawKiek(jobId) {
    const { rows } = await rawPool.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE subject_id = $1",
      [auditLog.pseudonymizeIdentifier(jobId)]
    );
    return rows[0].n;
  }

  /* ── Scenarijus A ─────────────────────────────────────────────────────── */

  await t.test(
    "#216 A: rašymas pradeda patikrą → erasure LAIMI → vėluojantis rašymas atmetamas → RAW eilutės NĖRA",
    async () => {
      const jobId = "scenarijus-a";

      /**
       * ⚠️ ŽYMOS TRANSAKCIJA IMITUOJAMA TIESIOGIAI, IR TAI SĄMONINGA.
       *
       * `tombstones.mark()` ima TĄ PATĮ advisory lock'ą. Iškvietus jį iš šio
       * proceso, kol lock'as laikomas, abu laukty vienas kito - deadlock, ne
       * lenktynės. Todėl testas pats vaidina lygiagrečią žymėjimo transakciją:
       * ima lock'ą, įrašo eilutę, commit'ina.
       *
       * ⚠️ TIKRINAMA BARJERO SKAITYMO PUSĖ, kuri eina per 7.5a
       * `assertNotBarredWithClient()` - ad-hoc SQL čia yra ĮVESTIS, ne patikra.
       */
      const zymetojas = await rawPool.connect();

      let auditoRezultatas;

      try {
        await zymetojas.query("BEGIN");
        await zymetojas.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [
          LOCK_NAMESPACE,
          jobId,
        ]);

        /** Audito rašymas pradeda savo transakciją ir SUSTOJA ties tuo pačiu lock'u. */
        const rasymas = rasytiAudita({
          event: "EXPORT_COMPLETED",
          jobId,
          success: true,
          format: "docx",
          outcome: "delivered",
        });

        await laukiantUzrakto(rawPool);

        /** Erasure laimi: žyma įrašoma ir commit'inama, kol rašymas laukia. */
        await zymetojas.query(
          `INSERT INTO erasure_marks (job_id, status, reason, actor_kind)
           VALUES ($1, 'deletion_pending', 'user_request', 'user')`,
          [jobId]
        );
        await zymetojas.query("COMMIT");

        auditoRezultatas = await rasymas;
      } finally {
        await zymetojas.query("ROLLBACK").catch(() => {});
        zymetojas.release();
      }

      /**
       * `EXPORT_COMPLETED` yra NE-BLOKUOJANTIS: operacija tęsiasi, bet eilutės
       * nėra. Būtent tai #216 ir reikalauja - eksportas pristatomas, o subjektui
       * susieta eilutė po ištrynimo NEATSIRANDA.
       */
      assert.equal(auditoRezultatas, null, "užblokuotas rašymas negali grąžinti eilutės");
      assert.equal(await rawKiek(jobId), 0, "RAW DB: subjektui susietos eilutės būti negali");
    }
  );

  await t.test("#216 A': blokuojantis įvykis po žymos ATMETA operaciją", async () => {
    const jobId = "scenarijus-a-blok";

    await tombstones.mark(jobId);

    await assert.rejects(
      () =>
        rasytiAudita({
          event: "ADMIN_DELETE_OVERRIDE",
          jobId,
          success: true,
          details: "sintetinis blokuojantis kelias",
        }),
      (klaida) => {
        assert.ok(klaida instanceof AuditWriteError);
        assert.equal(klaida.code, "AUDIT_WRITE_BLOCKED");
        return true;
      }
    );

    assert.equal(await rawKiek(jobId), 0);
  });

  /* ── Scenarijus B ─────────────────────────────────────────────────────── */

  await t.test(
    "#216 B: rašymas commit'inasi PRIEŠ barjerą → erasure jį pašalina → RAW eilutės NĖRA",
    async () => {
      const jobId = "scenarijus-b";

      await rasytiAudita({
        event: "EXPORT_STARTED",
        jobId,
        success: true,
        format: "docx",
        outcome: "started",
      });

      assert.equal(await rawKiek(jobId), 1, "teisėtai įrašyta eilutė turi egzistuoti");

      /** Ištrynimas: žyma + audito subjekto šalinimas - ta pati tvarka kaip `jobErasure`. */
      await tombstones.mark(jobId);
      await auditLog.removeBySubjectIdentifier(jobId);
      await tombstones.complete(jobId, "deleted");

      assert.equal(await rawKiek(jobId), 0, "RAW DB: po ištrynimo eilučių likti negali");

      /** Ir vėluojantis rašymas jos nebeatkuria. */
      await rasytiAudita({
        event: "EXPORT_COMPLETED",
        jobId,
        success: true,
        format: "docx",
        outcome: "delivered",
      });

      assert.equal(await rawKiek(jobId), 0, "vėluojantis rašymas NEGALI atkurti subjekto");
    }
  );

  /* ── Scenarijus C ─────────────────────────────────────────────────────── */

  await t.test(
    "#216 C: DVI nepriklausomos instancijos - viena trina, kita rašo - invariantas galioja",
    async () => {
      const jobId = "scenarijus-c";

      /**
       * ⚠️ ANTRA INSTANCIJA, NE ANTRA UŽKLAUSA. Barjeras negali būti procesui
       * lokalus: `createPostgresStore` su SAVO pool'u yra tas pats, kas antras
       * servisas prieš tą pačią DB.
       */
      const antrasPool = new Pool({ connectionString: DB_URL });
      const antraInstancija = createPostgresStore(antrasPool, {
        hashKeyId: DRUSKOS_ID,
        readinessBudgetMs: 2000,
      });

      try {
        /** Instancija A: ištrynimas. */
        await tombstones.mark(jobId);
        await auditLog.removeBySubjectIdentifier(jobId);
        await tombstones.complete(jobId, "deleted");

        /** Instancija B: rašo tam pačiam subjektui per SAVO pool'ą. */
        await assert.rejects(
          () =>
            antraInstancija.append(
              {
                id: "11111111-2222-4333-8444-555555555555",
                event: "EXPORT_COMPLETED",
                subjectId: auditLog.pseudonymizeIdentifier(jobId),
                result: "success",
                requestId: null,
                outcome: "delivered",
              },
              { jobId }
            ),
          (klaida) => klaida.code === "ERASURE_BARRIER",
          "antra instancija privalo matyti tą patį barjerą"
        );

        assert.equal(await rawKiek(jobId), 0, "RAW DB: multi-instance galutinumas");
      } finally {
        await antrasPool.end().catch(() => {});
      }
    }
  );

  /* ── `PG*` konfigūracija (§5 P1 šaka) ─────────────────────────────────── */

  await t.test(
    "#216 `PG*`: pool'as BE `DATABASE_URL` realiai pasiekia `erasure_marks`",
    async () => {
      /**
       * ⚠️ ŠI ŠAKA IKI ŠIOL BUVO DENGTA TIK VIENETINIAIS TESTAIS.
       *
       * `ci.yml` PostgreSQL žingsnis nustato `DATABASE_URL`, tad
       * `pasirinktiBackend()` `PGHOST` šaka - pataisa, uždariusi §5 P1 - prieš
       * TIKRĄ duomenų baze niekada nebuvo vykdoma. O būtent dėl jos visa §5 ir
       * daryta: dokumentuotas Compose diegimas naudoja `PG*`, ne URL.
       *
       * ⚠️ `DATABASE_URL` ČIA SĄMONINGAI NEPERDUODAMAS. Konfigūracija sudaroma
       * IŠSKAIDANT tą patį URL į `PG*` komponentes, tad jungiamasi prie tos
       * pačios, jau migruotos bazės, bet KITU konfigūracijos formatu - tuo,
       * kurio produkcija ir naudoja.
       */
      const u = new URL(DB_URL);

      const pgEnv = { PGHOST: u.hostname, PGPORT: u.port || "5432" };
      if (u.username) pgEnv.PGUSER = decodeURIComponent(u.username);
      if (u.password) pgEnv.PGPASSWORD = decodeURIComponent(u.password);
      pgEnv.PGDATABASE = u.pathname.replace(/^\//, "");

      assert.equal("DATABASE_URL" in pgEnv, false, "prielaida: URL formos čia nėra");
      assert.equal(
        tombstones.pasirinktiBackend(pgEnv),
        "postgres",
        "`PG*` privalo reikšti PostgreSQL - be to barjeras skaitytų tuščią lentelę"
      );

      const nustatymai = pgJungtiesNustatymai(pgEnv);
      assert.equal("connectionString" in nustatymai, false, "dvi formos kartu - neakivaizdi pirmenybė");

      const pgPool = new Pool(nustatymai);

      try {
        assert.equal(
          await probeBarrierWithClient(pgPool),
          true,
          "iš `PG*` sudarytas pool'as privalo realiai pasiekti `erasure_marks`"
        );
      } finally {
        await pgPool.end().catch(() => {});
      }
    }
  );

  /* ── Privatumas ───────────────────────────────────────────────────────── */

  await t.test("#216 PRIVATUMAS: transientinis `job_id` NEPERSISTINAMAS jokiame stulpelyje ar `meta`", async () => {
    /**
     * ⚠️ RAW, VISI STULPELIAI IR `meta::text`.
     *
     * Barjerui reikia PLIKO `job_id`, ir jis keliauja į `append()` antru
     * argumentu. Šis testas įrodo, kad jis ten ir lieka: nei `subject_id`
     * (pseudonimas), nei `meta` JSONB jo neturi.
     */
    const jobId = "privatumo-zondas-9f2c4e7a";

    await rasytiAudita({
      event: "EXPORT_COMPLETED",
      jobId,
      success: true,
      format: "docx",
      outcome: "delivered",
      details: `bytes=1234`,
    });

    const { rows } = await rawPool.query(
      "SELECT to_jsonb(a)::text AS visa FROM audit_log a WHERE subject_id = $1",
      [auditLog.pseudonymizeIdentifier(jobId)]
    );

    assert.equal(rows.length, 1, "eilutė turi egzistuoti - kitaip testas nieko netikrina");
    assert.equal(
      rows[0].visa.includes(jobId),
      false,
      "plikas job ID neturi patekti nė į vieną stulpelį ar `meta` lauką"
    );
  });

  await t.test("#216 PRIVATUMAS: `erasure_marks` žyma neatsiranda `audit_log` eilutėje", async () => {
    const jobId = "zymos-zondas-3b8d";

    await tombstones.mark(jobId);

    /** Nesusietas įvykis praeina - barjeras jam netaikomas. */
    await rasytiAudita({ event: "LOGIN_SUCCESS", success: true });

    const { rows } = await rawPool.query("SELECT to_jsonb(a)::text AS visa FROM audit_log a");
    for (const r of rows) {
      assert.equal(r.visa.includes(jobId), false, "žymos raktas negali nutekėti į auditą");
    }
  });
});
