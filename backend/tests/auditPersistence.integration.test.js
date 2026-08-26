const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { Pool } = require("pg");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { skipWithoutPostgres, testDatabaseUrl, adminDatabaseUrl } = require("./helpers/postgresGuard");
const { sukurtiResursuKruva } = require("./helpers/resourceStack");
const { createPostgresStore } = require("../utils/auditStore/postgresStore");
const {
  REQUIRED_AUDIT_CONSTRAINTS,
  REQUIRED_AUDIT_TRIGGER,
  auditoPoolNustatymai,
} = require("../utils/auditStore");
const { META_LAUKAI } = require("../utils/auditStore/fields");
const { EVENT_PATTERN } = require("../utils/auditEvents");

/**
 * AUDITO PERSISTENCIJOS GARANTIJOS (#155, 7.4b / #211).
 *
 * ⚠️ ČIA TIK TAI, KO ATMINTYJE NĖRA.
 *
 * Bendras elgesys (skaitymas, riba, filtrai, trynimas pagal subjektą,
 * idempotencija) gyvena `auditStoreBackendContract.integration.test.js` ir
 * vykdomas ABIEM backend'ams. Šis failas tikrina savybes, kurios egzistuoja
 * tik su tikra DB: schemą, invariantus, append-only trigerį, RAW eilučių
 * privatumą, pool'o gyvavimo ciklą, išlikimą po restarto ir kelių instancijų
 * matomumą.
 *
 * ⚠️ RAW SQL, NE STORE API. #211 to reikalauja eksplicitiškai: invariantą,
 * įrodytą per tą patį sluoksnį, kuris jį ir turėtų pažeisti, patikrinome
 * neteisingoje vietoje. Fasadas gali filtruoti tai, ką DB realiai saugo.
 */

const SKIP = skipWithoutPostgres();

/** Sentinel'ai parenkami taip, kad atsitiktinis sutapimas būtų neįmanomas. */
const JOB_SENTINEL = "JOB-PLIKAS-ID-a7f3e91c-4d2b-SENTINEL";
const TRANSKRIPCIJOS_SENTINEL = "TRANSKRIPCIJA-Jonas-Jonaitis-kalbejo-apie-SENTINEL";
const PROMPT_SENTINEL = "SISTEMINIS-PROMPTAS-b8c1-SENTINEL";

const HASH_KEY_ID = "persistencija-2026-08";

/**
 * Šviežia migruota DB. Grąžina `{ url, pool, resursai }`; kvietėjas privalo
 * iškviesti `resursai.isvalyti()`.
 */
async function paruostiDb(suffix) {
  const resursai = sukurtiResursuKruva();
  try {
    const url = testDatabaseUrl(suffix);
    const dbName = new URL(url).pathname.slice(1);

    const admin = new Pool({ connectionString: adminDatabaseUrl() });
    const uzdarytiAdmin = resursai.registruoti("admin pool", () => admin.end());
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
    resursai.registruoti("laikina DB", async () => {
      const a = new Pool({ connectionString: adminDatabaseUrl() });
      try {
        await a.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      } finally {
        await a.end();
      }
    });
    await uzdarytiAdmin();

    execFileSync("npx", ["node-pg-migrate", "up"], {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, DATABASE_URL: url },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const pool = new Pool({ connectionString: url });
    resursai.registruoti("darbinis pool", () => pool.end());

    return { url, pool, resursai };
  } catch (klaida) {
    await resursai.isvalyti(klaida);
    throw klaida;
  }
}

function eilute(perrasymai = {}) {
  const bazė = {
    id: crypto.randomUUID(),
    event: "PROCESSING_COMPLETED",
    subjectId: null,
    result: "success",
    requestId: null,
  };
  for (const laukas of META_LAUKAI) bazė[laukas] = null;
  return { ...bazė, ...perrasymai };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * SCHEMA IR INVARIANTAI
 * ═══════════════════════════════════════════════════════════════════════════ */

test("SCHEMA: `REQUIRED_AUDIT_CONSTRAINTS` sąrašas yra PILNAS", { skip: SKIP }, async () => {
  /**
   * ⚠️ SĄRAŠAS IŠVEDAMAS IŠ ŠVIEŽIAI MIGRUOTOS DB, ne surašomas ranka.
   *
   * `auditStore.init()` naudoja `REQUIRED_AUDIT_CONSTRAINTS` kaip STARTO
   * barjerą. Jei migracija pridės naują `CHECK`, o sąrašas liks senas, barjeras
   * praleis DB be to invarianto - tyliai. Todėl tikrinama abiem kryptim:
   * kiekvienas migracijos `CHECK` privalo būti sąraše, ir atvirkščiai.
   */
  const { pool, resursai } = await paruostiDb("audit_schema");
  try {
    const { rows } = await pool.query(
      `SELECT c.conname
         FROM pg_constraint c
         JOIN pg_class t     ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE t.relname = 'audit_log' AND n.nspname = current_schema() AND c.contype = 'c'`
    );

    const dbInvariantai = rows.map((r) => r.conname).sort();

    assert.deepEqual(
      dbInvariantai,
      [...REQUIRED_AUDIT_CONSTRAINTS].sort(),
      "starto barjero sąrašas ir migracijos invariantai išsiskyrė - " +
        "barjeras praleistų DB be dalies apsaugų"
    );
  } finally {
    await resursai.isvalyti();
  }
});

test("SCHEMA: filtruojami stulpeliai turi SAVO indeksus", { skip: SKIP }, async () => {
  /**
   * #211: filtruojami laukai indeksuojami atskirai, o ne skenuojant JSONB.
   * Be indekso `WHERE event = $1` virstų pilnu lentelės skenavimu - o auditas
   * yra būtent ta lentelė, kuri auga be ribos.
   */
  const { pool, resursai } = await paruostiDb("audit_indeksai");
  try {
    const { rows } = await pool.query(
      `SELECT a.attname AS stulpelis
         FROM pg_index i
         JOIN pg_class t   ON t.oid = i.indrelid
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey)
        WHERE t.relname = 'audit_log'`
    );
    const indeksuoti = new Set(rows.map((r) => r.stulpelis));

    for (const stulpelis of [
      "id",
      "timestamp",
      "event",
      "subject_id",
      "hash_key_id",
      "result",
      "request_id",
      "seq",
    ]) {
      assert.ok(indeksuoti.has(stulpelis), `${stulpelis} privalo turėti indeksą`);
    }
  } finally {
    await resursai.isvalyti();
  }
});

test("SCHEMA: plikojo `job_id` stulpelio NĖRA", { skip: SKIP }, async () => {
  const { pool, resursai } = await paruostiDb("audit_be_jobid");
  try {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'audit_log'`
    );
    const stulpeliai = rows.map((r) => r.column_name);

    for (const draudžiamas of ["job_id", "meeting_id", "transcript", "prompt", "audio"]) {
      assert.ok(
        !stulpeliai.includes(draudžiamas),
        `stulpelis \`${draudžiamas}\` audito lentelėje neleistinas`
      );
    }
  } finally {
    await resursai.isvalyti();
  }
});

