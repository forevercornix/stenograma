const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Client, Pool } = require("pg");

const { skipWithoutPostgres, testDatabaseUrl, adminDatabaseUrl } = require("./helpers/postgresGuard");

const pgDumpBackup = require("../utils/pgDumpBackup");
const erasureExport = require("../utils/erasureExport");
const deploymentIdentity = require("../utils/deploymentIdentity");
const drCoordinator = require("../utils/drCoordinator");
const tombstones = require("../utils/deletionTombstones");
const auditStore = require("../utils/auditStore");
const jobErasure = require("../utils/jobErasure");
const jobStore = require("../utils/jobStore");
const sesijuPg = require("../utils/sessionStore/postgresStore");
const { hashPassword } = require("../utils/credentials");
const { pasetiKeturisStatusus } = require("./helpers/postRestoreFixtures");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * 7.6c ERASURE-SAFE ATKŪRIMAS — PILNA DR PRATYBA (#155, #250).
 *
 * ⚠️ ŠIS FAILAS VIETINĖJE APLINKOJE NEVYKDOMAS. Jam reikia tikros PostgreSQL su
 * `pg_dump`/`psql`, ir pirmą kartą jį paleis CI. Registracija `postgres`
 * rinkinyje išvedama iš `postgresGuard` importo.
 *
 * ⚠️ KĄ ĮRODO BŪTENT ŠIS FAILAS, IR KO NEĮRODO KONTRAKTINIAI TESTAI.
 *
 * `erasureExportContract` įrodo suliejimo TAISYKLĘ, `erasureReplayContract` —
 * replay ELGESĮ atminties saugyklose, `drCoordinatorContract` — SEKOS raktus.
 * Nė vienas jų negali įrodyti to, kas čia: kad po TIKRO `pg_restore` iš seno
 * snapshot'o ištrinti duomenys FIZIŠKAI grįžta, ir kad koordinatorius juos
 * pašalina antrą kartą.
 *
 * ⚠️ TARPINĖ ASERCIJA PRIEŠ SULIEJIMĄ YRA ŠIO TESTO ŠERDIS.
 *
 * Be jos testas būtų klaidingai žalias: jei snapshot'as job'o A neatkurtų (ar
 * atkurtų kartu su jo žyma), pabaigos asercijos „job'o A nėra" praeitų
 * NIEKAM nieko neįrodydamos. Todėl prieš suliejimą tikrinami ABU faktai —
 * job'as A tikslinėje bazėje YRA, o jo žymos ten NĖRA.
 */

const SALTINIO_URL = testDatabaseUrl("drsource");
const TIKSLO_URL = testDatabaseUrl("drtarget");

const VARTOTOJAS_A = "11111111-1111-4111-8111-111111111111";
const VARTOTOJAS_B = "22222222-2222-4222-8222-222222222222";

function praleisti() {
  return skipWithoutPostgres();
}

async function vykdyti(url, sql, params = []) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await c.query(sql, params);
  } finally {
    await c.end();
  }
}

