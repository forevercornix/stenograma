const test = require("node:test");
const assert = require("node:assert/strict");
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
const { createPostgresStore } = require("../utils/jobStore/postgresStore");
const erasureReplay = require("../utils/erasureReplay");
const restoredJobStore = require("../utils/restoredJobStore");
const sesijuPg = require("../utils/sessionStore/postgresStore");
const { pasetiKeturisStatusus } = require("./helpers/postRestoreFixtures");
/**
 * ⚠️ APLINKA IMAMA IŠ BENDRO HELPERIO, NE APRAŠOMA ČIA.
 *
 * Ją tikrina `drRestorePreconditions` VIETOJE, prieš nepasiekiamą bazę: trys CI
 * raundai iš eilės krito ne ties elgesiu, o ties šia aplinka. Kopija reikštų,
 * kad vietinė patikra gina nebe tą aplinką, kurią naudoja šis failas.
 */
const { testoAplinka, auditoLaukas } = require("./helpers/drRestoreEnv");
const { suSugadintuAuditu } = require("./helpers/auditStoreSeam");
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
  let sesijuTokenai = [];
  let saltinioDeployment = null;
  let kopija = null;
  let artefaktas = null;

  await t.test("1. šaltinis pripildomas, tapatybė yra", async () => {
    await suAplinka(saltinioEnv, async () => {
      const pool = new Pool({ connectionString: SALTINIO_URL });
      try {
        jobai = await pasetiKeturisStatusus(createPostgresStore(pool), {
          ownerId: VARTOTOJAS_A,
          storageKey: (k) => `audio/${k}.wav`,
        });

        const store = sesijuPg.createPostgresStore(pool);
        for (const [userId, role, username] of [
          [VARTOTOJAS_A, "administrator", "admin"],
          [VARTOTOJAS_B, "operator", "petras"],
        ]) {
          const sesija = await store.create({ id: userId, role, username }, process.env);
          sesijuTokenai.push(sesija.token);
        }

        saltinioDeployment = await deploymentIdentity.skaitytiTapatybe(pool);
      } finally {
        await pool.end();
      }

      assert.match(saltinioDeployment, /^[0-9a-f-]{36}$/, "migracija sukūrė tapatybės eilutę");
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
      const pool = new Pool({ connectionString: SALTINIO_URL });
      try {
        /**
         * ⚠️ ATKARTOJAMA PRODUKCINĖ SEKA (`lifecycleService`): žyma → `eraseJob()` →
         * žymos uždarymas. Šio testo dalykas yra tai, kas vyksta PO to, tad
         * ištrynimas čia yra PARUOŠIMAS, ne tikrinamas elgesys.
         */
        const saugykla = restoredJobStore.sukurti(pool);
        const job = await saugykla.system.get(jobai.zymetas.id);
        await tombstones.mark(job.id, { reason: "user_request", actorKind: "user" });
        await jobErasure.eraseJob(job, { store: saugykla });
        await tombstones.complete(job.id, tombstones.TOMBSTONE_STATUS.DELETED, { completedAt: Date.now() });

        assert.equal(await saugykla.system.get(job.id), null, "šaltinyje job'o A nebėra");

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

  await t.test("6a. KONTROLĖ: replay per FASADĄ atkurtos eilutės NEPAŠALINA", async () => {
    /**
     * ⚠️ BE ŠIOS PUSĖS 7 ŽINGSNIS ĮRODYTŲ TIK TIEK, KAD NAUJAS KELIAS VEIKIA.
     *
     * 7.2a barjeras job'ų autoritetu palieka atmintį arba Redis, tad replay be
     * nukreiptos saugyklos atkurtos bazės NELIEČIA — ir vis tiek UŽDARO žymą bei
     * įrašo kvitą. „Sėkmė paskelbta, duomenys liko" yra tiksliai tas vakuumas,
     * dėl kurio saugykla DR kelyje privaloma. Šis žingsnis jį parodo, o ne
     * aprašo.
     */
    const zurnalas = erasureExport.perskaitytiArtefakta({
      envelope: artefaktas.envelope,
      manifest: artefaktas.manifest,
      env: saltinioEnv,
    });

    const vakuumas = await suAplinka(tiksloEnv, () =>
      erasureReplay.replay({ zymos: zurnalas.zymos, actor: "kontrole" })
    );

    assert.deepEqual(vakuumas.istrinta, [], "fasadas atkurtų eilučių nemato");
    assert.equal(
      await eiluciuSkaicius(TIKSLO_URL, "jobs", "WHERE id = $1", [jobai.zymetas.id]),
      1,
      "⚠️ eilutė LIKO: replay per fasadą būtų buvęs vakuumas"
    );
  });

  await t.test("6b. GEDIMO SKLIDIMAS: replay klaida sustabdo VISKĄ po jos", async () => {
    /**
     * ⚠️ KLAIDA ĮLEIDŽIAMA PO SĖKMINGO MERGE, NE ANKSČIAU.
     *
     * Sargai ir suliejimas privalo praeiti — kitaip testas įrodytų tik tiek, kad
     * fail-closed veikia ties ĮĖJIMU, o DoD reikalauja būtent sklidimo: replay
     * krito, vadinasi sesijos, job'ai, verifikacija ir cutover NEĮVYKO.
     *
     * Gedimas tikras, ne dirbtinis: `ERASURE_REPLAYED` yra BLOKUOJANTIS, tad
     * nepasiekiama audito saugykla ištrynimo nepatvirtina. Realizacija, kuri
     * tokią klaidą pagautų ir tęstų, praeitų visus kitus testus.
     */
    const priesSesijos = await eiluciuSkaicius(TIKSLO_URL, "sessions", "WHERE revoked_at IS NULL");
    const priesNeterminaliniai = await eiluciuSkaicius(
      TIKSLO_URL,
      "jobs",
      "WHERE status IN ('queued','processing')"
    );
    assert.ok(priesSesijos > 0 && priesNeterminaliniai > 0, "kontrolė: yra ką prarasti");

    /**
     * ⚠️ AUKA — KITAS JOB'AS, NE A.
     *
     * Replay šalina PIRMA, o kvitą rašo PO to, tad nepavykęs kvitas job'o
     * nebegrąžina. Panaudojus A, 7 žingsnis nebeturėtų ko replay'inti, ir pilna
     * seka liktų neįrodyta. Todėl gedimui naudojamas atskiras žurnalas su VIENA
     * žyma — `failed` job'ui, kurio nemato nė viena kita asercija.
     */
    const gedimoArtefaktas = await suAplinka(saltinioEnv, async () => {
      const pool = new Pool({ connectionString: SALTINIO_URL });
      try {
        await tombstones.mark(jobai.failed.id, { reason: "user_request", actorKind: "user" });
        const tik = (await tombstones.listAll()).filter((z) => z.jobId === jobai.failed.id);
        assert.equal(tik.length, 1, "žurnale — lygiai viena žyma");

        return erasureExport.sudarytiArtefakta({
          zymos: tik,
          horizontas: await tombstones.refreshBackupHorizon(),
          saltinis: erasureExport.saltinioTapatybe(process.env),
          deploymentId: await deploymentIdentity.skaitytiTapatybe(pool),
          env: process.env,
        });
      } finally {
        await pool.end();
      }
    });

    await suAplinka(tiksloEnv, async () => {
      const pool = new Pool({ connectionString: TIKSLO_URL });
      try {
        await assert.rejects(
          () =>
            suSugadintuAuditu(
              () =>
                drCoordinator.paleisti({
                  targetUrl: TIKSLO_URL,
                  artefaktas: gedimoArtefaktas,
                  vykdytojas: pool,
                  actor: "gedimo-testas",
                  env: process.env,
                }),
              { tikIvykiui: erasureReplay.AUDITO_IVYKIS }
            ),
          (k) => k.code === "DR_REPLAY_FAILED",
          "replay nesėkmė privalo nutraukti seką"
        );
      } finally {
        await pool.end();
      }
    });

    /** MERGE ĮVYKO — klaida tikrai buvo PO jo, ne prieš. */
    assert.equal(
      await eiluciuSkaicius(TIKSLO_URL, "erasure_marks", "WHERE job_id = $1", [jobai.failed.id]),
      1,
      "žyma sulieta: gedimas įleistas po sėkmingo merge"
    );

    /**
     * ⚠️ IR ŽYMA LIKO ATVIRA. Tai ne šalutinis efektas, o konstrukcija: kvitas
     * rašomas PRIEŠ uždarymą, tad nepatvirtintas ištrynimas lieka pakartojamas.
     */
    const zyma = await vykdyti(TIKSLO_URL, "SELECT status FROM erasure_marks WHERE job_id = $1", [
      jobai.failed.id,
    ]);
    assert.notEqual(zyma.rows[0].status, "deleted", "nepatvirtintas ištrynimas žymos NEUŽDARO");

    /** A NEPALIESTAS: gedimas nesuėdė 7 žingsnio dalyko. */
    assert.equal(
      await eiluciuSkaicius(TIKSLO_URL, "jobs", "WHERE id = $1", [jobai.zymetas.id]),
      1,
      "job'as A tebėra — jo žurnalo šis žingsnis nelietė"
    );

    /** IR NIEKAS PO REPLAY NEĮVYKO. */
    assert.equal(
      await eiluciuSkaicius(TIKSLO_URL, "sessions", "WHERE revoked_at IS NULL"),
      priesSesijos,
      "sesijos NEREVOKUOTOS — suderinimas nepasiektas"
    );
    assert.equal(
      await eiluciuSkaicius(TIKSLO_URL, "jobs", "WHERE status IN ('queued','processing')"),
      priesNeterminaliniai,
      "job'ai NETERMINALIZUOTI — suderinimas nepasiektas"
    );
    assert.equal(
      await eiluciuSkaicius(TIKSLO_URL, "audit_log", "WHERE event = 'DR_RECOVERY_COMPLETED'"),
      0,
      "atkūrimas NEDEKLARUOTAS"
    );
    assert.equal(
      await eiluciuSkaicius(TIKSLO_URL, "audit_log", "WHERE event = 'POST_RESTORE_RECONCILED'"),
      0,
      "7.6b suderinimas net neprasidėjo"
    );

    /**
     * ⚠️ ATSTATYMAS — PO SKLIDIMO ASERCIJŲ, NE PRIEŠ JAS.
     *
     * Pirmoji redakcija jį įterpė anksčiau, ir CI parodė `expected 2, actual 0`:
     * sesijas revokavo šis PAVYKĘS paleidimas, o asercija skaitė tai kaip įrodymą,
     * kad sklidimas neveikia. Testo tvarka yra jo teiginio dalis — matuoti reikia
     * TOJE būsenoje, apie kurią kalbama.
     *
     * ⚠️ GEDIMAS ATSTATOMAS PAKARTOJIMU — IR TAI TIKRINAMA, NE NUMANOMA.
     *
     * Atvira žyma NĖRA nekaltas likutis: `patikrinti()` ją mato ir cutover'į
     * BLOKUOJA (`DR_VERIFICATION_FAILED`). CI tai ir parodė — 7 žingsnis krito su
     * „neuždarytų žymų 1", nors pats replay pavyko. Sargas teisus: nepatvirtinto
     * ištrynimo negalima praleisti pro šalį.
     *
     * Iš to seka operatoriaus taisyklė, kurios anksčiau nebuvo užrašyta: po
     * nepavykusio paleidimo procedūra kartojama su TUO PAČIU žurnalu — kitas
     * žurnalas tos žymos neuždarys, nes jos jame nėra.
     */
    await suAplinka(tiksloEnv, async () => {
      const pool = new Pool({ connectionString: TIKSLO_URL });
      try {
        const atstatymas = await drCoordinator.paleisti({
          targetUrl: TIKSLO_URL,
          artefaktas: gedimoArtefaktas,
          vykdytojas: pool,
          actor: "gedimo-testas",
          env: process.env,
        });

        assert.deepEqual(atstatymas.replay.uzdarytosZymos, [jobai.failed.id], "žyma uždaryta");
        assert.equal(atstatymas.verify.suderinta, true, "cutover vėl leidžiamas");
      } finally {
        await pool.end();
      }
    });

    const poAtstatymo = await vykdyti(
      TIKSLO_URL,
      "SELECT status FROM erasure_marks WHERE job_id = $1",
      [jobai.failed.id]
    );
    assert.equal(poAtstatymo.rows[0].status, "deleted", "pakartojimas žymą uždarė");
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

    /**
     * ⚠️ REVOKACIJA STATO `revoked_at`, EILUČIŲ NETRINA (7.6b).
     *
     * Pirmoji šio testo redakcija tikrino `count(*) = 0` ir CI'uje krito su
     * `2 !== 0` — asercija buvo neteisinga, ne kodas: ištrynus eilutes dingtų
     * pėdsakas, kurios sesijos apskritai egzistavo.
     *
     * Tikrinami ABU dydžiai: aktyvių NĖRA, ir sesijų APSKRITAI buvo — kitaip
     * „nė vienos aktyvios" praeitų ir tuščioje lentelėje.
     */
    assert.ok(await eiluciuSkaicius(TIKSLO_URL, "sessions") > 0, "sesijų buvo, ką revokuoti");
    assert.equal(
      await eiluciuSkaicius(TIKSLO_URL, "sessions", "WHERE revoked_at IS NULL"),
      0,
      "nė viena sesija nelieka aktyvi (7.6b)"
    );

    /**
     * ⚠️ TIKRINAMAS ELGESYS, NE TIK STULPELIS.
     *
     * `revoked_at IS NOT NULL` yra būsena; DoD reikalauja, kad SENAS COOKIE
     * NEBEAUTENTIKUOTŲ. Tai skirtingi teiginiai: revokacija, kurios `touch()`
     * nepaiso, praeitų pirmąjį ir neapsaugotų nieko.
     */
    assert.ok(sesijuTokenai.length > 0, "kontrolė: tokenai išsaugoti");
    await suAplinka(tiksloEnv, async () => {
      const pool = new Pool({ connectionString: TIKSLO_URL });
      try {
        const store = sesijuPg.createPostgresStore(pool);
        for (const token of sesijuTokenai) {
          assert.equal(
            await store.touch(token, process.env),
            null,
            "senas cookie po atkūrimo nebeautentifikuoja"
          );
        }
      } finally {
        await pool.end();
      }
    });

    assert.equal(
      await eiluciuSkaicius(TIKSLO_URL, "jobs", "WHERE status IN ('queued','processing')"),
      0,
      "neterminaliniai job'ai terminalizuoti (7.6b)"
    );

    /**
     * ⚠️ SKAIČIUOJAMA PAGAL `outcome`, NE BENDRAI.
     *
     * 6a kontrolė paliko `erasure_confirmed` kvitą — tai jos radinio dalis, ne
     * triukšmas. Realių ištrynimų kvitas yra `erasure_replayed`, ir jų privalo
     * būti lygiai vienas.
     */
    const kvitai = await vykdyti(
      TIKSLO_URL,
      `SELECT event, ${auditoLaukas("outcome")} AS outcome, count(*)::int AS n ` +
        `FROM audit_log WHERE event = ANY($1) GROUP BY event, ${auditoLaukas("outcome")}`,
      [["ERASURE_REPLAYED", "DR_RECOVERY_COMPLETED"]]
    );
    const pagal = Object.fromEntries(kvitai.rows.map((r) => [`${r.event}:${r.outcome}`, r.n]));
    assert.equal(pagal["ERASURE_REPLAYED:erasure_replayed"], 1, "vienas kvitas vienam ištrynimui");
    /**
     * ⚠️ DU ĮRAŠAI, NE VIENAS: 6b atstatymo paleidimas ir šis. Kiekvienas
     * `DR_RECOVERY_COMPLETED` atitinka VIENĄ pilnai praėjusią seką — nepavykęs
     * 6b bandymas savo įrašo neturi, ir būtent tai tikrinama aukščiau.
     */
    assert.equal(
      kvitai.rows.filter((r) => r.event === "DR_RECOVERY_COMPLETED").reduce((a, r) => a + r.n, 0),
      2,
      "po vieną įrašą kiekvienai SĖKMINGAI sekai"
    );
  });

  /**
   * ⚠️ D5 LYGINA BŪSENĄ, NE `COUNT(*)` (Codex, #288).
   *
   * Skaičiai nepasikeistų ir tada, jei pakartojimas perrašytų rezultatą, pakeistų
   * job'o statusą, atvertų žymą ar pastumtų kopijų horizontą. Tad imamas turinys:
   * job'ų statusai ir fazės, rezultatų raktai, VISI žymų stulpeliai (jie
   * importuojami deterministiškai — `updated_at = EXCLUDED.updated_at`), sesijų
   * revokacijos laikas ir horizontas.
   */
  async function busenosPjuvis() {
    const uzklausos = {
      jobs: "SELECT id, status, phase FROM jobs ORDER BY id",
      job_results: "SELECT job_id FROM job_results ORDER BY job_id",
      erasure_marks:
        "SELECT job_id, status, reason, actor_kind, marked_at, updated_at, completed_at, " +
        "attempts, last_failure_kind, claim_token FROM erasure_marks ORDER BY job_id",
      sessions: "SELECT id, user_id, revoked_at FROM sessions ORDER BY id",
      backup_horizon: "SELECT * FROM backup_horizon",
    };

    const pjuvis = {};
    for (const [vardas, sql] of Object.entries(uzklausos)) {
      const { rows } = await vykdyti(TIKSLO_URL, sql);
      pjuvis[vardas] = rows;
    }
    return pjuvis;
  }

  await t.test("9. IDEMPOTENTIŠKUMAS: antras paleidimas būsenos nekeičia", async () => {
    const priesBusena = await busenosPjuvis();
    const priesJobai = await eiluciuSkaicius(TIKSLO_URL, "jobs");
    const priesZymos = await eiluciuSkaicius(TIKSLO_URL, "erasure_marks");

    /** KONTROLĖ: pjūvis tikrai kažką mato — tuščias palyginimas nieko neįrodytų. */
    assert.ok(priesBusena.jobs.length > 0, "job'ų yra");
    assert.ok(priesBusena.erasure_marks.length > 0, "žymų yra");
    assert.ok(priesBusena.sessions.length > 0, "sesijų yra");

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

    assert.deepEqual(
      await busenosPjuvis(),
      priesBusena,
      "persistentinė būsena po antro paleidimo privalo SUTAPTI, ne tik sutapti skaičiais"
    );

    const { rows } = await vykdyti(
      TIKSLO_URL,
      "SELECT count(*)::int AS n FROM audit_log WHERE event = 'ERASURE_REPLAYED' " +
        `AND ${auditoLaukas("outcome")} = 'erasure_replayed'`
    );
    assert.equal(rows[0].n, 1, "antras paleidimas antro ištrynimo kvito NERAŠO");
  });

  await t.test("10. PASENĘS ŽURNALAS `PRIVACY_MODE`: patvirtinimas veda iki `verify`", async () => {
    /**
     * ⚠️ TEIGIAMAS OVERRIDE KELIAS PER TIKRĄ SEKĄ (Codex, #288).
     *
     * Kontraktinis testas įrodo tik ARGUMENTO PERDAVIMĄ (jis dirba su nepasiekiama
     * baze). Čia tikrinama tai, dėl ko ta šaka apskritai egzistuoja: `PRIVACY_MODE`
     * diegimas su pasenusiu žurnalu privalo turėti kelią, kuris BAIGIASI —
     * suliejimu, replay, suderinimu ir `verify`.
     *
     * Be šio žingsnio būtų padengtos tik atmetimo pusės, o kelias, dėl kurio jos
     * egzistuoja, liktų neįrodytas.
     */
    const pasenesEnv = {
      ...tiksloEnv,
      PRIVACY_MODE: "true",
      /** Kiekvienas žurnalas iškart pasenęs — laikrodžio žaidimų nereikia. */
      ERASURE_EXPORT_MAX_AGE_MS: "1",
    };

    await suAplinka(pasenesEnv, async () => {
      const pool = new Pool({ connectionString: TIKSLO_URL });
      try {
        const bendri = {
          targetUrl: TIKSLO_URL,
          artefaktas,
          vykdytojas: pool,
          actor: "pasenusio-testas",
          env: process.env,
        };

        /** (a) BE `--allow-stale` — sustoja ties šviežumo riba. */
        await assert.rejects(
          () => drCoordinator.paleisti(bendri),
          (k) => k.code === "DR_LEDGER_STALE",
          "pasenęs žurnalas sustabdo atkūrimą"
        );

        /** (b) Su vėliava, BET be patvirtinimo — `PRIVACY_MODE` reikalauja pėdsako. */
        await assert.rejects(
          () => drCoordinator.paleisti({ ...bendri, leistiPasenusi: true }),
          (k) => k.code === "DR_STALE_OVERRIDE_UNCONFIRMED",
          "audito įrašas slopinamas, tad reikia patvirtinimo reikšmėmis"
        );

        /** (c) Su teisingu patvirtinimu — seka nueina IKI GALO. */
        const sargai = await drCoordinator.patikrintiSargus({
          targetUrl: TIKSLO_URL,
          artefaktas,
          vykdytojas: pool,
          env: process.env,
          leistiPasenusi: true,
        });

        const rezultatas = await drCoordinator.paleisti({
          ...bendri,
          leistiPasenusi: true,
          patvirtinimas: {
            deploymentId: sargai.deploymentId,
            zurnaloChecksum: sargai.zurnaloChecksum,
            pasenimoValandos: Math.floor(sargai.amzius / 3_600_000),
          },
        });

        assert.equal(rezultatas.merge.pasenes, true, "kelias tikrai ėjo per pasenusio šaką");
        assert.equal(
          rezultatas.merge.overrideLaikmena,
          "operatoriaus_patvirtinimas",
          "`PRIVACY_MODE` pėdsakas yra patvirtinimas, ne audito įrašas"
        );
        assert.equal(rezultatas.verify.suderinta, true, "verifikacija praėjo — cutover leidžiamas");
      } finally {
        await pool.end();
      }
    });
  });
});