test("APPEND-ONLY: tiesioginis SQL `UPDATE` ATMETAMAS", { skip: SKIP }, async () => {
  /**
   * ⚠️ TIKRINAMA PRO STORE'Ą APLENKIANT KELIĄ.
   *
   * Store'as `UPDATE` apskritai nekviečia, tad jo tylėjimas nieko neįrodo.
   * Garantija turi galioti ir tiesioginiam `psql` prisijungimui - būtent tokiu
   * keliu užpuolikas taisytų įrašą apie savo veiksmą.
   */
  const { pool, resursai } = await paruostiDb("audit_append_only");
  try {
    const store = createPostgresStore(pool, { hashKeyId: HASH_KEY_ID });
    const irasas = await store.append(eilute({ details: "originalas" }));

    await assert.rejects(
      () => pool.query("UPDATE audit_log SET result = 'failure' WHERE id = $1", [irasas.id]),
      /append-only/i,
      "audito įrašo redagavimas privalo būti atmestas DB lygiu"
    );

    /** Ir `meta` keitimas - ne tik stulpelių. */
    await assert.rejects(
      () => pool.query("UPDATE audit_log SET meta = '{}'::jsonb"),
      /append-only/i
    );

    const { rows } = await pool.query("SELECT result FROM audit_log WHERE id = $1", [irasas.id]);
    assert.equal(rows[0].result, "success", "eilutė privalo likti nepakeista");
  } finally {
    await resursai.isvalyti();
  }
});

test("APPEND-ONLY: `DELETE` LEIDŽIAMAS - GDPR ištrynimui jis būtinas", { skip: SKIP }, async () => {
  /**
   * ⚠️ SĄMONINGAS SPRENDIMAS, NE PRALEIDIMAS (#211 reikalavo eksplicitinio
   * pasirinkimo).
   *
   * `DELETE` DB lygmenyje NERIBOJAMAS. Atėmus jį (atskira rolė be `DELETE`
   * granto), `removeBySubjectIdentifier()` nustotų veikti - t. y. sulūžtų
   * būtent tas kelias, kurį auditas privalo aptarnauti. Riba gyvena API
   * lygmenyje: store'as eksponuoja tik subjektu apribotą trynimą.
   */
  const { pool, resursai } = await paruostiDb("audit_delete");
  try {
    const store = createPostgresStore(pool, { hashKeyId: HASH_KEY_ID });
    const irasas = await store.append(eilute({ subjectId: "pseudo-gdpr" }));

    const { rowCount } = await pool.query("DELETE FROM audit_log WHERE id = $1", [irasas.id]);
    assert.equal(rowCount, 1, "DELETE privalo veikti - kitaip GDPR ištrynimas neįmanomas");
  } finally {
    await resursai.isvalyti();
  }
});

