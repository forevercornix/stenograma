const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { execFileSync } = require("child_process");
const crypto = require("crypto");
const { Pool } = require("pg");
const { sukurtiInjektoriu } = require("./helpers/raceInjection");

const {
  skipWithoutPostgres,
  testDatabaseUrl,
  adminDatabaseUrl,
} = require("./helpers/postgresGuard");

const {
  createPostgresStore,
  DuplicateJobError,
  TENANT_SENTINEL,
  IMMUTABLE_COLUMNS,
  PROGRESO_CAS_PREDIKATAS,
} = require("../utils/jobStore/postgresStore");
const memoryStore = require("../utils/jobStore/memoryStore");
const { PROGRESS_INVARIANTS } = require("../utils/jobPhase");
const { OWNER_KIND, normalizeFieldValue } = require("../utils/jobStore/common");
const { IVESTYS, NELEISTINOS, patchLaukai } = require("./helpers/canonicalTypeFixtures");

/**
 * `postgresStore` INTEGRACINIAI TESTAI (#155, 7.2a).
 *
 * ⚠️ TIKRAS PostgreSQL BŪTINAS. Šie testai tikrina būtent tai, ko negalima
 * patikrinti mock'u: `CHECK` constraint'ų elgesį, `NULL`/`UNKNOWN` semantiką ir
 * dalinio `UNIQUE` indekso veikimą. Be `DATABASE_URL` jie praleidžiami; CI
 * naudoja `REQUIRE_POSTGRES=1`, kad praleidimas nebūtų tylus.
 *
 * ⚠️ ATSKIRA DUOMENŲ BAZĖ. Testai vykdo migracijas, tad negali dirbti toje
 * pačioje bazėje kaip kiti - `node --test` failus vykdo lygiagrečiai.
 */

const DB_URL = testDatabaseUrl("store");
const UUID_A = "11111111-1111-1111-1111-111111111111";
const UUID_B = "22222222-2222-2222-2222-222222222222";

let pool;
let store;

async function vykdyti(url, sql) {
  const p = new Pool({ connectionString: url });
  try {
    await p.query(sql);
  } finally {
    await p.end();
  }
}

/** Įrašo eilutę APEINANT store'ą - kad būtų tikrinamas DB, ne JS. */
/**
 * Lenktynių injekcija su laiko riba (#180 P3-10) - žr. `helpers/raceInjection.js`.
 * Pool'as imamas tingiai: jis priskiriamas tik testo paruošime.
 */
const injekcijaSuRiba = sukurtiInjektoriu(() => pool);

/**
 * Laukia, kol kuri nors užklausa REALIAI užsiblokuoja ties eilutės užraktu.
 *
 * ⚠️ NE `sleep`. Tikrinama tikra sąlyga (`pg_stat_activity.wait_event_type =
 * 'Lock'`), o riba egzistuoja tik tam, kad testas kristų su aiškia žinute, o ne
 * kabotų, jei blokavimo taip ir neatsirastų.
 */
const UZRAKTO_RIBA_MS = 5000;

