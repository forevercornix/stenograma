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
const { createErasureMarkStore, LOCK_NAMESPACE } = require("../utils/deletionTombstones/postgresStore");
const states = require("../utils/deletionTombstones/states");

/**
 * IŠTRYNIMO ŽYMŲ PERSISTENCIJOS GARANTIJOS (#155, 7.5a / #183).
 *
 * ⚠️ ČIA TIK TAI, KO ATMINTYJE ĮRODYTI NEĮMANOMA: schemos invariantai, FK
 * NEBUVIMAS, sąlyginių `UPDATE` forma, advisory lock'o elgesys tarp DVIEJŲ
 * POOL'Ų, išlikimas po „restarto" ir tai, kad lock'as NELAIKOMAS per išorinį
 * I/O.
 *
 * ⚠️ RAW SQL, NE STORE API - ten, kur tikrinamas invariantas. Invariantas,
 * įrodytas per tą patį sluoksnį, kuris jį ir turėtų pažeisti, patikrintas
 * neteisingoje vietoje: fasadas gali filtruoti tai, ką DB realiai leidžia.
 */

const SKIP = skipWithoutPostgres();
const S = states.TOMBSTONE_STATUS;

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

const REASON = states.ERASURE_REASON.USER_REQUEST;

test("SCHEMA: `status`, `reason` ir `actor_kind` domenai enforce'inami DB, ne kode", { skip: SKIP }, async () => {
  const { pool, resursai } = await paruostiDb("erasure_schema");

  try {
    /** Teisėta eilutė praeina. */
    await pool.query(
      "INSERT INTO erasure_marks (job_id, status, reason, actor_kind) VALUES ($1, $2, $3, $4)",
      ["ok", S.PENDING, REASON, "user"]
    );

    for (const [stulpelis, reiksme] of [
      ["status", "kažkokia_būsena"],
      ["reason", "nes_norėjau"],
      ["actor_kind", "jonas@example.com"],
    ]) {
      const eilute = { job_id: `bad_${stulpelis}`, status: S.PENDING, reason: REASON, actor_kind: "user" };
      eilute[stulpelis] = reiksme;

      await assert.rejects(
        () =>
          pool.query(
            "INSERT INTO erasure_marks (job_id, status, reason, actor_kind) VALUES ($1, $2, $3, $4)",
            [eilute.job_id, eilute.status, eilute.reason, eilute.actor_kind]
          ),
        /violates check constraint/,
        `${stulpelis} = "${reiksme}" privalo būti atmesta DB LYGIU`
      );
    }
  } finally {
    await resursai.isvalyti();
  }
});

