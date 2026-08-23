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
 * ⚠️ FILTRAS YRA VYKDOMAS KELYJE (7.2b jau sumergintas).
 *
 * Anksčiau čia rašė, kad filtras nepasiekiamas: tuo metu vienintelis kelias
 * buvo `writePatched()`, kuris visada eina per `applyPatch()` - o šis tapatybę,
 * nuosavybę ir erą atstato iš originalaus job'o, tad `jobToRow()` iki
 * `snake_case` patch'o net nepriėjo.
 *
 * 7.2b tą pakeitė. `changedColumns()` filtruoja per ŠIĄ aibę, ir per jį eina
 * abu sąlyginiai CAS keliai (`updateOwned()`, `reportProgressAtomic()`), o
 * `writePatched()` - per tą pačią aibę tiesiogiai. Nekintamumas dabar
 * tikrinamas ELGESIU: bendras kontraktų rinkinys siunčia patch'ą, bandantį
 * pakeisti tapatybę, nuosavybę ir erą, ir reikalauja, kad nė vienas backend'as
 * jos nepakeistų.
 *
 * `jobOwnership.test.js` papildomai tikrina, kad ši aibė sutampa su
 * `applyPatch()` saugomais camelCase laukais - kitaip atsirastų laukas, kurį
 * vienas backend'as keičia, o kitas ne.
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

/**
 * PATCH LAUKAS → STULPELIAI, KURIUOS JIS RAŠO.
 *
 * ⚠️ SKIRTUMO NEPAKANKA (#180, Codex „Preserve explicitly patched columns").
 *
 * Anksčiau `SET` sąrašas buvo vien REIKŠMIŲ SKIRTUMAS tarp perskaitytos ir
 * pataisytos eilutės. Jei kvietėjas eksplicitiškai nustato lauką į TĄ PAČIĄ
 * reikšmę, kurią ką tik matė, o konkurentas ją tuo tarpu pakeitė, skirtumo
 * nėra - stulpelis iškrenta iš `SET`, CAS pavyksta, ir operacija praneša SĖKMĘ,
 * nors prašytas patch'as NEBUVO pritaikytas. Konkurento reikšmė lieka.
 *
 * Todėl `SET` sudaro SĄJUNGA: patch'o paliesti stulpeliai ∪ realiai pasikeitę.
 *
 * ⚠️ AIBĖS PILNUMAS TIKRINAMAS TESTU. Praleistas laukas reikštų tyliai
 * neįrašomą patch'ą, tad `jobOwnership.test.js` reikalauja, kad kiekvienas
 * NEKINTAMU nelaikomas `COLUMNS` stulpelis turėtų bent vieną patch raktą.
 */
const PATCH_STULPELIAI = Object.freeze({
  type: ["type"],
  status: ["status"],
  phase: ["phase"],
  /** `progress` ir `progressKnown` yra viena trijų stulpelių būsena. */
  progress: ["progress_known", "progress_current", "progress_total"],
  progressKnown: ["progress_known", "progress_current", "progress_total"],
  actor: ["actor"],
  actorRole: ["actor_role"],
  actorSource: ["actor_source"],
  requestId: ["request_id"],
  storageKey: ["storage_key"],
  artefacts: ["artefacts"],
  /** Senas `error` yra `error_message` sinonimas (žr. `applyPatch()`). */
  error: ["error_message"],
  error_message: ["error_message"],
  error_code: ["error_code"],
  attempt_count: ["attempt_count"],
  audio_cleanup_pending: ["audio_cleanup_pending"],
  audio_cleanup_attempts: ["audio_cleanup_attempts"],
  audio_cleanup_next_attempt_at: ["audio_cleanup_next_attempt_at"],
  deletion_pending: ["deletion_pending"],
  deletion_attempts: ["deletion_attempts"],
  deletion_next_attempt_at: ["deletion_next_attempt_at"],
  started_at: ["started_at"],
  completed_at: ["completed_at"],
  updatedAt: ["updated_at"],
});

