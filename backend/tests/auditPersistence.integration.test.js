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
  REQUIRED_AUDIT_UNIQUE_CONSTRAINTS,
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

    /**
     * ⚠️ UNIKALUMO INVARIANTAI TIKRINAMI ATSKIRAI: jie yra `contype = 'u'`, tad
     * `CHECK` užklausa jų NEMATO. Be `audit_log_seq_unique` tiesioginis INSERT
     * galėtų pakartoti `seq`, ir deklaruotas tvarkos autoritetas nustotų galioti.
     */
    const { rows: uRows } = await pool.query(
      `SELECT c.conname
         FROM pg_constraint c
         JOIN pg_class t     ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE t.relname = 'audit_log' AND n.nspname = current_schema() AND c.contype = 'u'`
    );

    assert.deepEqual(
      uRows.map((r) => r.conname).sort(),
      [...REQUIRED_AUDIT_UNIQUE_CONSTRAINTS].sort(),
      "unikalumo invariantų sąrašas išsiskyrė su migracija"
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

test("STARTAS: retencijos įspėjimas kyla TIK kai `AUDIT_MAX_ENTRIES` nustatytas", { skip: SKIP }, async () => {
  /**
   * ⚠️ ŠIO TESTO DALYKAS PASIKEITĖ 7.4d (#213).
   *
   * Iki 7.4d įspėjimas kildavo KIEKVIENO postgres starto metu, nes retencija
   * ten neveikė - tai galiojo visiems. Dabar ji veikia, ir vienintelis likęs
   * skirtumas yra `AUDIT_MAX_ENTRIES`, kuris persistentinėms eilutėms
   * NETAIKOMAS.
   *
   * Todėl tikrinamos ABI pusės: nustačius kintamąjį įspėjimas privalo kilti,
   * o jo nenustačius - NE. Vien teigiama pusė leistų grąžinti besąlygišką
   * įspėjimą, kuris kiekvieno starto metu praneša apie normalią būseną - toks
   * triukšmas išmokstamas ignoruoti kartu su svarbiais pranešimais.
   */
  const auditStore = require("../utils/auditStore");
  const { RETENCIJOS_ISPEJIMAS } = auditStore;
  const { url, resursai } = await paruostiDb("audit_retencijos_ispejimas");

  const originalus = console.warn;
  const savedLogLevel = process.env.LOG_LEVEL;

  /**
   * ⚠️ `LOG_LEVEL` LAIKINAI SUŠVELNINAMAS - BE TO TESTAS MATUOJA TYLĄ.
   *
   * Šio failo viršuje nustatyta `LOG_LEVEL = "error"`, tad `log.warn()` būtų
   * filtruojamas ir `console.warn` niekada nekviečiamas: pirmoji šio testo
   * versija krito CI būtent dėl to, o ne dėl produkcinio kodo.
   */
  process.env.LOG_LEVEL = "warn";

  const paleisti = async (papildoma) => {
    const pagauta = [];
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
        ...papildoma,
      });
    } finally {
      console.warn = originalus;
    }
    return pagauta;
  };

  try {
    assert.ok(process.env.LOG_LEVEL === "warn", "prielaida: `warn` lygis įjungtas");

    /** ── Nustatytas `AUDIT_MAX_ENTRIES`: įspėjimas PRIVALO kilti ─────────── */
    const suRiba = await paleisti({ AUDIT_MAX_ENTRIES: "1000" });

    assert.equal(auditStore.backend(), "postgres", "startas privalo pavykti - tai ĮSPĖJIMAS, ne klaida");
    assert.ok(
      suRiba.some((eil) => eil.includes("AUDIT_MAX_ENTRIES")),
      "sukonfigūravus ribą, kuri persistentiškai negalioja, operatorius privalo tai sužinoti"
    );

    /** ── Nenustatytas: įspėjimo BŪTI NEGALI ──────────────────────────────── */
    const beRibos = await paleisti({ AUDIT_MAX_ENTRIES: undefined });

    assert.equal(
      beRibos.filter((eil) => eil.includes(RETENCIJOS_ISPEJIMAS)).length,
      0,
      "be sukonfigūruotos ribos įspėti nėra ko - tai būtų triukšmas kiekviename starte"
    );

    assert.ok(RETENCIJOS_ISPEJIMAS.length > 50, "prielaida: konstanta nėra tuščia");
  } finally {
    console.warn = originalus;
    if (savedLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = savedLogLevel;
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

    /**
     * ⚠️ TIKRINAMI INVARIANTAI, ne tik trys skaičiai.
     *
     * Pirmoji versija tikrino tik konkrečias reikšmes, ir kai biudžeto dalys
     * buvo perdalytos (0.2/0.7 → 0.15/0.55/0.70), testas kritо CI - o lokaliai
     * jis praleidžiamas, tad drift'as pasimatė tik po push'o. Dabar konkretūs
     * skaičiai lieka kaip kanarėlė, bet PAGRINDINIS tikrinimas yra santykiai,
     * kurie ir yra tikroji garantija.
     */
    assert.equal(nustatymai.connectionTimeoutMillis, 300, "pool 0.15 × T");
    assert.equal(nustatymai.statement_timeout, 1100, "serveris 0.55 × T");
    assert.equal(nustatymai.query_timeout, 1400, "klientas 0.70 × T");

    /** SERVERIS suveikia PIRMAS - kitaip `pg` atmestų, o užklausa liktų vykdoma. */
    assert.ok(
      nustatymai.statement_timeout < nustatymai.query_timeout,
      "serverio riba privalo būti ANKSTESNĖ už kliento"
    );
    assert.ok(
      nustatymai.connectionTimeoutMillis + nustatymai.query_timeout < 2000,
      "pool ir kliento ribos privalo tilpti į fasado langą"
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

test("STARTAS: REPLICA-ONLY trigeris NEPRALEIDŽIAMAS", { skip: SKIP }, async () => {
  /**
   * ⚠️ `ENABLE REPLICA TRIGGER` YRA PAVOJINGIAUSIAS ATVEJIS.
   *
   * Skirtingai nei `DISABLE`, jis palieka `pg_trigger` eilutę ĮJUNGTĄ atrodančią
   * (`tgenabled = 'R'`), bet trigeris suveikia TIK kai
   * `session_replication_role = 'replica'`. Aplikacijos sesijos veikia kaip
   * `origin`, tad `UPDATE` praeina.
   *
   * Testas tikrina ABI puses: kad startas atmeta IR kad `UPDATE` tokioje DB
   * realiai praeitų - kitaip tikrintume tik `tgenabled` raidę, o ne priežastį,
   * dėl kurios ji svarbi.
   */
  const auditStore = require("../utils/auditStore");
  const { url, pool, resursai } = await paruostiDb("audit_replica_trigger");

  try {
    const store = createPostgresStore(pool, { hashKeyId: HASH_KEY_ID });
    const irasas = await store.append(eilute({ details: "originalas" }));

    await pool.query(`ALTER TABLE audit_log ENABLE REPLICA TRIGGER ${REQUIRED_AUDIT_TRIGGER}`);

    /** PRIELAIDA: būtent dėl to režimas nepriimtinas - `UPDATE` nebestabdomas. */
    await pool.query("UPDATE audit_log SET result = 'failure' WHERE id = $1", [irasas.id]);
    const { rows } = await pool.query("SELECT result FROM audit_log WHERE id = $1", [irasas.id]);
    assert.equal(rows[0].result, "failure", "prielaida: replica režimu append-only NEBEVEIKIA");

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
      /tgenabled="R"|neapsaugo/,
      "replica-only trigeris privalo nutraukti startą, o ne būti palaikytas veikiančiu"
    );
  } finally {
    await auditStore.shutdown();
    await resursai.isvalyti();
  }
});

test("STARTAS: trūkstamas `seq` unikalumas NUTRAUKIA startą", { skip: SKIP }, async () => {
  /**
   * `ORDER BY seq` yra deklaruotas skaitymo tvarkos autoritetas. Be unikalumo
   * tiesioginis INSERT gali pakartoti `seq`, ir tvarka tampa neapibrėžta -
   * o `CHECK` invariantų patikra šio constraint'o nemato (`contype = 'u'`).
   */
  const auditStore = require("../utils/auditStore");
  const { url, pool, resursai } = await paruostiDb("audit_be_seq_unique");

  try {
    await pool.query(`ALTER TABLE audit_log DROP CONSTRAINT ${REQUIRED_AUDIT_UNIQUE_CONSTRAINTS[0]}`);
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
      new RegExp(REQUIRED_AUDIT_UNIQUE_CONSTRAINTS[0]),
      "be `seq` unikalumo skaitymo tvarka nebegarantuojama"
    );
  } finally {
    await auditStore.shutdown();
    await resursai.isvalyti();
  }
});

test("BENDRAS TRYNIMAS: `clear()` produkcijoje ATMETAMAS", { skip: SKIP }, async () => {
  /**
   * ⚠️ Deklaruota riba („store eksponuoja tik subjektu apribotą trynimą") turi
   * būti VYKDOMA, ne vien parašyta. Neribotas `DELETE FROM audit_log`
   * produkcijoje sunaikintų visą pėdsaką.
   */
  const { pool, resursai } = await paruostiDb("audit_clear_guard");

  const savedEnv = process.env.NODE_ENV;
  try {
    const store = createPostgresStore(pool, { hashKeyId: HASH_KEY_ID });
    await store.append(eilute({ details: "lieka" }));

    process.env.NODE_ENV = "production";
    await assert.rejects(() => store.clear(), /TIK testuose|removeBySubjectIdentifier/);

    const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM audit_log");
    assert.equal(rows[0].n, 1, "atmestas `clear()` negali nieko ištrinti");

    /** Testų režime jis privalo veikti - kitaip nebūtų kaip valyti tarp testų. */
    process.env.NODE_ENV = "test";
    await store.clear();
    const { rows: po } = await pool.query("SELECT COUNT(*)::int AS n FROM audit_log");
    assert.equal(po[0].n, 0);
  } finally {
    process.env.NODE_ENV = savedEnv;
    await resursai.isvalyti();
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 7.4c: RAKTO ROTACIJA, GENERACIJŲ SAUGA IR GDPR (#212)
 *
 * ⚠️ ČIA GYVENA RAW DB ĮRODYMAI. `auditRotation.test.js` tikrina TIK fan-out
 * logiką atmintyje ir rotacijos NEĮRODO: atminties backend'as `hash_key_id`
 * nesaugo. Ataskaitoje tai dvi atskiros eilutės.
 * ═══════════════════════════════════════════════════════════════════════════ */

const RAKTAS_A = "cm90YWNpamEtcmFrdGFzLUE";
const RAKTAS_B = "cm90YWNpamEtcmFrdGFzLUI";

/** PostgreSQL aplinka su nurodyta aktyvia generacija ir istoriniais raktais. */
function pgAplinka(url, { aktyvusId, aktyvusSecret, istoriniai = null, leistiNasliaites = false }) {
  const env = {
    ...process.env,
    AUDIT_BACKEND: "postgres",
    DATABASE_URL: url,
    AUDIT_ID_SALT: aktyvusSecret,
    AUDIT_ID_SALT_ID: aktyvusId,
    PRIVACY_MODE: "false",
  };
  if (istoriniai) env.AUDIT_ID_SALT_PREVIOUS = istoriniai;
  if (leistiNasliaites) env.AUDIT_ALLOW_UNRESOLVABLE_KEY_GENERATIONS = "true";
  return env;
}

test("ROTACIJA: RAW eilutės rodo ABI generacijas su teisingu `hash_key_id`", { skip: SKIP }, async () => {
  /**
   * ⚠️ TIKRINAMOS ABI PUSĖS. Vien `hash_key_id` buvimo nepakanka: reikia, kad
   * SENAS įrašas liktų su `A`, o NAUJAS gautų `B`, ir kad jų `subject_id`
   * SKIRTŲSI - kitaip rotacija būtų dekoracija.
   */
  const auditStore = require("../utils/auditStore");
  const auditLog = require("../utils/auditLog");
  const { url, pool, resursai } = await paruostiDb("audit_rotacija");

  try {
    await auditStore.shutdown();
    await auditStore.init(pgAplinka(url, { aktyvusId: "A", aktyvusSecret: RAKTAS_A }));
    await auditLog.record({ event: "PROCESSING_COMPLETED", jobId: "job-X", success: true });

    await auditStore.shutdown();
    await auditStore.init(
      pgAplinka(url, { aktyvusId: "B", aktyvusSecret: RAKTAS_B, istoriniai: `A:${RAKTAS_A}` })
    );
    await auditLog.record({ event: "PROCESSING_COMPLETED", jobId: "job-X", success: true });

    const { rows } = await pool.query(
      "SELECT hash_key_id, subject_id FROM audit_log ORDER BY seq ASC"
    );

    assert.equal(rows.length, 2);
    assert.equal(rows[0].hash_key_id, "A", "senas įrašas privalo LIKTI su savo generacija");
    assert.equal(rows[1].hash_key_id, "B", "naujas rašomas aktyvia generacija");
    assert.notEqual(
      rows[0].subject_id,
      rows[1].subject_id,
      "tas pats job'as skirtingose generacijose privalo turėti SKIRTINGĄ pseudonimą"
    );

    /** ⚠️ Ir nė vienoje eilutėje nėra plikojo ID. */
    const { rows: visa } = await pool.query("SELECT to_jsonb(t)::text AS visa FROM audit_log t");
    for (const r of visa) assert.ok(!r.visa.includes("job-X"), "plikas job ID RAW eilutėje");
  } finally {
    await auditStore.shutdown();
    await resursai.isvalyti();
  }
});

test("GDPR RAW: ištrynimas pašalina ĮRAŠUS IŠ VISŲ GENERACIJŲ", { skip: SKIP }, async () => {
  /**
   * ⚠️ ĮRODYMAS PER RAW EILUTES, NE `getAll()` (#212).
   *
   * Filtravimo realizacija galėtų praeiti ir su likusiomis našlaitėmis: jei
   * `getAll()` ar `query()` senos generacijos nerodo, jos atrodo ištrintos, nors
   * fiziškai lentelėje yra. GDPR klausimas yra apie eilutes, ne apie atsakymą.
   */
  const auditStore = require("../utils/auditStore");
  const auditLog = require("../utils/auditLog");
  const { url, pool, resursai } = await paruostiDb("audit_gdpr_rotacija");

  try {
    await auditStore.shutdown();
    await auditStore.init(pgAplinka(url, { aktyvusId: "A", aktyvusSecret: RAKTAS_A }));
    await auditLog.record({ event: "PROCESSING_COMPLETED", jobId: "job-X", success: true });
    await auditLog.record({ event: "PROCESSING_COMPLETED", jobId: "job-LIEKA", success: true });

    await auditStore.shutdown();
    await auditStore.init(
      pgAplinka(url, { aktyvusId: "B", aktyvusSecret: RAKTAS_B, istoriniai: `A:${RAKTAS_A}` })
    );
    await auditLog.record({ event: "PROCESSING_COMPLETED", jobId: "job-X", success: true });

    const { rows: pries } = await pool.query("SELECT COUNT(*)::int AS n FROM audit_log");
    assert.equal(pries[0].n, 3, "prielaida: trys eilutės, `job-X` dviejose generacijose");

    const pasalinta = await auditLog.removeBySubjectIdentifier("job-X");
    assert.equal(pasalinta, 2, "privalo dingti abi `job-X` generacijos");

    /** ── RAW patikra ─────────────────────────────────────────────────────── */
    const { rows: liko } = await pool.query(
      "SELECT hash_key_id, subject_id FROM audit_log ORDER BY seq ASC"
    );

    assert.equal(liko.length, 1, "lentelėje privalo likti TIK svetimo job'o eilutė");
    assert.equal(liko[0].hash_key_id, "A", "likusi eilutė yra `job-LIEKA` iš A generacijos");

    const { candidateSubjectIds, resolveKeyRing } = require("../utils/auditStore/keyRing");
    const ziedas = resolveKeyRing(
      pgAplinka(url, { aktyvusId: "B", aktyvusSecret: RAKTAS_B, istoriniai: `A:${RAKTAS_A}` }),
      { reikalaujamaAktyvausId: true }
    );

    for (const kandidatas of candidateSubjectIds(ziedas, "job-X", ["A", "B"])) {
      const { rows } = await pool.query(
        "SELECT COUNT(*)::int AS n FROM audit_log WHERE subject_id = $1",
        [kandidatas]
      );
      assert.equal(rows[0].n, 0, `generacijos pseudonimas ${kandidatas} privalo būti pašalintas`);
    }
  } finally {
    await auditStore.shutdown();
    await resursai.isvalyti();
  }
});

test("SAUGA: raktas su DB įrašais PAMIRŠTAS - startas NUTRŪKSTA", { skip: SKIP }, async () => {
  /**
   * ⚠️ TAI GDPR KORREKTIŠKUMO, NE HIGIENOS TAISYKLĖ.
   *
   * Praradus secret'ą, tų eilučių `subject_id` nebeįmanoma atkurti -
   * `removeBySubjectIdentifier()` jų NEBEPASIEKS, nors fiziškai jos egzistuoja.
   */
  const auditStore = require("../utils/auditStore");
  const auditLog = require("../utils/auditLog");
  const { url, resursai } = await paruostiDb("audit_nasliaite");

  try {
    await auditStore.shutdown();
    await auditStore.init(pgAplinka(url, { aktyvusId: "A", aktyvusSecret: RAKTAS_A }));
    await auditLog.record({ event: "PROCESSING_COMPLETED", jobId: "job-X", success: true });

    await auditStore.shutdown();

    /** `A` pašalintas iš konfigūracijos, nors DB jo įrašų dar turi. */
    await assert.rejects(
      () => auditStore.init(pgAplinka(url, { aktyvusId: "B", aktyvusSecret: RAKTAS_B })),
      /neturime rakto|A/,
      "raktas su DB įrašais negali būti pamirštas"
    );

    assert.equal(auditStore.backend(), "memory", "kritus init'ui pusiau paruoštos būsenos nelieka");
  } finally {
    await auditStore.shutdown();
    await resursai.isvalyti();
  }
});

test("SAUGA: raktas BE DB įrašų gali būti pašalintas - startas pavyksta", { skip: SKIP }, async () => {
  /**
   * ⚠️ PRIEŠINGA PUSĖ. Be jos ankstesnis testas galėtų praeiti ir tada, kai
   * startas krinta VISADA - fail-closed be išėjimo būtų ne apsauga, o spąstai.
   */
  const auditStore = require("../utils/auditStore");
  const auditLog = require("../utils/auditLog");
  const { url, pool, resursai } = await paruostiDb("audit_nasliaite_saugu");

  try {
    await auditStore.shutdown();
    await auditStore.init(pgAplinka(url, { aktyvusId: "A", aktyvusSecret: RAKTAS_A }));
    await auditLog.record({ event: "PROCESSING_COMPLETED", jobId: "job-X", success: true });

    /** Visos `A` eilutės pašalinamos - generacija tampa nebenaudojama. */
    await pool.query("DELETE FROM audit_log WHERE hash_key_id = 'A'");

    await auditStore.shutdown();
    await auditStore.init(pgAplinka(url, { aktyvusId: "B", aktyvusSecret: RAKTAS_B }));

    assert.equal(auditStore.backend(), "postgres", "be įrašų raktą pašalinti saugu");
  } finally {
    await auditStore.shutdown();
    await resursai.isvalyti();
  }
});

test("SAUGA: `AUDIT_ALLOW_UNRESOLVABLE_KEY_GENERATIONS` paleidžia, bet ĮSPĖJA", { skip: SKIP }, async () => {
  /**
   * ⚠️ ATSISTATYMO KELIAS. Negrįžtamai praradus secret'ą fail-closed kitaip
   * reikštų amžinai nepaleidžiamą backend'ą. Vėliava yra dokumentuotas SĄMONINGAS
   * GDPR garantijos laužymas, tad ji privalo RĖKTI kiekvieno starto metu.
   */
  const auditStore = require("../utils/auditStore");
  const auditLog = require("../utils/auditLog");
  const { url, resursai } = await paruostiDb("audit_escape_hatch");

  const savedLogLevel = process.env.LOG_LEVEL;
  const pagauta = [];
  const originalus = console.warn;

  try {
    await auditStore.shutdown();
    await auditStore.init(pgAplinka(url, { aktyvusId: "A", aktyvusSecret: RAKTAS_A }));
    await auditLog.record({ event: "PROCESSING_COMPLETED", jobId: "job-X", success: true });
    await auditStore.shutdown();

    /** ⚠️ `warn` lygis - žr. `auditPersistence` retencijos testo paaiškinimą. */
    process.env.LOG_LEVEL = "warn";
    console.warn = (...args) => pagauta.push(args.join(" "));

    await auditStore.init(
      pgAplinka(url, { aktyvusId: "B", aktyvusSecret: RAKTAS_B, leistiNasliaites: true })
    );

    console.warn = originalus;

    assert.equal(auditStore.backend(), "postgres", "su vėliava startas privalo pavykti");
    assert.ok(
      pagauta.some((e) => e.includes("GDPR") && e.includes("A")),
      "privalo įspėti, kad `A` generacijos įrašai tapo nepasiekiami ištrynimui"
    );
  } finally {
    console.warn = originalus;
    if (savedLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = savedLogLevel;
    await auditStore.shutdown();
    await resursai.isvalyti();
  }
});

test("KIEKIO RIBA: 11 raktų su įrašais praeina, 11 su vienu tuščiu - ne", { skip: SKIP }, async () => {
  /**
   * ⚠️ #212 SPĄSTAI: „maks. N" + „negalima pašalinti, kol yra įrašų" naiviai
   * suporuoti duotų nepaleidžiamą sistemą. Riba pažeidžiama TIK tada, kai bent
   * vienas istorinis raktas DB įrašų nebeturi - tokį pašalinti saugu.
   */
  const auditStore = require("../utils/auditStore");
  const { url, pool, resursai } = await paruostiDb("audit_kiekio_riba");

  try {
    const generacijos = Array.from({ length: 11 }, (_, i) => `g${i}`);

    /** Kiekvienai generacijai - po eilutę, tad visos yra „dar reikalingos". */
    for (const g of generacijos) {
      await pool.query(
        `INSERT INTO audit_log (id, event, hash_key_id, result)
         VALUES ($1, 'PROCESSING_COMPLETED', $2, 'success')`,
        [crypto.randomUUID(), g]
      );
    }

    const istoriniai = generacijos.map((g) => `${g}:${RAKTAS_A}`).join(",");

    await auditStore.shutdown();
    await auditStore.init(
      pgAplinka(url, { aktyvusId: "AKTYVUS", aktyvusSecret: RAKTAS_B, istoriniai })
    );
    assert.equal(auditStore.backend(), "postgres", "11 raktų SU įrašais privalo praeiti");

    /** Vienos generacijos eilutės pašalinamos - raktas tampa nebereikalingas. */
    await pool.query("DELETE FROM audit_log WHERE hash_key_id = 'g0'");
    await auditStore.shutdown();

    await assert.rejects(
      () =>
        auditStore.init(pgAplinka(url, { aktyvusId: "AKTYVUS", aktyvusSecret: RAKTAS_B, istoriniai })),
      /riba|g0/,
      "viršijus ribą nebereikalingas raktas privalo būti atmestas"
    );
  } finally {
    await auditStore.shutdown();
    await resursai.isvalyti();
  }
});

test("SKENAVIMAS: generacijų paieška naudoja INDEKSĄ, ne pilną skenavimą", { skip: SKIP }, async () => {
  /**
   * ⚠️ `SELECT DISTINCT hash_key_id` kas startą būtų pilnas augančios lentelės
   * skenavimas. Rekursyvus CTE šokinėja per `hash_key_id` indeksą: viena eilutė
   * generacijai, ne viena įrašui.
   */
  const { pool, resursai } = await paruostiDb("audit_loose_scan");

  try {
    for (let i = 0; i < 200; i += 1) {
      await pool.query(
        `INSERT INTO audit_log (id, event, hash_key_id, result)
         VALUES ($1, 'PROCESSING_COMPLETED', $2, 'success')`,
        [crypto.randomUUID(), `g${i % 3}`]
      );
    }
    await pool.query("ANALYZE audit_log");

    const { rows } = await pool.query(
      `EXPLAIN (FORMAT JSON)
       WITH RECURSIVE gen AS (
         (SELECT hash_key_id FROM audit_log ORDER BY hash_key_id LIMIT 1)
         UNION ALL
         SELECT (SELECT a.hash_key_id FROM audit_log a
                  WHERE a.hash_key_id > g.hash_key_id
                  ORDER BY a.hash_key_id LIMIT 1)
           FROM gen g WHERE g.hash_key_id IS NOT NULL
       )
       SELECT hash_key_id FROM gen WHERE hash_key_id IS NOT NULL`
    );

    const planas = JSON.stringify(rows[0]["QUERY PLAN"]);

    assert.match(planas, /Index (Only )?Scan/, "planas privalo naudoti `hash_key_id` indeksą");
    assert.ok(!/"Node Type": "Seq Scan"/.test(planas), `pilnas skenavimas plane: ${planas.slice(0, 200)}`);
  } finally {
    await resursai.isvalyti();
  }
});

test("FILTRAI: `job_id` per generacijas ir kiti filtrai - VIENA užklausa", { skip: SKIP }, async () => {
  const auditStore = require("../utils/auditStore");
  const auditLog = require("../utils/auditLog");
  const { url, resursai } = await paruostiDb("audit_filtrai_pg");

  try {
    await auditStore.shutdown();
    await auditStore.init(pgAplinka(url, { aktyvusId: "A", aktyvusSecret: RAKTAS_A }));
    await auditLog.record({ event: "LOGIN_SUCCESS", jobId: "job-X", success: true });

    await auditStore.shutdown();
    await auditStore.init(
      pgAplinka(url, { aktyvusId: "B", aktyvusSecret: RAKTAS_B, istoriniai: `A:${RAKTAS_A}` })
    );
    await auditLog.record({ event: "LOGIN_SUCCESS", jobId: "job-X", success: true });
    await auditLog.record({ event: "LOGIN_FAILED", jobId: "job-X", success: false });
    await auditLog.record({ event: "LOGIN_SUCCESS", jobId: "job-KITAS", success: true });

    /** `job_id` randa ABI generacijas. */
    const visi = await auditLog.query({ limit: 50, jobId: "job-X" });
    assert.equal(visi.entries.length, 3, "abi generacijos plius nesėkmės įrašas");

    /** `job_id` + `action` komponuojasi. */
    const filtruoti = await auditLog.query({ limit: 50, jobId: "job-X", action: "LOGIN_SUCCESS" });
    assert.equal(filtruoti.entries.length, 2, "filtrai privalo susikirsti, ne pakeisti vienas kitą");
    assert.ok(filtruoti.entries.every((e) => e.event === "LOGIN_SUCCESS"));
  } finally {
    await auditStore.shutdown();
    await resursai.isvalyti();
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * RETENCIJA IR `PRIVACY_MODE` (#155, 7.4d / #213)
 *
 * ⚠️ ČIA GYVENA TAI, KO ATMINTYJE PATIKRINTI NEĮMANOMA: tikra `timestamp`
 * riba SQL pusėje, batch'ų ribojimas DB kvietimų lygiu, dviejų instancijų
 * lygiagretumas ir RAW eilučių fizinis dingimas.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** RAW įrašas su VALDOMU laiku - `append()` laiką ima iš DB `now()`. */
async function irasytiSuLaiku(pool, { id, timestamp, hashKeyId = HASH_KEY_ID, subjectId = null }) {
  await pool.query(
    `INSERT INTO audit_log (id, timestamp, event, hash_key_id, result, subject_id)
     VALUES ($1, $2, 'PROCESSING_COMPLETED', $3, 'success', $4)`,
    [id, timestamp, hashKeyId, subjectId]
  );
}

async function kiekEilučių(pool) {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM audit_log");
  return rows[0].n;
}

test("RETENCIJA: riba TIKSLI - `< cutoff` dingsta, `== cutoff` ir `> cutoff` lieka", { skip: SKIP }, async () => {
  /**
   * ⚠️ RIBA TIKRINAMA RAW LENTELĖJE, NE PER FASADĄ.
   *
   * `== cutoff` yra fiksuotas #213 sprendimas, ir jis yra būtent ta vieta, kur
   * `<` ir `<=` skirtumas nematomas akimi, bet reiškia vieną negrįžtamai
   * ištrintą įrašą.
   */
  const { pool, resursai } = await paruostiDb("audit_retencijos_riba");

  try {
    const cutoff = "2026-06-01T00:00:00.000Z";

    await irasytiSuLaiku(pool, { id: crypto.randomUUID(), timestamp: "2026-05-31T23:59:59.999Z" });
    await irasytiSuLaiku(pool, { id: crypto.randomUUID(), timestamp: cutoff });
    await irasytiSuLaiku(pool, { id: crypto.randomUUID(), timestamp: "2026-06-01T00:00:00.001Z" });

    const store = createPostgresStore(pool, { hashKeyId: HASH_KEY_ID });
    const pasalinta = await store.purgeExpired(cutoff, 100);

    assert.equal(pasalinta, 1, "tik `< cutoff` eilutė");

    const { rows } = await pool.query("SELECT timestamp FROM audit_log ORDER BY timestamp");
    assert.equal(rows.length, 2, "`== cutoff` ir `> cutoff` privalo likti");
    assert.equal(new Date(rows[0].timestamp).toISOString(), cutoff, "riba pati NEŠALINAMA");
  } finally {
    await resursai.isvalyti();
  }
});

test("RETENCIJA: vienas DB kvietimas riboja batch'ą; didesnei aibei - keli kvietimai", { skip: SKIP }, async () => {
  /**
   * ⚠️ TIKRINAMI DB KVIETIMAI, NE GALUTINIS REZULTATAS.
   *
   * Sweep'as, kuris viską ištrina vienu neribotu `DELETE`, duotų tą patį
   * galutinį vaizdą - ir užrakintų lentelę visam trynimo laikui. Riba egzistuoja
   * dėl transakcijos trukmės, tad ir įrodymas turi būti apie kvietimus.
   */
  const { pool, resursai } = await paruostiDb("audit_retencijos_batch");

  try {
    const SENAS = "2026-01-01T00:00:00.000Z";
    for (let i = 0; i < 7; i += 1) {
      await irasytiSuLaiku(pool, { id: crypto.randomUUID(), timestamp: SENAS });
    }

    /** Pool'as-apvalkalas: skaičiuoja `DELETE` kvietimus. */
    const kvietimai = [];
    const stebimas = {
      query: (tekstas, parametrai) => {
        if (/DELETE/i.test(String(tekstas))) kvietimai.push(String(tekstas));
        return pool.query(tekstas, parametrai);
      },
    };

    const store = createPostgresStore(stebimas, { hashKeyId: HASH_KEY_ID });

    assert.equal(await store.purgeExpired("2026-06-01T00:00:00.000Z", 3), 3, "vienas kvietimas - ne daugiau nei limitas");
    assert.equal(kvietimai.length, 1);

    let iš_viso = 3;
    for (;;) {
      const kiek = await store.purgeExpired("2026-06-01T00:00:00.000Z", 3);
      iš_viso += kiek;
      if (kiek < 3) break;
    }

    assert.equal(iš_viso, 7, "ciklas pašalina visą aibę");
    assert.equal(await kiekEilučių(pool), 0);
    assert.ok(kvietimai.length >= 3, `didesnei aibei reikia kelių kvietimų, buvo ${kvietimai.length}`);

    /** ⚠️ Ir tikrai `LIMIT`, ne `DELETE` be ribos. */
    assert.match(kvietimai[0], /LIMIT/i);
    assert.match(kvietimai[0], /FOR UPDATE SKIP LOCKED/i);
  } finally {
    await resursai.isvalyti();
  }
});

test("RETENCIJA: dvi instancijos lygiagrečiai - be deadlock'o ir be likučių", { skip: SKIP }, async () => {
  /**
   * ⚠️ PROCESO LOKALI SPYNA ČIA NEGALIOJA - ir būtent todėl testas egzistuoja.
   *
   * Dvi instancijos turi atskirus pool'us ir atskiras transakcijas.
   * `FOR UPDATE SKIP LOCKED` reiškia, kad antroji praleidžia pirmosios
   * užrakintas eilutes, o ne laukia jų ar susiduria deadlock'e; trynimas
   * idempotentiškas, nes jau ištrinta eilutė nebeatrenkama.
   */
  const { url, pool, resursai } = await paruostiDb("audit_retencijos_lygiagretumas");

  try {
    const SENAS = "2026-01-01T00:00:00.000Z";
    for (let i = 0; i < 40; i += 1) {
      await irasytiSuLaiku(pool, { id: crypto.randomUUID(), timestamp: SENAS });
    }

    const poolA = new Pool({ connectionString: url });
    const poolB = new Pool({ connectionString: url });
    resursai.registruoti("instancija A", () => poolA.end());
    resursai.registruoti("instancija B", () => poolB.end());

    const sweep = async (p) => {
      const store = createPostgresStore(p, { hashKeyId: HASH_KEY_ID });
      let viso = 0;
      for (;;) {
        const kiek = await store.purgeExpired("2026-06-01T00:00:00.000Z", 5);
        viso += kiek;
        if (kiek < 5) return viso;
      }
    };

    const [a, b] = await Promise.all([sweep(poolA), sweep(poolB)]);

    assert.equal(await kiekEilučių(pool), 0, "expired eilučių likti negali");
    assert.equal(a + b, 40, "kiekviena eilutė pašalinta TIKSLIAI vieną kartą");
  } finally {
    await resursai.isvalyti();
  }
});

test("RETENCIJA: taikoma VISOMS generacijoms vienodai", { skip: SKIP }, async () => {
  const { pool, resursai } = await paruostiDb("audit_retencijos_generacijos");

  try {
    const SENAS = "2026-01-01T00:00:00.000Z";
    const NAUJAS = "2026-12-01T00:00:00.000Z";

    await irasytiSuLaiku(pool, { id: crypto.randomUUID(), timestamp: SENAS, hashKeyId: "A" });
    await irasytiSuLaiku(pool, { id: crypto.randomUUID(), timestamp: SENAS, hashKeyId: "B" });
    await irasytiSuLaiku(pool, { id: crypto.randomUUID(), timestamp: NAUJAS, hashKeyId: "A" });

    const store = createPostgresStore(pool, { hashKeyId: "B" });
    assert.equal(await store.purgeExpired("2026-06-01T00:00:00.000Z", 100), 2, "abi senos generacijos");

    const { rows } = await pool.query("SELECT hash_key_id FROM audit_log");
    assert.deepEqual(rows.map((r) => r.hash_key_id), ["A"], "liko tik naujas įrašas, nesvarbu kurios generacijos");
  } finally {
    await resursai.isvalyti();
  }
});

test("RETENCIJA ATRAKINA RAKTO IŠĖMIMĄ: A ištrinamas → A išimamas → startas praeina", { skip: SKIP }, async () => {
  /**
   * ⚠️ CIKLAS, KURIO NEUŽDARIUS 7.4c TAISYKLĖ TAPTŲ SPĄSTAIS.
   *
   * 7.4c neleidžia pašalinti rakto, kol DB yra jo `hash_key_id` įrašų. Be
   * retencijos tie įrašai neišnyktų niekada, tad istorinių raktų sąrašas galėtų
   * tik augti. Šis testas parodo išėjimą: retencija pašalina generaciją, ir
   * raktą tampa saugu išimti.
   */
  const auditStore = require("../utils/auditStore");
  const { url, pool, resursai } = await paruostiDb("audit_retencija_atrakina");

  try {
    await irasytiSuLaiku(pool, {
      id: crypto.randomUUID(),
      timestamp: "2026-01-01T00:00:00.000Z",
      hashKeyId: "A",
    });

    /** Prielaida: be istorinio rakto startas KRISTŲ - kitaip testas nieko neįrodo. */
    await auditStore.shutdown();
    await assert.rejects(
      () => auditStore.init(pgAplinka(url, { aktyvusId: "B", aktyvusSecret: RAKTAS_B })),
      /neturime rakto|NEPASIEKS/i,
      "prielaida: 7.4c fail-closed veikia"
    );

    const store = createPostgresStore(pool, { hashKeyId: "B" });
    assert.equal(await store.purgeExpired("2026-06-01T00:00:00.000Z", 100), 1);

    /** Dabar `A` DB įrašų nebeturi - jį galima išimti iš PREVIOUS. */
    await auditStore.shutdown();
    await auditStore.init(pgAplinka(url, { aktyvusId: "B", aktyvusSecret: RAKTAS_B }));

    assert.equal(auditStore.backend(), "postgres", "startas privalo pavykti");
    assert.deepEqual(auditStore.nasliaitesGeneracijos(), []);
  } finally {
    await auditStore.shutdown();
    await resursai.isvalyti();
  }
});

test("PRIVACY_MODE: RAW sentinel eilutė dingsta per startą, naujų neatsiranda", { skip: SKIP }, async () => {
  /**
   * ⚠️ ĮRODYMAS RAW LENTELĖJE, NE PER `GET /api/audit`.
   *
   * Fasadas `PRIVACY_MODE` metu grąžina tuščią sąrašą NEPRIKLAUSOMAI nuo to, ar
   * eilutės fiziškai ištrintos. Per jį tikrinant, nutildymas atrodytų kaip
   * ištrynimas - o kontraktas žada būtent ištrynimą.
   */
  const auditStore = require("../utils/auditStore");
  const auditLog = require("../utils/auditLog");
  const { url, pool, resursai } = await paruostiDb("audit_privacy_purge");

  const SENTINEL = crypto.randomUUID();

  try {
    await irasytiSuLaiku(pool, { id: SENTINEL, timestamp: "2026-06-01T00:00:00.000Z" });
    assert.equal(await kiekEilučių(pool), 1, "prielaida: eilutė DB yra");

    /**
     * ⚠️ ĮSPĖJIMAS PAKEITĖ 7.4b SARGĄ, TAD JIS TIKRINAMAS (#213).
     *
     * Iki 7.4d šis derinys buvo starto klaida. Panaikinus sargą, vienintelis
     * likęs signalas yra starto įspėjimas - be jo operatorius gautų tylią,
     * sukonfigūruotą ir amžinai tuščią audito lentelę.
     */
    const pagauta = [];
    const originalusWarn = console.warn;
    const savedLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "warn";
    console.warn = (...args) => pagauta.push(args.join(" "));

    await auditStore.shutdown();
    try {
      await auditStore.init({
        ...pgAplinka(url, { aktyvusId: "B", aktyvusSecret: RAKTAS_B }),
        PRIVACY_MODE: "true",
      });
    } finally {
      console.warn = originalusWarn;
      if (savedLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = savedLevel;
    }

    assert.ok(
      pagauta.some((eil) => eil.includes("PRIVACY_MODE=true") && /IŠJUNGTAS|NEGRĮŽTAMA/.test(eil)),
      `startas privalo garsiai įspėti apie sąmoningai išjungtą auditą: ${pagauta.join(" | ")}`
    );

    const { rows } = await pool.query("SELECT id FROM audit_log WHERE id = $1", [SENTINEL]);
    assert.equal(rows.length, 0, "sentinel eilutė privalo būti FIZIŠKAI pašalinta");

    /** Ir naujas įvykis po starto nepalieka eilutės. */
    await auditLog.record({ event: "LOGIN_SUCCESS", jobId: "job-privacy", success: true });
    assert.equal(await kiekEilučių(pool), 0, "PRIVACY_MODE metu nauji įrašai nepersistinami");

    /** `true → false`: seni negrįžta, nauji vėl rašomi. */
    await auditStore.shutdown();
    await auditStore.init(pgAplinka(url, { aktyvusId: "B", aktyvusSecret: RAKTAS_B }));

    await auditLog.record({ event: "LOGIN_SUCCESS", jobId: "job-po", success: true });

    const { rows: poIsjungimo } = await pool.query("SELECT id FROM audit_log");
    assert.equal(poIsjungimo.length, 1, "naujas įrašas rašomas");
    assert.ok(!poIsjungimo.some((r) => r.id === SENTINEL), "ištrinti įrašai NEGRĮŽTA");
  } finally {
    await auditStore.shutdown();
    await resursai.isvalyti();
  }
});

test("PRIVACY_MODE: purge vyksta PRIEŠ generacijų patikrą - našlaitės nestabdo starto", { skip: SKIP }, async () => {
  /**
   * ⚠️ TVARKOS ĮRODYMAS, KURIO KITAIP NĖRA.
   *
   * DB turi generaciją, kurios rakto nebeturime. Be teisingos tvarkos
   * `patikrintiGeneracijas()` nutrauktų startą fail-closed - dėl eilučių,
   * kurias purge tuoj pat ištrintų. Su teisinga tvarka `usedGenerations()`
   * grąžina `[]`, ir atmesti nebėra ko.
   */
  const auditStore = require("../utils/auditStore");
  const { url, pool, resursai } = await paruostiDb("audit_privacy_tvarka");

  try {
    await irasytiSuLaiku(pool, {
      id: crypto.randomUUID(),
      timestamp: "2026-06-01T00:00:00.000Z",
      hashKeyId: "PRARASTA-GENERACIJA",
    });

    /** Prielaida: BE `PRIVACY_MODE` toks startas krenta. */
    await auditStore.shutdown();
    await assert.rejects(
      () => auditStore.init(pgAplinka(url, { aktyvusId: "B", aktyvusSecret: RAKTAS_B })),
      /neturime rakto|NEPASIEKS/i,
      "prielaida: našlaitė realiai stabdo startą"
    );

    await auditStore.shutdown();
    await auditStore.init({
      ...pgAplinka(url, { aktyvusId: "B", aktyvusSecret: RAKTAS_B }),
      PRIVACY_MODE: "true",
    });

    assert.equal(auditStore.backend(), "postgres", "su PRIVACY_MODE startas privalo praeiti");
    assert.equal(await kiekEilučių(pool), 0, "eilutės pašalintos");
    assert.deepEqual(auditStore.nasliaitesGeneracijos(), [], "našlaičių nebeliko");
  } finally {
    await auditStore.shutdown();
    await resursai.isvalyti();
  }
});

test("`AUDIT_MAX_ENTRIES`: postgres režime NĖRA retencijos taisyklė", { skip: SKIP }, async () => {
  /**
   * ⚠️ ELGSENOS ĮRODYMAS, NE KONFIGŪRACIJOS TEKSTO.
   *
   * Riba buvo apsauga nuo RAM augimo. Perkelta į DB ji taptų tyliu duomenų
   * naikinimu: audito įrašas dingtų ne dėl retencijos politikos, o dėl to, kad
   * po jo atėjo pakankamai naujų.
   */
  const auditStore = require("../utils/auditStore");
  const auditLog = require("../utils/auditLog");
  const { url, pool, resursai } = await paruostiDb("audit_max_entries_pg");

  const RIBA = 3;

  try {
    await auditStore.shutdown();
    await auditStore.init({
      ...pgAplinka(url, { aktyvusId: "B", aktyvusSecret: RAKTAS_B }),
      AUDIT_MAX_ENTRIES: String(RIBA),
    });

    for (let i = 0; i < RIBA + 4; i += 1) {
      await auditLog.record({ event: "LOGIN_SUCCESS", jobId: `job-${i}`, success: true });
    }

    assert.equal(
      await kiekEilučių(pool),
      RIBA + 4,
      "eilutės neturi būti šalinamos vien dėl kiekio"
    );
  } finally {
    await auditStore.shutdown();
    await resursai.isvalyti();
  }
});

test("`DELETE` POLITIKA: trys tiksliniai keliai yra, bendro trynimo NĖRA", { skip: SKIP }, async () => {
  /**
   * ⚠️ 7.4b APSAUGA GYVENA STORE API, NE DB (migracija `DELETE` palieka atvirą,
   * kad veiktų GDPR ištrynimas). Todėl 7.4d nepridėjo „raw SQL hack'o", o pridėjo
   * du VARDU APIBRĖŽTUS kelius; bendras `clear()` produkcijoje toliau meta.
   */
  const { pool, resursai } = await paruostiDb("audit_delete_politika");

  try {
    const store = createPostgresStore(pool, { hashKeyId: HASH_KEY_ID });

    for (const metodas of ["removeBySubject", "purgeExpired", "purgeAllForPrivacy"]) {
      assert.equal(typeof store[metodas], "function", `trūksta teisėto kelio: ${metodas}`);
    }

    /** Bendras trynimas produkcijoje - vis dar užrakintas. */
    const saved = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      await assert.rejects(() => store.clear(), /TIK testuose/i, "bendras `clear()` privalo likti uždarytas");
    } finally {
      process.env.NODE_ENV = saved;
    }

    /** Ir append-only barjeras nepaliestas: `UPDATE` toliau atmetamas. */
    const id = crypto.randomUUID();
    await irasytiSuLaiku(pool, { id, timestamp: "2026-06-01T00:00:00.000Z" });
    await assert.rejects(
      () => pool.query("UPDATE audit_log SET result = 'failure' WHERE id = $1", [id]),
      (e) => e.code === "23001",
      "7.4d neturi susilpninti append-only trigerio"
    );
  } finally {
    await resursai.isvalyti();
  }
});
