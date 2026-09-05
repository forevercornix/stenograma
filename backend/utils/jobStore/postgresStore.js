const {
  STATUS,
  JOB_TYPES,
  TTL_MS,
  newJob,
  applyPatch,
  matchesOwner,
  normalizeJob,
  idempotentiskasAtsakymas,
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
/**
 * @param {object} row
 * @param {{hidratuota?: boolean}} [nustatymai] `hidratuota: false` - metaduomenų kelias
 */
function rowToJob(row, { hidratuota = true } = {}) {
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
    /**
     * OPTIMISTIC LOCK VERSIJA (#184, 7.5b). Legacy eilutė stulpelio neturi tik
     * tol, kol nepritaikyta migracija; ten `?? 1` duoda tą pačią pradinę
     * reikšmę, kurią duoda `DEFAULT 1`.
     */
    version: row.version ?? 1,
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

  /**
   * ⚠️ NEHIDRATUOTAS JOB'AS `result` LAUKO NETURI — JIS NĖRA `null`.
   *
   * `null` reiškia „rezultato NĖRA" (`common.js` `rezultatoNera()`), ir metaduomenų
   * kelyje tai būtų MELAS apie job'ą, kurio rezultatas puikiausiai egzistuoja. Be to
   * `applyPatch()` sprendžia pagal `"result" in job`: `null` reikštų nurodymą
   * IŠTRINTI rezultatą, jei toks įrašas kada nors keliautų į `update()`.
   *
   * Lauko nebuvimas yra tas pats mechanizmas, kurį jau naudoja `schemaVersion`.
   */
  if (hidratuota) job.result = row.result === undefined ? null : row.result;

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
    version: job.version ?? 1,
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
  /** Optimistic lock versija (#184, 7.5b). */
  "version",
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
 * 7.2b tą pakeitė. Filtras dabar YRA vykdomame kelyje: per `KINTAMI_STULPELIAI`
 * eina abu sąlyginiai CAS keliai (`changedColumns()`) ir `writePatched()`.
 *
 * ⚠️ BET SĄŽININGAI: JIS TEBĖRA GYNYBA Į GYLĮ, NE VIENINTELĖ APSAUGA.
 *
 * Nekintamų stulpelių į `SET` neįleidžia ir be jo: `applyPatch()` tapatybę,
 * nuosavybę bei erą atstato iš originalaus job'o (tad reikšmė nesiskiria ir į
 * skirtumą nepatenka), o `PATCH_STULPELIAI` neturi nė vieno nekintamo lauko
 * rakto. Patikrinta mutacija: pašalinus filtrą iš šios aibės, nė vienas testas
 * NEKRINTA - nes elgesys nepasikeičia.
 *
 * Todėl bendro kontrakto testas („patch'as negali pakeisti tapatybės") įrodo
 * REZULTATĄ, o ne šį filtrą atskirai. Filtras laikomas dėl to, kad garantija,
 * kurią duoda vien `applyPatch()`, dingtų pirmam keliui, kuris jo neiškviečia.
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
 * STULPELIAI, KURIUOS APSKRITAI GALIMA RAŠYTI.
 *
 * ⚠️ VIENA IŠVESTIS, NE KELIOS KOPIJOS (#180 P3-12). Filtras
 * `COLUMNS.filter((c) => !IMMUTABLE_COLUMNS.has(c))` anksčiau buvo perrašytas
 * kiekviename mutacijos kelyje. Trys kopijos to paties sprendimo neišvengiamai
 * išsiskiria - pakanka vienoje vietoje pamiršti `IMMUTABLE_COLUMNS`, ir
 * nekintamumo garantija dingsta būtent tame kelyje.
 */
const KINTAMI_STULPELIAI = Object.freeze(
  COLUMNS.filter((c) => !IMMUTABLE_COLUMNS.has(c))
);

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
  /**
   * ⚠️ ĮRAŠAS NĖRA LEIDIMAS KVIETĖJUI RAŠYTI `version`.
   *
   * `applyPatch()` versiją perrašo besąlygiškai (`job.version + 1`), tad patch'o
   * raktas jos pakeisti negali. Įrašas čia reikalingas dėl PILNUMO patikros:
   * `jobOwnership.test.js` reikalauja, kad kiekvienas kintamas `COLUMNS`
   * stulpelis turėtų bent vieną patch raktą, kitaip naujas stulpelis tyliai
   * iškristų iš `SET` sąrašo.
   */
  version: ["version"],
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
   * ⚠️ `updated_at` IR `version` ČIA NEBEĮTRAUKIAMI. Abu rašo SQL išraiškos
   * rašymo METU (`LAIKO_ZYMA`, `VERSIJOS_ZYMA`), ne pasenusios JS reikšmės -
   * todėl parametrais jie neperduodami.
   *
   * ⚠️ `version` be šios išimties į `SET` patektų VISADA, nes `applyPatch()` jį
   * keičia kiekvienoje mutacijoje - ir tada pasenusi snapshot'o reikšmė
   * nugalėtų SQL išraišką.
   */
  return KINTAMI_STULPELIAI.filter(
    (c) => c !== "updated_at" && c !== "version" && (patchStulpeliai.has(c) || row[c] !== expected[c])
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
 * ⚠️ VERSIJA DIDINAMA RAŠYMO METU, NE IŠ SNAPSHOT'O (#184, Codex B6).
 *
 * TIKSLIAI TA PATI PROBLEMA IR TAS PATS SPRENDIMAS KAIP `LAIKO_ZYMA` AUKŠČIAU.
 *
 * `applyPatch()` apskaičiuoja `job.version + 1` iš PERSKAITYTO snapshot'o. Kol
 * ta reikšmė keliauja į besąlyginį `UPDATE`, du lygiagretūs kvietėjai gali
 * perskaityti `N`, abu apskaičiuoti `N + 1` ir abu sėkmingai commit'inti — įvyko
 * DVI mutacijos, o versija paaugo VIENĄ kartą.
 *
 * Pasekmė nėra kosmetinė: po pirmojo commit'o paimtas snapshot'as neša `N + 1`,
 * tad vėlesnis CAS su tuo `expectedVersion` PRAEINA nepaisant to, kad tarp jų
 * įsiterpė antra mutacija — ir ją perrašo. Optimistic lock garantija
 * („kiekviena sėkminga mutacija +1") lūžta būtent ten, kur ji reikalinga.
 *
 * Todėl `version`, kaip ir `updated_at`, NĖRA parametras: jį skaičiuoja pats
 * PostgreSQL eilutės rašymo momentu. `SET` dėl šios išraiškos irgi niekada
 * nebūna tuščias.
 *
 * ⚠️ SĄLYGINIAME KELYJE TAI NEKONFLIKTUOJA SU `WHERE version = $n`: sąlyga
 * tikrina SENĄ reikšmę, o išraiška rašo naują — abu tame pačiame sakinyje.
 */
const VERSIJOS_ZYMA = `"version" = jobs.version + 1`;

/**
 * Rašomi stulpeliai BE `updated_at` ir BE `version` - abu visada rašo SQL
 * išraiškos (`LAIKO_ZYMA`, `VERSIJOS_ZYMA`), tad parametrais jie
 * nebeperduodami nė viename kelyje.
 */
const KINTAMI_BE_LAIKO = Object.freeze(
  KINTAMI_STULPELIAI.filter((c) => c !== "updated_at" && c !== "version")
);

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
 *
 * ⚠️ ANTRAS TOS PAČIOS KLASĖS PAVYZDYS — `rezultatoEilute()` (#184, 7.5b).
 *
 * Ta pati `EvalPlanQual` asimetrija pasirodė KITU pavidalu: `readJobForUpdate()`
 * yra `jobs LEFT JOIN job_results ... FOR UPDATE OF j`, ir EPQ iš naujo skaito
 * TIK užrakintą `jobs` eilutę — PRIJUNGTA `job_results` eilutė lieka pradinio
 * sakinio snapshot'o. Lenktynėse antrasis vykdytojas matydavo
 * `status = 'completed'` (nauja) su `result = NULL` (sena).
 *
 * Čia išsiskiria SKALIARAS, ten — PRIJUNGTA EILUTĖ. Abu pavyzdžiai laikomi
 * greta sąmoningai: klasė ta pati, o antrąjį jos pavidalą pagavo tik tikras
 * PostgreSQL (memory ir Redis jo neturi - `HGETALL` atomiškas), ir pasekmė buvo
 * fail-safe kryptimi, tad be gilaus testo atrodė kaip teisingas elgesys.
 */
const EILUTE_YRA = `SELECT count(*) FROM jobs WHERE id = $1`;

/**
 * „Eilutė YRA, bet `version` NESUTAMPA" - optimistic lock nesėkmės priežastis
 * (#184, 7.5b).
 *
 * ⚠️ TAS PATS MODELIS KAIP `SVETIMAS_SCOPE`, IR DĖL TOS PAČIOS PRIEŽASTIES.
 * Nulis pakeistų eilučių savaime NĖRA versijos konfliktas: eilutės gali
 * apskritai nebūti. Priežastis skaičiuojama TAME PAČIAME sakinyje, tad ji
 * remiasi tuo snapshot'u, kurio atžvilgiu buvo įvertintas CAS predikatas -
 * neužrakintas skaitymas PO nepavykusio `UPDATE` atsakytų apie KITĄ įrašo
 * inkarnaciją (žr. `updateOwned` komentarą apie `buvo === 0`).
 *
 * ⚠️ `IS DISTINCT FROM`, ne `<>`. Stulpelis yra `NOT NULL`, tad `NULL` čia
 * neturėtų atsirasti - bet `<>` su `NULL` duotų `UNKNOWN`, eilutė nebūtų
 * suskaičiuota, ir versijos konfliktas tyliai virstų „nesuderinta baigtimi".
 * Trivertė logika čia kainuoja nieko, o klaidos klasę pašalina.
 *
 * ⚠️ PARAMETRO NUMERIS PERDUODAMAS, NE ĮRAŠYTAS KIETAI. `update` ir
 * `updateOwned` sakiniuose laukiama versija atsiduria skirtingose pozicijose
 * ($2 ir $4), o dvi kopijos su skirtingais numeriais išsiskirtų būtent taip,
 * kad viena klasifikuotų pagal SVETIMĄ parametrą - ir atsakytų apie ne tą
 * sąlygą, kurią tikrino mutacija.
 *
 * ⚠️ `$n::int IS NOT NULL` - kai sąlygos nėra, klasifikatorius privalo grąžinti
 * `0`, o ne „versija skiriasi nuo NULL".
 */
function versijaSkiriasi(n) {
  return `SELECT count(*) FROM jobs
            WHERE id = $1 AND $${n}::int IS NOT NULL AND version IS DISTINCT FROM $${n}`;
}

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

/**
 * UŽKLAUSA SKAIDOMA Į DVI: METADUOMENYS IR TURINYS (#157, PR-3).
 *
 * ⚠️ `LEFT JOIN ... r.payload` TEMPIA REZULTATĄ Į KIEKVIENĄ SKAITYMĄ.
 *
 * Autorizacija, sąrašai, sweep ir `countActiveJobs()` naudoja tik metaduomenis, bet
 * `SELECT_JOB` jiems deserializuodavo VISĄ `payload` — su 20 MiB riba ir šimtu
 * eilučių tai keli GiB per praėjimą, tiesiogiai prieštaraujant priežasčiai, dėl
 * kurios rezultatai iškelti į atskirą lentelę. `listByFlag()` šito jau vengė; čia tas
 * pats precedentas išplečiamas, o ne įvedama nauja taisyklė.
 *
 * ⚠️ METADUOMENŲ UŽKLAUSA TRAUKIA REZULTATO **NUORODĄ**, NE TURINĮ.
 *
 * `storage_type`, `storage_key`, `bytes` ir `checksum` yra keli baitai eilutei, bet
 * be jų PR-5 sprendimas „ar šiam job'ui yra ką trinti saugykloje" būtų neįmanomas
 * nepridėjus antros užklausos (Codex #289). ⚠️ Šie laukai LIEKA VIDINIAI: į bendrą
 * job modelį jie nepatenka, kitaip viešas kontraktas imtų priklausyti nuo saugyklos.
 */
/**
 * ⚠️ KIEKVIENAS NUORODOS STULPELIS GAUNA `result_` PRIEŠDĖLĮ, IR TAI NE STILIUS.
 *
 * `jobs` IR `job_results` abi turi `storage_key`. Be alias'ų `pg` eilutės objekte
 * lieka PASKUTINIS to paties vardo stulpelis, tad `row.storage_key` imtų reikšti
 * rezultato nuorodą (inline atveju - `NULL`), o job'o audio raktas tyliai dingtų per
 * įprastą round-trip: `update()` jį perrašytų į `NULL`, ir audio valymas nebežinotų,
 * kurie failai naudojami. Išmatuota CI (33984736988): trys nesusiję postgres testai
 * krito iš karto.
 */
const REZULTATO_NUORODA = [
  "r.storage_type AS result_storage_type",
  "r.storage_key AS result_storage_key",
  "r.bytes AS result_bytes",
  "r.checksum AS result_checksum",
].join(", ");

const SELECT_JOB_META = `
  SELECT j.*, ${REZULTATO_NUORODA}
    FROM jobs j
    LEFT JOIN job_results r ON r.job_id = j.id
`;

const SELECT_JOB_WITH_RESULT = `
  SELECT j.*, ${REZULTATO_NUORODA}, r.payload AS result
    FROM jobs j
    LEFT JOIN job_results r ON r.job_id = j.id
`;

/**
 * ⚠️ VIDINIAI KELIAI LIEKA PRIE PILNOS UŽKLAUSOS. `readJob()` ir
 * `readJobForUpdate()` aptarnauja mutacijas, kurioms rezultatas reikalingas
 * (idempotencija, `finishAtomic`), tad jų skaidyti nėra ko — o `finishAtomic`
 * non-inline eilutę atmeta fail-closed sargu (#157), kol PR-4 neatidaro rašymo kelio.
 */
const SELECT_JOB = SELECT_JOB_WITH_RESULT;

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

/**
 * @param {object} pool `pg` pool
 * @param {{artifactStore?: object}} [priklausomybes] external rezultatų saugykla (#157)
 */
function createPostgresStore(pool, { artifactStore = null } = {}) {
  /** Rezultato įrašymas — `payload` yra JSONB, tad bet koks JSON tinka. */
  async function upsertResult(client, jobId, result) {
    if (result === undefined) return;

    if (result === null) {
      await client.query("DELETE FROM job_results WHERE job_id = $1", [jobId]);
      return;
    }

    /**
     * ⚠️ SĄLYGINIS PERRAŠYMAS (#184, 7.5b).
     *
     * Iki 7.5b čia buvo `DO UPDATE SET payload = EXCLUDED.payload` — BESĄLYGINIS
     * perrašymas. Idempotentiškas pakartojimas su TUO PAČIU rezultatu perrašydavo
     * eilutę: `created_at` išlikdavo, bet eilutė būdavo perrašoma, ir „no-op"
     * tyliai likdavo RAŠYMU. Antrasis vykdytojas po lenktynių taip pat
     * perrašydavo pirmojo rezultatą.
     *
     * ⚠️ SĄLYGA YRA `jsonb` LYGYBĖ, IR TAI NĖRA ANTRA TAISYKLĖ. `jsonb =`
     * PostgreSQL'e yra SEMANTINIS palyginimas: raktų tvarka nereikšminga,
     * dublikatai pašalinti, skaičiai normalizuoti — lygiai tas pats, ką
     * `kanoninisRezultatas()` daro JS pusėje. Kontrakto sprendimą (no-op ar
     * konfliktas) priima JS autoritetas; ši sąlyga saugo nuo BEREIKALINGO
     * eilutės perrašymo. Integracinis testas tikrina, kad abi sutampa per
     * REALŲ DB round-trip'ą.
     */
    await client.query(
      `INSERT INTO job_results (job_id, storage_type, payload, created_at)
       VALUES ($1, 'inline', $2::jsonb, now())
       ON CONFLICT (job_id) DO UPDATE SET payload = EXCLUDED.payload
        WHERE job_results.payload IS DISTINCT FROM EXCLUDED.payload`,
      [jobId, JSON.stringify(result)]
    );
  }

  /**
   * `job_results` EILUTĖ — ŠVIEŽIAI, `finish` transakcijos viduje (#184, 7.5b).
   *
   * ⚠️ Į JOB OBJEKTĄ `storage_type` NEDEDAMAS SĄMONINGAI. Memory ir Redis jo
   * neturi ir turėti negali; bendro kontrakto rinkinys lygina backend'ų
   * grąžinamas būsenas `deepEqual`, tad PG-only laukas arba sulaužytų
   * palyginimus, arba priverstų jį iš jų išimti — t. y. tyliai susiaurintų
   * rinkinį. Todėl skaitomas atskira užklausa ten, kur reikia sprendimo.
   *
   * ⚠️ IR `payload` SKAITOMAS ČIA, NE IMAMAS IŠ `readJobForUpdate()` (RADO CI).
   *
   * `SELECT_JOB` yra `jobs LEFT JOIN job_results` su `FOR UPDATE OF j`. Užraktas
   * ir `EvalPlanQual` galioja TIK užrakintai lentelei: sutikęs konkurenčiai
   * pakeistą `jobs` eilutę, PostgreSQL perskaito jos NAUJAUSIĄ versiją, bet
   * PRIJUNGTOS `job_results` eilutės iš naujo NEIMA — ji lieka to sakinio
   * snapshot'o, paimto PRIEŠ konkurento commit'ą.
   *
   * Praktinė pasekmė lenktynėse: antrasis vykdytojas mato `status = 'completed'`
   * (nauja reikšmė) kartu su `result = NULL` (sena) ir grąžina klaidingą
   * `COMPLETED_WITHOUT_RESULT` vietoj `RESULT_CONFLICT`. Tai fail-safe kryptimi
   * (audio lieka, darbas neperrašomas), bet vis tiek NETEISINGA — ir vietinėje
   * aplinkoje nepasiekiama.
   *
   * ⚠️ TAI TA PATI MVCC KLASĖ, KURIĄ #180 JAU DOKUMENTAVO prie `EILUTE_YRA`:
   * ten `SELECT` dalys lieka prie snapshot'o, o duomenis keičianti dalis daro
   * `EvalPlanQual`. Skirtumas tik tas, kad ten išsiskirdavo skaliaras, o čia —
   * prijungta eilutė.
   *
   * Atskiras sakinys PO užrakto gauna NAUJĄ snapshot'ą (`READ COMMITTED`), tad
   * mato konkurento jau įsipareigotą rezultatą.
   */
  async function rezultatoEilute(client, jobId) {
    const { rows } = await client.query(
      "SELECT storage_type, payload FROM job_results WHERE job_id = $1",
      [jobId]
    );
    return rows[0] || null;
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
  async function restoreRecord(irasas) {
    /** ⚠️ PRIEŠ transakciją - netinkamas įrašas negali ištrinti esamo. */
    assertAtstovaujamasProgresas(irasas);

    /**
     * ⚠️ NORMALIZUOJAMA PO #180 PATIKROS, NE PRIEŠ JĄ (#205, 7.2c).
     *
     * Tvarka čia yra sprendimas, ne atsitiktinumas. `assertAtstovaujamasProgresas()`
     * SĄMONINGAI atmeta ne-boolean `progressKnown` (#180 P2-C): ranka redaguota
     * kopija su `"true"` reiškia, kad kopiją gamino sugedęs rašytojas, ir #180
     * pasirinko GARSŲ atmetimą, o ne konvertavimą. Normalizavus pirma, `"true"`
     * taptų `true`, patikra nebeturėtų ko atmesti, ir esama garantija tyliai
     * dingtų.
     *
     * ⚠️ TODĖL ATKŪRIMO KELYJE `progressKnown` YRA GRIEŽTESNIS PostgreSQL
     * REŽIME nei memory/Redis. Tai #180 asimetrija, ne 7.2c: fasadas
     * `assertRestorable()` irgi kviečia šią patikrą tik `postgres` backend'ui.
     * Likę kanoniniai laukai (`audio_cleanup_pending`, `attempt_count` ir kt.)
     * normalizuojami vienodai visuose trijuose.
     *
     * Kopijos turinys savavališkas, o `applyPatch()` šio kelio nedengia.
     */
    const job = normalizeJob(irasas);
    return inTransaction(async (client) => {
      /**
       * ⚠️ BARJERAS TIKRINAMAS ŠIOJE TRANSAKCIJOJE (#183 Codex, P1).
       *
       * Fasadas prieš tai daro `isDeleted()` - bet tai ATSKIRAS skaitymas, tad
       * lygiagreti replika gali įterpti žymą tarp patikros ir šio rašymo, ir
       * atkūrimas prikeltų ištrintą job'ą. `assertNotBarred()` ima tą patį
       * advisory lock'ą, kurį ima `mark()`, ir skaito TOJE PAČIOJE
       * transakcijoje, tad „patikrink, tada rašyk" tampa atominis.
       *
       * Būtent tam šis API ir buvo sukurtas 7.5a metu; produkcinis atkūrimo
       * kelias jo nepasiekdavo, tad deklaruotas cross-replica barjeras šio
       * kelio negynė.
       *
       * ⚠️ KVIEČIAMA STORE LYGIO FUNKCIJA, NE FASADAS - IR TAI SVARBU.
       *
       * Fasadas prieš patikrą daro `ensureInit()`, kuris jungiasi pagal
       * `process.env.DATABASE_URL`. Tai gali būti KITA duomenų bazė nei ta,
       * kurioje vyksta ši transakcija: taip ir nutiko CI, kur
       * `postgresStore.integration` migruoja `<bazė>_store`, o aplinkos
       * kintamasis rodo į `<bazė>`.
       *
       * Barjeras privalo būti skaitomas TOJE PAČIOJE jungtyje, kur vyksta
       * rašymas - kitos DB būsena apie šį rašymą neįrodo nieko. Funkcija
       * naudoja tik perduotą klientą, tad nei pool'o, nei `init()` jai nereikia.
       *
       * ⚠️ `require` VIETOJE, ne faile: išvengiama ciklinės priklausomybės ir
       * `jobStore` lieka naudojamas be žymų modulio inicijavimo.
       */
      const { assertNotBarredWithClient } = require("../deletionTombstones/postgresStore");
      await assertNotBarredWithClient(client, job.id);

      await client.query("DELETE FROM jobs WHERE id = $1", [job.id]);
      await client.query(insertSql(), insertValues(job));
      await upsertResult(client, job.id, job.result ?? null);
      return job;
    });
  }

  /**
   * REZULTATO HIDRATACIJA — RIBOTA PAGAL KONSTRUKCIJĄ (#157, PR-3).
   *
   * ⚠️ RIBA TIKRINAMA PRIEŠ ĮKĖLIMĄ, NE PO JO.
   *
   * External eilutėje `bytes` persistinamas kartu su nuoroda (PR-1 kolona), tad
   * per didelis rezultatas atmetamas NĖ NEKREIPUS į saugyklą. Tai pigus atmetimas,
   * o ne garantija: jei objektas saugykloje perrašytas iki didesnio, pasenusi maža
   * reikšmė patikrą praeitų. Kietas stabdis gyvena `skaitytiRibotai()` — skaitiklyje
   * skaitymo metu (Codex P2, #289).
   *
   * ⚠️ FAIL-CLOSED BE SAUGYKLOS. External nuoroda be sukonfigūruotos saugyklos
   * reiškia, kad rezultato perskaityti NEGALIME. Grąžinti `null` čia būtų
   * „`completed` be rezultato" — būsena, po kurios terminalus valymas ištrina
   * šaltinio audio.
   */
  async function hidratuotiRezultata(eilute) {
    const tipas = eilute.result_storage_type;

    if (!tipas || tipas === "inline") {
      return eilute.result === undefined ? null : eilute.result;
    }

    if (!artifactStore) {
      throw new Error(
        `postgresStore: job_results.storage_type = '${tipas}', bet artefaktų saugykla ` +
          "nesukonfigūruota. Rezultato perskaityti neįmanoma (#157)."
      );
    }

    /**
     * ⚠️ EILUTĖS BACKEND'AS PRIVALO SUTAPTI SU SAUGYKLOS (Codex, #291).
     *
     * Pilnas dispatch pagal `storage_type` yra PR-4/PR-6 tema, o čia skaitoma iš
     * vienos injekuotos saugyklos. Blogiausias atvejis mažai tikėtinas, bet
     * konkretus: `s3` eilutė, skaitoma per `fs` saugyklą, tuo pačiu raktu ir su
     * sutampančiu dydžiu, hidratuotų SVETIMĄ turinį — ir niekas apie tai nesužinotų.
     *
     * Fail-closed čia kainuoja vieną `if`, tad jis ir daromas: neatitikimas yra
     * konfigūracijos klaida, ne bandymas skaityti.
     */
    if (artifactStore.backend && artifactStore.backend !== tipas) {
      throw new Error(
        `postgresStore: eilutės storage_type = '${tipas}', o sukonfigūruota saugykla yra ` +
          `'${artifactStore.backend}'. Skaityti iš kitos saugyklos neleidžiama (#157).`
      );
    }

    const { getLimits, LIMIT_KIND, assertWithinLimit } = require("../resultLimits");
    const { skaitytiRibotai } = require("../artifactStore");

    /** `bigint` per `node-postgres` grįžta EILUTE — normalizuojama vieną kartą. */
    const deklaruoti = Number(eilute.result_bytes);
    const deklaruotiBaitai = Number.isInteger(deklaruoti) && deklaruoti >= 0 ? deklaruoti : null;

    if (deklaruotiBaitai !== null) {
      /** Pigus atmetimas: į saugyklą net nesikreipiame. */
      assertWithinLimit(LIMIT_KIND.RESULT_BYTES, deklaruotiBaitai);
    }

    const { reiksme } = await skaitytiRibotai(artifactStore, eilute.result_storage_key, {
      maxBaitai: getLimits()[LIMIT_KIND.RESULT_BYTES],
      deklaruotiBaitai,
    });

    return reiksme;
  }

  /**
   * @param {string} id
   * @param {{hydrate?: boolean}} [nustatymai] `hydrate: false` - tik metaduomenys
   */
  async function get(id, { hydrate = true } = {}) {
    const uzklausa = hydrate ? SELECT_JOB_WITH_RESULT : SELECT_JOB_META;
    const { rows } = await pool.query(`${uzklausa} WHERE j.id = $1`, [id]);
    if (!rows[0]) return null;

    const job = rowToJob(rows[0], { hidratuota: hydrate });
    if (hydrate) job.result = await hidratuotiRezultata(rows[0]);

    return job;
  }

  /**
   * @param {object} [options]
   * @param {number} [options.expectedVersion] optimistic lock sąlyga (#184, 7.5b)
   * @returns {object|null|"CONCURRENCY_CONFLICT"}
   */
  async function update(id, patch, options = {}) {
    return inTransaction(async (client) => {
      const current = await readJob(client, id);
      if (!current) return null;
      if (options.expectedVersion === undefined) {
        return writePatched(client, current, patch);
      }
      return writePatchedCas(client, current, patch, options.expectedVersion);
    });
  }

  /**
   * SĄLYGINIS RAŠYMAS SU `expectedVersion` (#184, 7.5b).
   *
   * ⚠️ KODĖL ATSKIRAS KELIAS, O NE `writePatched()` SU PAPILDOMU `WHERE`.
   *
   * `writePatched()` yra BESĄLYGINIS rašymas po neužrakinto skaitymo - jam
   * nulis pakeistų eilučių reiškia tik „eilutės nebėra". Sąlyginiam keliui to
   * neužtenka: nulis turi tris skirtingas priežastis, ir jos privalo būti
   * atskirtos TAME PAČIAME sakinyje. Sujungus abu kelius, besąlyginis rašymas
   * neštų klasifikacijos kainą be jokios naudos.
   *
   * ⚠️ SIAURAS `SET` - tie patys stulpeliai kaip `updateOwned` CAS kelyje, dėl
   * tos pačios priežasties: platus `SET` iš pasenusio snapshot'o atsuktų atgal
   * konkurento jau užcommitintus laukus.
   *
   * ⚠️ PAKARTOJIMO ČIA NĖRA, IR TAI SĄMONINGA. `updateOwned` kartoja, nes jo
   * CAS predikatas (nuosavybė) yra NEKINTAMAS - antras bandymas su ta pačia
   * sąlyga privalo pavykti. Versijos predikatas priešingas: jei versija
   * pasikeitė, ji nebesugrįš, ir pakartojimas su tuo pačiu `expectedVersion`
   * duotų tą patį atsakymą amžinai. Kvietėjas gauna konfliktą ir sprendžia pats.
   */
  /**
   * ATOMINIS IR IDEMPOTENTIŠKAS TERMINALUS PERĖJIMAS (#184, 7.5b).
   *
   * ⚠️ `jobs` IR `job_results` — VIENOJE TRANSAKCIJOJE.
   *
   * `COMPLETED` reiškia BŪTENT tokią būseną: `jobs.status = 'completed'` IR
   * egzistuojantis `job_results` įrašas, abu commit'inti kartu. Rezultato
   * rašymui nepavykus, rollback'inama visa `finish` transakcija — pusinės
   * `completed` būsenos nelieka.
   *
   * ⚠️ TRANSAKCIJOS RIBOS. Ji apima `jobs` ir `job_results` ir NIEKO DAUGIAU.
   * Auditas, eilės patvirtinimas ir audio valymas lieka už jos: audito
   * įtraukimas reikštų, kad rollback ištrina ir audito įrašą.
   *
   * ⚠️ SPRENDIMAS PRIIMAMAS PO `FOR UPDATE`, TOJE PAČIOJE TRANSAKCIJOJE.
   * Tai antrasis #184 leistas klasifikavimo būdas: užraktas stabilizuoja
   * būseną iki commit'o, tad „ar tas pats rezultatas" negali pasenti tarp
   * sprendimo ir įrašymo. Neužrakinto skaitymo po nepavykusio `UPDATE` čia
   * nėra.
   *
   * @returns {object|null|"RESULT_CONFLICT"|"COMPLETED_WITHOUT_RESULT"}
   */
  async function finishAtomic(id, status, extra = {}) {
    const jobPhase = require("../jobPhase");
    return inTransaction(async (client) => {
      const job = await readJobForUpdate(client, id);
      if (!job) return null;

      if (job.status === STATUS.COMPLETED) {
        /**
         * ⚠️ `storage_type <> 'inline'` — FAIL-CLOSED (#157 riba).
         *
         * `upsertResult()` rašo kietą `'inline'`, o `SELECT_JOB` hidratuoja tik
         * `payload`, tad `s3` rezultato NORMALIZAVIMO / HIDRATACIJOS autoriteto
         * repo neturi. Palyginus tokį įrašą pagal `payload`, „skirtingas
         * rezultatas" tyliai taptų „nepalyginamas", ir antrasis vykdytojas
         * gautų idempotentišką sėkmę apie darbą, kurio nematė.
         *
         * ⚠️ SARGAS YRA PERSPEKTYVINIS: produkcinio kelio, kuris parašytų kitą
         * `storage_type`, ŠIANDIEN NĖRA. Jis pasiekiamas tik įrašius eilutę
         * tiesiogiai. Įvardyta atvirai, kad neatrodytų kaip įrodytas elgesys.
         */
        const eilute = await rezultatoEilute(client, id);
        if (eilute && eilute.storage_type !== "inline") {
          throw new Error(
            `postgresStore.finishAtomic: job_results.storage_type = '${eilute.storage_type}' ` +
              "neturi lygybės autoriteto (#157). Rezultatų palyginimas apibrėžtas TIK 'inline'."
          );
        }

        /**
         * ⚠️ SPRENDIMAS PRIIMAMAS IŠ ŠVIEŽIO SKAITYMO, ne iš `readJobForUpdate()`
         * prijungtos reikšmės — žr. `rezultatoEilute()`. Be šito lenktynių
         * pralaimėtojas gautų `COMPLETED_WITHOUT_RESULT` vietoj
         * `RESULT_CONFLICT`.
         */
        const sviezias = { ...job, result: eilute ? eilute.payload : null };
        const jauBaigtas = idempotentiskasAtsakymas(sviezias, status, extra);
        if (jauBaigtas !== undefined) return jauBaigtas;
      }

      const patch = jobPhase.finish(job, status, extra);
      return writePatched(client, job, patch);
    });
  }

  /**
   * POST-RESTORE TERMINALIZAVIMAS SVETIMOJE TRANSAKCIJOJE (#155, 7.6b / #249, D3+D4).
   *
   * ⚠️ GRYNOJI TAISYKLĖ PERDUODAMA SAUGYKLAI, KURI JĄ VYKDO — ta pati forma kaip
   * `reportProgressAtomicSync(id, event, jobPhase)` ir `finishAtomic()`.
   *
   * Patch'as IŠVEDAMAS iš `jobPhase.finish(job, FAILED, extra)`, tad
   * `jobs_status_phase`, `jobs_progress_only_processing`, `jobs_progress_known`
   * ir `jobs_version_positive` tenkinami DĖL AUTORITETO. Ranka surašytas
   * `SET status='failed', phase=NULL, …` sąrašas šiandien praeitų ir pasentų po
   * kito schemos pokyčio — būtent to D3 neleidžia.
   *
   * ⚠️ KLIENTAS ATEINA IŠ IŠORĖS, TRANSAKCIJOS ČIA NEATVERIAME. D4 reikalauja,
   * kad sesijų revokacija ir job'ų terminalizavimas būtų VIENA transakcija; jos
   * ribas valdo `utils/postRestoreReconcile.js`, nes tik jis mato abu dalykus.
   *
   * ⚠️ `praleisti` YRA KVIETĖJO SPRENDIMAS. Tombstone barjeras gyvena savo
   * modulyje (`deletionTombstones.assertNotBarredWithClient`), ir `jobStore`
   * apie ištrynimo žymas čia nieko nesužino — kvietėjas paduoda predikatą, o
   * praleisti job'ai grąžinami VARDAIS, ne tik skaičiumi, kad tyliai nedingtų.
   *
   * @param {object} client atviros transakcijos klientas
   * @param {object} opcijos `{ jobPhase, extra, praleisti }`
   * @returns {{terminalizuota: number, praleista: string[], rasta: number}}
   */
  async function terminalizuotiNeTerminaliniusWithClient(client, opcijos = {}) {
    const { jobPhase, extra = {}, praleisti = null } = opcijos;
    if (!jobPhase || typeof jobPhase.finish !== "function") {
      throw new TypeError("terminalizuotiNeTerminalinius: reikia `jobPhase` autoriteto.");
    }

    /**
     * ⚠️ `FOR UPDATE` IŠ KARTO. Eilutės užrakinamos viena užklausa, tad tarp
     * atrankos ir mutacijos niekas negali jų pakeisti — o suderinimas vykdomas
     * offline, kur konkurentų neturėtų būti VISAI. Užraktas čia yra tripwire:
     * jei kas nors dirba lygiagrečiai, jis lauks, o ne perrašys.
     */
    const { rows } = await client.query(
      `SELECT id FROM jobs WHERE status IN ($1, $2) ORDER BY created_at, id FOR UPDATE`,
      [STATUS.QUEUED, STATUS.PROCESSING]
    );

    const praleista = [];
    let terminalizuota = 0;

    for (const { id } of rows) {
      if (praleisti && (await praleisti(client, id))) {
        praleista.push(id);
        continue;
      }

      const job = await readJob(client, id);
      if (!job) continue;

      const patch = jobPhase.finish(job, STATUS.FAILED, extra);
      await writePatched(client, job, patch);
      terminalizuota += 1;
    }

    return { rasta: rows.length, terminalizuota, praleista };
  }

  /** Kiek job'ų vis dar ne terminalūs (verifikacijai ir idempotentiškumo patikrai). */
  async function skaiciuotiNeTerminaliniusWithClient(client) {
    const { rows } = await client.query(
      "SELECT id FROM jobs WHERE status IN ($1, $2) ORDER BY id",
      [STATUS.QUEUED, STATUS.PROCESSING]
    );
    return rows.map((r) => r.id);
  }

  async function writePatchedCas(client, current, patch, expectedVersion) {
    const row = jobToRow(applyPatch(current, patch));
    const rasomi = changedColumns(jobToRow(current), row, patch);
    const sets = [
      ...rasomi.map((c, i) => `"${c}" = $${i + 3}`),
      LAIKO_ZYMA,
      VERSIJOS_ZYMA,
    ].join(", ");

    const result = await client.query(
      casSuKlasifikacija(
        `      UPDATE jobs SET ${sets}
            WHERE id = $1 AND version = $2
          RETURNING id`,
        versijaSkiriasi(2),
        { buvo: EILUTE_YRA }
      ),
      [current.id, expectedVersion, ...rasomi.map((c) => row[c])]
    );

    const { pakeista, priezastis, buvo } = result.rows[0];
    if (pakeista > 0) {
      await upsertResult(client, current.id, patch.result);
      return readJob(client, current.id);
    }

    /**
     * ⚠️ EILUTĖS CAS SNAPSHOT'E NEBUVO → GALUTINIS `null` (#180, 1 punktas).
     * Vėliau tuo pačiu id atsiradusi eilutė yra KITA inkarnacija.
     */
    if (buvo === 0) return null;

    /** Eilutė yra, versija kita - nustatyta tuo pačiu snapshot'u kaip CAS. */
    if (priezastis > 0) return "CONCURRENCY_CONFLICT";

    /**
     * ⚠️ NESUDERINTA BAIGTIS (`EvalPlanQual`): snapshot'e versija SUTAPO, bet
     * mutacija vis tiek nepavyko - eilutė sakinio metu buvo konkurenčiai
     * pakeista arba ištrinta. Užrakintas skaitymas TOJE PAČIOJE transakcijoje
     * (leistinas #184 būdas) atskiria dvi likusias galimybes.
     */
    const dabartine = await readJobForUpdate(client, current.id);
    if (!dabartine) return null;
    return "CONCURRENCY_CONFLICT";
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
    const mutable = KINTAMI_BE_LAIKO;

    /**
     * ⚠️ LAIKO ŽYMA - RAŠYMO METU, ne prieš užrakto laukimą.
     *
     * `update()` daro neužrakintą skaitymą ir po jo BESĄLYGINĮ `UPDATE`. Jei tas
     * `UPDATE` laukia svetimo eilutės užrakto, `applyPatch()` dar prieš laukimą
     * užfiksuota `updatedAt` perrašytų konkurento naujesnę žymą atgal - tas pats
     * gedimas kaip abiejuose CAS keliuose. Užlaikymui viršijus `TTL_MS`, ką tik
     * commit'inta eilutė iš karto taptų tinkama `sweepExpired()` valymui.
     */
    const sets = [
      ...mutable.map((c, i) => `"${c}" = $${i + 2}`),
      LAIKO_ZYMA,
      VERSIJOS_ZYMA,
    ].join(", ");

    await client.query(
      `UPDATE jobs SET ${sets} WHERE id = $1`,
      [current.id, ...mutable.map((c) => row[c])]
    );

    await upsertResult(client, current.id, patch.result);
    return readJob(client, current.id);
  }

  /**
   * ⚠️ NUOSAVYBĖ SPRENDŽIAMA PRIEŠ HIDRATACIJĄ (Codex blokatorius, #291).
   *
   * Iki PR-3 tvarka buvo nekalta: `get()` skaitė tą pačią eilutę, tad hidratacija
   * nieko nekainavo. Dabar `get()` gali eiti į IŠORINĘ saugyklą, ir riziką sukūrė
   * būtent šis PR — tad ji taisoma jame.
   *
   * Trys atskiros pasekmės, jei sprendimas priimamas PO hidratacijos:
   *
   *   · AMPLIFIKACIJA — svetimas žmogus, žinantis job ID, priverčia iki
   *     `MAX_RESULT_BYTES` saugyklos I/O užklausai, kuri turėjo baigtis `403`;
   *   · INFORMACIJOS NUTEKĖJIMAS — vietoj vienodo atsakymo jis gauna
   *     `ARTIFACT_CORRUPT` arba „nėra", t. y. sužino apie SVETIMO job'o būseną;
   *   · SAVININKAS NEBEPASIEKIA REMONTO — skaitymas krenta ties hidratacija
   *     būtent tada, kai objektas sugadintas, o tai tas atvejis, kuriam kelias ir
   *     reikalingas.
   *
   * ⚠️ DVI UŽKLAUSOS, IR TAI SĄMONINGA KAINA. Metaduomenų užklausa priima
   * sprendimą, o turinys traukiamas TIK jį praėjus. Vienos užklausos variantas
   * (paimti viską ir hidratuoti po patikros) saugyklos I/O irgi išvengtų, bet
   * svetimai užklausai vis tiek deserializuotų inline `payload` — o amplifikacija
   * yra amplifikacija, nesvarbu, kuri pusė ją apmoka.
   *
   * @returns {object|null|"FORBIDDEN"}
   */
  async function getOwned(id, scope) {
    const metaduomenys = await get(id, { hydrate: false });
    if (!metaduomenys) return null;
    if (!matchesOwner(metaduomenys, scope)) return "FORBIDDEN";

    return get(id);
  }

  /** @returns {object|null|"FORBIDDEN"|"CONCURRENCY_CONFLICT"} */
  async function updateOwned(id, patch, scope, options = {}) {
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
          ...rasomi.map((c, i) => `"${c}" = $${i + 5}`),
          LAIKO_ZYMA,
          VERSIJOS_ZYMA,
        ].join(", ");
        /**
         * ⚠️ NUOSAVYBĖ IR VERSIJA - VIENAME `UPDATE` (#184, 7.5b).
         *
         * Du round-trip'ai („pirma patikrinam versiją, tada rašom") atkurtų
         * tiksliai tą TOCTOU langą, kurį visas šis darbas uždaro. `$4::int IS
         * NULL` šaka reiškia „sąlygos nėra" - elgesys be `expectedVersion`
         * nesikeičia nė kiek.
         */
        result = await client.query(
          casSuKlasifikacija(
            `      UPDATE jobs SET ${sets}
            WHERE id = $1 AND owner_id IS NOT DISTINCT FROM $2 AND owner_kind = $3
              AND ($4::int IS NULL OR version = $4)
          RETURNING id`,
            SVETIMAS_SCOPE,
            { buvo: EILUTE_YRA, versija: versijaSkiriasi(4) }
          ),
          [
            id,
            scope.ownerId ?? null,
            scope.ownerKind,
            options.expectedVersion ?? null,
            ...rasomi.map((c) => row[c]),
          ]
        );
        const { pakeista, priezastis, buvo, versija } = result.rows[0];
        if (pakeista > 0) break;
        /**
         * ⚠️ NUOSAVYBĖ PIRMA, VERSIJA PO JOS (#184).
         *
         * Svetimas savininkas su pasenusia versija privalo gauti `"FORBIDDEN"`.
         * Perklasifikavus jį į `"CONCURRENCY_CONFLICT"`, kvietėjui būtų pasakyta
         * „bandyk dar kartą" ten, kur teisingas atsakymas yra „tau negalima" -
         * ir autorizacijos rezultatas taptų lygiagretumo rezultatu.
         */
        if (priezastis > 0) return "FORBIDDEN";
        /** Eilutė sava, bet versija kita - tas pats snapshot'as kaip CAS. */
        if (versija > 0) return "CONCURRENCY_CONFLICT";

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
        /**
         * ⚠️ VERSIJOS KONFLIKTAS NEKARTOJAMAS (#184, 7.5b).
         *
         * Pakartojimas čia teisėtas TIK todėl, kad nuosavybės predikatas
         * NEKINTAMAS: užrakinta sava eilutė svetima nebetaps, tad antras CAS
         * privalo pavykti. Versijos predikatas priešingas - pasikeitusi versija
         * nebesugrįš, ir ciklas su tuo pačiu `expectedVersion` suktųsi iki ribos
         * tam, kad galiausiai grąžintų klaidą vietoj teisingo konflikto.
         */
        if (options.expectedVersion !== undefined && dabartine.version !== options.expectedVersion) {
          return "CONCURRENCY_CONFLICT";
        }
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
        VERSIJOS_ZYMA,
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
  /**
   * PASENUSIŲ JOB'Ų ID - BE ŠALINIMO (#183).
   *
   * ⚠️ Retencijai reikia ID, o ne kiekio: nuo #183 kiekvienas ištrynimo kelias
   * privalo palikti barjerą, tad žyma rašoma PRIEŠ šalinimą. Predikatas
   * PRIVALO sutapti su `sweepExpired()` - kitaip retencija žymėtų vienus, o
   * trintų kitus.
   */
  async function listExpired(now = Date.now(), limit = 500) {
    const riba = new Date(now - TTL_MS).toISOString();
    const { rows } = await pool.query(
      `SELECT id FROM jobs
        WHERE status = ANY($1)
          AND updated_at < $2
          AND NOT audio_cleanup_pending
          AND NOT deletion_pending
        ORDER BY updated_at
        LIMIT $3`,
      [[STATUS.COMPLETED, STATUS.FAILED, STATUS.CANCELLED], riba, limit]
    );
    return rows.map((r) => r.id);
  }

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

  /**
   * @param {{hydrate?: boolean}} [nustatymai] `hydrate: false` - tik metaduomenys
   */
  async function listAll({ hydrate = true } = {}) {
    const uzklausa = hydrate ? SELECT_JOB_WITH_RESULT : SELECT_JOB_META;
    const { rows } = await pool.query(`${uzklausa} ORDER BY j.created_at`);

    const jobai = rows.map((row) => rowToJob(row, { hidratuota: hydrate }));
    if (!hydrate) return jobai;

    /**
     * ⚠️ EXTERNAL EILUTĖS HIDRATUOJAMOS PO VIENĄ, IR KAINA UŽRAŠOMA: tai po
     * kreipinį į saugyklą kiekvienam tokiam job'ui. Vienintelis hidratuojantis
     * `listAll()` kvietėjas yra kopijos kūrimas, kuriam rezultatai BŪTINI; visi
     * metaduomenų keliai perduoda `hydrate: false` ir šios kainos nemoka.
     */
    for (let i = 0; i < rows.length; i += 1) {
      jobai[i].result = await hidratuotiRezultata(rows[i]);
    }

    return jobai;
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
     * ⚠️ IR `result` LAUKO ČIA NĖRA — jis nėra `null` (#157, PR-3). Anksčiau ši
     * užklausa `payload` netempė, bet `rowToJob()` vis tiek pridėdavo `result: null`,
     * t. y. teigdavo „rezultato NĖRA" apie job'ą, kurio rezultatas puikiausiai yra.
     * Dabar naudojama ta pati nehidratuota projekcija kaip `get(id, {hydrate:false})`;
     * prireikus rezultato, jis imamas per `get()`.
     */
    const { rows } = await pool.query(
      `SELECT j.* FROM jobs j WHERE j."${field}" ORDER BY j.updated_at LIMIT $1`,
      [limit]
    );
    return rows.map((row) => rowToJob(row, { hidratuota: false }));
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
    finishAtomic,
    /**
     * ⚠️ ATKŪRIMO OPERACIJOS — NE FASADO KONTRAKTO DALIS, IR TAI SĄMONINGA.
     *
     * `jobStoreBackendContract` reikalauja, kad visi TRYS backend'ai deklaruotų
     * tą pačią 17 metodų aibę: trūkstamas metodas reikštų tylų fasado grįžimą į
     * atsarginį kelią. Šios dvi operacijos fasado NEPASIEKIAMOS — jas kviečia
     * tik offline suderinimas (`utils/postRestoreReconcile.js`), kuris pagal D7
     * ne PostgreSQL režime privalo KRISTI, ne veikti. Memory/Redis realizacijos
     * būtų negyvas kodas, kurio niekas neturi teisės iškviesti.
     *
     * Todėl jos gyvena atskirame RAKTE, ne tarp metodų: kontraktas lieka
     * nepaliestas, o šis komentaras yra vieta, kur tai pasakyta atvirai — ne
     * atsitiktinis prasilenkimas su sargo filtru.
     */
    atkurimas: {
      terminalizuotiNeTerminaliniusWithClient,
      skaiciuotiNeTerminaliniusWithClient,
    },
    getOwned,
    updateOwned,
    removeOwned,
    listExpired,
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
  PROGRESO_CAS_PREDIKATAS,
  UnsupportedProgressError,
  assertAtstovaujamasProgresas,
};