async function laukiantUzblokuotoUzrakto(sablonas, kontekstas) {
  const iki = Date.now() + UZRAKTO_RIBA_MS;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database()
          AND state = 'active'
          AND wait_event_type = 'Lock'
          AND query LIKE $1`,
      [sablonas]
    );
    if (rows[0].n > 0) return;
    if (Date.now() > iki) {
      throw new Error(
        `${kontekstas}: per ${UZRAKTO_RIBA_MS} ms neužsiblokavo ties eilutės užraktu - ` +
          "lenktynių eiliškumas nesusidarė, tad testas nieko neįrodytų"
      );
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function rawInsert(stulpeliai) {
  const laukai = Object.keys(stulpeliai);
  const params = laukai.map((_, i) => `$${i + 1}`).join(", ");
  await pool.query(
    `INSERT INTO jobs (${laukai.map((l) => `"${l}"`).join(", ")}) VALUES (${params})`,
    laukai.map((l) => stulpeliai[l])
  );
}

/** Bazinė galiojanti eilutė; testai perrašo tik tai, ką tikrina. */
function bazineEilute(perrasymai = {}) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    type: "transcription",
    status: "queued",
    progress_known: false,
    created_at: now,
    updated_at: now,
    ...perrasymai,
  };
}

async function atmeta(stulpeliai, kodel) {
  await assert.rejects(
    () => rawInsert(bazineEilute(stulpeliai)),
    (err) => err.code === "23514" || err.code === "23502",
    `DB PRIĖMĖ eilutę, kurios neturėtų: ${kodel}`
  );
}

async function priima(stulpeliai, kodel) {
  await assert.doesNotReject(
    () => rawInsert(bazineEilute(stulpeliai)),
    `DB ATMETĖ eilutę, kurią turėtų priimti: ${kodel}`
  );
}

test("postgresStore", { skip: skipWithoutPostgres() }, async (t) => {
  const vardas = new URL(DB_URL).pathname.replace(/^\//, "");

  await vykdyti(adminDatabaseUrl(), `DROP DATABASE IF EXISTS "${vardas}" WITH (FORCE)`);
  await vykdyti(adminDatabaseUrl(), `CREATE DATABASE "${vardas}"`);

  /**
   * Migracijos leidžiamos TUO PAČIU keliu kaip `migrations.integration.test.js`
   * ir kaip produkcija (`npm run migrate:up`) - per CLI, ne per programinį API.
   * Kitaip testas tikrintų kitą kodo kelią nei tas, kurį diegia operatorius.
   */
  execFileSync("npx", ["node-pg-migrate", "up"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, DATABASE_URL: DB_URL },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  pool = new Pool({ connectionString: DB_URL });
  store = createPostgresStore(pool);

  t.after(async () => {
    await store.close().catch(() => {});
    await vykdyti(adminDatabaseUrl(), `DROP DATABASE IF EXISTS "${vardas}" WITH (FORCE)`);
  });

  t.beforeEach(async () => {
    await pool.query("TRUNCATE jobs CASCADE");
  });

  /* ── Kontraktas ──────────────────────────────────────────────────────── */

  await t.test("deklaruoja TĄ PAČIĄ metodų aibę kaip memory backend'as", () => {
    /**
     * ⚠️ 15 → 16 (#183): pridėtas `listExpired(now, limit)`.
     *
     * KODĖL JIS KONTRAKTE. Retencija iki 7.5a trynė pasenusius job'us bendru
     * `sweepExpired()`, kuris grąžina tik KIEKĮ. Nuo #183 kiekvienas ištrynimo
     * kelias privalo palikti ištrynimo žymą PRIEŠ šalinimą, o tam reikia ID -
     * tad skaitymo metodas atsiranda šalia trynimo metodo, ne vietoj jo.
     *
     * ⚠️ KODĖL VISUOSE TRIJUOSE, nors Redis grąžina tuščią sąrašą: kontraktas
     * yra apie DEKLARAVIMĄ. Trūkstamas metodas viename backend'e reikštų, kad
     * fasadas tyliai grįžta į atsarginį kelią - būtent tai šis sargas ir gaudo.
     * Redis semantinį skirtumą (terminą vykdo `EXPIRE`, tad žymai vietos nėra)
     * įvardija `docs/deletion-guarantees.md`.
     *
     * ⚠️ Skaičius keliamas SĄMONINGAI, ne dėl žalio CI: jis yra vienintelis
     * dalykas, verčiantis kontrakto plėtimą pagrįsti.
     */
    const metodai = (s) => Object.keys(s).filter((k) => typeof s[k] === "function").sort();

    assert.deepEqual(metodai(store), metodai(memoryStore));
    assert.ok(
      metodai(store).includes("listExpired"),
      "`listExpired` yra kontrakto dalis nuo #183 - žr. paaiškinimą aukščiau"
    );
    assert.equal(metodai(store).length, 16, "kontraktas turi 16 metodų, ne 15");
  });

  /* ── tenant_id sentinelis ────────────────────────────────────────────── */

  await t.test("create() be tenantId praeina, o get() grąžina null, ne sentinelį", async () => {
    const job = await store.create({ ownerKind: OWNER_KIND.UNOWNED });

    assert.equal(job.tenantId, null);
    assert.equal((await store.get(job.id)).tenantId, null);

    const { rows } = await pool.query("SELECT tenant_id FROM jobs WHERE id = $1", [job.id]);
    assert.equal(rows[0].tenant_id, TENANT_SENTINEL, "DB turi laikyti sentinelį, ne NULL");
  });

  /* ── schemaVersion (#158) ────────────────────────────────────────────── */

  await t.test("schemaVersion išgyvena round-trip", async () => {
    const job = await store.create({ ownerKind: OWNER_KIND.UNOWNED });
    assert.equal(job.schemaVersion, 2);
    assert.equal((await store.get(job.id)).schemaVersion, 2);
  });

  await t.test("legacy įrašas atkuriamas BE schemaVersion lauko, ne su null", async () => {
    const id = crypto.randomUUID();
    await store.restoreRecord({
      id,
      type: "transcription",
      status: "processing",
      phase: null,
      progress: null,
      progressKnown: false,
      ownerId: null,
      ownerKind: null,
      tenantId: null,
      artefacts: [],
      created_at: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const atkurtas = await store.get(id);
    assert.equal("schemaVersion" in atkurtas, false, "legacy įrašas gavo erą, kurios neturėjo");
    assert.equal(atkurtas.ownerKind, null);
    assert.equal(atkurtas.status, "processing");
  });

  /* ── Rezultatų hidratacija ───────────────────────────────────────────── */

  await t.test("get/getOwned/listAll grąžina rezultatą iš job_results", async () => {
    const job = await store.create({ ownerKind: OWNER_KIND.UNOWNED });
    await store.update(job.id, { status: "processing", phase: "transcribing" });
    await store.update(job.id, { status: "completed", phase: null, result: { text: "transkripcija" } });

    const scope = { ownerKind: OWNER_KIND.UNOWNED, ownerId: null };
    assert.deepEqual((await store.get(job.id)).result, { text: "transkripcija" });
    assert.deepEqual((await store.getOwned(job.id, scope)).result, { text: "transkripcija" });
    assert.deepEqual((await store.listAll())[0].result, { text: "transkripcija" });
  });

  await t.test("job_results ištrinami kartu su job'u (ON DELETE CASCADE)", async () => {
    const job = await store.create({ ownerKind: OWNER_KIND.UNOWNED });
    await store.update(job.id, { status: "processing", phase: "transcribing" });
    await store.update(job.id, { status: "completed", phase: null, result: { a: 1 } });

    await store.remove(job.id);

    const { rows } = await pool.query("SELECT count(*)::int n FROM job_results");
    assert.equal(rows[0].n, 0);
  });

  /* ── listReferencedStorageKeys: ELGESYS, ne egzistavimas ─────────────── */

  await t.test("listReferencedStorageKeys grąžina queued IR processing raktus", async () => {
    const a = await store.create({ ownerKind: OWNER_KIND.UNOWNED, storageKey: "audio/a.wav" });
    const b = await store.create({ ownerKind: OWNER_KIND.UNOWNED, storageKey: "audio/b.wav" });
    await store.update(b.id, { status: "processing", phase: "transcribing" });

    const raktai = (await store.listReferencedStorageKeys()).sort();

    /**
     * ⚠️ `retentionSweeper` šią reikšmę traktuoja kaip įrodymą, kad JOKS gyvas
     * job'as neberodo į audio, ir tuos failus IŠTRINA. Realizacija, grąžinanti
     * `[]`, praeitų metodų aibės patikrą ir sunaikintų dar apdorojamų job'ų
     * audio - todėl tikrinamas turinys, ne tik tipas.
     */
    assert.deepEqual(raktai, ["audio/a.wav", "audio/b.wav"]);
    assert.ok(a.id && b.id);
  });

  /* ── sweepExpired ────────────────────────────────────────────────────── */

  await t.test("sweepExpired NEŠALINA jobų su nebaigtu valymu", async () => {
    const job = await store.create({ ownerKind: OWNER_KIND.UNOWNED, storageKey: "audio/x.wav" });
    await store.update(job.id, { status: "processing", phase: "transcribing" });
    await store.update(job.id, { status: "completed", phase: null, audio_cleanup_pending: true });

    assert.equal(await store.sweepExpired(Date.now() + 999e6), 0);
    assert.ok(await store.get(job.id), "jobStore įrašas yra vienintelis storageKey šaltinis");

    await store.update(job.id, { audio_cleanup_pending: false });
    assert.equal(await store.sweepExpired(Date.now() + 999e6), 1);
  });

  await t.test("sweepExpired nešalina ne-terminalių jobų", async () => {
    await store.create({ ownerKind: OWNER_KIND.UNOWNED });
    assert.equal(await store.sweepExpired(Date.now() + 999e6), 0);
  });

  /* ── Nuosavybė ───────────────────────────────────────────────────────── */

  await t.test("getOwned skiria null (nėra) nuo FORBIDDEN (svetimas)", async () => {
    const job = await store.create({ ownerKind: OWNER_KIND.USER, ownerId: UUID_A });

    assert.equal(await store.getOwned(crypto.randomUUID(), { ownerKind: OWNER_KIND.USER, ownerId: UUID_A }), null);
    assert.equal(await store.getOwned(job.id, { ownerKind: OWNER_KIND.USER, ownerId: UUID_B }), "FORBIDDEN");
    assert.equal((await store.getOwned(job.id, { ownerKind: OWNER_KIND.USER, ownerId: UUID_A })).id, job.id);
  });

  await t.test("updateOwned NEPERDUODA job'o kitam savininkui", async () => {
    const job = await store.create({ ownerKind: OWNER_KIND.USER, ownerId: UUID_A });

    /**
     * ⚠️ Realizacija, atvaizduojanti patch'o laukus tiesiai į `SET`, galėtų
     * atominiai autorizuoti kaip savininkas A ir PERDUOTI eilutę savininkui B.
     * Nekintamumą privalo užtikrinti pati backend'o operacija, ne vien
     * `applyPatch()` helperis.
     */
    const po = await store.updateOwned(
      job.id,
      { ownerId: UUID_B, ownerKind: OWNER_KIND.USER, attempt_count: 3 },
      { ownerKind: OWNER_KIND.USER, ownerId: UUID_A }
    );

    assert.equal(po.ownerId, UUID_A, "NUOSAVYBĖ PERDUOTA");
    assert.equal(po.attempt_count, 3, "patch'as nepritaikytas");
  });

  await t.test("removeOwned: unowned job'as su owner_id IS NULL veikia", async () => {
    /**
     * ⚠️ Su `= $1` (vietoj `IS NOT DISTINCT FROM`) ši operacija lūžtų KIEKVIENAM
     * ne-vartotojo job'ui: `NULL = NULL` duoda `UNKNOWN`, ir `UPDATE`/`DELETE`
     * neatitiktų nė vienos eilutės.
     */
    const job = await store.create({ ownerKind: OWNER_KIND.UNOWNED });
    const scope = { ownerKind: OWNER_KIND.UNOWNED, ownerId: null };

    assert.equal(await store.removeOwned(job.id, scope), true);
    assert.equal(await store.get(job.id), null);
  });

  await t.test("removeOwned: bendro rakto job'as neprieinamas desktop scope'ui", async () => {
    const job = await store.create({ ownerKind: OWNER_KIND.API_PRINCIPAL });

    assert.equal(
      await store.removeOwned(job.id, { ownerKind: OWNER_KIND.UNOWNED, ownerId: null }),
      "FORBIDDEN",
      "abu turi owner_id NULL - be ownerKind palyginimo jie susilietų"
    );
  });

  /* ── Idempotency ─────────────────────────────────────────────────────── */

  await t.test("tas pats idempotency_key toje pačioje nuomoje atmetamas DB", async () => {
    await store.create({ ownerKind: OWNER_KIND.UNOWNED, idempotencyKey: "raktas" });

    await assert.rejects(
      () => store.create({ ownerKind: OWNER_KIND.UNOWNED, idempotencyKey: "raktas" }),
      (err) => err instanceof DuplicateJobError && err.code === "DUPLICATE_JOB"
    );
  });

  await t.test("idempotency_key IŠLIEKA po gyvavimo ciklo update()", async () => {
    /**
     * ⚠️ REGRESIJOS TESTAS. Ankstesnė versija `rowToJob()` šio lauko
     * nehidratavo, tad pirmas `update()` perrašydavo stulpelį į `NULL` -
     * dalinis indeksas `NULL` neapima, ir pakartotinis `create()` PRAEIDAVO.
     * Idempotency dingdavo per ĮPRASTĄ round-trip.
     *
     * Ankstesnis testas to nepagavo, nes tarp dviejų `create()` nedarė
     * jokio `update()`.
     */
    const job = await store.create({ ownerKind: OWNER_KIND.UNOWNED, idempotencyKey: "gyvas" });
    assert.equal(job.idempotencyKey, "gyvas", "create() negrąžino rakto");
    assert.equal((await store.get(job.id)).idempotencyKey, "gyvas", "get() prarado raktą");

    await store.update(job.id, { status: "processing", phase: "transcribing" });
    await store.update(job.id, { status: "completed", phase: null, result: { a: 1 } });

    const { rows } = await pool.query("SELECT idempotency_key FROM jobs WHERE id = $1", [job.id]);
    assert.equal(rows[0].idempotency_key, "gyvas", "update() ištrynė raktą");

    await assert.rejects(
      () => store.create({ ownerKind: OWNER_KIND.UNOWNED, idempotencyKey: "gyvas" }),
      (err) => err instanceof DuplicateJobError
    );
  });

  await t.test("SQL SET niekada neliečia tapatybės, nuosavybės ir eros stulpelių", () => {
    /**
     * ⚠️ TIKRINAMAS KONTRAKTAS, NE ELGESYS - IR TAI SĄMONINGA.
     *
     * Elgesio testo čia parašyti neįmanoma: `writePatched()` visada eina per
     * `applyPatch()`, kuris šiuos laukus atstato, o `jobToRow()` skaito tik
     * camelCase - tad `snake_case` patch'as row builder'io nepasiekia.
     * Kelio, kuriuo reikšmė pasiektų `SET`, KOL KAS NĖRA.
     *
     * Filtras vis tiek būtinas: 7.2b įveda naujus SQL mutacijų kelius
     * (`UPDATE ... WHERE ... RETURNING`), kuriuose `applyPatch()` gali
     * nebedalyvauti. Testas fiksuoja aibę, kad tie keliai negalėtų jos
     * praplėsti nepastebimai.
     *
     * ⚠️ `schema_version` yra AUTORIZACIJOS laukas: pagal jį
     * `jobAuthorization.resolveCurrentRole()` sprendžia, ar `actor` yra
     * userId (era 2), ar username (legacy).
     */
    /**
     * ⚠️ LYGINAMA PILNA AIBĖ, ne narystė po vieną.
     *
     * `has()` kiekvienam elementui tikrina tik APATINĘ ribą: pridėjus
     * `status` ar kitą gyvavimo ciklo lauką, visos patikros vis tiek
     * praeitų, o `writePatched()` tą stulpelį praleistų KIEKVIENAME
     * atnaujinime - job'as niekada nepakeistų statuso, ir niekas to
     * nepastebėtų.
     */
    assert.deepEqual(
      [...IMMUTABLE_COLUMNS].sort(),
      [
        "created_at",
        "id",
        "idempotency_key",
        "owner_id",
        "owner_kind",
        "schema_version",
        "tenant_id",
      ],
      "IMMUTABLE_COLUMNS aibė pasikeitė - patikrinkite, ar naujas laukas tikrai nekintamas"
    );
  });

  await t.test("idempotency_key NEKINTAMAS per update()", async () => {
    const job = await store.create({ ownerKind: OWNER_KIND.UNOWNED, idempotencyKey: "pradinis" });
    const po = await store.update(job.id, { idempotencyKey: "kitas" });

    assert.equal(po.idempotencyKey, "pradinis", "kūrimo ketinimo raktas neturi būti keičiamas");
  });

  await t.test("null idempotency_key nekonfliktuoja (dalinis indeksas)", async () => {
    await store.create({ ownerKind: OWNER_KIND.UNOWNED });
    await store.create({ ownerKind: OWNER_KIND.UNOWNED });

    assert.equal(await store.size(), 2);
  });

  /* ── CHECK: nuosavybė ────────────────────────────────────────────────── */

  await t.test("owner_kind × owner_id: kiekvienas neleistinas derinys atmetamas", async () => {
    /**
     * ⚠️ KRITINIS ATVEJIS. Su `OR` grandine šis derinys duotų `UNKNOWN`, o
     * `CHECK` atmeta tik `FALSE` - DB priimtų nuosavybės būseną, kurios
     * `assertOwnerIdentity()` sukurti negali.
     */
    await atmeta({ owner_kind: null, owner_id: UUID_A }, "legacy (NULL kind) su owner_id");

    await atmeta({ owner_kind: "user", owner_id: null }, "user be ID");
    await atmeta({ owner_kind: "unowned", owner_id: UUID_A }, "unowned su ID");
    await atmeta({ owner_kind: "api-key", owner_id: UUID_A }, "bendras raktas su ID");
    await atmeta({ owner_kind: "administratorius", owner_id: null }, "nežinoma rūšis");
  });

  await t.test("owner_kind × owner_id: legacy ir unowned atskiriami DB lygyje", async () => {
    await priima({ owner_kind: null, owner_id: null }, "legacy įrašas");
    await priima({ owner_kind: "unowned", owner_id: null }, "desktop");
    await priima({ owner_kind: "api-key", owner_id: null }, "bendras raktas");
    await priima({ owner_kind: "user", owner_id: UUID_A }, "vartotojas su UUID");
  });

  /* ── CHECK: status × phase ───────────────────────────────────────────── */

  await t.test("phase leidžiama TIK processing eilutėse", async () => {
    await atmeta({ status: "queued", phase: "transcribing" }, "queued su faze");
    await atmeta({ status: "completed", phase: "transcribing" }, "completed su faze");
  });

  await t.test("DABARTINIS (schema_version=2) processing + phase=NULL ATMETAMAS", async () => {
    /**
     * ⚠️ Išimtis skirta TIK pre-#154 kopijoms. Besąlyginė ji priimtų ir
     * dabartinį įrašą, kurį `assertConsistentJobRecord()` atmeta kaip
     * `INVALID_STATUS_PHASE` - sugadinta nauja kopija būtų įrašyta ir
     * užstrigtų.
     */
    await atmeta(
      { status: "processing", phase: null, schema_version: 2 },
      "dabartinės eros processing be fazės"
    );
  });

  await t.test("LEGACY processing + phase=NULL PRIIMAMAS", async () => {
    /**
     * ⚠️ #154 tai eksplicitiškai laiko realiu pre-#154 atsarginių kopijų
     * formatu: `finish()` tokį įrašą terminalizuoja, o `restoreService`
     * perduoda `restoreRecord()` nepakeistą. Constraint'as, atmetantis šią
     * būseną, sulaužytų atkūrimo kontraktą ir galėtų nutraukti restore per
     * pusę.
     */
    await priima(
      { status: "processing", phase: null, schema_version: null },
      "legacy processing (be eros žymens)"
    );
  });

  await t.test("fazė privalo tikti JOB TIPUI, ne tik būti ne-NULL", async () => {
    /**
     * ⚠️ `phase IS NOT NULL` vieno nepakanka: praeitų
     * `type='protocol', phase='transcribing'` arba tiesiog `'bogus'`, o
     * `assertPhaseAllowedForType()` tokią porą atmeta. Sugadinta kopija būtų
     * įrašyta, o progreso ir perkrovimo operacijos ant jos kristų.
     */
    await atmeta(
      { type: "protocol", status: "processing", phase: "transcribing", schema_version: 2 },
      "protocol su transcription faze"
    );
    await atmeta(
      { type: "transcription", status: "processing", phase: "generating_protocol", schema_version: 2 },
      "transcription su protocol faze"
    );
    await atmeta(
      { type: "transcription", status: "processing", phase: "bogus", schema_version: 2 },
      "nežinoma fazė"
    );

    await priima(
      { type: "protocol", status: "processing", phase: "generating_protocol", schema_version: 2 },
      "protocol su savo faze"
    );
  });

  await t.test("CHECK fazių aibė SUTAMPA su phasesForType()", async () => {
    /**
     * ⚠️ Aibės dubliuojamos SQL'e ir JS'e; be šio testo nauja fazė būtų
     * pridėta `jobPhase.js`, o migracija liktų sena - ir DB tyliai atmestų
     * teisėtą būseną.
     */
    const { phasesForType } = require("../utils/jobPhase");

    for (const tipas of ["transcription", "protocol"]) {
      for (const faze of phasesForType(tipas)) {
        await priima(
          { type: tipas, status: "processing", phase: faze, schema_version: 2 },
          `${tipas}/${faze} turi būti priimama`
        );
      }
    }
  });

  await t.test("schema_version tik iš palaikomos aibės", async () => {
    /**
     * ⚠️ Neapribotas `integer` priimtų `schemaVersion: 3` iš ateities kopijos:
     * atkūrimas praneštų SĖKMĘ, o `authorizeJobExecution()` vėliau mestų
     * „Nepalaikoma job schemaVersion" - job'as niekada nepasileistų.
     */
    await atmeta({ schema_version: 3 }, "ateities era");
    await atmeta({ schema_version: 0 }, "nulinė era");
    await atmeta({ schema_version: -1 }, "neigiama era");

    await priima({ schema_version: null }, "legacy be eros");
    await priima({ schema_version: 2 }, "dabartinė era");
  });

  await t.test("valymo pakartojimo TERMINAI išgyvena round-trip", async () => {
    /**
     * ⚠️ `utils/deletionRetry.js` juos rašo per `jobStore.update()`, o
     * memory/Redis bet kokį patch'o lauką išsaugo (`{ ...job, ...patch }`).
     * Be stulpelio PostgreSQL juos išmestų TYLIAI: `update()` pavyktų, o kitas
     * praėjimas job'ą laikytų iškart vykdytinu - eksponentinis backoff nustotų
     * veikti, ir taip po KIEKVIENO restarto.
     */
    const terminas = new Date(Date.now() + 3600e3).toISOString();
    const job = await store.create({ ownerKind: OWNER_KIND.UNOWNED });

    await store.update(job.id, {
      deletion_pending: true,
      deletion_attempts: 2,
      deletion_next_attempt_at: terminas,
      audio_cleanup_next_attempt_at: terminas,
    });

    const po = await store.get(job.id);
    assert.equal(po.deletion_next_attempt_at, terminas);
    assert.equal(po.audio_cleanup_next_attempt_at, terminas);
    assert.equal((await store.listByFlag("deletion_pending"))[0].deletion_next_attempt_at, terminas);
  });

  /* ── CHECK: NOT NULL kaip UNKNOWN apsauga ────────────────────────────── */

  await t.test("status ir progress_known yra NOT NULL (kitaip CHECK duotų UNKNOWN)", async () => {
    await atmeta({ status: null }, "status = NULL");
    await atmeta({ progress_known: null }, "progress_known = NULL");
  });

  /* ── CHECK ↔ PROGRESS_INVARIANTS paritetas ───────────────────────────── */

  await t.test("progress_known ↔ progress_* abiem kryptim", async () => {
    await atmeta(
      { status: "processing", phase: "transcribing", progress_known: true },
      "progressKnown=true be progreso"
    );
    await atmeta(
      { status: "processing", phase: "transcribing", progress_known: false, progress_current: 1, progress_total: 2 },
      "progressKnown=false su progresu"
    );
  });

  await t.test("progresas IŠVALOMAS ne-processing eilutėse", async () => {
    /**
     * ⚠️ ATSKIRAS constraint'as. `status × phase` ir progreso patikros
     * nesikerta, tad `completed + phase=NULL + galiojantis progresas` praeitų
     * abi - nors `finish()` grąžina `progress: null, progressKnown: false`.
     * `PROGRESS_INVARIANTS` šio kryžminio ryšio neaprėpia.
     */
    await atmeta(
      { status: "completed", phase: null, progress_known: true, progress_current: 5, progress_total: 10 },
      "terminalus job'as su progresu"
    );
    await atmeta(
      { status: "queued", progress_known: true, progress_current: 5, progress_total: 10 },
      "queued su progresu"
    );
  });

  /**
   * ⚠️ SĄRAŠAS IŠVEDAMAS IŠ `PROGRESS_INVARIANTS`, ne surašomas ranka.
   *
   * Ranka surašytas rinkinys reikštų KETVIRTĄ tų pačių taisyklių kopiją
   * (predikatai, `assertValidProgress`, SQL, testas) - o pridėjus naują
   * invariantą testas liktų žalias, kol kas nors jį rankiniu būdu papildys.
   * Čia kiekvienam eksportuotam predikatui parenkama jį pažeidžianti reikšmė
   * ir tikimasi, kad DB ją atmes.
   */
  const PAZEIDIMAI = {
    "Number.isFinite(current)": [
      { current: NaN, total: 100 },
      { current: Infinity, total: 100 },
      { current: -Infinity, total: 100 },
    ],
    "Number.isFinite(total)": [
      { current: 1, total: NaN },
      { current: 1, total: Infinity },
    ],
    "total > 0": [{ current: 0, total: 0 }, { current: 0, total: -5 }],
    "current >= 0": [{ current: -1, total: 100 }],
    "current <= total": [{ current: 101, total: 100 }],
  };

  await t.test("DB constraint'ai atitinka VISUS PROGRESS_INVARIANTS", async (t2) => {
    assert.deepEqual(
      Object.keys(PAZEIDIMAI).sort(),
      PROGRESS_INVARIANTS.map((i) => i.raiska).sort(),
      "PROGRESS_INVARIANTS pasikeitė - pridėkite pažeidžiančią reikšmę naujam invariantui"
    );

    for (const invariantas of PROGRESS_INVARIANTS) {
      for (const p of PAZEIDIMAI[invariantas.raiska]) {
        await t2.test(`${invariantas.raiska}: (${p.current}, ${p.total})`, async () => {
          assert.equal(
            invariantas.tikrinti(p),
            false,
            "reikšmė turi pažeisti JS predikatą - kitaip testas netikrina nieko"
          );

          await atmeta(
            {
              status: "processing",
              phase: "transcribing",
              progress_known: true,
              progress_current: p.current,
              progress_total: p.total,
            },
            `${invariantas.raiska} praleistas DB lygyje`
          );
        });
      }
    }
  });

  await t.test("galiojantis progresas priimamas", async () => {
    await priima(
      {
        status: "processing",
        phase: "transcribing",
        progress_known: true,
        progress_current: 50,
        progress_total: 100,
      },
      "normalus progresas"
    );
  });

  await t.test("7.2b ownership CAS kontraktai ir lygiagretus delete", async () => {
    const scope = { ownerKind: "user", ownerId: UUID_A };
    const svetimas = { ownerKind: "user", ownerId: UUID_B };
    const job = await store.create({ ownerKind: scope.ownerKind, ownerId: scope.ownerId });

    assert.equal(await store.getOwned("00000000-0000-0000-0000-000000000099", scope), null);
    assert.equal(await store.getOwned(job.id, svetimas), "FORBIDDEN");
    assert.equal((await store.getOwned(job.id, scope)).id, job.id);
    assert.equal(await store.updateOwned(job.id, { requestId: "x" }, svetimas), "FORBIDDEN");
    assert.equal((await store.updateOwned(job.id, { requestId: "x", ownerId: UUID_B,
      schemaVersion: 999 }, scope)).requestId, "x");
    const nepakites = await store.get(job.id);
    assert.equal(nepakites.ownerId, UUID_A);
    assert.equal(nepakites.schemaVersion, 2);

    const outcomes = await Promise.all([
      store.removeOwned(job.id, scope),
      store.removeOwned(job.id, scope),
    ]);
    assert.deepEqual(outcomes.sort(), [false, true]);
  });

  await t.test("7.2b progreso CAS deterministiškai atmeta tarp read ir UPDATE pasikeitusią fazę", async () => {
    const job = await store.create({ ownerKind: OWNER_KIND.UNOWNED });
    await store.update(job.id, {
      status: "processing", phase: "transcribing", progressKnown: true,
      progress: { current: 1, total: 10 },
    });

    let intercepted = false;
    let casRowCount = null;
    const racingPool = {
      connect: async () => {
        const client = await pool.connect();
        return {
          release: () => client.release(),
          query: async (sql, params) => {
            if (!intercepted && /^WITH mutacija AS/.test(sql) && /progress_known IS NOT DISTINCT FROM/.test(sql)) {
              intercepted = true;
              await injekcijaSuRiba(
                "UPDATE jobs SET phase = 'diarizing', progress_known = false, " +
                  "progress_current = NULL, progress_total = NULL WHERE id = $1",
                [job.id],
                "progreso CAS: pasikeitusi faze");
              const result = await client.query(sql, params);
              casRowCount = result.rows[0].pakeista;
              return result;
            }
            return client.query(sql, params);
          },
        };
      },
      end: async () => {},
    };
    const racingStore = createPostgresStore(racingPool);
    const outcome = await racingStore.reportProgressAtomic(job.id, {
      phase: "transcribing", progress: { current: 5, total: 10 },
    });

    assert.equal(intercepted, true, "prielaida: mutacija įterpta tarp read ir CAS");
    assert.equal(casRowCount, 0, "stale CAS UPDATE privalo pakeisti 0 eilučių");
    assert.equal(outcome, "REJECTED");
  });


  await t.test("7.2b progreso CAS atmeta tarp read ir UPDATE pasikeitusį tipą", async () => {
    const job = await store.create({ ownerKind: OWNER_KIND.UNOWNED });
    await store.update(job.id, {
      status: "processing", phase: "transcribing", progressKnown: true,
      progress: { current: 1, total: 10 },
    });
    let intercepted = false;
    let casRowCount = null;
    const racingPool = {
      connect: async () => {
        const client = await pool.connect();
        return { release: () => client.release(), query: async (sql, params) => {
          if (!intercepted && /^WITH mutacija AS/.test(sql) && /type = \$2/.test(sql)) {
            intercepted = true;
            await injekcijaSuRiba(
              "UPDATE jobs SET type = 'protocol', phase = 'generating_protocol', " +
                "progress_known = false, progress_current = NULL, progress_total = NULL WHERE id = $1",
              [job.id],
              "progreso CAS: pasikeites tipas");
            const result = await client.query(sql, params);
            casRowCount = result.rows[0].pakeista;
            return result;
          }
          return client.query(sql, params);
        } };
      }, end: async () => {},
    };
    const outcome = await createPostgresStore(racingPool).reportProgressAtomic(job.id, {
      phase: "transcribing", progress: { current: 5, total: 10 },
    });
    assert.equal(intercepted, true, "tipas pakeistas tarp initial read ir CAS UPDATE");
    assert.equal(casRowCount, 0, "stale type CAS UPDATE privalo pakeisti 0 eilučių");
    assert.equal(outcome, "REJECTED");
    assert.equal((await store.get(job.id)).type, "protocol");
  });


  await t.test("7.2b ownership CAS atmeta scope pakeitimą tarp read ir UPDATE", async () => {
    const scope = { ownerKind: "user", ownerId: UUID_A };
    const job = await store.create({ ownerKind: scope.ownerKind, ownerId: scope.ownerId });
    let casRowCount = null;
    const racingPool = {
      connect: async () => {
        const client = await pool.connect();
        return { release: () => client.release(), query: async (sql, params) => {
          if (casRowCount === null && /^WITH mutacija AS/.test(sql) && /owner_id IS NOT DISTINCT FROM/.test(sql)) {
            await injekcijaSuRiba("UPDATE jobs SET owner_id = $2 WHERE id = $1", [job.id, UUID_B],
              "nuosavybes CAS: pasikeites scope");
            const result = await client.query(sql, params);
            casRowCount = result.rows[0].pakeista;
            return result;
          }
          return client.query(sql, params);
        } };
      }, end: async () => {},
    };
    const outcome = await createPostgresStore(racingPool).updateOwned(
      job.id, { requestId: "must-not-write" }, scope
    );
    assert.equal(casRowCount, 0);
    assert.equal(outcome, "FORBIDDEN");
    assert.equal((await store.get(job.id)).requestId, null);
  });


  await t.test(
    "#180 P2-B: po CAS atsiradusi eilutė NEIŠTRINAMA ir nevirsta FORBIDDEN",
    async () => {
      /**
       * ⚠️ ŠIS TESTAS PAKEITĖ ANKSTESNĮ 7.2b VARIANTĄ.
       *
       * Anksčiau čia buvo tikrinama, kad po CAS atsiradusi SAVA eilutė
       * pakartotinai ištrinama ir grąžinama `true`. MVCC peržiūra parodė, kad
       * tai neteisinga: eilutės, atsiradusios JAU PO operacijos snapshot'o,
       * kvietėjas niekada neprašė šalinti - `restoreRecord()` (DELETE + INSERT)
       * ką tik atkurtas įrašas būtų tyliai sunaikintas, o atsakymas skelbtų
       * sėkmę.
       *
       * Kontraktas (#180, 2 punktas): „job neegzistuoja → false". CAS
       * snapshot'e eilutės nebuvo, tad `false`.
       *
       * MUTACIJOS ĮRODYMAS: pašalinus `buvo === 0` trumpąjį kelią ir grąžinus
       * pakartojimą per `readJobForUpdate()`, `outcome` taptų `true`, o įterpta
       * eilutė - ištrinta; abu žemiau esantys tikrinimai krinta.
       */
      const id = crypto.randomUUID();
      const scope = { ownerKind: "user", ownerId: UUID_A };

      let intercepted = false;
      let casBuvo = null;
      let casPakeista = null;
      const racingPool = {
        connect: async () => {
          const client = await pool.connect();
          return {
            release: () => client.release(),
            query: async (sql, params) => {
              if (!intercepted && /^WITH mutacija AS/.test(sql) && /DELETE FROM jobs/.test(sql)) {
                intercepted = true;
                const result = await client.query(sql, params);
                casBuvo = result.rows[0].buvo;
                casPakeista = result.rows[0].pakeista;
                /** SAVA eilutė atsiranda TIK PO CAS - jos snapshot'e nebuvo. */
                await rawInsert(bazineEilute({
                  id, owner_kind: scope.ownerKind, owner_id: scope.ownerId,
                }));
                return result;
              }
              return client.query(sql, params);
            },
          };
        },
        end: async () => {},
      };

      const outcome = await createPostgresStore(racingPool).removeOwned(id, scope);

      assert.equal(intercepted, true, "prielaida: CAS perimtas");
      assert.equal(casPakeista, 0, "CAS privalo pakeisti 0 eilučių");
      assert.equal(casBuvo, 0, "CAS snapshot'e eilutės NEBUVO");
      assert.equal(outcome, false,
        "po snapshot'o atsiradusi eilutė negali paversti atsakymo į true (nei į FORBIDDEN)");

      /** ⚠️ ESMĖ: naujoji inkarnacija privalo IŠLIKTI. */
      const naujoji = await store.get(id);
      assert.notEqual(naujoji, null,
        "eilutė, sukurta po operacijos snapshot'o, negali būti ištrinta");
      assert.equal(naujoji.ownerId, UUID_A);
      await pool.query("DELETE FROM jobs WHERE id = $1", [id]);
    }
  );

  await t.test("7.2b klaida po job CAS rollbackina job ir result, o connection grįžta pool'ui", async () => {
    const scope = { ownerKind: OWNER_KIND.UNOWNED, ownerId: null };
    const job = await store.create({ ownerKind: OWNER_KIND.UNOWNED });
    await store.update(job.id, { result: { version: "before" } });
    const cyclic = {};
    cyclic.self = cyclic;

    /**
     * ⚠️ SENOS JUNGTIES PATIKROS BUVO TIESA IR GEDIMO ATVEJU (#180 P3-9).
     *
     * `pool.waitingCount === 0` galioja visada, kol pool'as neišsemtas, o
     * `pool.query("SELECT 1")` pavyksta net nutekėjus vienam klientui
     * (numatytas `max` = 10). Abi patikros praeidavo IR tada, kai `release()`
     * nebūdavo iškviestas - t. y. „connection grąžintas" buvo TEIGIAMA, ne
     * įrodoma.
     *
     * Dabar sekamas KONKRETUS transakcijos klientas: `release()` privalo būti
     * iškviestas lygiai vieną kartą. Vienos jungties nutekėjimas krinta iš
     * karto, nelaukiant, kol pool'as išseks.
     */
    let prisijungimai = 0;
    let atlaisvinimai = 0;
    const stebimasPool = {
      connect: async () => {
        prisijungimai++;
        const klientas = await pool.connect();
        return {
          query: (...a) => klientas.query(...a),
          release: (...a) => { atlaisvinimai++; return klientas.release(...a); },
        };
      },
      end: async () => {},
    };

    const laisviPries = pool.idleCount;

    await assert.rejects(
      () => createPostgresStore(stebimasPool)
        .updateOwned(job.id, { requestId: "must-rollback", result: cyclic }, scope),
      (err) => err instanceof TypeError
    );

    /** Rollback įrodymas nepakito. */
    const after = await store.get(job.id);
    assert.equal(after.requestId, null, "jobs UPDATE turi būti rollbackintas");
    assert.deepEqual(after.result, { version: "before" }, "job_results turi likti suderintas");

    /** ⚠️ ESMINIS P3-9 ĮRODYMAS. */
    assert.equal(prisijungimai, 1, "transakcija privalo paimti tiksliai vieną klientą");
    assert.equal(atlaisvinimai, 1,
      "klientas privalo būti grąžintas pool'ui lygiai kartą - `release()` neiškviestas");

    /**
     * Antras, nepriklausomas patvirtinimas: pool'o laisvų jungčių skaičius
     * atsistatė. Skirtingai nei `waitingCount`, ši reikšmė realiai sumažėja
     * nutekėjus klientui.
     */
    assert.equal(pool.idleCount, laisviPries,
      "pool'o laisvų jungčių skaičius po rollback privalo atsistatyti");
  });


  await t.test("7.2b concurrent progress CAS deterministiškai išlaiko monotoniškumą", async () => {
    const job = await store.create({ ownerKind: OWNER_KIND.UNOWNED });
    await store.update(job.id, { status: "processing", phase: "transcribing",
      progressKnown: true, progress: { current: 1, total: 10 } });
    let casRowCount = null;
    const racingPool = {
      connect: async () => {
        const client = await pool.connect();
        return { release: () => client.release(), query: async (sql, params) => {
          if (casRowCount === null && /^WITH mutacija AS/.test(sql) && /progress_current IS NOT DISTINCT FROM/.test(sql)) {
            await injekcijaSuRiba("UPDATE jobs SET progress_current = 7 WHERE id = $1", [job.id],
              "progreso CAS: monotoniskumas");
            const result = await client.query(sql, params);
            casRowCount = result.rows[0].pakeista;
            return result;
          }
          return client.query(sql, params);
        } };
      }, end: async () => {},
    };
    const stale = await createPostgresStore(racingPool).reportProgressAtomic(job.id, {
      phase: "transcribing", progress: { current: 5, total: 10 },
    });
    assert.equal(casRowCount, 0);
    assert.equal(stale, "REJECTED");
    assert.deepEqual((await store.get(job.id)).progress, { current: 7, total: 10 });
  });

  await t.test("7.2b PostgreSQL infrastruktūros klaida netampa domeno sentineliu", async () => {
    const job = await store.create({ ownerKind: OWNER_KIND.UNOWNED });
    await store.update(job.id, { status: "processing", phase: "transcribing" });
    const expected = Object.assign(new Error("connection lost"), { code: "08006" });
    const failingPool = {
      connect: async () => {
        const client = await pool.connect();
        return { release: () => client.release(), query: async (sql, params) => {
          if (/^WITH mutacija AS/.test(sql) && /progress_known IS NOT DISTINCT FROM/.test(sql)) throw expected;
          return client.query(sql, params);
        } };
      }, end: async () => {},
    };
    await assert.rejects(
      () => createPostgresStore(failingPool).reportProgressAtomic(job.id, {
        phase: "transcribing", progress: { current: 1, total: 10 },
      }),
      (err) => err === expected && err.code === "08006"
    );
  });

  await t.test(
    "#180 P1-1: pavykęs progreso CAS NEATSUKA konkurentinių ne-predikato stulpelių",
    async () => {
      /**
       * ⚠️ PRARASTO ATNAUJINIMO REGRESIJA.
       *
       * Kiti šio failo lenktynių testai tikrina CAS NESĖKMĘ (`rowCount = 0`,
       * `"REJECTED"`) - t. y. atvejį, kai konkurentas pakeitė PREDIKATO lauką.
       * Čia tikrinamas priešingas ir pavojingesnis atvejis: konkurentas keičia
       * lauką, kurio predikate NĖRA, tad CAS teisėtai PAVYKSTA - ir klausimas
       * yra, ką tas sėkmingas `UPDATE` įrašo į LIKUSIUS stulpelius.
       *
       * Platus `SET` (visi `COLUMNS` be `IMMUTABLE_COLUMNS`) juos rašo iš
       * PASENUSIO snapshot'o, tad `deletion_pending = true` tyliai virstų
       * `false`, o `listByFlag("deletion_pending")` job'o nebematytų -
       * pakartotinis ištrynimas (`jobErasure.js`) niekada neįvyktų.
       *
       * MUTACIJOS ĮRODYMAS: grąžinus `changedColumns()` į
       * `COLUMNS.filter((c) => !IMMUTABLE_COLUMNS.has(c))`, trys žemiau esantys
       * `po.*` tikrinimai krinta (`deletion_pending`, `deletion_attempts`,
       * `storageKey` atsisuka į pradines reikšmes). Vien `outcome` tikrinimo
       * NEPAKAKTŲ - jis praeitų ir su plačiu `SET`.
       *
       * DETERMINISTIŠKUMAS: konkurentinė mutacija įterpiama per adapterio hook'ą
       * TIKSLIAI tarp pradinio `readJob()` ir CAS `UPDATE`, ne pasikliaujant
       * scheduler'iu.
       */
      const job = await store.create({ ownerKind: OWNER_KIND.UNOWNED });
      await store.update(job.id, {
        status: "processing", phase: "transcribing", progressKnown: true,
        progress: { current: 1, total: 10 },
      });

      let intercepted = false;
      let casRowCount = null;
      let casSql = null;
      const racingPool = {
        connect: async () => {
          const client = await pool.connect();
          return {
            release: () => client.release(),
            query: async (sql, params) => {
              if (
                !intercepted &&
                /^WITH mutacija AS/.test(sql) &&
                /progress_known IS NOT DISTINCT FROM/.test(sql)
              ) {
                intercepted = true;
                /**
                 * Nė vieno iš šių stulpelių NĖRA progreso CAS predikate, tad
                 * CAS privalo pavykti - ir jų nepaliesti.
                 */
                await injekcijaSuRiba(
                  `UPDATE jobs SET deletion_pending = true, deletion_attempts = 3,
                     storage_key = 'konkurentinis', attempt_count = 7
                   WHERE id = $1`,
                  [job.id],
                  "P1-1: ne-predikato stulpeliai");
                const result = await client.query(sql, params);
                casSql = sql;
                casRowCount = result.rows[0].pakeista;
                return result;
              }
              return client.query(sql, params);
            },
          };
        },
        end: async () => {},
      };

      const outcome = await createPostgresStore(racingPool).reportProgressAtomic(job.id, {
        phase: "transcribing", progress: { current: 5, total: 10 },
      });

      assert.equal(intercepted, true,
        "prielaida: konkurentinė mutacija įterpta tarp read ir CAS UPDATE");
      assert.equal(casRowCount, 1,
        "CAS privalo PAVYKTI - nė vienas predikato stulpelis nepasikeitė");
      assert.notEqual(outcome, "REJECTED");
      assert.notEqual(outcome, null);
      assert.deepEqual(outcome.progress, { current: 5, total: 10 },
        "progresas privalo būti pritaikytas");

      /**
       * ⚠️ ESMINIAI TIKRINIMAI. Konkurentinės reikšmės privalo IŠLIKTI - jos
       * užcommitintos PO to, kai `reportProgressAtomic()` nuskaitė savo
       * snapshot'ą.
       */
      const po = await store.get(job.id);
      assert.deepEqual(po.progress, { current: 5, total: 10 });
      assert.equal(po.deletion_pending, true,
        "konkurentinis deletion_pending atsuktas atgal - prarastas atnaujinimas");
      assert.equal(po.deletion_attempts, 3,
        "konkurentinis deletion_attempts atsuktas atgal - prarastas atnaujinimas");
      assert.equal(po.storageKey, "konkurentinis",
        "konkurentinis storage_key atsuktas atgal - prarastas atnaujinimas");
      assert.equal(po.attempt_count, 7,
        "konkurentinis attempt_count atsuktas atgal - prarastas atnaujinimas");

      /**
       * ⚠️ TRIPWIRE, ne elgesio įrodymas (AGENTS.md §9.2). Elgesį įrodo `po.*`
       * tikrinimai aukščiau; ši eilutė tik greičiau parodo PRIEŽASTĮ, jei
       * `SET` sąrašas kada nors vėl išplistų.
       */
      const setDalis = casSql.slice(0, casSql.indexOf("WHERE"));
      for (const stulpelis of ["deletion_pending", "storage_key", "attempt_count"]) {
        assert.equal(setDalis.includes(`"${stulpelis}"`), false,
          `SET sąrašas neturi liesti nepakeisto stulpelio "${stulpelis}"`);
      }
      /** Grąžinamas objektas irgi privalo rodyti TIKRĄ būseną, ne snapshot'ą. */
      assert.equal(outcome.deletion_pending, true,
        "grąžinamas job'as privalo rodyti konkurentinę būseną, ne pasenusį snapshot'ą");
    }
  );

  await t.test(
    "#180 P2-2: pavykęs nuosavybės CAS NEATSUKA konkurentinių ne-patch'o stulpelių",
    async () => {
      /**
       * ⚠️ PRARASTO ATNAUJINIMO REGRESIJA NUOSAVYBĖS KELYJE.
       *
       * `updateOwned()` CAS predikatas tikrina TIK nuosavybę, o nuosavybė yra
       * NEKINTAMA (`IMMUTABLE_COLUMNS`). Vadinasi, predikatas sutampa su
       * KIEKVIENU konkurentiniu rašymu - jis niekada nepagaus svetimo
       * pakeitimo. Tai iš esmės skiriasi nuo progreso CAS, kur pats predikatas
       * atmeta pasenusį įvykį.
       *
       * Todėl vienintelė apsauga yra `SET` sąrašo siaurumas: rašomi tik
       * patch'o REALIAI pakeisti stulpeliai. Platus `SET` (visi `COLUMNS` be
       * `IMMUTABLE_COLUMNS`) tyliai atsuktų `phase`, `attempt_count`,
       * `deletion_pending` ir `deletion_attempts` į pasenusias reikšmes, o
       * operacija vis tiek grąžintų sėkmę.
       *
       * MUTACIJOS ĮRODYMAS: grąžinus `changedColumns(...)` į
       * `COLUMNS.filter((c) => !IMMUTABLE_COLUMNS.has(c))`, keturi `po.*`
       * tikrinimai krinta. Vien `outcome.requestId` tikrinimo NEPAKAKTŲ - jis
       * praeitų ir su plačiu `SET`.
       *
       * DETERMINISTIŠKUMAS: konkurentinė mutacija įterpiama per adapterio
       * hook'ą TIKSLIAI tarp `readJob()` ir sąlyginio `UPDATE`.
       */
      const scope = { ownerKind: "user", ownerId: UUID_A };
      const job = await store.create({
        ownerKind: scope.ownerKind,
        ownerId: scope.ownerId,
      });
      await store.update(job.id, {
        status: "processing", phase: "transcribing", attempt_count: 1,
      });

      let intercepted = false;
      let casRowCount = null;
      let casSql = null;
      let casParams = null;
      const racingPool = {
        connect: async () => {
          const client = await pool.connect();
          return {
            release: () => client.release(),
            query: async (sql, params) => {
              if (
                !intercepted &&
                /^WITH mutacija AS/.test(sql) &&
                /owner_id IS NOT DISTINCT FROM/.test(sql)
              ) {
                intercepted = true;
                /**
                 * NUOSAVYBĖ NEKEIČIAMA - CAS privalo pavykti. Keičiami tik
                 * laukai, kurių NĖRA nei predikate, nei prašomame patch'e.
                 */
                await injekcijaSuRiba(
                  `UPDATE jobs SET phase = 'diarizing', attempt_count = 9,
                     deletion_pending = true, deletion_attempts = 3
                   WHERE id = $1`,
                  [job.id],
                  "P2-2: ne-patcho stulpeliai");
                const result = await client.query(sql, params);
                casSql = sql;
                casParams = params;
                casRowCount = result.rows[0].pakeista;
                return result;
              }
              return client.query(sql, params);
            },
          };
        },
        end: async () => {},
      };

      const outcome = await createPostgresStore(racingPool).updateOwned(
        job.id,
        { requestId: "patch-taikomas", ownerId: UUID_B, schemaVersion: 999 },
        scope
      );

      assert.equal(intercepted, true,
        "prielaida: konkurentinė mutacija įterpta tarp read ir CAS UPDATE");
      assert.equal(casRowCount, 1,
        "nuosavybė nepakito, tad nuosavybės CAS privalo PAVYKTI");
      assert.notEqual(outcome, "FORBIDDEN");
      assert.notEqual(outcome, null);

      /** Nuosavybės CAS privalo likti mutacijos `WHERE` dalyje. */
      assert.match(casSql, /owner_id IS NOT DISTINCT FROM \$2/);
      assert.match(casSql, /owner_kind = \$3/);
      assert.equal(casParams[1], UUID_A);
      assert.equal(casParams[2], scope.ownerKind);

      const po = await store.get(job.id);

      /** 1) Prašomas patch'as pritaikytas. */
      assert.equal(po.requestId, "patch-taikomas", "patch'as privalo būti pritaikytas");

      /** 2) ⚠️ ESMĖ: konkurentinės reikšmės privalo IŠLIKTI. */
      assert.equal(po.phase, "diarizing",
        "konkurentinė phase atsukta atgal - prarastas atnaujinimas");
      assert.equal(po.attempt_count, 9,
        "konkurentinis attempt_count atsuktas atgal - prarastas atnaujinimas");
      assert.equal(po.deletion_pending, true,
        "konkurentinis deletion_pending atsuktas atgal - prarastas atnaujinimas");
      assert.equal(po.deletion_attempts, 3,
        "konkurentinis deletion_attempts atsuktas atgal - prarastas atnaujinimas");

      /** 3) Nekintami laukai lieka nekintami NET su priešišku patch'u. */
      assert.equal(po.ownerId, UUID_A, "nuosavybė patch'u nekeičiama");
      assert.equal(po.ownerKind, "user");
      assert.equal(po.schemaVersion, 2, "įrašo era patch'u nekeičiama");
      assert.equal(po.id, job.id);

      /**
       * ⚠️ TRIPWIRE, ne elgesio įrodymas (AGENTS.md §9.2). Elgesį įrodo `po.*`
       * tikrinimai; ši eilutė greičiau parodo PRIEŽASTĮ, jei `SET` išplistų.
       */
      const setDalis = casSql.slice(0, casSql.indexOf("WHERE"));
      for (const stulpelis of ["phase", "attempt_count", "deletion_pending",
        "deletion_attempts", "status", "storage_key"]) {
        assert.equal(setDalis.includes(`"${stulpelis}"`), false,
          `SET neturi liesti nepakeisto stulpelio "${stulpelis}"`);
      }
      for (const stulpelis of IMMUTABLE_COLUMNS) {
        assert.equal(setDalis.includes(`"${stulpelis}"`), false,
          `NEKINTAMAS stulpelis "${stulpelis}" niekada negali patekti į SET`);
      }
    }
  );

  /* ───────────────────────────────────────────────────────────────────────
   * #180 P2-3 - KLASIFIKACIJA ATOMINĖ SU NEPAVYKUSIA MUTACIJA
   *
   * Šie trys testai tikrina NE mutacijos rezultatą, o SENTINELIO TEISINGUMĄ,
   * kai eilutė pasikeičia PO nepavykusio CAS. Senoji forma (`rowCount === 0`
   * → atskiras `readJobForUpdate()` → klasifikacija) grąžindavo sentinelį,
   * aprašantį VĖLESNĘ eilutės būseną, ne tą, dėl kurios CAS nepavyko.
   * ─────────────────────────────────────────────────────────────────────── */

  /* ───────────────────────────────────────────────────────────────────────
   * #180 P2-6 - KIEKVIENAS CAS PREDIKATO KOMPONENTAS ATSKIRAI
   *
   * Ankstesni lenktynių testai keisdavo KELIS saugomus laukus vienu metu
   * (pvz. `type` KARTU su `phase` ir progresu), tad pašalinus TIK vieną
   * predikatą CAS vis tiek nerasdavo eilutės ir testas likdavo žalias. Todėl
   * DoD teiginys „progreso CAS saugo nuo pasenusio type/status/phase/epochos"
   * buvo stipresnis už turimus įrodymus.
   *
   * Žemiau kiekvienam IZOLIUOJAMAM komponentui keičiamas TIKSLIAI VIENAS
   * laukas, ir tai TIKRINAMA, o ne teigiama komentare: CAS snapshot'as imamas
   * iš TIKRŲ `$2..$7` parametrų, eilutės būsena perskaitoma iš karto po
   * injekcijos, ir skirtumų aibė privalo būti lygiai `[<komponentas>]`.
   * ─────────────────────────────────────────────────────────────────────── */

  /**
   * Laukai, kuriuos saugo progreso CAS predikatas.
   *
   * ⚠️ IŠVEDAMA IŠ PRODUKCINIO PREDIKATO, NE PERRAŠOMA RANKA (#180 P2-6).
   *
   * Rankinis sąrašas tyliai atsiliktų: pridėjus septintą komponentą į CAS,
   * izoliacijos tikrinimai jo tiesiog nebedengtų, o testai liktų žali. Dabar
   * vardai imami iš to paties `PROGRESO_CAS_PREDIKATAS`, kurį vykdo store, tad
   * nuokrypis neįmanomas iš principo. `id` praleidžiamas - jis parenka eilutę,
   * o ne saugo kintamą būseną.
   */
  const SAUGOMI_LAUKAI = [
    ...new Set(
      [...PROGRESO_CAS_PREDIKATAS.matchAll(/([a-z_]+)\s+(?:IS NOT DISTINCT FROM|=)\s+\$/g)]
        .map((m) => m[1])
        .filter((c) => c !== "id")
    ),
  ];

  /** NULL-safe skirtumų aibė tarp CAS snapshot'o ir realios eilutės būsenos. */
  function skiriasiSaugomi(snapshot, eilute) {
    return SAUGOMI_LAUKAI.filter((k) => {
      const a = snapshot[k];
      const b = eilute[k];
      if (a == null && b == null) return false;
      return a !== b;
    });
  }

  /**
   * Deterministinė izoliuota CAS lenktynė.
   *
   * ⚠️ SNAPSHOT'AS IMAMAS IŠ PRODUKCINIŲ PARAMETRŲ, ne iš testo prielaidos:
   * `params[1..6]` yra būtent tos reikšmės, kurias `reportProgressAtomic()`
   * įrašė į CAS predikatą. Todėl izoliacijos tikrinimas negali „sutapti" su
   * klaidinga prielaida apie perskaitytą būseną.
   *
   * ⚠️ Skaitoma `rows[0].pakeista` (P2-3 CTE), NE išorinio sakinio `rowCount`.
   */
  async function izoliuotaCasLenktyne({ pradineBusena, injekcija, ivykis }) {
    const job = await store.create({ ownerKind: OWNER_KIND.UNOWNED });
    await store.update(job.id, pradineBusena);

    let perimta = false;
    let snapshot = null;
    let poInjekcijos = null;
    let pakeista = null;

    const racingPool = {
      connect: async () => {
        const client = await pool.connect();
        return {
          release: () => client.release(),
          query: async (sql, params) => {
            if (
              !perimta &&
              /^WITH mutacija AS/.test(sql) &&
              /progress_known IS NOT DISTINCT FROM/.test(sql)
            ) {
              perimta = true;
              snapshot = {
                type: params[1], status: params[2], phase: params[3],
                progress_known: params[4], progress_current: params[5],
                progress_total: params[6],
              };
              await injekcijaSuRiba(injekcija, [job.id],
                "P2-6 izoliuota lenktyne");
              poInjekcijos = (await pool.query(
                `SELECT ${SAUGOMI_LAUKAI.join(", ")} FROM jobs WHERE id = $1`,
                [job.id]
              )).rows[0];
              const result = await client.query(sql, params);
              pakeista = result.rows[0].pakeista;
              return result;
            }
            return client.query(sql, params);
          },
        };
      },
      end: async () => {},
    };

    const outcome = await createPostgresStore(racingPool).reportProgressAtomic(job.id, ivykis);
    return { job, perimta, snapshot, poInjekcijos, pakeista, outcome };
  }

  /** Bendra pradinė būsena: visi saugomi laukai apibrėžti ir teisėti. */
  const P26_BUSENA = (phase = "transcribing") => ({
    status: "processing", phase, progressKnown: true, progress: { current: 5, total: 10 },
  });

  /** Bendri tikrinimai kiekvienai izoliuotai lenktynei. */
  async function tikrintiIzoliacija(r, komponentas) {
    assert.equal(r.perimta, true, `${komponentas}: prielaida - CAS perimtas`);
    assert.deepEqual(skiriasiSaugomi(r.snapshot, r.poInjekcijos), [komponentas],
      `${komponentas}: IZOLIACIJA - nuo CAS snapshot'o privalo skirtis TIKSLIAI šis laukas`);
    assert.equal(r.pakeista, 0, `${komponentas}: sąlyginis UPDATE privalo pakeisti 0 eilučių`);
    assert.equal(r.outcome, "REJECTED", `${komponentas}: kontraktas - pasenęs įvykis atmetamas`);
    /** P1-1: atmestas CAS negali perrašyti konkurentinio pakeitimo. */
    const po = await store.get(r.job.id);
    assert.deepEqual(po.progress, { current: 5, total: 10 },
      `${komponentas}: atmestas progresas negali patekti į saugyklą`);
    return po;
  }

  await t.test("#180 P2-6: CAS atmeta, kai pasikeitė TIK `type`", async () => {
    /**
     * ⚠️ `validating` FAZĖ PARINKTA SĄMONINGAI. Ji teisėta ABIEM grafams
     * (transcription ir protocol), tad `type` gali pasikeisti NEPAŽEIDŽIANT
     * `jobs_status_phase` ir NEPAKEIČIANT `phase`. Su `transcribing` tektų
     * keisti ir fazę - būtent to trūkumo ir buvo P2-6.
     *
     * `type` produkcijoje nekintamas; scenarijus sintetinis pagal #180 9 punktą.
     */
    const r = await izoliuotaCasLenktyne({
      pradineBusena: P26_BUSENA("validating"),
      injekcija: "UPDATE jobs SET type = 'protocol' WHERE id = $1",
      ivykis: { phase: "validating", progress: { current: 7, total: 10 } },
    });
    const po = await tikrintiIzoliacija(r, "type");
    assert.equal(po.type, "protocol", "type: konkurentinis pakeitimas privalo išlikti");
  });

  await t.test("#180 P2-6: CAS atmeta, kai pasikeitė TIK `phase`", async () => {
    /** `transcribing` → `diarizing`: abi teisėtos transcription grafui. */
    const r = await izoliuotaCasLenktyne({
      pradineBusena: P26_BUSENA("transcribing"),
      injekcija: "UPDATE jobs SET phase = 'diarizing' WHERE id = $1",
      ivykis: { phase: "transcribing", progress: { current: 7, total: 10 } },
    });
    const po = await tikrintiIzoliacija(r, "phase");
    assert.equal(po.phase, "diarizing", "phase: konkurentinis pakeitimas privalo išlikti");
  });

  await t.test("#180 P2-6: CAS atmeta, kai pasikeitė TIK `progress_current`", async () => {
    /**
     * Esamas monotoniškumo testas jau keitė vien `progress_current`, bet
     * izoliacijos NETIKRINO. Čia ta pati savybė įrodoma eksplicitiškai.
     */
    const r = await izoliuotaCasLenktyne({
      pradineBusena: P26_BUSENA("transcribing"),
      injekcija: "UPDATE jobs SET progress_current = 7 WHERE id = $1",
      ivykis: { phase: "transcribing", progress: { current: 8, total: 10 } },
    });
    assert.equal(r.perimta, true);
    assert.deepEqual(skiriasiSaugomi(r.snapshot, r.poInjekcijos), ["progress_current"]);
    assert.equal(r.pakeista, 0);
    assert.equal(r.outcome, "REJECTED");
    const po = await store.get(r.job.id);
    assert.deepEqual(po.progress, { current: 7, total: 10 },
      "progress_current: konkurentinė reikšmė privalo išlikti, o atmesta - ne");
  });

  await t.test("#180 P2-6: CAS atmeta, kai pasikeitė TIK `progress_total`", async () => {
    /** `current = 5 <= total = 20`, tad `jobs_progress_invariants` tenkinamas. */
    const r = await izoliuotaCasLenktyne({
      pradineBusena: P26_BUSENA("transcribing"),
      injekcija: "UPDATE jobs SET progress_total = 20 WHERE id = $1",
      ivykis: { phase: "transcribing", progress: { current: 7, total: 10 } },
    });
    assert.equal(r.perimta, true);
    assert.deepEqual(skiriasiSaugomi(r.snapshot, r.poInjekcijos), ["progress_total"]);
    assert.equal(r.pakeista, 0);
    assert.equal(r.outcome, "REJECTED");
    const po = await store.get(r.job.id);
    assert.deepEqual(po.progress, { current: 5, total: 20 },
      "progress_total: konkurentinė reikšmė privalo išlikti");
  });

  await t.test(
    "#180 P2-6: `status` ir `progress_known` NEIZOLIUOJAMI - schema draudžia vieno lauko skirtumą",
    async () => {
      /**
       * ⚠️ TAI ĮRODYMAS, NE PASITEISINIMAS.
       *
       * Šiems dviem komponentams elgesio izoliuoto testo parašyti NEĮMANOMA:
       * produkcinė schema neleidžia egzistuoti eilutei, kurioje nuo snapshot'o
       * skirtųsi TIK `status` arba TIK `progress_known`. Vietoj komentaro
       * tikrinama pati riba - jei constraint'as kada nors dings, šis testas
       * praeis ir aiškiai parodys, kad izoliuotą testą jau galima parašyti.
       */
      const job = await store.create({ ownerKind: OWNER_KIND.UNOWNED });
      await store.update(job.id, P26_BUSENA("transcribing"));

      /**
       * `status` vienas: `jobs_status_phase` reikalauja `phase IS NULL` ne
       * `processing` eilutėje, o `jobs_progress_only_processing` draudžia
       * `progress_known` už `processing` ribų. Vienintelis statusas, suderinamas
       * su ne-NULL faze IR progresu, yra `processing`.
       */
      await assert.rejects(
        () => pool.query("UPDATE jobs SET status = 'queued' WHERE id = $1", [job.id]),
        (e) => e.code === "23514",
        "status vienas privalo būti draudžiamas CHECK constraint'o"
      );

      /**
       * `progress_known` vienas: `jobs_progress_known` sieja jį su
       * `progress_current`/`progress_total` (true ⇒ abu ne-NULL, false ⇒ abu NULL).
       */
      await assert.rejects(
        () => pool.query("UPDATE jobs SET progress_known = false WHERE id = $1", [job.id]),
        (e) => e.code === "23514",
        "progress_known vienas privalo būti draudžiamas CHECK constraint'o"
      );

      /** Eilutė privalo likti nepakitusi - nė vienas bandymas nepraėjo. */
      const po = await store.get(job.id);
      assert.equal(po.status, "processing");
      assert.equal(po.progressKnown, true);
      assert.deepEqual(po.progress, { current: 5, total: 10 });
    }
  );

  await t.test(
    "#180 P2-3: pasenusio progreso REJECTED nevirsta null, kai eilutė ištrinama po CAS",
    async () => {
      /**
       * SCENARIJUS (3 → 4 pagal issue race sąrašą): CAS nepavyksta, nes
       * progreso snapshot'as pasenęs; eilutė ištrinama IŠ KART po to.
       *
       * SENOJI REALIZACIJA: `readJobForUpdate()` eilutės nebranda → `null`,
       * t. y. „job'o nėra", nors iš tikrųjų įvykis buvo ATMESTAS kaip pasenęs.
       * Kvietėjas (`queues/processors.js`) šias reikšmes traktuoja skirtingai.
       *
       * MUTACIJOS ĮRODYMAS: grąžinus
       * `if (result.rowCount === 0) return (await readJobForUpdate(...)) ? "REJECTED" : null;`
       * šis testas gauna `null` vietoj `"REJECTED"` ir krinta.
       */
      const job = await store.create({ ownerKind: OWNER_KIND.UNOWNED });
      await store.update(job.id, {
        status: "processing", phase: "transcribing", progressKnown: true,
        progress: { current: 1, total: 10 },
      });

      let intercepted = false;
      let casPakeista = null;
      const racingPool = {
        connect: async () => {
          const client = await pool.connect();
          return {
            release: () => client.release(),
            query: async (sql, params) => {
              if (
                !intercepted &&
                /^WITH mutacija AS/.test(sql) &&
                /progress_known IS NOT DISTINCT FROM/.test(sql)
              ) {
                intercepted = true;
                /** 1) padarome perskaitytą progreso snapshot'ą pasenusį */
                await injekcijaSuRiba(
                  "UPDATE jobs SET progress_current = 7 WHERE id = $1", [job.id],
                  "P2-3: pasenes progreso snapshotas");
                /** 2) CAS - privalo pakeisti 0 eilučių IR čia pat klasifikuoti */
                const result = await client.query(sql, params);
                casPakeista = result.rows[0].pakeista;
                /** 3) eilutė dingsta PO nepavykusio CAS (senosios formos langas) */
                await pool.query("DELETE FROM jobs WHERE id = $1", [job.id]);
                return result;
              }
              return client.query(sql, params);
            },
          };
        },
        end: async () => {},
      };

      const outcome = await createPostgresStore(racingPool).reportProgressAtomic(job.id, {
        phase: "transcribing", progress: { current: 5, total: 10 },
      });

      assert.equal(intercepted, true, "prielaida: CAS perimtas");
      assert.equal(casPakeista, 0, "pasenęs progreso CAS privalo pakeisti 0 eilučių");
      assert.equal(await store.get(job.id), null, "prielaida: eilutė realiai ištrinta po CAS");
      assert.equal(outcome, "REJECTED",
        "sentinelis privalo aprašyti CAS nesėkmės priežastį (pasenęs snapshot'as), " +
          "o ne vėlesnį eilutės ištrynimą");
    }
  );

  await t.test(
    "#180 P2-3: removeOwned neatiduoda FORBIDDEN dėl eilutės, atsiradusios PO CAS",
    async () => {
      /**
       * SCENARIJUS (1 → 5 pagal issue race sąrašą): CAS metu eilutės NĖRA;
       * iš karto po to tuo pačiu id atsiranda SVETIMO savininko eilutė.
       *
       * SENOJI REALIZACIJA: `readJobForUpdate()` mato B eilutę → `"FORBIDDEN"`,
       * t. y. „šis job'as ne tavo", nors kvietėjo job'o apskritai nebuvo.
       * Teisingas atsakymas - `false`.
       *
       * MUTACIJOS ĮRODYMAS: grąžinus po-CAS klasifikaciją
       * (`if (!current) return false; if (!matchesOwner(...)) return "FORBIDDEN";`)
       * šis testas gauna `"FORBIDDEN"` vietoj `false` ir krinta.
       */
      const id = crypto.randomUUID();
      const scope = { ownerKind: "user", ownerId: UUID_A };

      let intercepted = false;
      let casPakeista = null;
      let casPriezastis = null;
      const racingPool = {
        connect: async () => {
          const client = await pool.connect();
          return {
            release: () => client.release(),
            query: async (sql, params) => {
              if (!intercepted && /^WITH mutacija AS/.test(sql) && /DELETE FROM jobs/.test(sql)) {
                intercepted = true;
                /** CAS vykdomas TUŠČIAI būsenai - eilutės dar nėra. */
                const result = await client.query(sql, params);
                casPakeista = result.rows[0].pakeista;
                casPriezastis = result.rows[0].priezastis;
                /** Tik DABAR atsiranda SVETIMO savininko eilutė tuo pačiu id. */
                await rawInsert(bazineEilute({ id, owner_kind: "user", owner_id: UUID_B }));
                return result;
              }
              return client.query(sql, params);
            },
          };
        },
        end: async () => {},
      };

      const outcome = await createPostgresStore(racingPool).removeOwned(id, scope);

      assert.equal(intercepted, true, "prielaida: CAS perimtas");
      assert.equal(casPakeista, 0, "CAS privalo pakeisti 0 eilučių");
      assert.equal(casPriezastis, 0,
        "CAS snapshot'e eilutės NEBUVO - klasifikacija negali sakyti „svetima\"");
      assert.equal(outcome, false,
        "eilutė, atsiradusi PO CAS, negali paversti atsakymo į FORBIDDEN");

      /** ⚠️ Ir svetima eilutė privalo LIKTI - jos trinti niekas neprašė. */
      const svetima = await store.get(id);
      assert.notEqual(svetima, null, "svetimo savininko eilutė negali būti ištrinta");
      assert.equal(svetima.ownerId, UUID_B);
      await pool.query("DELETE FROM jobs WHERE id = $1", [id]);
    }
  );

  await t.test(
    "#180 P2-3: updateOwned grąžina null, kai eilutė dingsta prieš CAS ir atgimsta svetima",
    async () => {
      /**
       * SCENARIJUS (4 + 5 pagal issue race sąrašą): eilutė perskaitoma (sava),
       * dingsta PRIEŠ CAS, o PO CAS tuo pačiu id atgimsta su kitu savininku.
       *
       * SENOJI REALIZACIJA: po `rowCount === 0` skaitomas užrakintas įrašas,
       * matoma B eilutė → `"FORBIDDEN"`. Bet CAS momentu eilutės nebuvo, tad
       * kontraktas reikalauja `null`.
       *
       * MUTACIJOS ĮRODYMAS: grąžinus po-CAS `readJobForUpdate()` klasifikaciją
       * gaunamas `"FORBIDDEN"` vietoj `null` ir testas krinta.
       */
      const scope = { ownerKind: "user", ownerId: UUID_A };
      const job = await store.create({
        ownerKind: scope.ownerKind, ownerId: scope.ownerId,
      });

      let intercepted = false;
      let casPakeista = null;
      let casPriezastis = null;
      const racingPool = {
        connect: async () => {
          const client = await pool.connect();
          return {
            release: () => client.release(),
            query: async (sql, params) => {
              if (
                !intercepted &&
                /^WITH mutacija AS/.test(sql) &&
                /owner_id IS NOT DISTINCT FROM/.test(sql)
              ) {
                intercepted = true;
                /** 1) sava eilutė dingsta PRIEŠ CAS */
                await injekcijaSuRiba("DELETE FROM jobs WHERE id = $1", [job.id],
                  "P2-3: eilute dingsta pries CAS");
                /** 2) CAS tuščiai būsenai */
                const result = await client.query(sql, params);
                casPakeista = result.rows[0].pakeista;
                casPriezastis = result.rows[0].priezastis;
                /** 3) tuo pačiu id atgimsta SVETIMA eilutė */
                await rawInsert(bazineEilute({
                  id: job.id, owner_kind: "user", owner_id: UUID_B,
                }));
                return result;
              }
              return client.query(sql, params);
            },
          };
        },
        end: async () => {},
      };

      const outcome = await createPostgresStore(racingPool).updateOwned(
        job.id, { requestId: "neturi-buti-irasyta" }, scope
      );

      assert.equal(intercepted, true, "prielaida: CAS perimtas");
      assert.equal(casPakeista, 0, "CAS privalo pakeisti 0 eilučių");
      assert.equal(casPriezastis, 0, "CAS snapshot'e eilutės nebuvo");
      assert.equal(outcome, null,
        "atgimusi svetima eilutė negali paversti atsakymo į FORBIDDEN");

      /** Svetima eilutė privalo likti NEPALIESTA. */
      const svetima = await store.get(job.id);
      assert.equal(svetima.ownerId, UUID_B);
      assert.equal(svetima.requestId, null, "svetimas job'as negalėjo būti mutuotas");
      await pool.query("DELETE FROM jobs WHERE id = $1", [job.id]);
    }
  );

  await t.test(
    "#180 P2-C: atkūrimo riba - neatstovaujamas progresas krinta ir NESUNAIKINA esamo įrašo",
    async () => {
      /**
       * A/B/C/D vienoje vietoje: teisėtas atkūrimas pavyksta; skaitinės eilutės
       * ir įdėti metaduomenys krinta PRIEŠ destruktyvų `DELETE`; esamas įrašas
       * lieka nepaliestas.
       */
      const id = crypto.randomUUID();

      /** A. Teisėtas skaitinis progresas atkuriamas. */
      await store.restoreRecord({
        id, type: "transcription", status: "processing", phase: "transcribing",
        progressKnown: true, progress: { current: 5, total: 10 },
        ownerKind: OWNER_KIND.UNOWNED, ownerId: null, tenantId: null, artefacts: [],
        schemaVersion: 2,
        created_at: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      });
      const pries = await store.get(id);
      assert.deepEqual(pries.progress, { current: 5, total: 10 });

      const sugadinti = [
        ["B. skaitinės eilutės", { current: "8", total: "10" }],
        ["C. įdėti metaduomenys", { metadata: { total: 20 }, current: 7, total: 10 }],
      ];

      for (const [pavadinimas, progresas] of sugadinti) {
        await assert.rejects(
          () => store.restoreRecord({
            id, type: "transcription", status: "processing", phase: "transcribing",
            progressKnown: true, progress: progresas,
            ownerKind: OWNER_KIND.UNOWNED, ownerId: null, tenantId: null, artefacts: [],
            schemaVersion: 2,
            created_at: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
          }),
          (e) => e.code === "UNSUPPORTED_PROGRESS_REPRESENTATION",
          `${pavadinimas}: privalo kristi, o ne tyliai perinterpretuoti`
        );

        /** D. ⚠️ ESMĖ: esamas įrašas privalo išlikti NEPAKITĘS. */
        const po = await store.get(id);
        assert.notEqual(po, null, `${pavadinimas}: esamas įrašas negali būti ištrintas`);
        assert.deepEqual(po.progress, { current: 5, total: 10 },
          `${pavadinimas}: esamas progresas privalo likti nepakitęs`);
      }

      await pool.query("DELETE FROM jobs WHERE id = $1", [id]);
    }
  );

  await t.test(
    "#180 P2-D: konkurentinis DELETE, kol CAS laukia užrakto, grąžina null (ne REJECTED)",
    async () => {
      /**
       * ⚠️ TIKSLIAI TA EILIŠKUMO ATKARPA, KURIOS TRŪKO.
       *
       * Esami P2-3 testai ištrina eilutę PO to, kai CAS sakinys jau grąžino
       * rezultatą. Čia `DELETE` įsipatvirtina TADA, KAI CAS `UPDATE` jau laukia
       * eilutės užrakto:
       *
       *   1. T1 užrakina eilutę (`SELECT ... FOR UPDATE`);
       *   2. `reportProgressAtomic()` pradedamas - jo CAS `UPDATE` blokuojasi;
       *   3. T1 ištrina eilutę ir COMMIT'ina;
       *   4. CAS atsiblokuoja, `EvalPlanQual` randa eilutę dingusią.
       *
       * Tada `pakeista = 0`, o skaliarinis `EILUTE_YRA` fiksuotame snapshot'e
       * TEBEMATO seną tuple'ą. Be `atitiko` stulpelio rezultatas būtų
       * `"REJECTED"`, nors eilutės nebėra - kontraktas reikalauja `null`.
       *
       * ⚠️ BLOKAVIMO LAUKIAMA PAGAL REALIĄ SĄLYGĄ (`pg_stat_activity`
       * `wait_event_type = 'Lock'`), ne pagal fiksuotą `sleep`.
       */
      const job = await store.create({ ownerKind: OWNER_KIND.UNOWNED });
      await store.update(job.id, {
        status: "processing", phase: "transcribing",
        progressKnown: true, progress: { current: 1, total: 10 },
      });

      const t1 = await pool.connect();
      let uzdaryta = false;
      try {
        await t1.query("BEGIN");
        await t1.query("SELECT id FROM jobs WHERE id = $1 FOR UPDATE", [job.id]);

        /** CAS startuoja ir užsiblokuoja ties T1 užraktu. */
        const veikia = store.reportProgressAtomic(job.id, {
          phase: "transcribing", progress: { current: 5, total: 10 },
        });

        await laukiantUzblokuotoUzrakto("%WITH mutacija AS%", "progreso CAS UPDATE");

        /** Eilutė dingsta, kol CAS TEBELAUKIA. */
        await t1.query("DELETE FROM jobs WHERE id = $1", [job.id]);
        await t1.query("COMMIT");
        uzdaryta = true;

        const outcome = await veikia;
        assert.equal(outcome, null,
          'eilutės nebėra - kontraktas reikalauja null, ne "REJECTED"');
        assert.equal(await store.get(job.id), null, "prielaida: eilutė realiai ištrinta");
      } finally {
        if (!uzdaryta) await t1.query("ROLLBACK").catch(() => {});
        t1.release();
      }
    }
  );

  await t.test(
    "#180 CAS: po užrakto laukimo updated_at NEATSUKAMAS atgal",
    async () => {
      /**
       * ⚠️ LAIKO ŽYMA SKAIČIUOJAMA RAŠYMO METU.
       *
       * `applyPatch()` `updatedAt` užfiksuoja PRIEŠ CAS. Jei sakinys paskui
       * laukia svetimo eilutės užrakto, o tas rašytojas per tą laiką įrašo
       * NAUJESNĘ žymą, pasenusi JS reikšmė ją perrašytų atgal. Užlaikymui
       * viršijus `TTL_MS`, ką tik commit'inta eilutė iš karto taptų tinkama
       * `sweepExpired()` valymui.
       */
      const scope = { ownerKind: "user", ownerId: UUID_A };
      const job = await store.create({
        ownerKind: scope.ownerKind, ownerId: scope.ownerId,
      });

      const t1 = await pool.connect();
      let uzdaryta = false;
      try {
        await t1.query("BEGIN");
        await t1.query("SELECT id FROM jobs WHERE id = $1 FOR UPDATE", [job.id]);

        /** CAS startuoja ir blokuojasi ties T1 užraktu. */
        const veikia = store.updateOwned(job.id, { requestId: "po-laukimo" }, scope);
        await laukiantUzblokuotoUzrakto("%WITH mutacija AS%", "nuosavybės CAS UPDATE");

        /** Konkurentas įrašo NAUJESNĘ žymą ir atlaisvina užraktą. */
        await t1.query(
          "UPDATE jobs SET updated_at = clock_timestamp() + interval '1 hour' WHERE id = $1",
          [job.id]
        );
        const { rows: [konkurento] } = await t1.query(
          "SELECT updated_at FROM jobs WHERE id = $1", [job.id]
        );
        await t1.query("COMMIT");
        uzdaryta = true;

        const outcome = await veikia;
        assert.notEqual(outcome, null);
        assert.notEqual(outcome, "FORBIDDEN");
        assert.equal(outcome.requestId, "po-laukimo", "patch'as privalo būti pritaikytas");

        const { rows: [po] } = await pool.query(
          "SELECT updated_at FROM jobs WHERE id = $1", [job.id]
        );
        assert.ok(new Date(po.updated_at) >= new Date(konkurento.updated_at),
          `updated_at atsuktas atgal: ${po.updated_at} < ${konkurento.updated_at}`);
      } finally {
        if (!uzdaryta) await t1.query("ROLLBACK").catch(() => {});
        t1.release();
        await pool.query("DELETE FROM jobs WHERE id = $1", [job.id]).catch(() => {});
      }
    }
  );

  /* ── Kanoninių tipų paritetas (#205, 7.2c) ───────────────────────────── */

  await t.test(
    "#205 PARITETAS: tekstinis patch'as duoda TĄ PAČIĄ reikšmę ir TIPĄ kaip memory/Redis",
    async () => {
      /**
       * ⚠️ TREČIOJI PARITETO PUSĖ. Memory ir Redis dengiami
       * `jobStoreTypeNormalization.test.js` (be išorinių servisų); čia tas pats
       * scenarijus vykdomas prieš TIKRĄ PostgreSQL, kur reikšmę galutinai lemia
       * `boolean` ir `integer` stulpelių tipai.
       *
       * Iki 7.2c `jobToRow()` darydavo `Boolean("false")` → `true`, t. y.
       * PRIEŠINGĄ loginę reikšmę nei memory. Lauktina reikšmė NEĮRAŠYTA ranka -
       * ji skaičiuojama tuo pačiu `normalizeFieldValue()`, kurį naudoja abi
       * normalizavimo vietos.
       *
       * ⚠️ TIKRINAMA IR `update()` GRĄŽINIMAS, IR `get()`: vien `get()` patikra
       * paslėptų rašymo kelio regresiją.
       */
      const beIvesciu = patchLaukai().filter((laukas) => !IVESTYS[laukas]);
      assert.deepEqual(beIvesciu, [], "naujas kanoninis laukas privalo gauti įvestis fixtures'uose");

      for (const laukas of patchLaukai()) {
        for (const ivestis of [...IVESTYS[laukas], ...NELEISTINOS]) {
          const job = await store.create({ ownerKind: OWNER_KIND.UNOWNED, ownerId: null });

          const poUpdate = await store.update(job.id, { [laukas]: ivestis });
          const poGet = await store.get(job.id);

          const tikimasi = normalizeFieldValue(laukas, ivestis);
          const kontekstas = `${laukas}=${JSON.stringify(ivestis)}`;

          assert.equal(poUpdate[laukas], tikimasi, `update() reikšmė: ${kontekstas}`);
          assert.equal(typeof poUpdate[laukas], typeof tikimasi, `update() tipas: ${kontekstas}`);
          assert.equal(poGet[laukas], tikimasi, `get() reikšmė: ${kontekstas}`);
          assert.equal(typeof poGet[laukas], typeof tikimasi, `get() tipas: ${kontekstas}`);

          await store.remove(job.id);
        }
      }
    }
  );

  await t.test("#205 `restoreRecord()`: sena kopija su eilutėmis atkuriama KANONINE", async () => {
    /**
     * `applyPatch()` šio kelio NEDENGIA - `restoreRecord()` jo nekviečia. Senesnė
     * kopija gali turėti būtent tas tekstines reikšmes, dėl kurių #205 egzistuoja.
     *
     * ⚠️ `progressKnown` ČIA NEDALYVAUJA SĄMONINGAI: #180 P2-C atkūrimo kelyje
     * ne-boolean `progressKnown` GARSIAI atmeta, ir 7.2c tos garantijos
     * nesilpnina - normalizavimas vyksta PO tos patikros.
     */
    const bazinis = await store.create({ ownerKind: OWNER_KIND.UNOWNED, ownerId: null });
    await store.remove(bazinis.id);

    const senaKopija = {
      ...bazinis,
      audio_cleanup_pending: "false",
      deletion_pending: "false",
      attempt_count: "0",
      audio_cleanup_attempts: "0",
      deletion_attempts: "0",
    };

    const grazinta = await store.restoreRecord(senaKopija);
    const perskaityta = await store.get(bazinis.id);

    for (const laukas of ["audio_cleanup_pending", "deletion_pending", "attempt_count",
      "audio_cleanup_attempts", "deletion_attempts"]) {
      const tikimasi = normalizeFieldValue(laukas, senaKopija[laukas]);
      assert.equal(grazinta[laukas], tikimasi, `restoreRecord() GRĄŽINIMAS: ${laukas}`);
      assert.equal(typeof grazinta[laukas], typeof tikimasi, `restoreRecord() tipas: ${laukas}`);
      assert.equal(perskaityta[laukas], tikimasi, `po get(): ${laukas}`);
      assert.equal(typeof perskaityta[laukas], typeof tikimasi, `po get() tipas: ${laukas}`);
    }

    await store.remove(bazinis.id);
  });

  /* ── Optimistic lock versijos CAS (#184, 7.5b) ───────────────────────── */

  await t.test("#184 `expectedVersion` konfliktas: nulis eilučių klasifikuojamas TAME PAČIAME sakinyje", async () => {
    /**
     * ⚠️ TIKRAS PostgreSQL BŪTINAS. Klasifikacija remiasi `casSuKlasifikacija()`
     * CTE snapshot'u - savybe, kurios nei memory, nei `FakeRedis` neturi. Be DB
     * šis testas tikrintų tik JS `if` sakinius.
     */
    const job = await store.create({ ownerKind: OWNER_KIND.UNOWNED, ownerId: null });
    assert.equal(job.version, 1);

    /** Konkurentas - atskiru kvietimu, be sąlygos. */
    await store.update(job.id, { actor: "konkurentas" });

    const rezultatas = await store.update(job.id, { actor: "pasenes" }, { expectedVersion: 1 });
    assert.equal(rezultatas, "CONCURRENCY_CONFLICT");

    const dabartinis = await store.get(job.id);
    assert.equal(dabartinis.actor, "konkurentas", "konfliktas NIEKO neįrašė");
    assert.equal(dabartinis.version, 2, "konfliktas versijos NEDIDINA");

    await store.remove(job.id);
  });

  await t.test("#184 sutampanti versija praeina; `version` didėja PERSISTENTIŠKAI", async () => {
    const job = await store.create({ ownerKind: OWNER_KIND.UNOWNED, ownerId: null });

    const po = await store.update(job.id, { actor: "as" }, { expectedVersion: 1 });
    assert.equal(po.version, 2);
    assert.equal(po.actor, "as");

    /** ⚠️ Ne iš grąžinimo, o iš stulpelio - grąžinimas galėtų slėpti neįrašytą SET. */
    const { rows } = await pool.query("SELECT version, actor FROM jobs WHERE id = $1", [job.id]);
    assert.equal(rows[0].version, 2);
    assert.equal(rows[0].actor, "as");

    await store.remove(job.id);
  });

  await t.test("#184 ⚠️ NULIS EILUČIŲ: not-found ir version conflict atskiriami KIEKVIENAS", async () => {
    /**
     * ⚠️ ŠIS TESTAS YRA VISO KONTRAKTO ESMĖ. Nulis pakeistų eilučių savaime nėra
     * versijos konfliktas: eilutės gali apskritai nebūti. Abi baigtys turi
     * skirtingus kvietėjo veiksmus (retry vs 404), tad jų suliejimas būtų tylus
     * elgesio pakeitimas.
     */
    const nesamas = crypto.randomUUID();
    assert.equal(
      await store.update(nesamas, { actor: "x" }, { expectedVersion: 1 }),
      null,
      "eilutės nėra → null, ne konfliktas"
    );

    const job = await store.create({ ownerKind: OWNER_KIND.UNOWNED, ownerId: null });
    assert.equal(
      await store.update(job.id, { actor: "x" }, { expectedVersion: 999 }),
      "CONCURRENCY_CONFLICT",
      "eilutė yra, versija kita → konfliktas, ne null"
    );
    await store.remove(job.id);
  });

  await t.test("#184 ⚠️ IŠTRINTA eilutė NEGAUNA egzistavimo verdikto iš NAUJOS inkarnacijos", async () => {
    /**
     * ⚠️ #180 komentaras (`postgresStore.js`, „CAS SNAPSHOT'E EILUTĖS NEBUVO")
     * aprašo būtent šitą: vėliau tuo pačiu id atsiradusi eilutė yra KITA įrašo
     * inkarnacija, ir sprendimas apie ją būtų priimtas ne tuo snapshot'u, kuriuo
     * operacija buvo įvertinta.
     *
     * Versijos klasifikatorius to negali sulaužyti: `buvo === 0` tikrinamas
     * PRIEŠ `priezastis`, tad ištrinta eilutė duoda `null`, o ne konfliktą.
     */
    const job = await store.create({ ownerKind: OWNER_KIND.UNOWNED, ownerId: null });
    const id = job.id;
    await store.remove(id);

    assert.equal(
      await store.update(id, { actor: "x" }, { expectedVersion: 1 }),
      null,
      "ištrintas įrašas → null, NE CONCURRENCY_CONFLICT"
    );
  });

  await t.test("#184 ⚠️ `updateOwned`: SVETIMAS savininkas su pasenusia versija lieka FORBIDDEN", async () => {
    /**
     * ⚠️ ABI NESĖKMĖS SĄLYGOS TENKINAMOS VIENU METU, ir klasifikatorių tvarka
     * yra kontrakto dalis: `SVETIMAS_SCOPE` tikrinamas PRIEŠ `versijaSkiriasi`.
     * Perklasifikavus, 403 vs 404 sprendimas (#159) remtųsi lygiagretumo faktu
     * vietoj autorizacijos.
     */
    const savininkas = { ownerKind: OWNER_KIND.USER, ownerId: crypto.randomUUID() };
    const svetimas = { ownerKind: OWNER_KIND.USER, ownerId: crypto.randomUUID() };

    const job = await store.create({ ...savininkas });
    await store.update(job.id, { actor: "konkurentas" });

    assert.equal(
      await store.updateOwned(job.id, { actor: "x" }, svetimas, { expectedVersion: 1 }),
      "FORBIDDEN"
    );
    assert.equal(
      await store.updateOwned(job.id, { actor: "x" }, savininkas, { expectedVersion: 1 }),
      "CONCURRENCY_CONFLICT",
      "ta pati situacija, tik SAVAS savininkas → atsakymas privalo pasikeisti"
    );

    await store.remove(job.id);
  });

  await t.test("#184 be `expectedVersion` `updateOwned` elgesys NEPAKITĘS", async () => {
    /** Regresijos sargas: sąlyginis kelias neturi tapti numatytuoju. */
    const savininkas = { ownerKind: OWNER_KIND.USER, ownerId: crypto.randomUUID() };
    const job = await store.create({ ...savininkas });

    await store.update(job.id, { actor: "konkurentas" });
    const po = await store.updateOwned(job.id, { actor: "as" }, savininkas);

    assert.equal(po.actor, "as");
    assert.equal(po.version, 3);

    await store.remove(job.id);
  });

  /* ── Atominis ir idempotentiškas `finish` (#184, 7.5b) ───────────────── */

  async function processingJob() {
    const job = await store.create({ ownerKind: OWNER_KIND.UNOWNED, ownerId: null });
    await store.update(job.id, { status: "processing", phase: "validating" });
    return job.id;
  }

  await t.test("#184 `finish(COMPLETED)` įrašo `jobs` IR `job_results` VIENOJE transakcijoje", async () => {
    const id = await processingJob();
    const po = await store.finishAtomic(id, "completed", { result: { protocol: { a: 1 } } });

    assert.equal(po.status, "completed");

    const { rows } = await pool.query(
      "SELECT j.status, r.payload, r.storage_type FROM jobs j LEFT JOIN job_results r ON r.job_id = j.id WHERE j.id = $1",
      [id]
    );
    assert.equal(rows[0].status, "completed");
    assert.deepEqual(rows[0].payload, { protocol: { a: 1 } }, "rezultatas commit'intas kartu");
    assert.equal(rows[0].storage_type, "inline");
  });

  await t.test("#184 ⚠️ rezultato rašymui NEPAVYKUS lieka ROLLBACK, ne pusinė `completed` būsena", async () => {
    /**
     * ⚠️ TAI IR YRA `COMPLETED` APIBRĖŽIMO ESMĖ. `jobs.status = 'completed'` be
     * `job_results` yra būsena, kurios kvietėjas negali nei naudoti, nei
     * suremontuoti - ir kurioje audio valymas ištrintų vienintelę medžiagą
     * remontui. Todėl gedimas privalo atsukti VISKĄ.
     */
    const id = await processingJob();

    /** Pool'as, kuris krenta BŪTENT ties `job_results` rašymu. */
    const luztantisPool = {
      connect: async () => {
        const client = await pool.connect();
        const originalus = client.query.bind(client);
        client.query = (sql, params) => {
          if (typeof sql === "string" && /INSERT INTO job_results/.test(sql)) {
            return Promise.reject(new Error("simuliuotas gedimas rašant job_results"));
          }
          return originalus(sql, params);
        };
        return client;
      },
    };

    await assert.rejects(
      () => createPostgresStore(luztantisPool).finishAtomic(id, "completed", { result: { a: 1 } }),
      /simuliuotas gedimas/
    );

    const { rows } = await pool.query(
      "SELECT j.status, j.version, r.payload FROM jobs j LEFT JOIN job_results r ON r.job_id = j.id WHERE j.id = $1",
      [id]
    );
    assert.equal(rows[0].status, "processing", "⚠️ statusas NEPAKEISTAS - pusinės būsenos nėra");
    assert.equal(rows[0].payload, null, "rezultato nėra");
    assert.equal(rows[0].version, 2, "versija nepadidėjo (create=1, update=2)");
  });

  await t.test("#184 ⚠️ pakartojimas su TUO PAČIU rezultatu: `version` IR `job_results.created_at` NEPAKITĘ", async () => {
    /**
     * ⚠️ BE ŠIOS PATIKROS „IDEMPOTENTIŠKA SĖKMĖ" TYLIAI LIKTŲ RAŠYMU.
     *
     * AS-IS `upsertResult()` darė `ON CONFLICT DO UPDATE SET payload =
     * EXCLUDED.payload` - besąlyginį perrašymą. Testas, tikrinantis tik grąžintą
     * statusą, to nepagautų: rezultatas atrodytų teisingas, o eilutė būtų
     * perrašyta kiekvieną kartą.
     */
    const id = await processingJob();
    const pirmas = await store.finishAtomic(id, "completed", { result: { a: 1, b: { c: 2 } } });

    const { rows: pries } = await pool.query(
      "SELECT j.version, r.created_at FROM jobs j JOIN job_results r ON r.job_id = j.id WHERE j.id = $1",
      [id]
    );

    /** ⚠️ KITA RAKTŲ TVARKA - semantiškai TAS PATS rezultatas. */
    const antras = await store.finishAtomic(id, "completed", { result: { b: { c: 2 }, a: 1 } });
    assert.equal(antras.version, pirmas.version, "grąžinta versija nepakitusi");

    const { rows: po } = await pool.query(
      "SELECT j.version, r.created_at FROM jobs j JOIN job_results r ON r.job_id = j.id WHERE j.id = $1",
      [id]
    );
    assert.equal(po[0].version, pries[0].version, "⚠️ `jobs.version` NEPADIDĖJO");
    assert.equal(
      po[0].created_at.getTime(),
      pries[0].created_at.getTime(),
      "⚠️ `job_results` eilutė NEPERRAŠYTA"
    );
  });

  await t.test("#184 ⚠️ raktų tvarka: TAS PATS rezultatas per REALŲ `jsonb` round-trip'ą", async () => {
    /**
     * ⚠️ TESTAS EINA PER DB, NE PER RANKOMIS SUMAIŠYTĄ OBJEKTĄ.
     *
     * `jsonb` raktų tvarkos nesaugo - ją nustato PATS PostgreSQL pagal savo
     * vidinę tvarką. Rankomis sumaišius objektą, testas tikrintų MŪSŲ spėjimą
     * apie tą tvarką; einant per round-trip'ą, tikrinama tikroji.
     */
    const id = await processingJob();
    const rasomas = { zzz: 1, aaa: 2, mmm: { yyy: 3, bbb: 4 } };
    await store.finishAtomic(id, "completed", { result: rasomas });

    const perskaitytas = (await store.get(id)).result;
    assert.notEqual(
      JSON.stringify(perskaitytas),
      JSON.stringify(rasomas),
      "prielaida: `jsonb` raktų tvarką PAKEITĖ - kitaip testas nieko netikrintų"
    );

    /** Pakartojimas su DB grąžinta forma - privalo būti no-op, ne konfliktas. */
    const po = await store.finishAtomic(id, "completed", { result: perskaitytas });
    assert.equal(typeof po, "object", "no-op, ne RESULT_CONFLICT");

    /** Ir su ORIGINALIA forma - taip pat. */
    const po2 = await store.finishAtomic(id, "completed", { result: rasomas });
    assert.equal(typeof po2, "object", "originali raktų tvarka irgi yra TAS PATS rezultatas");
  });

  await t.test("#184 KITAS rezultatas → RESULT_CONFLICT; esamas NEPERRAŠOMAS", async () => {
    const id = await processingJob();
    await store.finishAtomic(id, "completed", { result: { a: 1 } });

    assert.equal(
      await store.finishAtomic(id, "completed", { result: { a: 2 } }),
      "RESULT_CONFLICT"
    );

    const { rows } = await pool.query("SELECT payload FROM job_results WHERE job_id = $1", [id]);
    assert.deepEqual(rows[0].payload, { a: 1 }, "⚠️ pirmojo vykdytojo rezultatas nepaliestas");
  });

  await t.test("#184 `completed` BE `job_results` → COMPLETED_WITHOUT_RESULT", async () => {
    const id = await processingJob();
    await store.finishAtomic(id, "completed", { result: { a: 1 } });

    /** Remontuotina būsena: eilutė dingo (nutrūkusi transakcija, ranka redaguota DB). */
    await pool.query("DELETE FROM job_results WHERE job_id = $1", [id]);

    assert.equal(
      await store.finishAtomic(id, "completed", { result: { a: 1 } }),
      "COMPLETED_WITHOUT_RESULT"
    );
  });

  await t.test("#184 `storage_type <> 'inline'` — FAIL-CLOSED (perspektyvinis sargas, #157)", async () => {
    /**
     * ⚠️ SARGAS BE PRODUKCINIO KVIETĖJO, IR TAI ĮVARDIJAMA.
     *
     * `upsertResult()` rašo kietą `'inline'`, tad nė viena eilutė kito tipo
     * ŠIANDIEN atsirasti negali - testas jį pasiekia tik įrašydamas tiesiogiai.
     * Sargas egzistuoja tam, kad #157 negalėtų tyliai paversti „skirtingo
     * rezultato" į „nepalyginamą": be jo antrasis vykdytojas gautų
     * idempotentišką sėkmę apie darbą, kurio nematė.
     */
    const id = await processingJob();
    await store.finishAtomic(id, "completed", { result: { a: 1 } });
    await pool.query("UPDATE job_results SET storage_type = 's3' WHERE job_id = $1", [id]);

    await assert.rejects(
      () => store.finishAtomic(id, "completed", { result: { a: 1 } }),
      /#157/,
      "nepalyginamas saugojimo tipas privalo KRISTI, ne tyliai sutapti"
    );

    await pool.query("UPDATE job_results SET storage_type = 'inline' WHERE job_id = $1", [id]);
  });

  await t.test("#184 ⚠️ LENKTYNĖS: du vykdytojai, dvi jungtys — tik VIENAS įsipareigoja", async () => {
    /**
     * ⚠️ DETERMINISTIŠKA BE `sleep()`.
     *
     * Serializavimą duoda `FOR UPDATE` eilutės užraktas `finishAtomic()`
     * transakcijoje, ne laikas: antroji transakcija BLOKUOJASI, kol pirmoji
     * commit'ina, ir tada mato ĮSIPAREIGOTĄ būseną. Todėl baigčių AIBĖ yra
     * fiksuota, net jei nugalėtojas kaskart kitas - lygiai to ir reikia.
     *
     * ⚠️ TIKRINAMA AIBĖ, NE KONKRETUS NUGALĖTOJAS. Testas, reikalaujantis, kad
     * laimėtų būtent A, priklausytų nuo planuoklio ir taptų flaky - tai būtent
     * ta klasė, kurios #184 reikalauja vengti.
     */
    const id = await processingJob();

    const poolA = new Pool({ connectionString: DB_URL });
    const poolB = new Pool({ connectionString: DB_URL });
    try {
      const [a, b] = await Promise.all([
        createPostgresStore(poolA).finishAtomic(id, "completed", { result: { vykdytojas: "A" } }),
        createPostgresStore(poolB).finishAtomic(id, "completed", { result: { vykdytojas: "B" } }),
      ]);

      const baigtys = [a, b];
      const laimeje = baigtys.filter((x) => x && typeof x === "object");
      const konfliktai = baigtys.filter((x) => x === "RESULT_CONFLICT");

      assert.equal(laimeje.length, 1, "tiksliai VIENAS įsipareigoja");
      assert.equal(konfliktai.length, 1, "antrasis gauna consistency konfliktą");

      const { rows } = await pool.query("SELECT payload FROM job_results WHERE job_id = $1", [id]);
      assert.deepEqual(
        rows[0].payload,
        laimeje[0].result,
        "⚠️ saugykloje guli BŪTENT nugalėtojo rezultatas - antrasis jo neperrašė"
      );
    } finally {
      await poolA.end();
      await poolB.end();
    }
  });

  await t.test("#184 `finish(FAILED)` `job_results` NERAŠO ir esamo NETRINA", async () => {
    /** Elgesys APIBRĖŽIAMAS, ne keičiamas - kad netaptų antra, netyčine semantika. */
    const id = await processingJob();
    const po = await store.finishAtomic(id, "failed", { error: "x", error_code: "E" });
    assert.equal(po.status, "failed");

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM job_results WHERE job_id = $1", [id]);
    assert.equal(rows[0].n, 0, "FAILED rezultato neįrašo");
  });

});
