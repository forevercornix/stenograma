const {
  STATUS,
  JOB_TYPES,
  TTL_MS,
  newJob,
  applyPatch,
  matchesOwner,
} = require("./common");

/**
 * PostgreSQL job store backend'as (#155, 7.2a) — TREČIAS backend'as.
 *
 * ⚠️ ŠIS FAILAS NEĮJUNGIA PostgreSQL. Backend'o parinkimą ir aktyvavimo barjerą
 * valdo `index.js`; žr. `docs/decisions/155-postgres-authority.md` skyrių
 * „AKTYVAVIMO BARJERAS". Iki 7.5a/7.5b/7.6 prielaidų PostgreSQL naudojamas TIK
 * integraciniuose ir kontraktų testuose.
 *
 * KONTRAKTAS — 15 metodų, ne 12. Fasadas besąlygiškai kviečia `getOwned()`
 * nuosavybės skaitymui, `restoreRecord()` atkūrimui ir `size()` diagnostikai;
 * `listByFlag` / `listReferencedStorageKeys` maitina laukiančio valymo paiešką
 * ir retenciją. Backend'as su trumpesniu sąrašu lūžtų įprastose užklausose.
 *
 * Atominės `updateOwned`, `removeOwned` ir `reportProgressAtomic` operacijos
 * sprendimo preconditions laiko SQL mutacijos `WHERE` dalyje ir naudoja
 * `RETURNING`; jų ekvivalentumą trims backend'ams tikrina bendras rinkinys.
 */

/**
 * `tenant_id` SENTINELIS.
 *
 * ⚠️ VERTIMAS BŪTINAS, `DEFAULT` NEPAKANKA. `newJob()` visada materializuoja
 * `tenantId: null`, tad `INSERT` siunčia EKSPLICITINĮ `NULL` — o tokiu atveju
 * stulpelio `DEFAULT` NETAIKOMAS ir kiekvienas `create()` pažeistų `NOT NULL`.
 *
 * Vertimas dvipusis, kad bendras kontraktas liktų nepakitęs: memory ir Redis
 * mato `null`, DB — sentinelį.
 */
const TENANT_SENTINEL = "00000000-0000-0000-0000-000000000000";

function tenantToDb(value) {
  return value == null ? TENANT_SENTINEL : value;
}

function tenantFromDb(value) {
  return value === TENANT_SENTINEL ? null : value;
}

/** ISO eilutė ↔ `timestamptz`. Job kontraktas laikus laiko ISO eilutėmis. */
function isoFromDb(value) {
  return value == null ? null : new Date(value).toISOString();
}

/**
 * Eilutė → job objektas.
 *
 * ⚠️ REZULTATAS HIDRATUOJAMAS. Transkripcijos gyvena `job_results`, bet
 * `utils/jobResponse.js` skaito `job.result`. Be susiejimo atgal realizacija
 * galėtų sėkmingai IŠSAUGOTI transkripciją ir grąžinti `result: null`
 * kiekvienam klientui — sėkmingas įrašymas, tuščias atsakymas.
 */