/**
 * SIAURAS RAŠYMAS: stulpeliai, kuriuos ši operacija REALIAI keičia.
 *
 * ⚠️ PLATUS `SET` YRA PRARASTAS ATNAUJINIMAS (#180 P1-1).
 *
 * Sąlyginė mutacija saugo tik tuos stulpelius, kurie yra jos `WHERE` dalyje.
 * Jei `SET` sąrašas platesnis už predikatą, kiekvienas jame esantis, bet
 * predikate nesantis stulpelis įrašomas iš PASENUSIO snapshot'o - ir
 * konkurentinis, jau užcommitintas pakeitimas tyliai atsukamas atgal:
 *
 *   A: readJob()                       (deletion_pending = false)
 *   B: UPDATE ... deletion_pending = true   COMMIT
 *   A: CAS UPDATE - progreso predikatas nepakito, tad PAVYKSTA
 *      → deletion_pending vėl false, o B pakeitimas dingo
 *
 * Tai ne teorinis atvejis: `jobErasure.js` tokiu būdu pažymi job'ą
 * pakartotiniam ištrynimui, o `listByFlag("deletion_pending")` jo nebematytų.
 *
 * ⚠️ TAS PATS SPRENDIMAS KAIP REDIS PUSĖJE. `redisStore.CAS_PROGRESS_LUA` rašo
 * TIK `progress`, `progressKnown` ir `updatedAt` būtent dėl šios priežasties
 * (žr. komentarą „Pirmoji versija rašė VISĄ serializuotą job'ą"). Memory
 * backend'as lango neturi, nes dirba be `await`. Platus `SET` PostgreSQL'e
 * padarytų jį VIENINTELIU backend'u, kuris atsuka svetimus laukus.
 *
 * Sąrašas skaičiuojamas iš SKIRTUMO, ne iš fiksuoto vardų sąrašo: taip jis
 * lieka teisingas, jei domeno taisyklė (`jobPhase`) kada nors grąžins platesnį
 * patch'ą, ir nesukuria antros vietos, kurią reikėtų prižiūrėti rankomis.
 *
 * `updated_at` įtraukiamas VISADA - dėl to sąrašas niekada nebūna tuščias
 * (tuščias `SET` būtų SQL sintaksės klaida), o sėkmingas rašymas visada
 * pastumia įrašo laiką.
 *
 * ⚠️ NEKINTAMI STULPELIAI Į SĄRAŠĄ NEPATENKA NIEKADA - filtruojama per tą pačią
 * `IMMUTABLE_COLUMNS` aibę (#180, 4 punktas).
 */
function changedColumns(expected, row, patch = {}) {
  const patchStulpeliai = new Set();
  for (const raktas of Object.keys(patch || {})) {
    for (const stulpelis of PATCH_STULPELIAI[raktas] || []) patchStulpeliai.add(stulpelis);
  }

  /**
   * ⚠️ `updated_at` ČIA NEBEĮTRAUKIAMAS. Jį rašo SQL išraiška rašymo METU
   * (žr. `LAIKO_ZYMA`), ne pasenusi JS reikšmė - todėl jis nėra parametras.
   */
  return COLUMNS.filter(
    (c) => !IMMUTABLE_COLUMNS.has(c) && c !== "updated_at" &&
      (patchStulpeliai.has(c) || row[c] !== expected[c])
  );
}

/**
 * ⚠️ LAIKO ŽYMA SKAIČIUOJAMA RAŠYMO METU, NE PRIEŠ UŽRAKTO LAUKIMĄ.
 *
 * `applyPatch()` `updatedAt` užfiksuoja PRIEŠ CAS. Jei sąlyginis sakinys paskui
 * laukia svetimo eilutės užrakto, įrašoma reikšmė būna SENESNĖ už konkurento ką
 * tik įrašytą - monotoniškumas lūžta. Užlaikymui viršijus `TTL_MS`, ką tik
 * commit'inta eilutė iš karto taptų tinkama `sweepExpired()` valymui.
 *
 * `clock_timestamp()` (ne `now()`) grąžina TIKRĄ laiką eilutės rašymo momentu -
 * `now()` yra transakcijos pradžios žyma, tad laukimo neapimtų. `GREATEST`
 * garantuoja, kad reikšmė niekada nesumažėja net ir laikrodžiui pašokus atgal.
 *
 * `SET` dėl šios išraiškos NIEKADA nebūna tuščias.
 */
