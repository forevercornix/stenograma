const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { execFileSync } = require("child_process");
const crypto = require("crypto");
const { Pool } = require("pg");

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
} = require("../utils/jobStore/postgresStore");
const memoryStore = require("../utils/jobStore/memoryStore");
const { PROGRESS_INVARIANTS } = require("../utils/jobPhase");
const { OWNER_KIND } = require("../utils/jobStore/common");

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
    const metodai = (s) => Object.keys(s).filter((k) => typeof s[k] === "function").sort();

    assert.deepEqual(metodai(store), metodai(memoryStore));
    assert.equal(metodai(store).length, 15, "kontraktas turi 15 metodų, ne 12");
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
});