function rowToJob(row) {
  if (!row) return null;

  const progress = row.progress_known
    ? { current: Number(row.progress_current), total: Number(row.progress_total) }
    : null;

  const job = {
    id: row.id,
    type: row.type,
    status: row.status,
    phase: row.phase,
    progress,
    progressKnown: row.progress_known,
    ownerId: row.owner_id,
    ownerKind: row.owner_kind,
    tenantId: tenantFromDb(row.tenant_id),
    /**
     * ⚠️ HIDRATUOJAMAS BŪTINAI. `jobToRow()` jį rašo, o be atgalinio susiejimo
     * pirmas gyvavimo ciklo `update()` perrašytų stulpelį į `NULL`: dalinis
     * indeksas `NULL` eilučių neapima, tad pakartotinis `create()` su tuo pačiu
     * raktu praeitų vietoj `DuplicateJobError`. Idempotency dingtų per
     * ĮPRASTĄ round-trip, ne per kraštutinį atvejį.
     */
    idempotencyKey: row.idempotency_key,
    actor: row.actor,
    actorRole: row.actor_role,
    actorSource: row.actor_source,
    requestId: row.request_id,
    storageKey: row.storage_key,
    artefacts: row.artefacts || [],
    result: row.result === undefined ? null : row.result,
    /**
     * `error` yra ATGALINIS SUDERINAMUMAS su senu lauku — `applyPatch()` jį
     * laiko `error_message` kopija. Atskiro stulpelio nėra sąmoningai: dvi
     * kolonos tam pačiam tekstui neišvengiamai išsiskirtų.
     */
    error: row.error_message,
    error_code: row.error_code,
    error_message: row.error_message,
    attempt_count: row.attempt_count,
    audio_cleanup_pending: row.audio_cleanup_pending,
    audio_cleanup_attempts: row.audio_cleanup_attempts,
    audio_cleanup_next_attempt_at: isoFromDb(row.audio_cleanup_next_attempt_at),
    deletion_pending: row.deletion_pending,
    deletion_attempts: row.deletion_attempts,
    deletion_next_attempt_at: isoFromDb(row.deletion_next_attempt_at),
    created_at: isoFromDb(row.created_at),
    started_at: isoFromDb(row.started_at),
    completed_at: isoFromDb(row.completed_at),
    createdAt: isoFromDb(row.created_at),
    updatedAt: isoFromDb(row.updated_at),
  };

  /**
   * ĮRAŠO ERA (#158) — PERSISTINAMA IR GRĄŽINAMA.
   *
   * `newJob()` nustato `2`, ir `jobAuthorization.resolveCurrentRole()` būtent
   * pagal ją interpretuoja sesijos aktorių kaip stabilų UUID. Pametus lauką per
   * round-trip, job'as eitų legacy vardo keliu ir jo vykdymas būtų atmestas.
   *
   * LEGACY įrašas lauko NETURI — tai skiriasi nuo `schemaVersion: null`.
   * `applyPatch()` tikrina `"schemaVersion" in job`, tad reikšmė turi būti
   * NESANTI, ne `null`.
   */
  if (row.schema_version != null) job.schemaVersion = row.schema_version;

  return job;
}

/** Job objektas → `INSERT`/`UPDATE` parametrai. */
function jobToRow(job) {
  const known = job.progressKnown === true;
  return {
    id: job.id,
    schema_version: job.schemaVersion ?? null,
    type: job.type,
    status: job.status,
    phase: job.phase ?? null,
    progress_known: known,
    progress_current: known && job.progress ? job.progress.current : null,
    progress_total: known && job.progress ? job.progress.total : null,
    owner_kind: job.ownerKind ?? null,
    owner_id: job.ownerId ?? null,
    tenant_id: tenantToDb(job.tenantId),
    idempotency_key: job.idempotencyKey ?? null,
    actor: job.actor ?? null,
    actor_role: job.actorRole ?? null,
    actor_source: job.actorSource ?? null,
    request_id: job.requestId ?? null,
    storage_key: job.storageKey ?? null,
    artefacts: JSON.stringify(job.artefacts || []),
    error_code: job.error_code ?? null,
    /** Senas `error` priimamas kaip šaltinis, jei `error_message` nėra. */
    error_message: job.error_message ?? job.error ?? null,
    attempt_count: job.attempt_count ?? 0,
    audio_cleanup_pending: Boolean(job.audio_cleanup_pending),
    audio_cleanup_attempts: job.audio_cleanup_attempts ?? 0,
    audio_cleanup_next_attempt_at: job.audio_cleanup_next_attempt_at ?? null,
    deletion_pending: Boolean(job.deletion_pending),
    deletion_attempts: job.deletion_attempts ?? 0,
    deletion_next_attempt_at: job.deletion_next_attempt_at ?? null,
    created_at: job.created_at || job.createdAt || new Date().toISOString(),
    updated_at: job.updatedAt || new Date().toISOString(),
    started_at: job.started_at ?? null,
    completed_at: job.completed_at ?? null,
  };
}