const LAIKO_ZYMA = `"updated_at" = GREATEST(updated_at, clock_timestamp())`;

/**
 * SĄLYGINĖ MUTACIJA IR JOS NESĖKMĖS KLASIFIKACIJA VIENAME SAKINYJE (#180 P2-3).
 *
 * ⚠️ ATSKIRAS SKAITYMAS PO NEPAVYKUSIO CAS YRA TOCTOU.
 *
 * Ankstesnė forma buvo: `UPDATE/DELETE ... WHERE <CAS>` → `rowCount === 0` →
 * ATSKIRAS `SELECT ... FOR UPDATE` → klasifikacija. `READ COMMITTED` režime
 * antrasis sakinys gauna NAUJĄ snapshot'ą, tad grąžinamas sentinelis aprašo
 * VĖLESNĘ eilutės būseną, o ne tą, dėl kurios mutacija nepavyko:
 *
 *   A: DELETE ... WHERE owner = A   → 0 eilučių (eilutė jau ištrinta)
 *   B: INSERT to paties id eilutę su savininku B   COMMIT
 *   A: SELECT ... FOR UPDATE        → mato B eilutę → grąžina "FORBIDDEN"
 *
 * Kvietėjas gauna „svetimas job'as", nors iš tikrųjų JO job'o nebėra. Teisingas
 * atsakymas yra `false`.
 *
 * SPRENDIMAS: mutacija įvyniojama į duomenis keičiantį CTE, o nesėkmės
 * priežastis skaičiuojama TAME PAČIAME sakinyje. PostgreSQL visiems `WITH`
 * sub-sakiniams ir pagrindinei užklausai duoda VIENĄ snapshot'ą, tad
 * klasifikacija remiasi būtent ta būsena, kurios atžvilgiu buvo įvertintas CAS
 * predikatas. Vėlesni kitų rašytojų pakeitimai jos paveikti nebegali.
 *
 * ⚠️ MUTACIJA LIEKA SĄLYGINĖ. CTE viduje yra tas pats `UPDATE`/`DELETE ...
 * WHERE <CAS predikatas> RETURNING`; CTE nieko nepalengvina ir nepakeičia
 * užraktu (#180 reikalavimas).
 *
 * ⚠️ `rowCount` REIKŠMĖ PASIKEITĖ. Išorinis `SELECT` visada grąžina VIENĄ
 * eilutę, tad realų pakeistų eilučių skaičių sako `rows[0].pakeista`, ne
 * `result.rowCount`.
 *
 * @param {string} mutacija - sąlyginis `UPDATE`/`DELETE ... RETURNING` sakinys
 * @param {string} priezastis - `SELECT count(*)`, apibrėžiantis nesėkmės rūšį
 */
function casSuKlasifikacija(mutacija, priezastis, papildomi = {}) {
  const extra = Object.entries(papildomi)
    .map(([vardas, uzklausa]) => `,\n           (${uzklausa})::int AS ${vardas}`)
    .join("");
  return `WITH mutacija AS (
${mutacija}
    )
    SELECT (SELECT count(*) FROM mutacija)::int AS pakeista,
           (${priezastis})::int AS priezastis${extra}`;
}

/**
 * „Eilutė YRA, bet nuosavybė NESUTAMPA" - `updateOwned`/`removeOwned` nesėkmės
 * priežastis, atskirianti `"FORBIDDEN"` nuo `null`/`false`.
 *
 * ⚠️ ČIA `owner_kind IS NOT DISTINCT FROM`, nors mutacijos predikate yra `=`.
 * Tai NE neatitikimas, o trivertės logikos reikalavimas: legacy eilutėje
 * `owner_kind IS NULL`, tad `owner_kind = $3` duotų `UNKNOWN`, `NOT (UNKNOWN)`
 * irgi `UNKNOWN`, ir eilutė NEBŪTŲ suskaičiuota - legacy job'as staiga
 * atrodytų „neegzistuojantis" vietoj `"FORBIDDEN"`. Mutacijos pusėje `=` yra
 * teisingas (legacy eilutė neturi būti keičiama), o klasifikacijai reikia
 * tikslaus „egzistuoja, bet netinka" atsakymo.
 */