test("CHECK: neleistina `result` reikšmė ATMETAMA", { skip: SKIP }, async () => {
  const { pool, resursai } = await paruostiDb("audit_result_check");
  try {
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO audit_log (id, event, hash_key_id, result)
           VALUES ($1, 'PROCESSING_COMPLETED', $2, 'maybe')`,
          [crypto.randomUUID(), HASH_KEY_ID]
        ),
      /audit_log_result_allowed/,
      "trečia baigties reikšmė padarytų audito statistiką neinterpretuojamą"
    );
  } finally {
    await resursai.isvalyti();
  }
});

test("CHECK: neatitinkantis įvykio vardas ATMETAMAS, o runtime šablonas SUTAMPA", { skip: SKIP }, async () => {
  /**
   * ⚠️ PARITETAS TIKRINAMAS ELGESIU, NE TEKSTU.
   *
   * `auditStoreFields.test.js` tikrina tik tai, kad migracija IMPORTUOJA
   * šabloną (tripwire, AGENTS.md §9.2). Čia tikrinama, kad DB realiai priima
   * tuos pačius vardus, kuriuos priima runtime - abiem kryptim.
   */
  const { pool, resursai } = await paruostiDb("audit_event_check");
  try {
    const netinkami = ["login_success", "Login", "A", "SU TARPU", "PER-BRUKSNI", ""];

    for (const vardas of netinkami) {
      assert.equal(EVENT_PATTERN.test(vardas), false, `prielaida: runtime atmeta "${vardas}"`);
      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO audit_log (id, event, hash_key_id, result)
             VALUES ($1, $2, $3, 'success')`,
            [crypto.randomUUID(), vardas, HASH_KEY_ID]
          ),
        /audit_log_event_pattern/,
        `DB privalo atmesti "${vardas}" - kitaip runtime ir schema išsiskyrė`
      );
    }

    for (const vardas of ["LOGIN_SUCCESS", "DATA_ERASED", "A1_B2"]) {
      assert.equal(EVENT_PATTERN.test(vardas), true, `prielaida: runtime priima "${vardas}"`);
      await pool.query(
        `INSERT INTO audit_log (id, event, hash_key_id, result)
         VALUES ($1, $2, $3, 'success')`,
        [crypto.randomUUID(), vardas, HASH_KEY_ID]
      );
    }
  } finally {
    await resursai.isvalyti();
  }
});