const COLUMNS = [
  "id", "schema_version", "type", "status", "phase",
  "progress_known", "progress_current", "progress_total",
  "owner_kind", "owner_id", "tenant_id", "idempotency_key",
  "actor", "actor_role", "actor_source", "request_id", "storage_key",
  "artefacts", "error_code", "error_message", "attempt_count",
  "audio_cleanup_pending", "audio_cleanup_attempts", "audio_cleanup_next_attempt_at",
  "deletion_pending", "deletion_attempts", "deletion_next_attempt_at",
  "created_at", "updated_at", "started_at", "completed_at",
];

/** `j.*` su prijungtu rezultatu — vienintelė skaitymo forma (žr. hidrataciją). */
/**
 * STULPELIAI, KURIŲ `UPDATE ... SET` NIEKADA NELIEČIA.
 *
 * Tapatybė (`id`), nuosavybė (#159), nuoma, kūrimo ketinimas
 * (`idempotency_key`), įrašo era (#158) ir sukūrimo laikas nustatomi TIK
 * `create()` / `restoreRecord()` metu.
 *
 * ⚠️ SĄŽININGAI: ŠIANDIEN ŠIS FILTRAS NEPASIEKIAMAS.
 *
 * `writePatched()` visada eina per `applyPatch()`, kuris tapatybę, nuosavybę
 * ir erą atstato iš originalaus job'o, o `jobToRow()` skaito tik camelCase
 * laukus - tad `snake_case` patch'as row builder'io nepasiekia. Vadinasi,
 * pakeisti šių laukų per esamą kelią NEĮMANOMA ir be šio filtro.
 *
 * Filtras vis tiek reikalingas: garantija, kurią duoda vien helperis, dingsta
 * pirmam keliui, kuris jo neiškviečia - o 7.2b kaip tik įveda naujus SQL
 * mutacijų kelius (`UPDATE ... WHERE ... RETURNING`), kuriuose `applyPatch()`
 * gali nebedalyvauti. Aibė tikrinama kontrakto testu, ne elgesiu, nes elgesio
 * kelio kol kas nėra.
 */
const IMMUTABLE_COLUMNS = new Set([
  "id",
  "owner_id",
  "owner_kind",
  "tenant_id",
  "idempotency_key",
  "schema_version",
  "created_at",
]);

const SELECT_JOB = `
  SELECT j.*, r.payload AS result
    FROM jobs j
    LEFT JOIN job_results r ON r.job_id = j.id
`;

function insertSql() {
  const cols = COLUMNS.map((c) => `"${c}"`).join(", ");
  const params = COLUMNS.map((_, i) => `$${i + 1}`).join(", ");
  return `INSERT INTO jobs (${cols}) VALUES (${params}) RETURNING *`;
}

function insertValues(job) {
  const row = jobToRow(job);
  return COLUMNS.map((c) => row[c]);
}

/**
 * Ar klaida yra idempotency dublikatas?
 *
 * „Duplicate write → kontroliuojama klaida" turi pasakyti, KAS yra duplicate:
 * tas pats `idempotency_key` toje pačioje nuomoje. Kitos `unique_violation`
 * (pvz. pirminio rakto) reiškia ką kita ir neturi būti sulietos.
 */
class DuplicateJobError extends Error {
  constructor(key) {
    super(`Job su idempotency_key="${key}" toje pačioje nuomoje jau egzistuoja.`);
    this.name = "DuplicateJobError";
    this.code = "DUPLICATE_JOB";
  }
}