const SVETIMAS_SCOPE = `SELECT count(*) FROM jobs
            WHERE id = $1
              AND NOT (owner_id IS NOT DISTINCT FROM $2
                       AND owner_kind IS NOT DISTINCT FROM $3)`;

/**
 * „Eilutė YRA" snapshot'e.
 *
 * Naudojama dviem tikslams:
 *   - `reportProgressAtomic` nesėkmės priežastis (`"REJECTED"` vs `null`);
 *   - nuosavybės operacijose - `buvo` stulpelis, atskiriantis „eilutės CAS
 *     snapshot'e NEBUVO" nuo „buvo, bet mutacija vis tiek nepavyko".
 *
 * ⚠️ KODĖL `buvo` BŪTINAS (MVCC / EvalPlanQual).
 *
 * `READ COMMITTED` režime VISOS vieno sakinio dalys naudoja tą patį snapshot'ą,
 * BET duomenis keičianti dalis papildomai daro `EvalPlanQual`: sutikusi
 * konkurenčiai pakeistą eilutę, ji PERSKAITO naujausią patvirtintą versiją ir
 * predikatą įvertina jai. `SELECT` dalys to NEDARO - jos lieka prie snapshot'o.
 *
 * Tad įmanoma nesuderinta baigtis: `pakeista = 0` (EPQ versija nebeatitinka)
 * kartu su `priezastis = 0` (snapshot'o versija buvo SAVA). Be `buvo` ši baigtis
 * nesiskirtų nuo „eilutės apskritai nebuvo", ir savininko pasikeitimas sakinio
 * viduryje būtų klaidingai paskelbtas `false`/`null` vietoj `"FORBIDDEN"`.
 */
const EILUTE_YRA = `SELECT count(*) FROM jobs WHERE id = $1`;

/**
 * PROGRESO CAS PREDIKATAS - VIENAS ŠALTINIS (#180 P2-D).
 *
 * Naudojamas DU kartus tame pačiame sakinyje: sąlyginėje mutacijoje ir
 * `atitiko` klasifikacijoje. Dvi kopijos neišvengiamai išsiskirtų, o tada
 * klasifikacija atsakytų apie KITĄ sąlygą nei mutacija.
 */
const PROGRESO_CAS_PREDIKATAS = `id = $1 AND type = $2 AND status = $3
            AND phase IS NOT DISTINCT FROM $4
            AND progress_known IS NOT DISTINCT FROM $5
            AND progress_current IS NOT DISTINCT FROM $6
            AND progress_total IS NOT DISTINCT FROM $7`;

/**
 * „Eilutė ATITIKO CAS predikatą snapshot'e."
 *
 * ⚠️ KODĖL TO NEPAKANKA `EILUTE_YRA` (#180 P2-D).
 *
 * `EILUTE_YRA` sako tik tiek, kad eilutė snapshot'e buvo. Jei konkurentinis
 * `DELETE` įsipatvirtina PO snapshot'o, bet PRIEŠ tai, kai CAS `UPDATE` gauna
 * eilutės užraktą, `EvalPlanQual` mutaciją palieka be eilučių (`pakeista = 0`),
 * o skaliarinis `EILUTE_YRA` tebemato SENĄ tuple'ą fiksuotame snapshot'e
 * (`priezastis = 1`). Rezultatas būtų `"REJECTED"`, nors eilutės nebėra -
 * kontraktas reikalauja `null`.
 *
 * `atitiko` atskiria dvi iš esmės skirtingas `pakeista = 0` priežastis:
 *   - `atitiko = 0` → predikatas snapshot'e NESUTAPO: įvykis tikrai pasenęs;
 *   - `atitiko = 1` → predikatas SUTAPO, bet mutacija vis tiek nepavyko, t. y.
 *     eilutė sakinio metu buvo ištrinta arba pakeista (EPQ). Tik ŠIOJE
 *     nesuderintoje šakoje reikia užrakinto perskaitymo.
 */