async function pasalintiDb(url) {
  if (!url) return;
  const vardas = new URL(url).pathname.replace(/^\//, "");
  await vykdyti(adminDatabaseUrl(), `DROP DATABASE IF EXISTS "${vardas}" WITH (FORCE)`);
}

async function perkurtiSaltini(url) {
  const vardas = new URL(url).pathname.replace(/^\//, "");
  await vykdyti(adminDatabaseUrl(), `DROP DATABASE IF EXISTS "${vardas}" WITH (FORCE)`);
  await vykdyti(adminDatabaseUrl(), `CREATE DATABASE "${vardas}"`);
  execFileSync("npx", ["node-pg-migrate", "up"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, DATABASE_URL: url },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * ⚠️ TIKSLINĖ BAZĖ KURIAMA TUŠČIA — BE MIGRACIJŲ.
 *
 * 7.6a atkūrimas turi tuštumo preflight'ą (`pgDumpBackup`: „atkūrimas į bazę su
 * svetimu turiniu duotų dviejų bazių SĄJUNGĄ"), tad migruota bazė jo nepraeitų.
 * Iš to seka ir 7.6c konstrukcijos ašis: schemą IR `deployment_identity` eilutę
 * atneša pats dump'as, tad atkurta bazė turi ŠALTINIO diegimo tapatybę. Būtent
 * dėl to kilmės patikra tikroje avarijoje praeina tyliai.
 */
async function sukurtiTusciaDb(url) {
  const vardas = new URL(url).pathname.replace(/^\//, "");
  await vykdyti(adminDatabaseUrl(), `DROP DATABASE IF EXISTS "${vardas}" WITH (FORCE)`);
  await vykdyti(adminDatabaseUrl(), `CREATE DATABASE "${vardas}"`);
}

function testoAplinka(url) {
  return {
    ...process.env,
    DATABASE_URL: url,
    JOB_STORE_BACKEND: "postgres",
    SESSION_STORE_BACKEND: "postgres",
    AUDIT_BACKEND: "postgres",
    BACKUP_ENABLED: "true",
    BACKUP_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
  };
}

/** Aplinka pririšama prie konkrečios bazės — kitaip saugyklos dirbtų su kita. */
async function suAplinka(env, veiksmas) {
  const senas = { ...process.env };
  Object.assign(process.env, env);

  await auditStore.shutdown().catch(() => {});
  await tombstones.shutdown().catch(() => {});
  await auditStore.init(process.env);
  await tombstones.init(process.env);

  try {
    return await veiksmas();
  } finally {
    await tombstones.shutdown().catch(() => {});
    await auditStore.shutdown().catch(() => {});
    for (const raktas of Object.keys(env)) {
      if (senas[raktas] === undefined) delete process.env[raktas];
      else process.env[raktas] = senas[raktas];
    }
  }
}

async function eiluciuSkaicius(url, lentele, saStr = "", params = []) {
  const { rows } = await vykdyti(url, `SELECT count(*)::int AS n FROM ${lentele} ${saStr}`, params);
  return rows[0].n;
}

test("7.6c: DR pratyba — ištrynimas išgyvena atkūrimą iš senesnės kopijos", { timeout: 600000 }, async (t) => {
  if (praleisti()) return;

  t.after(async () => {
    await pasalintiDb(SALTINIO_URL);
    await pasalintiDb(TIKSLO_URL);
  });

  const saltinioEnv = testoAplinka(SALTINIO_URL);
  const tiksloEnv = { ...saltinioEnv, DATABASE_URL: TIKSLO_URL };

  await perkurtiSaltini(SALTINIO_URL);

  let jobai = null;
  let saltinioDeployment = null;
  let kopija = null;
  let artefaktas = null;

  await t.test("1. šaltinis pripildomas, tapatybė yra", async () => {
    await suAplinka(saltinioEnv, async () => {
      await jobStore.init(process.env);
      jobai = await pasetiKeturisStatusus(jobStore, {
        ownerId: VARTOTOJAS_A,
        storageKey: (k) => `audio/${k}.wav`,
      });

      const pool = new Pool({ connectionString: SALTINIO_URL });
      try {
        const store = sesijuPg.createPostgresStore(pool);
        for (const [userId, role, username] of [
          [VARTOTOJAS_A, "administrator", "admin"],
          [VARTOTOJAS_B, "operator", "petras"],
        ]) {
          await store.create({
            userId,
            role,
            username,
            passwordHash: hashPassword("a1"),
            expiresAt: new Date(Date.now() + 3_600_000),
          });
        }

        saltinioDeployment = await deploymentIdentity.skaitytiTapatybe(pool);
      } finally {
        await pool.end();
      }

      assert.match(saltinioDeployment, /^[0-9a-f-]{36}$/, "migracija sukūrė tapatybės eilutę");
      await jobStore.shutdown().catch(() => {});
    });
  });

  await t.test("2. kopija paimama PRIEŠ ištrynimą", async () => {
    kopija = await suAplinka(saltinioEnv, () =>
      pgDumpBackup.sukurtiSifruotaKopija({
        databaseUrl: SALTINIO_URL,
        actor: "dr-pratybos",
        env: process.env,
      })
    );

    assert.equal(kopija.manifest.encrypted, true);
  });

  await t.test("3. job'as A ištrinamas PO kopijos, žurnalas eksportuojamas", async () => {
    await suAplinka(saltinioEnv, async () => {
      await jobStore.init(process.env);

      /**
       * ⚠️ ATKARTOJAMA PRODUKCINĖ SEKA (`lifecycleService`): žyma → `eraseJob()` →
       * žymos uždarymas. Šio testo dalykas yra tai, kas vyksta PO to, tad
       * ištrynimas čia yra PARUOŠIMAS, ne tikrinamas elgesys.
       */
      const job = await jobStore.system.get(jobai.zymetas.id);
      await tombstones.mark(job.id, { reason: "user_request", actorKind: "user" });
      await jobErasure.eraseJob(job);
      await tombstones.complete(job.id, tombstones.TOMBSTONE_STATUS.DELETED, { completedAt: Date.now() });

      assert.equal(await jobStore.system.get(job.id), null, "šaltinyje job'o A nebėra");

      const pool = new Pool({ connectionString: SALTINIO_URL });
      try {
        artefaktas = erasureExport.sudarytiArtefakta({
          zymos: await tombstones.listAll(),
          horizontas: await tombstones.refreshBackupHorizon(),
          saltinis: erasureExport.saltinioTapatybe(process.env),
          deploymentId: await deploymentIdentity.skaitytiTapatybe(pool),
          env: process.env,
        });
      } finally {
        await pool.end();
      }

      assert.ok(artefaktas.envelope.ciphertext, "žurnalas šifruotas");
      assert.equal(
        JSON.stringify(artefaktas).includes(jobai.zymetas.id),
        false,
        "⚠️ `job_id` NEMATOMAS artefakte — žurnalas yra asmens duomenys"
      );

      await jobStore.shutdown().catch(() => {});
    });
  });

  await t.test("4. SENESNĖ kopija atkuriama į tuščią tikslinę bazę", async () => {
    await sukurtiTusciaDb(TIKSLO_URL);

    await pgDumpBackup.atkurtiSifruotaKopija({
      envelope: kopija.envelope,
      manifest: kopija.manifest,
      targetUrl: TIKSLO_URL,
      env: saltinioEnv,
    });
  });

  await t.test("5. TARPINĖ ASERCIJA: job'as A grįžo, o jo žymos NĖRA", async () => {
    /**
     * ⚠️ ABU FAKTAI, NE VIENAS.
     *
     * „Job'as A yra" be „žymos nėra" praeitų ir tada, jei kopija būtų paimta PO
     * ištrynimo — o tada visa procedūra neturėtų ką įrodyti. „Žymos nėra" be
     * „job'as A yra" praeitų, jei snapshot'as apskritai neatkurtų eilučių.
     */
    assert.equal(
      await eiluciuSkaicius(TIKSLO_URL, "jobs", "WHERE id = $1", [jobai.zymetas.id]),
      1,
      "ištrintas job'as GRĮŽO su senu snapshot'u — būtent šią spragą uždaro 7.6c"
    );

    assert.equal(
      await eiluciuSkaicius(TIKSLO_URL, "erasure_marks", "WHERE job_id = $1", [jobai.zymetas.id]),
      0,
      "žymos tikslinėje bazėje NĖRA: ji atsirado po kopijos"
    );

    /** Kilmės ašis: tapatybė ATKELIAVO su dump'u, tad kilmės patikra praeis. */
    const pool = new Pool({ connectionString: TIKSLO_URL });
    try {
      assert.equal(
        await deploymentIdentity.skaitytiTapatybe(pool),
        saltinioDeployment,
        "atkurta bazė turi ŠALTINIO diegimo tapatybę"
      );
    } finally {
      await pool.end();
    }
  });

  await t.test("6. svetimas žurnalas ATMETAMAS (kilmės kontrolė)", async () => {
    await suAplinka(tiksloEnv, async () => {
      const svetimas = erasureExport.sudarytiArtefakta({
        zymos: [],
        horizontas: null,
        saltinis: erasureExport.saltinioTapatybe(process.env),
        deploymentId: "99999999-9999-4999-8999-999999999999",
        env: process.env,
      });

      const pool = new Pool({ connectionString: TIKSLO_URL });
      try {
        await assert.rejects(
          () =>
            drCoordinator.patikrintiSargus({
              targetUrl: TIKSLO_URL,
              artefaktas: svetimas,
              vykdytojas: pool,
              env: process.env,
            }),
          (k) => k.code === "ERASURE_FOREIGN_LEDGER"
        );
      } finally {
        await pool.end();
      }
    });
  });

  let pirmas = null;

  await t.test("7. koordinatorius: suliejimas → replay → suderinimas → verifikacija", async () => {
    pirmas = await suAplinka(tiksloEnv, async () => {
      const pool = new Pool({ connectionString: TIKSLO_URL });
      try {
        return await drCoordinator.paleisti({
          targetUrl: TIKSLO_URL,
          artefaktas,
          vykdytojas: pool,
          actor: "dr-pratybos",
          env: process.env,
        });
      } finally {
        await pool.end();
      }
    });

    assert.deepEqual(pirmas.replay.istrinta, [jobai.zymetas.id], "job'as A ištrintas ANTRĄ kartą");
    assert.equal(pirmas.verify.suderinta, true);
  });

  await t.test("8. galinė būsena: A nebėra, B nepaliesti, sesijos revokuotos", async () => {
    assert.equal(
      await eiluciuSkaicius(TIKSLO_URL, "jobs", "WHERE id = $1", [jobai.zymetas.id]),
      0,
      "ištrynimas išgyveno atkūrimą"
    );

    assert.equal(
      await eiluciuSkaicius(TIKSLO_URL, "job_results", "WHERE job_id = $1", [jobai.zymetas.id]),
      0,
      "rezultato eilutės taip pat nebėra"
    );

    /** ⚠️ KONTROLĖ: procedūra NEIŠTRYNĖ visko. Be jos „0 eilučių" nieko neįrodo. */
    assert.equal(
      await eiluciuSkaicius(TIKSLO_URL, "jobs", "WHERE id = $1", [jobai.completed.id]),
      1,
      "nepažymėtas job'as B liko"
    );

    const zyma = await vykdyti(TIKSLO_URL, "SELECT status FROM erasure_marks WHERE job_id = $1", [
      jobai.zymetas.id,
    ]);
    assert.equal(zyma.rows[0].status, "deleted", "žyma sulieta IR uždaryta");

    assert.equal(await eiluciuSkaicius(TIKSLO_URL, "sessions"), 0, "sesijos revokuotos (7.6b)");

    assert.equal(
      await eiluciuSkaicius(TIKSLO_URL, "jobs", "WHERE status IN ('queued','processing')"),
      0,
      "neterminaliniai job'ai terminalizuoti (7.6b)"
    );

    const kvitai = await vykdyti(
      TIKSLO_URL,
      "SELECT event, count(*)::int AS n FROM audit_log WHERE event = ANY($1) GROUP BY event",
      [["ERASURE_REPLAYED", "DR_RECOVERY_COMPLETED"]]
    );
    const pagalIvyki = Object.fromEntries(kvitai.rows.map((r) => [r.event, r.n]));
    assert.equal(pagalIvyki.ERASURE_REPLAYED, 1, "vienas kvitas vienam ištrynimui");
    assert.equal(pagalIvyki.DR_RECOVERY_COMPLETED, 1, "atkūrimo faktas užfiksuotas PO visos sekos");
  });

  await t.test("9. IDEMPOTENTIŠKUMAS: antras paleidimas būsenos nekeičia", async () => {
    const priesJobai = await eiluciuSkaicius(TIKSLO_URL, "jobs");
    const priesZymos = await eiluciuSkaicius(TIKSLO_URL, "erasure_marks");

    const antras = await suAplinka(tiksloEnv, async () => {
      const pool = new Pool({ connectionString: TIKSLO_URL });
      try {
        return await drCoordinator.paleisti({
          targetUrl: TIKSLO_URL,
          artefaktas,
          vykdytojas: pool,
          actor: "dr-pratybos",
          env: process.env,
        });
      } finally {
        await pool.end();
      }
    });

    assert.deepEqual(antras.replay.istrinta, [], "trinti nebėra ko");
    assert.deepEqual(antras.replay.jauNebuvo, [jobai.zymetas.id]);

    assert.equal(await eiluciuSkaicius(TIKSLO_URL, "jobs"), priesJobai);
    assert.equal(await eiluciuSkaicius(TIKSLO_URL, "erasure_marks"), priesZymos);

    const { rows } = await vykdyti(
      TIKSLO_URL,
      "SELECT count(*)::int AS n FROM audit_log WHERE event = 'ERASURE_REPLAYED'"
    );
    assert.equal(rows[0].n, 1, "antras paleidimas antro ištrynimo kvito NERAŠO");
  });
});