test("LAIKAS: `timestamp` autoritetas yra DB, ne aplikacija", { skip: SKIP }, async () => {
  /**
   * Programos laikrodis skiriasi tarp replikų. Jei `timestamp` ateitų iš
   * aplikacijos, sugedęs NTP viename konteineryje sumaišytų viso audito tvarką,
   * o kvietėjas galėtų laiką pasirinkti pats.
   */
  const { pool, resursai } = await paruostiDb("audit_laikas");
  try {
    const store = createPostgresStore(pool, { hashKeyId: HASH_KEY_ID });

    const melagingas = "1999-01-01T00:00:00.000Z";
    const irasas = await store.append(eilute({ timestamp: melagingas }));

    assert.notEqual(irasas.timestamp, melagingas, "aplikacijos laikas negali patekti į lentelę");

    const { rows } = await pool.query("SELECT timestamp FROM audit_log WHERE id = $1", [irasas.id]);
    const skirtumasMs = Math.abs(Date.now() - rows[0].timestamp.getTime());
    assert.ok(skirtumasMs < 60_000, "DB laikas turi būti dabartinis");
  } finally {
    await resursai.isvalyti();
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * RAW PRIVATUMAS
 * ═══════════════════════════════════════════════════════════════════════════ */

test("RAW: plikojo job ID NĖRA NĖ VIENAME stulpelyje ar `meta` lauke", { skip: SKIP }, async () => {
  /**
   * ⚠️ RAŠOMA PRO PRODUKCINĮ KELIĄ (`auditLog.record`), ne tiesiai į store'ą.
   *
   * Tikrinama ne tai, ar store'as moka nerašyti, o tai, ar produkcinis kelias
   * realiai neatneša plikojo ID. Pseudonimizacija gyvena `auditLog`, tad
   * apeinant jį testas tikrintų ne tą sluoksnį.
   *
   * ⚠️ `to_jsonb(t)` SERIALIZUOJA VISĄ EILUTĘ - visus stulpelius IR `meta`
   * rekursyviai. Stulpelių sąrašo tikrinimas po vieną praleistų naują stulpelį,
   * pridėtą vėliau.
   */
  const auditStore = require("../utils/auditStore");
  const auditLog = require("../utils/auditLog");
  const { url, pool, resursai } = await paruostiDb("audit_raw_privacy");

  try {
    await auditStore.shutdown();
    await auditStore.init({
      ...process.env,
      AUDIT_BACKEND: "postgres",
      DATABASE_URL: url,
      AUDIT_ID_SALT: "testine-druska-nera-produkcine",
      AUDIT_ID_SALT_ID: HASH_KEY_ID,
      PRIVACY_MODE: "false",
    });

    await auditLog.record({
      event: "PROCESSING_COMPLETED",
      jobId: JOB_SENTINEL,
      success: true,
      details: "queue=deleted storage=none",
    });

    const { rows } = await pool.query("SELECT to_jsonb(t)::text AS visa FROM audit_log t");
    assert.equal(rows.length, 1, "prielaida: įrašas realiai pateko į DB");

    assert.ok(
      !rows[0].visa.includes(JOB_SENTINEL),
      "plikas job ID rastas RAW eilutėje - pseudonimizacija neapsaugojo saugyklos"
    );

    /** Ir teigiama pusė: pseudonimas TURI būti, kitaip GDPR ištrynimas nerastų įrašo. */
    const { rows: subj } = await pool.query("SELECT subject_id, hash_key_id FROM audit_log");
    assert.ok(subj[0].subject_id, "`subject_id` privalo būti užpildytas");
    assert.equal(subj[0].hash_key_id, HASH_KEY_ID, "`hash_key_id` ateina iš AUDIT_ID_SALT_ID");
  } finally {
    await auditStore.shutdown();
    await resursai.isvalyti();
  }
});

test("RAW: transkripcijos ir prompt'o turinio NĖRA", { skip: SKIP }, async () => {
  const auditStore = require("../utils/auditStore");
  const auditLog = require("../utils/auditLog");
  const { url, pool, resursai } = await paruostiDb("audit_raw_turinys");

  try {
    await auditStore.shutdown();
    await auditStore.init({
      ...process.env,
      AUDIT_BACKEND: "postgres",
      DATABASE_URL: url,
      AUDIT_ID_SALT: "testine-druska",
      AUDIT_ID_SALT_ID: HASH_KEY_ID,
      PRIVACY_MODE: "false",
    });

    /**
     * ⚠️ TURINYS PERDUODAMAS TYČIA. Produkcinis kodas jo neperduoda, bet
     * garantija turi galioti ir tada, kai kas nors ateity įdės jį netyčia -
     * būtent tam allowlist ir egzistuoja.
     */
    await auditLog.record({
      event: "PROCESSING_COMPLETED",
      jobId: "job-turinio-testas",
      success: true,
      transcript: TRANSKRIPCIJOS_SENTINEL,
      prompt: PROMPT_SENTINEL,
      transcriptionText: TRANSKRIPCIJOS_SENTINEL,
      details: "leistina reiksme",
    });

    const { rows } = await pool.query("SELECT to_jsonb(t)::text AS visa FROM audit_log t");

    for (const [pavadinimas, sentinel] of [
      ["transkripcija", TRANSKRIPCIJOS_SENTINEL],
      ["prompt'as", PROMPT_SENTINEL],
    ]) {
      assert.ok(
        !rows[0].visa.includes(sentinel),
        `${pavadinimas} rasta RAW eilutėje - \`meta\` allowlist neapsaugojo`
      );
    }

    assert.ok(rows[0].visa.includes("leistina reiksme"), "leistinas laukas privalo išlikti");
  } finally {
    await auditStore.shutdown();
    await resursai.isvalyti();
  }
});

test("RAW: `meta` JSONB turi TIK allowlist raktus", { skip: SKIP }, async () => {
  const { pool, resursai } = await paruostiDb("audit_meta_allowlist");
  try {
    const store = createPostgresStore(pool, { hashKeyId: HASH_KEY_ID });

    await store.append(
      eilute({
        details: "leistina",
        transcript: TRANSKRIPCIJOS_SENTINEL,
        jobId: JOB_SENTINEL,
        slaptasLaukas: "kazkas",
      })
    );

    const { rows } = await pool.query(
      "SELECT jsonb_object_keys(meta) AS raktas FROM audit_log"
    );
    const raktai = rows.map((r) => r.raktas);

    for (const raktas of raktai) {
      assert.ok(
        META_LAUKAI.includes(raktas),
        `\`meta\` turi neleistiną raktą "${raktas}" - allowlist neveikia rašymo metu`
      );
    }

    for (const draudžiamas of ["transcript", "jobId", "slaptasLaukas"]) {
      assert.ok(!raktai.includes(draudžiamas), `${draudžiamas} negali būti persistintas`);
    }
  } finally {
    await resursai.isvalyti();
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * IŠLIKIMAS, KELIOS INSTANCIJOS, POOL
 * ═══════════════════════════════════════════════════════════════════════════ */

test("IŠLIKIMAS: instancija A įrašo, A sunaikinama, B tą patį randa", { skip: SKIP }, async () => {
  /**
   * Tai yra visos 7.4b priežastis: atmintyje šis scenarijus neįmanomas iš
   * principo. „Instancijos sunaikinimas" modeliuojamas uždarant pool'ą - tai
   * viskas, kas siejo procesą su DB.
   */
  const { url, resursai } = await paruostiDb("audit_islikimas");
  try {
    const poolA = new Pool({ connectionString: url });
    const storeA = createPostgresStore(poolA, { hashKeyId: HASH_KEY_ID });
    const irasas = await storeA.append(eilute({ details: "pries-restarta", subjectId: "pseudo-r" }));
    await poolA.end();

    const poolB = new Pool({ connectionString: url });
    resursai.registruoti("pool B", () => poolB.end());
    const storeB = createPostgresStore(poolB, { hashKeyId: HASH_KEY_ID });

    const { entries, total } = await storeB.list();

    assert.equal(total, 1, "auditas privalo išlikti po instancijos sunaikinimo");
    assert.equal(entries[0].id, irasas.id);
    assert.equal(entries[0].details, "pries-restarta");
  } finally {
    await resursai.isvalyti();
  }
});

test("KELIOS INSTANCIJOS: dvi saugyklos toje pačioje DB mato viena kitą", { skip: SKIP }, async () => {
  const { url, resursai } = await paruostiDb("audit_multi");
  try {
    const poolA = new Pool({ connectionString: url });
    const poolB = new Pool({ connectionString: url });
    resursai.registruoti("pool A", () => poolA.end());
    resursai.registruoti("pool B", () => poolB.end());

    const storeA = createPostgresStore(poolA, { hashKeyId: HASH_KEY_ID });
    const storeB = createPostgresStore(poolB, { hashKeyId: HASH_KEY_ID });

    await storeA.append(eilute({ details: "is-A" }));
    await storeB.append(eilute({ details: "is-B" }));

    /** Abi turi matyti ABU įrašus - kitaip auditas priklausytų nuo replikos. */
    for (const [pavadinimas, store] of [["A", storeA], ["B", storeB]]) {
      const { entries } = await store.list();
      assert.deepEqual(
        entries.map((e) => e.details).sort(),
        ["is-A", "is-B"],
        `instancija ${pavadinimas} nemato kitos instancijos įrašo`
      );
    }

    /** GDPR ištrynimas vienoje instancijoje galioja ir kitai. */
    await storeA.append(eilute({ subjectId: "pseudo-trinti" }));
    assert.equal(await storeB.removeBySubject("pseudo-trinti"), 1);
    assert.equal(await storeA.countBySubject("pseudo-trinti"), 0);
  } finally {
    await resursai.isvalyti();
  }
});

test("POOL: `shutdown()` uždaro jungtis - kabančių sesijų nelieka", { skip: SKIP }, async () => {
  /**
   * ⚠️ TIKRINAMA DB PUSĖJE (`pg_stat_activity`), ne `pool.ended` vėliava.
   *
   * Vėliava pasakytų tik tai, ką `pg` mano apie save. Neuždarytos jungtys yra
   * DB resursas: jos išnaudoja `max_connections`, ir po kelių restartų nauja
   * instancija nebeprisijungtų.
   */
  const auditStore = require("../utils/auditStore");
  const { url, pool, resursai } = await paruostiDb("audit_pool");

  try {
    const dbName = new URL(url).pathname.slice(1);

    await auditStore.shutdown();
    await auditStore.init({
      ...process.env,
      AUDIT_BACKEND: "postgres",
      DATABASE_URL: url,
      AUDIT_ID_SALT: "testine-druska",
      AUDIT_ID_SALT_ID: HASH_KEY_ID,
      PRIVACY_MODE: "false",
    });

    await auditStore.current().append(eilute({ details: "jungties-testas" }));

    const kiekis = async () => {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM pg_stat_activity
          WHERE datname = $1 AND application_name <> 'psql' AND pid <> pg_backend_pid()`,
        [dbName]
      );
      return rows[0].n;
    };

    assert.ok((await kiekis()) >= 1, "prielaida: audito jungtis realiai atidaryta");

    await auditStore.shutdown();

    /** `pg_stat_activity` atsinaujina ne akimirksniu - duodam kelis bandymus. */
    let likusios = await kiekis();
    for (let i = 0; i < 20 && likusios > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      likusios = await kiekis();
    }

    assert.equal(likusios, 0, "po `shutdown()` audito jungčių DB pusėje likti negali");
  } finally {
    await auditStore.shutdown();
    await resursai.isvalyti();
  }
});

test("STARTAS: postgres režimas ĮSPĖJA apie neveikiančią retenciją", { skip: SKIP }, async () => {
  /**
   * ⚠️ TIKRINAMA, KAD ĮSPĖJIMAS REALIAI LOGINAMAS, ne tik kad konstanta egzistuoja.
   *
   * Turinį tikrina `auditStoreFields` (be DB). Čia - kad `init()` jį praleidžia
   * pro `log.warn`, ir kad startas dėl to NENUTRŪKSTA: neribotas augimas yra
   * matomumo, o ne blokavimo klausimas.
   */
  const auditStore = require("../utils/auditStore");
  const { RETENCIJOS_ISPEJIMAS } = auditStore;
  const { url, resursai } = await paruostiDb("audit_retencijos_ispejimas");

  const pagauta = [];
  const originalus = console.warn;
  console.warn = (...args) => pagauta.push(args.join(" "));

  try {
    await auditStore.shutdown();
    await auditStore.init({
      ...process.env,
      AUDIT_BACKEND: "postgres",
      DATABASE_URL: url,
      AUDIT_ID_SALT: "testine-druska",
      AUDIT_ID_SALT_ID: HASH_KEY_ID,
      PRIVACY_MODE: "false",
    });

    console.warn = originalus;

    assert.equal(auditStore.backend(), "postgres", "startas privalo pavykti - tai ĮSPĖJIMAS, ne klaida");
    assert.ok(
      pagauta.some((eil) => eil.includes("AUDIT_RETENTION_DAYS") && eil.includes("7.4d")),
      "postgres startas privalo įspėti apie neveikiančią retenciją"
    );
    assert.ok(RETENCIJOS_ISPEJIMAS.length > 50, "prielaida: konstanta nėra tuščia");
  } finally {
    console.warn = originalus;
    await auditStore.shutdown();
    await resursai.isvalyti();
  }
});

test("POOL: nustatymuose YRA laiko ribos, ir jos MAŽESNĖS už fasado langą", { skip: SKIP }, async () => {
  /**
   * ⚠️ TIKRINAMA PRIEŠ TIKRĄ ELGESĮ, ne tik konfigūraciją.
   *
   * `statement_timeout` privalo suveikti ANKSČIAU nei `AUDIT_WRITE_TIMEOUT_MS`;
   * kitaip fasadas nustotų laukti pirmas, DB užklausa liktų vykdoma, ir vėlyvas
   * rašymas po timeout taptų neišvengiamas - t. y. auditas patvirtintų
   * veiksmą, kurį kvietėjas jau atšaukė.
   */
  const { url, resursai } = await paruostiDb("audit_timeout");
  try {
    const env = { ...process.env, DATABASE_URL: url, AUDIT_WRITE_TIMEOUT_MS: "2000" };
    const nustatymai = auditoPoolNustatymai(env);

    assert.equal(nustatymai.statement_timeout, 1400);
    assert.equal(nustatymai.connectionTimeoutMillis, 400);
    assert.ok(
      nustatymai.connectionTimeoutMillis + nustatymai.statement_timeout < 2000,
      "pool ir užklausos ribos privalo tilpti į fasado langą"
    );

    /** ELGSENA: DB realiai nutraukia užklausą, viršijusią `statement_timeout`. */
    const pool = new Pool(nustatymai);
    resursai.registruoti("timeout pool", () => pool.end());

    const pradzia = Date.now();
    await assert.rejects(
      () => pool.query("SELECT pg_sleep(5)"),
      /timeout|canceling statement/i,
      "DB privalo NUTRAUKTI ilgą užklausą, o ne leisti jai baigtis"
    );
    const trukmeMs = Date.now() - pradzia;

    assert.ok(trukmeMs < 2000, `nutraukta per ${trukmeMs} ms - privalo būti anksčiau nei fasado langas`);
  } finally {
    await resursai.isvalyti();
  }
});

test("POOL: išsekęs pool'as duoda KLAIDĄ per ribotą laiką, o ne kabo", { skip: SKIP }, async () => {
  /**
   * ⚠️ #211 7.4a SKOLA. Be `connectionTimeoutMillis` išsekęs pool'as laukia
   * NERIBOTAI: `suRiba()` suveiktų, kvietėjas gautų klaidą, o užklausa liktų
   * eilėje ir įsirašytų vėliau - tiksliai tas vėlyvas rašymas, kurio vengiam.
   */
  const { url, resursai } = await paruostiDb("audit_pool_issekes");
  try {
    const pool = new Pool({
      connectionString: url,
      max: 1,
      connectionTimeoutMillis: 300,
    });
    resursai.registruoti("mažas pool", () => pool.end());

    /** Vienintelė jungtis paimama ir NEATLAISVINAMA. */
    const uzimtas = await pool.connect();

    try {
      const pradzia = Date.now();
      await assert.rejects(
        () => pool.query("SELECT 1"),
        /timeout/i,
        "išsekęs pool'as privalo duoti klaidą, o ne kabėti"
      );
      assert.ok(Date.now() - pradzia < 2000, "klaida privalo ateiti per nustatytą ribą");
    } finally {
      uzimtas.release();
    }
  } finally {
    await resursai.isvalyti();
  }
});

test("PRODUKCINIS KELIAS: DB rašymo klaida NESUKELIA `unhandledRejection`", { skip: SKIP }, async () => {
  /**
   * ⚠️ 7.4a fire-and-forget detektorius, dabar su TIKRA DB klaida.
   *
   * Atmintyje `record()` niekada nekrisdavo, tad ši šaka realiai nebuvo
   * vykdoma. Su persistentiniu backend'u nukritusi DB yra kasdienis atvejis.
   */
  const auditStore = require("../utils/auditStore");
  const { rasytiAudita, AuditWriteError } = require("../utils/auditWrite");
  const { url, resursai } = await paruostiDb("audit_unhandled");

  const pagauti = [];
  const handler = (p) => pagauti.push(p);
  process.on("unhandledRejection", handler);

  try {
    await auditStore.shutdown();
    await auditStore.init({
      ...process.env,
      AUDIT_BACKEND: "postgres",
      DATABASE_URL: url,
      AUDIT_ID_SALT: "testine-druska",
      AUDIT_ID_SALT_ID: HASH_KEY_ID,
      PRIVACY_MODE: "false",
    });

    /** Lentelė pašalinama PO inicijavimo - modeliuojam gedimą veikimo metu. */
    const pool = new Pool({ connectionString: url });
    resursai.registruoti("drop pool", () => pool.end());
    await pool.query("DROP TABLE audit_log");

    /** BLOKUOJANTIS įvykis: veiksmas privalo būti atmestas, o ne tyliai praeiti. */
    await assert.rejects(
      () => rasytiAudita({ event: "LOGIN_SUCCESS", success: true, actor: "x" }),
      (e) => e instanceof AuditWriteError,
      "DB gedimas privalo virsti `AuditWriteError`, ne tyliu praėjimu"
    );

    /** NEBLOKUOJANTIS: operacija tęsiasi, bet gedimas suskaičiuojamas. */
    assert.equal(
      await rasytiAudita({ event: "PROCESSING_FAILED", success: false }),
      null,
      "neblokuojantis gedimas neturi numušti operacijos"
    );

    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
    assert.deepEqual(pagauti, [], "nė vienas audito kelias negali palikti nesuvaldyto Promise");
  } finally {
    process.off("unhandledRejection", handler);
    await auditStore.shutdown();
    await resursai.isvalyti();
  }
});

test("STARTAS: `postgres` be `AUDIT_ID_SALT` NEPAKYLA", { skip: SKIP }, async () => {
  /**
   * ⚠️ TIKRINAMA SU TIKRA DB, nors sprendimą priima grynas jungiklis.
   *
   * Vienetinis `resolveAuditBackend()` testas įrodo, kad funkcija meta. Šis
   * įrodo, kad `init()` jos REALIAI klauso ir nesukuria pool'o - be to
   * atsitiktinė druska tyliai liktų naudojama, o GDPR ištrynimas po restarto
   * senų įrašų nerastų.
   */
  const auditStore = require("../utils/auditStore");
  const { url, resursai } = await paruostiDb("audit_be_druskos");

  try {
    await auditStore.shutdown();

    await assert.rejects(
      () =>
        auditStore.init({
          ...process.env,
          AUDIT_BACKEND: "postgres",
          DATABASE_URL: url,
          AUDIT_ID_SALT: "",
          AUDIT_ID_SALT_ID: HASH_KEY_ID,
        }),
      /AUDIT_ID_SALT/,
      "be stabilios druskos persistentinis auditas negali startuoti"
    );

    assert.equal(auditStore.backend(), "memory", "kritus init'ui neturi likti pusiau paruoštos būsenos");
  } finally {
    await auditStore.shutdown();
    await resursai.isvalyti();
  }
});

test("STARTAS: netaikyta migracija NUTRAUKIA startą", { skip: SKIP }, async () => {
  const auditStore = require("../utils/auditStore");
  const { url, pool, resursai } = await paruostiDb("audit_be_migracijos");

  try {
    await pool.query("DROP TABLE audit_log");
    await auditStore.shutdown();

    await assert.rejects(
      () =>
        auditStore.init({
          ...process.env,
          AUDIT_BACKEND: "postgres",
          DATABASE_URL: url,
          AUDIT_ID_SALT: "testine-druska",
          AUDIT_ID_SALT_ID: HASH_KEY_ID,
          PRIVACY_MODE: "false",
        }),
      /audit_log|migrate:up/,
      "trūkstama lentelė privalo nutraukti startą, o ne virsti atminties režimu"
    );
  } finally {
    await auditStore.shutdown();
    await resursai.isvalyti();
  }
});

test("STARTAS: nukritęs append-only trigeris NUTRAUKIA startą", { skip: SKIP }, async () => {
  /**
   * ⚠️ TRIGERIS NĖRA `CHECK`, tad `REQUIRED_AUDIT_CONSTRAINTS` patikra jo
   * NEMATO. Be atskiro barjero DB, kurioje trigeris nukrito, startuotų
   * sėkmingai, o audito įrašai taptų redaguojami - tyliai.
   */
  const auditStore = require("../utils/auditStore");
  const { url, pool, resursai } = await paruostiDb("audit_be_trigerio");

  try {
    await pool.query(`DROP TRIGGER ${REQUIRED_AUDIT_TRIGGER} ON audit_log`);
    await auditStore.shutdown();

    await assert.rejects(
      () =>
        auditStore.init({
          ...process.env,
          AUDIT_BACKEND: "postgres",
          DATABASE_URL: url,
          AUDIT_ID_SALT: "testine-druska",
          AUDIT_ID_SALT_ID: HASH_KEY_ID,
          PRIVACY_MODE: "false",
        }),
      new RegExp(REQUIRED_AUDIT_TRIGGER),
      "be append-only trigerio auditas taptų redaguojamas"
    );
  } finally {
    await auditStore.shutdown();
    await resursai.isvalyti();
  }
});

test("RESTARTAS: auditas išlieka per PILNĄ `init → shutdown → init` ciklą", { skip: SKIP }, async () => {
  /**
   * ⚠️ TAI ATSKIRAS TESTAS, NE „IŠVEDIMAS IŠ IŠLIKIMO".
   *
   * Ankstesnis „išgyvena restartą" teiginys rėmėsi tuo, kad pool'o uždarymas yra
   * vienintelis proceso ryšys su DB. Tai TIESA, bet neišbandyta: restartas
   * praeina ir per `shutdown()`, ir per PAKARTOTINĮ `init()` - o būtent
   * pakartotinis `init()` iš naujo tikrina lentelę, invariantus ir trigerį, iš
   * naujo skaito `AUDIT_ID_SALT_ID` ir kuria naują pool'ą. Bet kuris iš tų
   * žingsnių galėtų sulaužyti tęstinumą, o `pool.end()` testas to nepamatytų.
   *
   * ⚠️ KO ŠIS TESTAS NEĮRODO: konteinerio restarto. Image sluoksniai, volume'ai
   * ir orkestruotojo tvarka lieka nepatikrinti - tam reikėtų Docker, kurio šioje
   * aplinkoje kelti negalima. Žr. ataskaitos §PostgreSQL evidence.
   */
  const auditStore = require("../utils/auditStore");
  const auditLog = require("../utils/auditLog");
  const { url, resursai } = await paruostiDb("audit_restartas");

  const env = {
    ...process.env,
    AUDIT_BACKEND: "postgres",
    DATABASE_URL: url,
    /** ⚠️ TA PATI druska abiem paleidimams - kitaip pseudonimai nesutaptų. */
    AUDIT_ID_SALT: "stabili-druska-per-restarta",
    AUDIT_ID_SALT_ID: HASH_KEY_ID,
    PRIVACY_MODE: "false",
  };

  try {
    /* ── Pirmas „paleidimas" ─────────────────────────────────────────────── */
    await auditStore.shutdown();
    await auditStore.init(env);

    await auditLog.record({
      event: "PROCESSING_COMPLETED",
      jobId: "job-per-restarta",
      success: true,
      details: "pries-restarta",
    });

    const priesRestarta = await auditLog.getAll();
    assert.equal(priesRestarta.length, 1, "prielaida: įrašas realiai pateko į DB");

    /* ── „Restartas": visa saugykla nuleidžiama ir keliama iš naujo ──────── */
    await auditStore.shutdown();
    assert.equal(auditStore.backend(), "memory", "po shutdown saugykla atsijungia");

    await auditStore.init(env);
    assert.equal(auditStore.backend(), "postgres", "pakartotinis init privalo pavykti");

    /* ── Antras „paleidimas" mato TĄ PATĮ įrašą ──────────────────────────── */
    const poRestarto = await auditLog.getAll();

    assert.equal(poRestarto.length, 1, "auditas privalo išlikti per restartą");
    assert.equal(poRestarto[0].id, priesRestarta[0].id, "tas pats įrašas, ne naujas");
    assert.equal(poRestarto[0].details, "pries-restarta");

    /**
     * ⚠️ IR SVARBIAUSIA - GDPR KELIAS VEIKIA PO RESTARTO.
     *
     * Būtent dėl to `AUDIT_ID_SALT` tapo privaloma: su procesui lokalia
     * atsitiktine druska antrasis paleidimas skaičiuotų KITĄ pseudonimą, ir
     * `removeBySubjectIdentifier()` senų įrašų nerastų - grąžintų „ištrinta 0"
     * tyliai.
     */
    assert.equal(
      await auditLog.removeBySubjectIdentifier("job-per-restarta"),
      1,
      "po restarto GDPR ištrynimas privalo rasti PRIEŠ restartą sukurtą įrašą"
    );
  } finally {
    await auditStore.shutdown();
    await resursai.isvalyti();
  }
});