const EILUTE_ATITIKO = `SELECT count(*) FROM jobs WHERE ${PROGRESO_CAS_PREDIKATAS}`;

/**
 * Kiek kartų kartojamas CAS po nesuderintos baigties.
 *
 * ⚠️ RIBA YRA ĮRODYMAS, NE ATSARGA. Kartojama TIK tada, kai `readJobForUpdate()`
 * eilutę UŽRAKINO ir ji tebėra sava - užrakinta eilutė pasikeisti nebegali, tad
 * antras CAS privalo pavykti. Riba paverčia tai tikrinamu faktu: jei ciklas
 * kada nors nesuartėtų, gausime aiškią klaidą, o ne begalinį suktuką.
 */
const CAS_BANDYMU_RIBA = 2;

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

/**
 * ATKŪRIMO RIBOS SARGAS: PostgreSQL progreso reprezentacija (#180 P2-C).
 *
 * ⚠️ `restoreRecord()` YRA VIENINTELIS KELIAS, APLENKIANTIS VALIDACIJĄ.
 *
 * Visi įprasti keliai progreso reikšmes filtruoja: `newJob()` jį visada
 * materializuoja kaip `null`, fasado `update()` atmeta neapdorotus
 * `progress`/`progressKnown` patch'us (`assertNoRawPhaseWrite`), o progreso
 * įvykiai eina per `jobPhase.assertValidProgress()` (`Number.isFinite`).
 *
 * `restoreRecord()` - ne: `restoreService._validateContent()` tikrina tik tai,
 * ar job'as yra objektas su `id`, ir įrašas keliauja tiesiai į `jobToRow()`.
 * Ranka redaguota ar sugadinta kopija su
 *
 *     progressKnown: true, progress: { current: "8", total: "10" }
 *
 * pasiektų `double precision` parametrus, ir PostgreSQL TYLIAI paverstų eilutes
 * skaičiais - būtent tai, ką #180 6 punktas draudžia. Įdėti progreso
 * metaduomenys tuo pačiu keliu būtų TYLIAI nukirpti.
 *
 * Option C sprendimas: tokios būsenos PostgreSQL produkciniame modelyje yra
 * struktūriškai neatstovaujamos, todėl atkūrimas KRENTA UŽDARAI, o ne
 * perinterpretuoja. Sargas taikomas TIK PostgreSQL - memory ir Redis šias
 * formas atstovauja ir jų elgesys nekeičiamas.
 *
 * ⚠️ TIKRINAMA PRIEŠ DESTRUKTYVŲ PAKEITIMĄ. `restoreRecord()` daro
 * `DELETE` + `INSERT`; patikra vykdoma PRIEŠ transakciją, tad netinkamas
 * įrašas negali ištrinti esamo.
 */
class UnsupportedProgressError extends Error {
  constructor(zinute) {
    super(`postgresStore.restoreRecord: ${zinute}`);
    this.name = "UnsupportedProgressError";
    this.code = "UNSUPPORTED_PROGRESS_REPRESENTATION";
  }
}

/** Vieninteliai raktai, kuriuos atstovauja `progress_current`/`progress_total`. */
const ATSTOVAUJAMI_PROGRESO_RAKTAI = new Set(["current", "total"]);

