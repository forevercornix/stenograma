const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { mock } = require("node:test");
const { Client, Pool } = require("pg");

const { skipWithoutPostgres, testDatabaseUrl, adminDatabaseUrl } = require("./helpers/postgresGuard");

const reconcile = require("../utils/postRestoreReconcile");
const jobPhase = require("../utils/jobPhase");
const auditStore = require("../utils/auditStore");
const { createPostgresStore } = require("../utils/jobStore/postgresStore");
const sesijuPg = require("../utils/sessionStore/postgresStore");
const { hashPassword } = require("../utils/credentials");
const tombstones = require("../utils/deletionTombstones");
const { pasetiKeturisStatusus } = require("./helpers/postRestoreFixtures");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * 7.6b POST-RESTORE SUDERINIMAS — TIKRA DUOMENŲ BAZĖ (#155, #249).
 *
 * ⚠️ ŠIS FAILAS VIETINĖJE APLINKOJE NEVYKDOMAS. Jam reikia tikros PostgreSQL, ir
 * pirmą kartą jį paleis CI. Registracija `postgres` rinkinyje išvedama iš
 * `postgresGuard` importo, tad `verify-postgres-suite-ran.mjs` reikalaus
 * neprapleisto `ok`.
 *
 * ⚠️ KODĖL BŪTENT ČIA. Visa, ką galima įrodyti be DB — sargai, patch'o kilmė,
 * praleidimo predikatas, CLI exit kodai — gyvena `postRestoreReconcileContract`.
 * Čia lieka tik tai, ko be dviejų tikrų lentelių įrodyti neįmanoma:
 * persistentinė būsena, transakcijos atsukimas, realus auth kelias su senais
 * cookie ir audito EILUTĖ (ne funkcijos iškvietimas).
 */
const SUDERINIMO_URL = testDatabaseUrl("postrestore");

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

async function perkurtiDb(url) {
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
 * ⚠️ APLINKA RIŠAMA PRIE TESTO BAZĖS, IR TAI ĮRODYMO DALIS.
 *
 * Suderinimas ir audito saugykla jungiasi pagal `process.env` (D7a: tapatumas
 * pagal konstrukciją). Testas tą aplinką pakeičia trumpam ir grąžina — kitaip
 * jis tikrintų ne tą bazę, kurią paruošė. 7.6a ta pati vieta kainavo visą
 * integracinį failą.
 */
async function suAplinka(url, veiksmas) {
  const senas = { ...process.env };

  process.env.DATABASE_URL = url;
  /**
   * ⚠️ `SESSION_STORE_BACKEND=postgres` BŪTINAS, IR TAI NE TESTO PATOGUMAS.
   *
   * Be jo aplikacijos sesijų autoritetas yra ATMINTIS (#280 P1), tad sesijų ašies
   * verdiktas būtų `nereikalinga` — ir testas tikrintų revokaciją, kurios
   * produkcijoje niekas nedarytų. DoD reikalauja būtent to atvejo, kur
   * revokacija turi prasmę.
   */
  process.env.SESSION_STORE_BACKEND = "postgres";
  process.env.AUDIT_BACKEND = "postgres";
  process.env.AUDIT_ID_SALT = crypto.randomBytes(32).toString("hex");
  process.env.AUDIT_ID_SALT_ID = "2026-09";
  process.env.AUTH_USERS =
    `admin:administrator:${hashPassword("a1")}:${VARTOTOJAS_A},` +
    `petras:operator:${hashPassword("b2")}:${VARTOTOJAS_B}`;

  await auditStore.shutdown().catch(() => {});
  await auditStore.init(process.env);

  /**
   * ⚠️ ŽYMŲ SAUGYKLA IRGI INICIJUOJAMA (D7b). Testas per ją SĖJA žymą, o
   * suderinimas ją skaito savo klientu — du skirtingi keliai į tą pačią lentelę,
   * ir būtent todėl tapatumas turi būti pririštas prie tos pačios bazės.
   */
  await tombstones.shutdown().catch(() => {});
  await tombstones.init(process.env);

  try {
    return await veiksmas();
  } finally {
    await tombstones.shutdown().catch(() => {});
    await auditStore.shutdown().catch(() => {});
    for (const raktas of [
      "DATABASE_URL",
      "SESSION_STORE_BACKEND",
      "AUDIT_BACKEND",
      "AUDIT_ID_SALT",
      "AUDIT_ID_SALT_ID",
      "AUTH_USERS",
    ]) {
      if (senas[raktas] === undefined) delete process.env[raktas];
      else process.env[raktas] = senas[raktas];
    }
  }
}

/** Sesijos dviem vartotojams — vienos sesijos testą praeitų ir bloga realizacija. */
async function pripildytiSesijas(pool) {
  const store = sesijuPg.createPostgresStore(pool);

  const sesijos = [];
  for (const [userId, role, username] of [
    [VARTOTOJAS_A, "administrator", "admin"],
    [VARTOTOJAS_A, "administrator", "admin"],
    [VARTOTOJAS_B, "operator", "petras"],
  ]) {
    const s = await store.create({ id: userId, role, username }, process.env);
    sesijos.push({ ...s, userId, role });
  }

  return { store, sesijos };
}

/** Keturi statusai vienu metu + vienas užbarjeruotas job'as (D5). */
async function pripildytiJobus(pool) {
  const store = createPostgresStore(pool);

  /**
   * ⚠️ SEKA — IŠ BENDRO HELPERIO. Ta pati, kurią vietinis kontraktinis testas
   * paleidžia prieš `memoryStore`; dvi kopijos išsiskirtų, ir vietinė patikra
   * imtų ginti nebe tą seką, kurią vykdo šis testas.
   */
  const { queued, processing, failed, completed, zymetas } = await pasetiKeturisStatusus(store, {
    ownerId: VARTOTOJAS_A,
    storageKey: (vardas) => `audio/${vardas}-${crypto.randomUUID()}.wav`,
  });

  /**
   * ⚠️ ŽYMA RAŠOMA PER MODULĮ, NE `INSERT`-u.
   *
   * `erasure_marks` SQL už `deletionTombstones` ribų draudžia sargas
   * („VIENAS AUTORITETAS", `erasureMarks.test.js`) — ir teisingai: testas,
   * rašantis žymą ranka, tikrintų savo supratimą apie lentelę, ne tą būseną,
   * kurią gamina produkcinis kelias. Pirmoji šio failo redakcija tą sargą
   * sulaužė, ir jis suveikė.
   */
  await tombstones.mark(zymetas.id, { reason: "user_request", actorKind: "user" });

  return { store, queued, processing, failed, completed, uzbarjeruotas: zymetas };
}

/** Persistentinė būsena — tai, ką lyginame prieš/po (ne `COUNT`). */
async function busena(url) {
  const jobs = await vykdyti(
    url,
    `SELECT id, status, phase, progress_known, progress_current, progress_total,
            error_code, error_message, storage_key, version, updated_at
       FROM jobs ORDER BY id`
  );
  const rezultatai = await vykdyti(url, "SELECT job_id, payload, storage_type FROM job_results ORDER BY job_id");
  const sesijos = await vykdyti(url, "SELECT id, user_id, revoked_at FROM sessions ORDER BY id");

  return { jobs: jobs.rows, rezultatai: rezultatai.rows, sesijos: sesijos.rows };
}

async function auditoIrasai(url) {
  const { rows } = await vykdyti(
    url,
    "SELECT event, result, meta FROM audit_log WHERE event = $1 ORDER BY seq",
    [reconcile.AUDITO_IVYKIS]
  );
  return rows;
}

test("7.6b: suderinimas revokuoja sesijas ir terminalizuoja job'us", { skip: praleisti(), timeout: 180000 }, async (t) => {
  t.after(async () => {
    await pasalintiDb(SUDERINIMO_URL);
  });

  await perkurtiDb(SUDERINIMO_URL);

  await suAplinka(SUDERINIMO_URL, async () => {
    const pool = new Pool({ connectionString: SUDERINIMO_URL });

    try {
      const { store: sesijuStore, sesijos } = await pripildytiSesijas(pool);
      const { queued, processing, failed, completed, uzbarjeruotas } = await pripildytiJobus(pool);

      /** ⚠️ KONTROLĖ: prieš suderinimą senos sesijos REALIAI autentifikuoja. */
      for (const s of sesijos) {
        assert.ok(await sesijuStore.touch(s.token, process.env), "prieš suderinimą sesija privalo veikti");
      }

      const pries = await busena(SUDERINIMO_URL);

      const r = await reconcile.suderinti({ targetUrl: SUDERINIMO_URL, actor: "operatorius-testas" });

      assert.equal(r.sesijos, 3, "revokuojamos VISOS aktyvios sesijos, ne vieno vartotojo");
      assert.equal(r.jobai.terminalizuota, 2, "`queued` ir `processing`");
      assert.deepEqual(r.jobai.praleista, [uzbarjeruotas.id], "užbarjeruotas job'as praleidžiamas (D5)");
      assert.equal(r.nieko, false);

      /**
       * ⚠️ AŠIŲ VERDIKTAI (#280 P1). Sesijos — `suderinta` (autoritetas
       * PostgreSQL); job'ai — `nereikalinga`, nes 7.2a barjeras palieka jų gyvą
       * autoritetą atmintyje. Darbas bazėje atliktas abiem, bet verdiktas sako
       * TIESĄ apie tai, ką suderinimas realiai užtikrina.
       */
      assert.equal(r.asys.sesijos.verdiktas, "suderinta");
      assert.equal(r.asys.sesijos.autoritetas, "postgres");
      assert.equal(r.asys.jobai.barjeras, true, "barjeras privalo būti matomas, ne numanomas");
      assert.equal(r.asys.jobai.verdiktas, "nereikalinga");

      /**
       * ⚠️ SESIJOS: PERSISTENTINIS LAUKAS **IR** REALUS AUTH KELIAS.
       *
       * `revoked_at` įrodo eilutę, `touch()` įrodo, kad senas cookie nebeveikia -
       * o būtent tai ir yra grėsmė, nuo kurios 7.6b saugo.
       */
      const po = await busena(SUDERINIMO_URL);
      assert.equal(po.sesijos.length, 3);
      for (const s of po.sesijos) assert.notEqual(s.revoked_at, null, "nė viena sesija negali likti aktyvi");
      for (const s of sesijos) {
        assert.equal(await sesijuStore.touch(s.token, process.env), null, "senas cookie nebeautentifikuoja");
      }

      const pagalId = (rows) => Object.fromEntries(rows.map((r2) => [r2.id, r2]));
      const prieJ = pagalId(pries.jobs);
      const poJ = pagalId(po.jobs);

      /** `queued`/`processing` → terminalūs, processing-only laukai sutvarkyti. */
      for (const id of [queued.id, processing.id]) {
        assert.equal(poJ[id].status, "failed");
        assert.equal(poJ[id].phase, null);
        assert.equal(poJ[id].progress_known, false);
        assert.equal(poJ[id].progress_current, null);
        assert.equal(poJ[id].progress_total, null);
        assert.equal(poJ[id].error_code, reconcile.TERMINALIZAVIMO_KODAS);
        assert.ok(poJ[id].version > prieJ[id].version, "versija didinama kaip ir bet kuriai mutacijai (7.5b)");
        assert.equal(poJ[id].storage_key, prieJ[id].storage_key, "D10: `storageKey` nekeičiamas");
      }

      /** `failed` semantiškai nepakitęs — suderinimas jo neperrašo savo kodu. */
      assert.deepEqual(poJ[failed.id], prieJ[failed.id], "terminalinis `failed` neliečiamas");

      /** `completed` + rezultato PERSISTENTINĖ reprezentacija identiška. */
      assert.deepEqual(poJ[completed.id], prieJ[completed.id]);
      assert.deepEqual(po.rezultatai, pries.rezultatai, "rezultatai nekuriami, neperrašomi ir netrinami");

      /** Užbarjeruotas job'as - nepaliestas. */
      assert.deepEqual(poJ[uzbarjeruotas.id], prieJ[uzbarjeruotas.id]);

      /** ⚠️ EVIDENCIJA YRA EILUTĖ (D7b): audito įrašas tikroje lentelėje. */
      const auditas = await auditoIrasai(SUDERINIMO_URL);
      assert.equal(auditas.length, 1, "sėkmingas suderinimas palieka evidenciją");
      assert.equal(auditas[0].result, "success");

      /** ⚠️ VERIFIKACIJA: užbarjeruotas job'as nėra „nesuderinimas". */
      const v = await reconcile.patikrinti({ targetUrl: SUDERINIMO_URL });
      assert.equal(v.suderinta, true);
      assert.equal(v.duomenysSutvarkyti, true);
      assert.equal(v.aktyviosSesijos, 0);
      assert.deepEqual(v.nesuderinti, []);
      assert.deepEqual(v.uzbarjeruoti, [uzbarjeruotas.id]);
    } finally {
      await pool.end().catch(() => {});
    }
  });
});

test("7.6b D9: antras vykdymas palieka TĄ PAČIĄ persistentinę būseną", { skip: praleisti(), timeout: 180000 }, async (t) => {
  t.after(async () => {
    await pasalintiDb(SUDERINIMO_URL);
  });

  await perkurtiDb(SUDERINIMO_URL);

  await suAplinka(SUDERINIMO_URL, async () => {
    const pool = new Pool({ connectionString: SUDERINIMO_URL });

    try {
      await pripildytiSesijas(pool);
      await pripildytiJobus(pool);

      await reconcile.suderinti({ targetUrl: SUDERINIMO_URL, actor: "operatorius-testas" });
      const poPirmo = await busena(SUDERINIMO_URL);

      const antras = await reconcile.suderinti({ targetUrl: SUDERINIMO_URL, actor: "operatorius-testas" });
      const poAntro = await busena(SUDERINIMO_URL);

      /**
       * ⚠️ IDEMPOTENTIŠKUMAS TIKRINAMAS BŪSENA, NE GRĄŽINAMU KODU.
       *
       * Antras vykdymas negrąžina klaidos - bet to nepakanka: `revoked_at`
       * pasislinkimas ar `version` padidėjimas reikštų naują semantinį pokytį,
       * nors abu paleidimai „pavyko".
       */
      assert.deepEqual(poAntro, poPirmo, "persistentinė būsena po pirmo ir antro vykdymo privalo sutapti");
      assert.equal(antras.sesijos, 0, "antram kartui aktyvių sesijų nebėra");
      assert.equal(antras.jobai.terminalizuota, 0);
      assert.equal(antras.nieko, false, "užbarjeruotas job'as vis dar randamas, tad tai ne visiškas no-op");
    } finally {
      await pool.end().catch(() => {});
    }
  });
});

test("7.6b D4: klaida po dalies darbo ATSUKA viską", { skip: praleisti(), timeout: 180000 }, async (t) => {
  t.after(async () => {
    await pasalintiDb(SUDERINIMO_URL);
  });

  await perkurtiDb(SUDERINIMO_URL);

  await suAplinka(SUDERINIMO_URL, async () => {
    const pool = new Pool({ connectionString: SUDERINIMO_URL });

    try {
      const { store: sesijuStore, sesijos } = await pripildytiSesijas(pool);
      await pripildytiJobus(pool);

      const pries = await busena(SUDERINIMO_URL);

      /**
       * ⚠️ DETERMINISTINIS GEDIMAS, NE `sleep()`.
       *
       * Sesijos revokuojamos PIRMOS, tad klaida job'ų pusėje įrodo būtent tai,
       * ko reikia: ar jau atliktas sesijų darbas atsukamas kartu. `jobPhase`
       * mock'inamas todėl, kad suderinimas jį importuoja vykdymo metu - tas pats
       * modulio egzempliorius.
       */
      const luztantis = mock.method(jobPhase, "finish", () => {
        throw new Error("sąmoningas gedimas vidury suderinimo");
      });

      try {
        await assert.rejects(
          () => reconcile.suderinti({ targetUrl: SUDERINIMO_URL, actor: "operatorius-testas" }),
          /sąmoningas gedimas/
        );
      } finally {
        luztantis.mock.restore();
      }

      const po = await busena(SUDERINIMO_URL);
      assert.deepEqual(po, pries, "nei sesijos, nei job'ai negali likti pakeisti");

      /** ⚠️ Ir realus auth kelias: sesijos privalo TEBEVEIKTI. */
      for (const s of sesijos) {
        assert.ok(await sesijuStore.touch(s.token, process.env), "atsukus transakciją sesija lieka aktyvi");
      }

      /** ⚠️ Rollback NEGALI palikti įrašo „suderinta" (D8). */
      assert.deepEqual(await auditoIrasai(SUDERINIMO_URL), [], "nepavykęs suderinimas evidencijos nepalieka");

      const v = await reconcile.patikrinti({ targetUrl: SUDERINIMO_URL });
      assert.equal(v.suderinta, false, "verifikacija privalo pasakyti, kad startas negalimas");
      assert.equal(v.aktyviosSesijos, 3);
    } finally {
      await pool.end().catch(() => {});
    }
  });
});

test("7.6b D7a: svetima bazė NEPALIEČIAMA — jokio pėdsako", { skip: praleisti(), timeout: 180000 }, async (t) => {
  const SVETIMA_URL = testDatabaseUrl("postrestore_svetima");

  t.after(async () => {
    await pasalintiDb(SUDERINIMO_URL);
    await pasalintiDb(SVETIMA_URL);
  });

  await perkurtiDb(SUDERINIMO_URL);
  await perkurtiDb(SVETIMA_URL);

  await suAplinka(SUDERINIMO_URL, async () => {
    const svetimasPool = new Pool({ connectionString: SVETIMA_URL });

    try {
      await pripildytiSesijas(svetimasPool);

      const pries = await busena(SVETIMA_URL);

      await assert.rejects(
        () => reconcile.suderinti({ targetUrl: SVETIMA_URL, actor: "operatorius-testas" }),
        (err) => {
          assert.equal(err.code, "RECONCILE_TARGET_MISMATCH");
          return true;
        }
      );

      /**
       * ⚠️ NEUŽTENKA „grąžino klaidą". Tikrinama, kad svetimoje bazėje NELIKO
       * PĖDSAKO: nei revokuotų sesijų, nei audito eilutės. 7.6a horizonto pamoka
       * buvo tiksliai ta pati - operacija „ne toje bazėje" yra tyli.
       */
      assert.deepEqual(await busena(SVETIMA_URL), pries, "svetimoje bazėje niekas negalėjo pasikeisti");
      assert.deepEqual(await auditoIrasai(SVETIMA_URL), []);
      assert.deepEqual(await auditoIrasai(SUDERINIMO_URL), [], "ir savoje bazėje evidencijos būti negali");
    } finally {
      await svetimasPool.end().catch(() => {});
    }
  });
});

test("#280 IV: konfigūracijos klaida NEPALIEKA įsipareigoto darbo", { skip: praleisti(), timeout: 180000 }, async (t) => {
  /**
   * ⚠️ TIKRINAMA BŪSENA, NE TVARKA.
   *
   * Kol ašys buvo nustatomos PO `COMMIT`, `JOB_STORE_BACKEND=postgres` su
   * uždarytu 7.2a barjeru duodavo: sesijos revokuotos, job'ai terminalizuoti,
   * `ROLLBACK` per vėlu, `POST_RESTORE_RECONCILED` neįrašytas, exit 2 —
   * ĮSIPAREIGOTOS, NEAUDITUOTOS mutacijos, pranešamos kaip nesėkmė. Operatorius
   * tokioje būsenoje arba kartotų komandą, arba laikytų atkūrimą neįvykusiu.
   *
   * Todėl testas tikrina ne „ašys skaičiuojamos anksčiau", o tai, kad po
   * komandos sesijų ir job'ų būsena NEPAKITUSI — vienintelis dalykas, kuris
   * skiria taisymą nuo pertvarkymo.
   */
  t.after(async () => {
    await pasalintiDb(SUDERINIMO_URL);
  });

  await perkurtiDb(SUDERINIMO_URL);

  await suAplinka(SUDERINIMO_URL, async () => {
    const pool = new Pool({ connectionString: SUDERINIMO_URL });

    try {
      const { store: sesijuStore, sesijos } = await pripildytiSesijas(pool);
      await pripildytiJobus(pool);

      const pries = await busena(SUDERINIMO_URL);

      await assert.rejects(
        () =>
          reconcile.suderinti({
            targetUrl: SUDERINIMO_URL,
            actor: "operatorius-testas",
            env: { ...process.env, JOB_STORE_BACKEND: "postgres" },
          }),
        /JOB_STORE_BACKEND=postgres dar neleidžiamas/
      );

      assert.deepEqual(await busena(SUDERINIMO_URL), pries, "konfigūracijos klaida negali palikti pakeitimų");

      for (const s of sesijos) {
        assert.ok(await sesijuStore.touch(s.token, process.env), "sesijos privalo likti aktyvios");
      }

      assert.deepEqual(await auditoIrasai(SUDERINIMO_URL), [], "nesėkmė evidencijos nepalieka");
    } finally {
      await pool.end().catch(() => {});
    }
  });
});

test("#280 follow-up: be nė vienos PostgreSQL ašies komanda KRENTA, nieko nepakeitusi", { skip: praleisti(), timeout: 180000 }, async (t) => {
  /**
   * ⚠️ D7 SAKO: „jokio successful skip memory režime; tylus praleidimas
   * pavojingesnis nei kritimas". Iki šio taisymo su `DATABASE_URL` ir numatytais
   * atmintiniais backend'ais abi ašys gaudavo `NEREIKALINGA`, `arSaugu()`
   * grąžindavo `true`, ir komanda išeidavo `0` NIEKO nesuderinusi — t. y.
   * operatorius gaudavo patvirtinimą apie darbą, kurio nebuvo.
   *
   * ⚠️ TIKRINAMA BŪSENA, NE FORMA: po kritimo sesijos privalo likti aktyvios,
   * job'ai nepakitę, audito eilutės nėra. „Krito su teisingu kodu" nepakanka —
   * reikia, kad nebūtų ir šalutinio efekto.
   */
  t.after(async () => {
    await pasalintiDb(SUDERINIMO_URL);
  });

  await perkurtiDb(SUDERINIMO_URL);

  await suAplinka(SUDERINIMO_URL, async () => {
    const pool = new Pool({ connectionString: SUDERINIMO_URL });

    try {
      const { store: sesijuStore, sesijos } = await pripildytiSesijas(pool);
      await pripildytiJobus(pool);

      const pries = await busena(SUDERINIMO_URL);

      /** ⚠️ `SESSION_STORE_BACKEND` PAŠALINAMAS — lieka numatytoji atmintis, o job'us uždaro barjeras. */
      const beAsiu = { ...process.env };
      delete beAsiu.SESSION_STORE_BACKEND;

      await assert.rejects(
        () => reconcile.suderinti({ targetUrl: SUDERINIMO_URL, actor: "operatorius-testas", env: beAsiu }),
        (err) => {
          assert.equal(err.code, "RECONCILE_BACKEND_NOT_POSTGRES");
          return true;
        }
      );

      assert.deepEqual(await busena(SUDERINIMO_URL), pries, "sargas negali palikti pakeitimų");
      for (const s of sesijos) {
        assert.ok(await sesijuStore.touch(s.token, process.env), "sesijos privalo likti aktyvios");
      }
      assert.deepEqual(await auditoIrasai(SUDERINIMO_URL), [], "nesėkmė evidencijos nepalieka");

      /** ⚠️ KONTROLĖ: su sesijų ašimi ta pati komanda PRAEINA — kitaip sargas draustų viską. */
      const r = await reconcile.suderinti({ targetUrl: SUDERINIMO_URL, actor: "operatorius-testas" });
      assert.equal(r.asys.sesijos.verdiktas, "suderinta");
    } finally {
      await pool.end().catch(() => {});
    }
  });
});