test("SCHEMA: `completed_at` ir būsena PRIVALO sutapti", { skip: SKIP }, async () => {
  /**
   * Eilutė su `deletion_failed` ir `completed_at` reikštų „nepavyko, bet štai
   * kada pavyko" - būseną, kuria remiasi ištrynimo kvitas.
   */
  const { pool, resursai } = await paruostiDb("erasure_completed_at");

  try {
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO erasure_marks (job_id, status, reason, completed_at)
           VALUES ($1, $2, $3, now())`,
          ["blogas", S.FAILED, REASON]
        ),
      /violates check constraint/,
      "nesėkmė NEGALI turėti ištrynimo laiko"
    );

    await assert.rejects(
      () =>
        pool.query(
          "INSERT INTO erasure_marks (job_id, status, reason) VALUES ($1, $2, $3)",
          ["blogas2", S.DELETED, REASON]
        ),
      /violates check constraint/,
      "`deleted` NEGALI būti be ištrynimo laiko"
    );
  } finally {
    await resursai.isvalyti();
  }
});

test("SCHEMA: `marked_at` NEKEIČIAMAS - trigeris atmeta", { skip: SKIP }, async () => {
  const { pool, resursai } = await paruostiDb("erasure_marked_at");

  try {
    await pool.query("INSERT INTO erasure_marks (job_id, status, reason) VALUES ($1, $2, $3)", [
      "j",
      S.PENDING,
      REASON,
    ]);

    await assert.rejects(
      () => pool.query("UPDATE erasure_marks SET marked_at = now() + interval '1 day' WHERE job_id = 'j'"),
      /marked_at is immutable/,
      "`marked_at` keitimas privalo būti atmestas"
    );

    /** Bet būsenos keitimas privalo VEIKTI - kitaip mašina apskritai nejudėtų. */
    const { rowCount } = await pool.query(
      "UPDATE erasure_marks SET status = $1, updated_at = now(), completed_at = now() WHERE job_id = 'j'",
      [S.DELETED]
    );
    assert.equal(rowCount, 1);
  } finally {
    await resursai.isvalyti();
  }
});

test("FK NĖRA: `jobs` eilutės ištrynimas NEPAŠALINA žymos", { skip: SKIP }, async () => {
  /**
   * ⚠️ TAI PAGRINDINIS ŠIO ETAPO INVARIANTAS. Su `ON DELETE CASCADE` žyma
   * dingtų būtent tuo momentu, kai tampa reikalinga: jobo nebėra, o vėluojanti
   * eilės žinutė nebeturėtų kas ją atmestų.
   */
  const { pool, resursai } = await paruostiDb("erasure_no_fk");

  try {
    const jobId = crypto.randomUUID();

    await pool.query(
      `INSERT INTO jobs (id, type, status, owner_kind, created_at, updated_at, schema_version)
       VALUES ($1, 'transcription', 'completed', 'unowned', now(), now(), 1)`,
      [jobId]
    );

    await pool.query("INSERT INTO erasure_marks (job_id, status, reason) VALUES ($1, $2, $3)", [
      jobId,
      S.PENDING,
      REASON,
    ]);

    await pool.query("DELETE FROM jobs WHERE id = $1", [jobId]);

    const { rows } = await pool.query("SELECT status FROM erasure_marks WHERE job_id = $1", [jobId]);

    assert.equal(rows.length, 1, "žyma PRIVALO fiziškai likti RAW lentelėje");
    assert.equal(rows[0].status, S.PENDING);

    /** Ir barjeras per store API vis dar galioja. */
    const store = createErasureMarkStore(pool);
    assert.equal(await store.isBarred(jobId), true);
  } finally {
    await resursai.isvalyti();
  }
});

test("PERĖJIMAI: `deleted` NEPERRAŠOMA vėlyvos nesėkmės", { skip: SKIP }, async () => {
  const { pool, resursai } = await paruostiDb("erasure_terminal");

  try {
    const store = createErasureMarkStore(pool);

    await store.mark("j", { reason: REASON });
    await store.transition("j", S.DELETED);

    const pries = await store.get("j");

    /** Vėluojantis nesėkmingas bandymas - tiksliai tas scenarijus, kurio bijom. */
    const rezultatas = await store.transition("j", S.FAILED);
    assert.equal(rezultatas, null, "perėjimas privalo NEĮVYKTI");

    const po = await store.get("j");
    assert.equal(po.status, S.DELETED, "būsena nepakitusi");
    assert.equal(po.completedAt, pries.completedAt, "ištrynimo laikas nepajudėjęs");

    /**
     * ⚠️ RAW SQL PATIKRA: garantija gyvena `WHERE` FORMOJE, ne JS `if`-e.
     * Tiesioginis `UPDATE` su `WHERE status = 'deletion_pending'` `deleted`
     * eilutės neliečia - tai ir yra mechanizmas.
     */
    const { rowCount } = await pool.query(
      "UPDATE erasure_marks SET status = $1 WHERE job_id = 'j' AND status = $2",
      [S.FAILED, S.PENDING]
    );
    assert.equal(rowCount, 0, "sąlyginis `UPDATE` neranda ko keisti - taip ir turi būti");
  } finally {
    await resursai.isvalyti();
  }
});

test("PERĖJIMAI: `mark()` NEPRIKELIA jau `deleted` žymos", { skip: SKIP }, async () => {
  /**
   * `ON CONFLICT DO UPDATE` čia pastumtų `marked_at` ir grąžintų terminalę žymą
   * atgal į `pending` - tos pačios klasės defektas kaip vėlyvas `failed`.
   */
  const { pool, resursai } = await paruostiDb("erasure_mark_idempotent");

  try {
    const store = createErasureMarkStore(pool);

    const pirma = await store.mark("j", { reason: REASON, actorKind: "user" });
    await store.transition("j", S.DELETED);

    const antra = await store.mark("j", { reason: states.ERASURE_REASON.OPERATOR_CLEANUP });

    assert.equal(antra.status, S.DELETED, "pakartotinis žymėjimas negrąžina į `pending`");
    assert.equal(antra.requestedAt, pirma.requestedAt, "`marked_at` nepajudėjęs");
    assert.equal(antra.reason, REASON, "pirmoji priežastis lieka autoritetinga");
  } finally {
    await resursai.isvalyti();
  }
});

test("LENKTYNĖS A: dvi instancijos, DU POOL'AI - tik viena laimi claim'ą", { skip: SKIP }, async () => {
  /**
   * ⚠️ DU NEPRIKLAUSOMI POOL'AI, NE DVI FUNKCIJOS TAME PAČIAME. Procesui lokalus
   * `Map` čia nieko negelbėtų, ir būtent to reikalauja #183: koordinacija
   * privalo veikti tarp procesų.
   *
   * Deterministiška: abi šakos paleidžiamos kartu, ir tikrinama, kad `deleted`
   * pasiekė TIK VIENA, o abi mato tą pačią galutinę būseną.
   */
  const { url, pool, resursai } = await paruostiDb("erasure_race_a");

  try {
    const antras = new Pool({ connectionString: url });
    resursai.registruoti("antras pool", () => antras.end());

    const a = createErasureMarkStore(pool);
    const b = createErasureMarkStore(antras);

    await Promise.all([a.mark("j", { reason: REASON }), b.mark("j", { reason: REASON })]);

    const [ra, rb] = await Promise.all([
      a.transition("j", S.DELETED),
      b.transition("j", S.DELETED),
    ]);

    const laimeje = [ra, rb].filter(Boolean);
    assert.equal(laimeje.length, 1, "destruktyvų perėjimą privalo įvykdyti TIK VIENA instancija");

    const [ba, bb] = await Promise.all([a.get("j"), b.get("j")]);
    assert.equal(ba.status, S.DELETED, "abi mato tą pačią galutinę būseną");
    assert.equal(bb.status, S.DELETED);
    assert.equal(ba.completedAt, bb.completedAt);
  } finally {
    await resursai.isvalyti();
  }
});

test("LENKTYNĖS B: lėtesnis bandymas krenta PO `deleted` - `deleted` išlieka", { skip: SKIP }, async () => {
  const { url, pool, resursai } = await paruostiDb("erasure_race_b");

  try {
    const antras = new Pool({ connectionString: url });
    resursai.registruoti("antras pool", () => antras.end());

    const greitas = createErasureMarkStore(pool);
    const letas = createErasureMarkStore(antras);

    await greitas.mark("j", { reason: REASON });
    await greitas.transition("j", S.DELETED);

    const veluojantis = await letas.transition("j", S.FAILED, {
      failureKind: "retryable",
    });

    assert.equal(veluojantis, null, "vėluojanti nesėkmė NEGALI pakeisti būsenos");
    assert.equal((await letas.get("j")).status, S.DELETED);
  } finally {
    await resursai.isvalyti();
  }
});

test("LENKTYNĖS C: kritimas ties `pending` - barjeras išgyvena, retry tęsia", { skip: SKIP }, async () => {
  /**
   * Kritimą imituoja jungties uždarymas: sesijinis advisory lock'as tokiu atveju
   * atlaisvinamas, o transakcinis - juo labiau. Žyma lieka `pending`.
   */
  const { url, pool, resursai } = await paruostiDb("erasure_race_c");

  try {
    const kritęs = new Pool({ connectionString: url });
    const kritusioStore = createErasureMarkStore(kritęs);

    await kritusioStore.mark("j", { reason: REASON });
    await kritęs.end(); // „procesas mirė"

    const naujas = createErasureMarkStore(pool);

    assert.equal(await naujas.isBarred("j"), true, "barjeras privalo išgyventi kritimą");
    assert.equal((await naujas.get("j")).status, S.PENDING);

    /** Jokio užstrigusio lock'o: kitas procesas gali tęsti iš karto. */
    const uzbaigta = await naujas.transition("j", S.DELETED);
    assert.ok(uzbaigta, "retry privalo galėti užbaigti");
  } finally {
    await resursai.isvalyti();
  }
});

test("LOCK'AS: NELAIKOMAS per išorinį I/O - kitas darbas vyksta tuo metu", { skip: SKIP }, async () => {
  /**
   * ⚠️ ŠIS TESTAS EGZISTUOJA DĖL #183 DoD PROOF GAP 2.
   *
   * Realizacija, apgaubianti visą ištrynimą viena ilga transakcija, praeitų
   * paprastą lenktynių testą ir produkcijoje išsemtų pool'ą. Čia išorinis I/O
   * imituojamas barjeru, kurio metu tikrinama, kad (a) TO PATIES `job_id`
   * advisory lock'as NEUŽIMTAS ir (b) kitos DB operacijos vyksta.
   *
   * Deterministiška: naudojami eksplicitiniai promise barjerai, ne `sleep`.
   */
  const { url, pool, resursai } = await paruostiDb("erasure_lock_io");

  try {
    const stebetojas = new Pool({ connectionString: url });
    resursai.registruoti("stebėtojo pool", () => stebetojas.end());

    const store = createErasureMarkStore(pool);

    let atlaisvinti;
    const isorinisIO = new Promise((r) => {
      atlaisvinti = r;
    });

    /** Claim'as baigiasi PRIEŠ išorinį I/O - tokia yra gamybinė seka. */
    await store.mark("j", { reason: REASON });

    const darbas = (async () => {
      await isorinisIO; // „failų / S3 / Redis trynimas"
      return store.transition("j", S.DELETED);
    })();

    /** Kol „I/O" kabo, lock'o niekas nelaiko. */
    const { rows } = await stebetojas.query(
      `SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND classid = $1`,
      [LOCK_NAMESPACE]
    );
    assert.equal(rows[0].n, 0, "advisory lock'as NEGALI būti laikomas per išorinį I/O");

    /** Ir nekonfliktuojantis darbas vyksta be laukimo. */
    const kitas = await store.mark("kitas_job", { reason: REASON });
    assert.equal(kitas.status, S.PENDING, "kitas job'as neužblokuotas");

    atlaisvinti();
    assert.ok(await darbas, "užbaigimas po I/O privalo pavykti");
  } finally {
    await resursai.isvalyti();
  }
});

test("7.4e SĄSAJA: `assertNotBarred()` veikia KVIETĖJO transakcijoje", { skip: SKIP }, async () => {
  /**
   * ⚠️ TOCTOU PRIELAIDA 7.4e. Barjero patikra ir kvietėjo rašymas privalo būti
   * atominiai: `SELECT ... FOR SHARE` to neduotų, nes neegzistuojanti eilutė
   * nieko neužrakina, ir lygiagretus `mark()` įsiterptų tarp jų.
   */
  const { url, pool, resursai } = await paruostiDb("erasure_toctou");

  try {
    const store = createErasureMarkStore(pool);
    const klientas = await pool.connect();
    resursai.registruoti("klientas", async () => klientas.release());

    /** Be žymos - praeina. */
    await klientas.query("BEGIN");
    await store.assertNotBarred(klientas, "svarus");
    await klientas.query("COMMIT");

    /** Su žyma - meta su atpažįstamu kodu, ne bendrine klaida. */
    await store.mark("uzbarjeruotas", { reason: REASON });

    await klientas.query("BEGIN");
    await assert.rejects(
      () => store.assertNotBarred(klientas, "uzbarjeruotas"),
      (e) => e.code === "ERASURE_BARRIER" && e.status === S.PENDING,
      "barjeras privalo būti atpažįstamas programiškai"
    );
    await klientas.query("ROLLBACK");

    /**
     * ATOMIŠKUMAS: kol kvietėjo transakcija laiko lock'ą, lygiagretus `mark()`
     * to paties `job_id` LAUKIA. Be to 7.4e patikra ir rašymas prasilenktų.
     */
    const antras = new Pool({ connectionString: url });
    resursai.registruoti("antras pool", () => antras.end());
    const kitasStore = createErasureMarkStore(antras);

    await klientas.query("BEGIN");
    await store.assertNotBarred(klientas, "lenktynes");

    let uzbaigta = false;
    const lygiagretus = kitasStore.mark("lenktynes", { reason: REASON }).then((r) => {
      uzbaigta = true;
      return r;
    });

    await new Promise((r) => setImmediate(r));
    assert.equal(uzbaigta, false, "lygiagretus žymėjimas privalo LAUKTI kvietėjo transakcijos");

    await klientas.query("COMMIT");
    assert.ok(await lygiagretus, "atleidus lock'ą žymėjimas praeina");
  } finally {
    await resursai.isvalyti();
  }
});

test("RETENCIJA: šalinamos TIK `deleted`, ribotais batch'ais", { skip: SKIP }, async () => {
  const { pool, resursai } = await paruostiDb("erasure_retention");

  try {
    const store = createErasureMarkStore(pool);
    const sena = "2000-01-01T00:00:00.000Z";

    await pool.query(
      `INSERT INTO erasure_marks (job_id, status, reason, marked_at, updated_at, completed_at)
       VALUES ('sena_deleted', $1, $2, $3, $3, $3),
              ('sena_pending', $4, $2, $3, $3, NULL),
              ('sena_failed', $5, $2, $3, $3, NULL)`,
      [S.DELETED, REASON, sena, S.PENDING, S.FAILED]
    );

    const pasalinta = await store.purgeExpired(Date.parse("2020-01-01T00:00:00.000Z"), 100);

    assert.equal(pasalinta, 1, "pašalinama TIK terminalė");

    const { rows } = await pool.query("SELECT job_id FROM erasure_marks ORDER BY job_id");
    assert.deepEqual(
      rows.map((r) => r.job_id),
      ["sena_failed", "sena_pending"],
      "neterminalės NESENSTA jokiu terminu"
    );
  } finally {
    await resursai.isvalyti();
  }
});

test("RESTORE: žyma, sukurta PO kopijos, atkūrimo NEPALIEČIAMA", { skip: SKIP }, async () => {
  /**
   * ⚠️ 7.6 SĄSAJA. `restoreService` perrašo job'us po vieną ir žymų lentelės
   * neliečia. Jei liestų - po kopijos sukurtos žymos dingtų, ir ištrinti job'ai
   * grįžtų BE tombstone, t. y. atkūrimas atšauktų GDPR ištrynimą.
   *
   * Testas tikrina MECHANIZMĄ, ne ketinimą: po pilno atkūrimo ciklo žyma
   * privalo likti fiziškai RAW lentelėje.
   */
  const { pool, resursai } = await paruostiDb("erasure_restore");

  try {
    const jobId = crypto.randomUUID();

    await pool.query(
      `INSERT INTO jobs (id, type, status, owner_kind, created_at, updated_at, schema_version)
       VALUES ($1, 'transcription', 'completed', 'unowned', now(), now(), 1)`,
      [jobId]
    );

    /** Žyma atsiranda PO to, kai kopija jau padaryta. */
    const store = createErasureMarkStore(pool);
    await store.mark(jobId, { reason: REASON });
    await store.transition(jobId, S.DELETED);

    /** Atkūrimas: job'as perrašomas iš „kopijos". */
    await pool.query(
      `INSERT INTO jobs (id, type, status, owner_kind, created_at, updated_at, schema_version)
       VALUES ($1, 'transcription', 'completed', 'unowned', now(), now(), 1)
       ON CONFLICT (id) DO UPDATE SET updated_at = now()`,
      [jobId]
    );

    const { rows } = await pool.query("SELECT status FROM erasure_marks WHERE job_id = $1", [jobId]);

    assert.equal(rows.length, 1, "žyma PRIVALO išlikti po atkūrimo");
    assert.equal(rows[0].status, S.DELETED);
    assert.equal(await store.isBarred(jobId), true, "barjeras tebegalioja");
  } finally {
    await resursai.isvalyti();
  }
});

test("RESTORE: `restoreService` niekur neliečia `erasure_marks` - tripwire", { skip: SKIP }, async () => {
  /**
   * ⚠️ TRIPWIRE (AGENTS.md §9.2) šalia elgsenos testo aukščiau. Jis gaudo
   * regresiją, kuri elgsenos teste pasirodytų tik tada, kai kas nors pridėtų
   * valymą į atkūrimo kelią.
   */
  const fs = require("node:fs");
  const { beKomentaru } = require("../utils/auditEvents");

  const saltinis = beKomentaru(
    fs.readFileSync(path.join(__dirname, "../services/restoreService.js"), "utf8")
  );

  assert.ok(
    !/erasure_marks/i.test(saltinis),
    "`restoreService` NEGALI minėti `erasure_marks` - jos gyvavimo ciklas ne jo"
  );
});