function createPostgresStore(pool) {
  /** Rezultato įrašymas — `payload` yra JSONB, tad bet koks JSON tinka. */
  async function upsertResult(client, jobId, result) {
    if (result === undefined) return;

    if (result === null) {
      await client.query("DELETE FROM job_results WHERE job_id = $1", [jobId]);
      return;
    }

    await client.query(
      `INSERT INTO job_results (job_id, storage_type, payload, created_at)
       VALUES ($1, 'inline', $2::jsonb, now())
       ON CONFLICT (job_id) DO UPDATE SET payload = EXCLUDED.payload`,
      [jobId, JSON.stringify(result)]
    );
  }

  async function readJob(client, id) {
    const { rows } = await client.query(`${SELECT_JOB} WHERE j.id = $1`, [id]);
    return rowToJob(rows[0]);
  }

  /**
   * Transakcija su garantuotu `ROLLBACK` ir kliento grąžinimu.
   *
   * Be `finally` bloko nutrūkęs `await` paliktų klientą su atvira transakcija,
   * o pool'as ilgainiui išsektų — gedimas pasirodytų ne ten, kur atsirado.
   */
  async function inTransaction(fn) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* prisijungimas jau nutrūkęs – pirminė klaida svarbesnė */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async function create(fields = {}) {
    const job = newJob(fields);
    try {
      return await inTransaction(async (client) => {
        await client.query(insertSql(), insertValues(job));
        return readJob(client, job.id);
      });
    } catch (err) {
      if (err.code === "23505" && err.constraint === "jobs_idempotency") {
        throw new DuplicateJobError(job.idempotencyKey);
      }
      throw err;
    }
  }

  /**
   * Įrašo jobą IŠSAUGANT jo ID (#20 PR2 – atkūrimui).
   *
   * `create()` generuotų naują ID, o kopijos įrašai nurodo konkrečius
   * identifikatorius: naujas ID nutrauktų audio raktus, audito įrašus ir
   * išvedimo grafą.
   *
   * Perduodama NEPAKEISTA — įskaitant legacy formas (`processing + phase=NULL`,
   * `ownerKind = null`), kurias schema priima sąmoningai.
   */
  async function restoreRecord(job) {
    return inTransaction(async (client) => {
      await client.query("DELETE FROM jobs WHERE id = $1", [job.id]);
      await client.query(insertSql(), insertValues(job));
      await upsertResult(client, job.id, job.result ?? null);
      return job;
    });
  }

  async function get(id) {
    const { rows } = await pool.query(`${SELECT_JOB} WHERE j.id = $1`, [id]);
    return rowToJob(rows[0]);
  }

  async function update(id, patch) {
    return inTransaction(async (client) => {
      const current = await readJob(client, id);
      if (!current) return null;
      return writePatched(client, current, patch);
    });
  }

  /** Bendras kelias visoms mutacijoms: `applyPatch()` + įrašymas. */
  async function writePatched(client, current, patch) {
    const next = applyPatch(current, patch);
    const row = jobToRow(next);

    /**
     * ⚠️ `id`, `owner_id`, `owner_kind` IR `tenant_id` Į `SET` NEPATENKA.
     *
     * Nuosavybė nustatoma TIK `create()` metu (#159). `applyPatch()` tą jau
     * garantuoja, bet garantija, kurią duoda vien helperis, dingsta pirmam
     * kelią, kuris jo neiškviečia — o `updateOwned` čia tuo pačiu keliu
     * atominiai autorizuoja kaip savininkas A. Sąrašas ribojamas ir SQL pusėje.
     */
    const mutable = COLUMNS.filter((c) => !IMMUTABLE_COLUMNS.has(c));

    const sets = mutable.map((c, i) => `"${c}" = $${i + 2}`).join(", ");

    await client.query(
      `UPDATE jobs SET ${sets} WHERE id = $1`,
      [current.id, ...mutable.map((c) => row[c])]
    );

    await upsertResult(client, current.id, patch.result);
    return readJob(client, current.id);
  }

  /** @returns {object|null|"FORBIDDEN"} */
  async function getOwned(id, scope) {
    const job = await get(id);
    if (!job) return null;
    return matchesOwner(job, scope) ? job : "FORBIDDEN";
  }

  /** @returns {object|null|"FORBIDDEN"} */
  async function updateOwned(id, patch, scope) {
    return inTransaction(async (client) => {
      const current = await readJob(client, id);
      if (!current) return null;
      if (!matchesOwner(current, scope)) return "FORBIDDEN";
      const row = jobToRow(applyPatch(current, patch));
      const mutable = COLUMNS.filter((c) => !IMMUTABLE_COLUMNS.has(c));
      const sets = mutable.map((c, i) => `"${c}" = $${i + 4}`).join(", ");
      const result = await client.query(
        `UPDATE jobs SET ${sets}
          WHERE id = $1 AND owner_id IS NOT DISTINCT FROM $2 AND owner_kind = $3
        RETURNING id`,
        [id, scope.ownerId ?? null, scope.ownerKind, ...mutable.map((c) => row[c])]
      );
      if (result.rowCount === 0) return (await readJob(client, id)) ? "FORBIDDEN" : null;
      await upsertResult(client, id, patch.result);
      return readJob(client, id);
    });
  }

  /** @returns {boolean|"FORBIDDEN"} */
  async function removeOwned(id, scope) {
    return inTransaction(async (client) => {
      const result = await client.query(
        `DELETE FROM jobs WHERE id = $1
            AND owner_id IS NOT DISTINCT FROM $2 AND owner_kind = $3
        RETURNING id`,
        [id, scope.ownerId ?? null, scope.ownerKind]
      );
      if (result.rowCount > 0) return true;
      return (await readJob(client, id)) ? "FORBIDDEN" : false;
    });
  }

  /** @returns {object|null|"REJECTED"} */
  async function reportProgressAtomic(id, event) {
    const jobPhase = require("../jobPhase");
    return inTransaction(async (client) => {
      const current = await readJob(client, id);
      if (!current) return null;
      const patch = jobPhase.reportProgress(current, event);
      if (!patch) return "REJECTED";
      const row = jobToRow(applyPatch(current, patch));
      const expected = jobToRow(current);
      const mutable = COLUMNS.filter((c) => !IMMUTABLE_COLUMNS.has(c));
      const sets = mutable.map((c, i) => `"${c}" = $${i + 8}`).join(", ");
      const result = await client.query(
        `UPDATE jobs SET ${sets}
          WHERE id = $1 AND type = $2 AND status = $3
            AND phase IS NOT DISTINCT FROM $4
            AND progress_known IS NOT DISTINCT FROM $5
            AND progress_current IS NOT DISTINCT FROM $6
            AND progress_total IS NOT DISTINCT FROM $7
        RETURNING id`,
        [id, expected.type, expected.status, expected.phase, expected.progress_known,
          expected.progress_current, expected.progress_total,
          ...mutable.map((c) => row[c])]
      );
      if (result.rowCount === 0) return (await readJob(client, id)) ? "REJECTED" : null;
      return readJob(client, id);
    });
  }

  async function remove(id) {
    const { rowCount } = await pool.query("DELETE FROM jobs WHERE id = $1", [id]);
    return rowCount > 0;
  }

  /**
   * TTL valymas.
   *
   * ⚠️ NEBAIGTO VALYMO JOBŲ NEIŠMETAM. Kol `audio_cleanup_pending` ar
   * `deletion_pending` nustatytas, jobStore įrašas yra VIENINTELIS šaltinis,
   * iš kurio žinomas `storageKey` (BullMQ job'as gali būti jau pašalintas).
   * Išmetus jį per TTL, likęs audio failas taptų nebeatsekamas — tas pats
   * sprendimas kaip `memoryStore` ir `redisStore.js:175`.
   */
  async function sweepExpired(now = Date.now()) {
    const riba = new Date(now - TTL_MS).toISOString();
    const { rowCount } = await pool.query(
      `DELETE FROM jobs
        WHERE status = ANY($1)
          AND updated_at < $2
          AND NOT audio_cleanup_pending
          AND NOT deletion_pending`,
      [[STATUS.COMPLETED, STATUS.FAILED, STATUS.CANCELLED], riba]
    );
    return rowCount;
  }

  async function size() {
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM jobs");
    return rows[0].n;
  }

  async function listAll() {
    const { rows } = await pool.query(`${SELECT_JOB} ORDER BY j.created_at`);
    return rows.map(rowToJob);
  }

  const FLAG_COLUMNS = new Set(["audio_cleanup_pending", "deletion_pending"]);

  async function listByFlag(field, limit = 100) {
    /**
     * ⚠️ STULPELIO VARDAS PER WHITELIST, ne interpoliacija. `field` ateina iš
     * kviečiančiojo kodo, o stulpelio vardo parametrizuoti negalima — be
     * whitelist čia būtų SQL injekcijos taškas.
     */
    if (!FLAG_COLUMNS.has(field)) {
      throw new TypeError(
        `listByFlag: nežinoma vėliava "${field}". Leidžiamos: ${[...FLAG_COLUMNS].join(", ")}.`
      );
    }

    /**
     * ⚠️ BE REZULTATŲ PRIJUNGIMO. `SELECT_JOB` daro `LEFT JOIN job_results` ir
     * deserializuoja KIEKVIENO job'o `payload`, nors abu valymo ciklai naudoja
     * tik metaduomenis (vėliava, bandymai, terminas, `storageKey`).
     *
     * Su numatytu `limit = 100` ir 20 MiB rezultato riba vienas periodinis
     * praėjimas be reikalo pertemptų kelis GiB - tiesiogiai prieštaraudamas
     * priežasčiai, dėl kurios rezultatai iškelti į atskirą lentelę.
     *
     * `result` čia lieka `null`; jei kada prireiks, imamas per `get()`.
     */
    const { rows } = await pool.query(
      `SELECT j.* FROM jobs j WHERE j."${field}" ORDER BY j.updated_at LIMIT $1`,
      [limit]
    );
    return rows.map(rowToJob);
  }

  /**
   * VISŲ gyvų jobų storage raktai.
   *
   * ⚠️ ELGESYS, NE EGZISTAVIMAS. `retentionSweeper.js:58-96` grąžintą reikšmę
   * traktuoja kaip įrodymą, kad joks gyvas job'as neberodo į seną audio, ir
   * TUOS FAILUS IŠTRINA. Realizacija, besąlygiškai grąžinanti `[]`, praeitų
   * metodų aibės patikrą ir sunaikintų dar apdorojamų job'ų audio — todėl
   * filtro pagal statusą ar vėliavas čia NĖRA.
   */
  async function listReferencedStorageKeys() {
    const { rows } = await pool.query(
      "SELECT DISTINCT storage_key FROM jobs WHERE storage_key IS NOT NULL"
    );
    return rows.map((r) => r.storage_key);
  }

  async function close() {
    await pool.end();
  }

  return {
    create,
    restoreRecord,
    get,
    update,
    remove,
    reportProgressAtomic,
    getOwned,
    updateOwned,
    removeOwned,
    sweepExpired,
    size,
    listAll,
    listByFlag,
    listReferencedStorageKeys,
    close,
    STATUS,
    JOB_TYPES,
    TTL_MS,
    backend: "postgres",
  };
}

module.exports = {
  createPostgresStore,
  IMMUTABLE_COLUMNS,
  rowToJob,
  jobToRow,
  tenantToDb,
  tenantFromDb,
  TENANT_SENTINEL,
  DuplicateJobError,
};