function assertAtstovaujamasProgresas(job) {
  const p = job.progress;

  /**
   * `progressKnown !== true` - legacy ir terminalinės formos. Jos teisėtos TIK
   * su tuščiu progresu: `jobs_progress_known` CHECK reikalauja, kad tada abu
   * reikšmių stulpeliai būtų `NULL`, tad bet kokia progreso reikšmė čia būtų
   * tyliai prarasta.
   */
  /**
   * ⚠️ `progressKnown` PRIVALO BŪTI TIKRAS BOOLEAN (arba visai nebūti).
   *
   * Ranka redaguota kopija su `progressKnown: "true"` (eilute) anksčiau
   * praeidavo: `!== true` ją laikydavo „progreso nėra" šaka, o `jobToRow()`
   * paskui įrašydavo `progress_known = false` - TYLIAI pakeisdamas įrašo
   * prasmę atkūrimo metu. Legacy įrašai lauko išvis neturi, tad `undefined`
   * lieka leistinas.
   */
  if (job.progressKnown !== undefined && typeof job.progressKnown !== "boolean") {
    throw new UnsupportedProgressError(
      `progressKnown = ${JSON.stringify(job.progressKnown)} nėra boolean; ` +
        "tipizuotas progress_known stulpelis reikšmę tyliai perinterpretuotų"
    );
  }

  if (job.progressKnown !== true) {
    if (p == null) return;
    throw new UnsupportedProgressError(
      `progressKnown=${JSON.stringify(job.progressKnown)} su ne tuščiu progresu ` +
        `${JSON.stringify(p)} - reikšmės būtų tyliai prarastos (jobs_progress_known)`
    );
  }

  if (p == null || typeof p !== "object" || Array.isArray(p)) {
    throw new UnsupportedProgressError(
      `progressKnown=true reikalauja { current, total }, gauta ${JSON.stringify(p)}`
    );
  }

  const perteklius = Object.keys(p).filter((k) => !ATSTOVAUJAMI_PROGRESO_RAKTAI.has(k));
  if (perteklius.length > 0) {
    throw new UnsupportedProgressError(
      `progrese yra laisvos formos raktų [${perteklius.join(", ")}], kurių produkcinė ` +
        "schema neturi kur saugoti - jie būtų tyliai nukirpti"
    );
  }

  /**
   * ⚠️ `Number.isFinite("8")` yra `false`. Būtent tai atmeta skaitines EILUTES,
   * kurias `double precision` riba tyliai paverstų skaičiais.
   */
  for (const raktas of ["current", "total"]) {
    if (!Number.isFinite(p[raktas])) {
      throw new UnsupportedProgressError(
        `progress.${raktas} = ${JSON.stringify(p[raktas])} nėra baigtinis SKAIČIUS; ` +
          "tipizuotas double precision stulpelis jį perinterpretuotų tyliai"
      );
    }
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
   * Naudojama tik nepavykus sąlyginei mutacijai: užraktas stabilizuoja
   * klasifikavimo rezultatą iki transakcijos pabaigos. Pati mutacija ir toliau
   * yra CAS sakinys; šis skaitymas nėra jos autorizacijos pakaitalas.
   */
  async function readJobForUpdate(client, id) {
    const { rows } = await client.query(
      `${SELECT_JOB} WHERE j.id = $1 FOR UPDATE OF j`,
      [id]
    );
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
    /** ⚠️ PRIEŠ transakciją - netinkamas įrašas negali ištrinti esamo. */
    assertAtstovaujamasProgresas(job);
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
      let current = await readJob(client, id);
      /**
       * Eilutės nėra - patch'o net nėra iš ko suskaičiuoti (`applyPatch()`
       * remiasi esama eilute). Tai NE klasifikacija po nepavykusio CAS: joks
       * CAS dar nebuvo bandytas, tad P2-3 lango čia nėra.
       */
      if (!current) return null;
      /**
       * ⚠️ NUOSAVYBĖS SPRENDIMO JS PUSĖJE NEBĖRA. Anksčiau čia buvo
       * `if (!matchesOwner(current, scope)) return "FORBIDDEN"` - aplikacijos
       * lygmens palyginimas, tapęs rezultato autoritetu. Dabar `"FORBIDDEN"`
       * gali kilti TIK iš SQL klasifikacijos, atominės su pačiu CAS.
       * `matchesOwner()` lieka naudojamas tik kaip pakartojimo sąlyga žemiau.
       */

      let result;
      for (let bandymas = 1; ; bandymas++) {
        /**
         * ⚠️ SIAURAS `SET` (#180 P2-2). Nuosavybės CAS predikatas saugo TIK
         * nuosavybę, o ji nekintama - vadinasi, jis sutampa su KIEKVIENU
         * konkurentiniu rašymu. Platus `SET` čia reikštų, kad bet koks
         * užcommitintas svetimas pakeitimas (`status`, `phase`, progresas,
         * `deletion_pending`, `attempt_count`, klaidų laukai) būtų atsuktas
         * atgal iš pasenusio snapshot'o - CAS to NEPAGAUTŲ, nes nuosavybė
         * nepasikeitė.
         *
         * Rašomi tik patch'o REALIAI pakeisti stulpeliai, tad nepaliesti
         * laukai lieka tokie, kokius paliko konkurentas.
         *
         * ⚠️ SĄRAŠAS SKAIČIUOJAMAS CIKLO VIDUJE. Po pakartotinio skaitymo
         * (`readJobForUpdate`) `current` yra kita eilutė, tad ir skirtumas
         * kitas; vienkartinis skaičiavimas prieš ciklą rašytų pasenusį sąrašą.
         *
         * ⚠️ `SET` NIEKADA nesudaromas iš neatfiltruotų patch'o laukų:
         * `applyPatch()` atstato tapatybę, nuosavybę ir erą, `jobToRow()` skaito
         * tik žinomus laukus, o `changedColumns()` papildomai išbraukia
         * `IMMUTABLE_COLUMNS` (#180, 4 punktas).
         */
        const row = jobToRow(applyPatch(current, patch));
        const rasomi = changedColumns(jobToRow(current), row, patch);
        const sets = [
          ...rasomi.map((c, i) => `"${c}" = $${i + 4}`),
          LAIKO_ZYMA,
        ].join(", ");
        result = await client.query(
          casSuKlasifikacija(
            `      UPDATE jobs SET ${sets}
            WHERE id = $1 AND owner_id IS NOT DISTINCT FROM $2 AND owner_kind = $3
          RETURNING id`,
            SVETIMAS_SCOPE,
            { buvo: EILUTE_YRA }
          ),
          [id, scope.ownerId ?? null, scope.ownerKind, ...rasomi.map((c) => row[c])]
        );
        const { pakeista, priezastis, buvo } = result.rows[0];
        if (pakeista > 0) break;
        /** Eilutė YRA, bet svetima - nustatyta tuo pačiu snapshot'u kaip CAS. */
        if (priezastis > 0) return "FORBIDDEN";

        /**
         * ⚠️ CAS SNAPSHOT'E EILUTĖS NEBUVO - GALUTINIS `null`.
         *
         * Vėliau atsiradusi eilutė yra KITA įrašo inkarnacija: jos nebuvo, kai
         * operacija buvo įvertinta. Ankstesnė versija tokiu atveju kartodavo CAS
         * ir mutuodavo eilutę, sukurtą JAU PO kvietimo - t. y. keisdavo įrašą,
         * kurio kvietėjas niekada neprašė. Kontraktas aiškus: „job neegzistuoja
         * → null" (#180, 1 punktas).
         */
        if (buvo === 0) return null;

        /**
         * ⚠️ NESUDERINTA BAIGTIS: snapshot'e eilutė BUVO SAVA, bet mutacija
         * nepavyko. Vienintelė priežastis - `EvalPlanQual`: eilutė sakinio metu
         * buvo konkurenčiai ištrinta arba jos nuosavybė pasikeitė.
         *
         * ⚠️ ŠIS SKAITYMAS NĖRA BENDRAS KLASIFIKATORIUS. Jis kviečiamas TIK
         * šioje siauroje, jau atmestoje šakoje ir tik tam, kad atskirtų dvi
         * likusias galimybes.
         */
        const dabartine = await readJobForUpdate(client, id);
        if (!dabartine) return null;
        if (!matchesOwner(dabartine, scope)) return "FORBIDDEN";
        if (bandymas >= CAS_BANDYMU_RIBA) {
          throw new Error(
            `postgresStore.updateOwned: CAS nesuartėjo per ${CAS_BANDYMU_RIBA} bandymus`
          );
        }
        current = dabartine;
      }
      await upsertResult(client, id, patch.result);
      return readJob(client, id);
    });
  }

  /** @returns {boolean|"FORBIDDEN"} */
  async function removeOwned(id, scope) {
    return inTransaction(async (client) => {
      for (let bandymas = 1; ; bandymas++) {
        const result = await client.query(
          casSuKlasifikacija(
            `      DELETE FROM jobs WHERE id = $1
              AND owner_id IS NOT DISTINCT FROM $2 AND owner_kind = $3
          RETURNING id`,
            SVETIMAS_SCOPE,
            { buvo: EILUTE_YRA }
          ),
          [id, scope.ownerId ?? null, scope.ownerKind]
        );
        const { pakeista, priezastis, buvo } = result.rows[0];
        if (pakeista > 0) return true;
        /** Eilutė YRA, bet svetima - tas pats snapshot'as kaip DELETE. */
        if (priezastis > 0) return "FORBIDDEN";

        /**
         * ⚠️ CAS SNAPSHOT'E EILUTĖS NEBUVO - GALUTINIS `false`.
         *
         * Vėliau tuo pačiu id atsiradusi eilutė yra KITA inkarnacija. Ankstesnė
         * versija ją ištrindavo ir grąžindavo `true` - t. y. sunaikindavo įrašą,
         * sukurtą jau PO kvietimo (pvz. `restoreRecord()` atkurtą). Kontraktas:
         * „job neegzistuoja → false" (#180, 2 punktas).
         */
        if (buvo === 0) return false;

        /**
         * ⚠️ NESUDERINTA BAIGTIS (`EvalPlanQual`) - žr. `EILUTE_YRA`.
         * Skaitymas TIK atskiria „ištrinta" nuo „nuosavybė pasikeitė".
         */
        const dabartine = await readJobForUpdate(client, id);
        if (!dabartine) return false;
        if (!matchesOwner(dabartine, scope)) return "FORBIDDEN";
        if (bandymas >= CAS_BANDYMU_RIBA) {
          throw new Error(
            `postgresStore.removeOwned: CAS nesuartėjo per ${CAS_BANDYMU_RIBA} bandymus`
          );
        }
      }
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
      /**
       * ⚠️ TIK PAKEISTI STULPELIAI (žr. `changedColumns()`). Platus `SET`
       * atsuktų atgal kiekvieną konkurentinį pakeitimą, kurio nėra žemiau
       * esančiame predikate.
       */
      const rasomi = changedColumns(expected, row, patch);
      const sets = [
        ...rasomi.map((c, i) => `"${c}" = $${i + 8}`),
        LAIKO_ZYMA,
      ].join(", ");
      const result = await client.query(
        casSuKlasifikacija(
          `      UPDATE jobs SET ${sets}
          WHERE ${PROGRESO_CAS_PREDIKATAS}
        RETURNING id`,
          EILUTE_YRA,
          { atitiko: EILUTE_ATITIKO }
        ),
        [id, expected.type, expected.status, expected.phase, expected.progress_known,
          expected.progress_current, expected.progress_total,
          ...rasomi.map((c) => row[c])]
      );
      const { pakeista, priezastis, atitiko } = result.rows[0];
      if (pakeista > 0) return readJob(client, id);

      /**
       * ⚠️ KLASIFIKACIJA IŠ TO PATIES SAKINIO (#180 P2-3), PATIKSLINTA P2-D.
       *
       * Predikatas snapshot'e NESUTAPO - baigtinis atsakymas, jokio vėlesnio
       * skaitymo. `priezastis` skiria „eilutė buvo, bet įvykis pasenęs" nuo
       * „eilutės apskritai nebuvo".
       */
      if (atitiko === 0) return priezastis > 0 ? "REJECTED" : null;

      /**
       * ⚠️ NESUDERINTA BAIGTIS (EPQ): predikatas snapshot'e SUTAPO, tad mutacija
       * turėjo pavykti, bet nepavyko. Vienintelė priežastis - eilutė sakinio
       * metu ištrinta arba pakeista konkurentinės transakcijos.
       *
       * ⚠️ TAI NĖRA NEUŽRAKINTAS PO-CAS `SELECT`. Skaitymas užrakina eilutę ir
       * kviečiamas TIK šioje jau įrodytai nesuderintoje šakoje - jis atskiria
       * dvi likusias galimybes, o ne klasifikuoja bendrai.
       */
      const dabartine = await readJobForUpdate(client, id);
      return dabartine ? "REJECTED" : null;
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
  COLUMNS,
  DuplicateJobError,
  PATCH_STULPELIAI,
  UnsupportedProgressError,
  assertAtstovaujamasProgresas,
};
