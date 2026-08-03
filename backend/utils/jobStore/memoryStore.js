const { STATUS, JOB_TYPES, TTL_MS, newJob, applyPatch, isFinished, hasPendingCleanup } = require("./common");

/**
 * In-memory job store backend'as.
 *
 * Ta pati ASYNC sąsaja kaip Redis backend'o (create/get/update/sweepExpired/size
 * grąžina Promise), kad routes kodas nesiskirtų nepriklausomai nuo to, kuris
 * backend'as naudojamas. Async čia "dirbtinis" (Map operacijos sinchroninės),
 * bet vienoda sąsaja leidžia perjungti į Redis be routes pakeitimų.
 *
 * APRIBOJIMAS (dokumentuotas): gyvena tik VIENO proceso atmintyje. Perkrovus
 * backendą jobai dingsta; keli procesai/replikos nemato vienas kito jobų. Tinka
 * dev/demo ir vieno vartotojo įrankiui. Produkcijai su restart-atsparumu ar
 * keliais worker'iais - naudokite Redis backend'ą (nustatykite REDIS_URL).
 */
const jobs = new Map();

async function create(fields = {}) {
  const job = newJob(fields);
  jobs.set(job.id, job);
  return job;
}

async function get(id) {
  return jobs.get(id) || null;
}

async function update(id, patch) {
  const job = jobs.get(id);
  if (!job) return null;
  const next = applyPatch(job, patch);
  jobs.set(id, next);
  return next;
}

async function sweepExpired(now = Date.now()) {
  let removed = 0;
  for (const [id, job] of jobs.entries()) {
    // Nebaigto valymo jobų NEIŠMETAM - kitaip prarastume vienintelę nuorodą į
    // likusį audio failą (žr. common.hasPendingCleanup).
    if (hasPendingCleanup(job)) continue;

    if (isFinished(job.status) && now - new Date(job.updatedAt).getTime() > TTL_MS) {
      jobs.delete(id);
      removed++;
    }
  }
  return removed;
}

async function size() {
  return jobs.size;
}

/**
 * Jobai su nustatyta boolean vėliava (`deletion_pending`,
 * `audio_cleanup_pending`). Naudoja periodiniai pakartojimo procesai -
 * žr. utils/deletionRetry.js.
 */
/**
 * VISŲ gyvų jobų storage raktai - nepriklausomai nuo statuso ar vėliavų.
 *
 * Naudoja retencijos sweeper'is (utils/retentionSweeper.js). Anksčiau jis
 * rinkdavo raktus tik iš `deletion_pending`/`audio_cleanup_pending` jobų, tad
 * paprastas `queued`/`processing` jobas su senu audio (ilgas įrašas, užstrigusi
 * eilė, GPU trūkumas) buvo palaikomas orphan ir jo failas IŠTRINAMAS dar
 * apdorojant. Čia turi būti VISI jobai.
 */
async function listReferencedStorageKeys() {
  const keys = new Set();
  for (const job of jobs.values()) {
    if (job.storageKey) keys.add(job.storageKey);
  }
  return [...keys];
}

/**
 * VISI jobai – atsarginėms kopijoms (#20 PR2).
 *
 * Kitos enumeracijos (`listByFlag`, `listPendingDeletions`) grąžina filtruotus
 * pogrupius. Kopijai reikia pilno vaizdo, tad ši funkcija sąmoningai neturi
 * filtro – filtravimas pagal būseną yra kopijavimo serviso sprendimas, ne
 * saugyklos.
 */
/**
 * Įrašo jobą IŠSAUGANT jo ID (#20 PR2 – atkūrimui).
 *
 * `create()` generuoja naują ID; atkuriant to negalima – kopijos įrašai nurodo
 * konkrečius identifikatorius, ir naujas ID nutrauktų visas sąsajas (audio
 * raktus, audito įrašus, išvedimo grafą).
 */
async function restoreRecord(job) {
  jobs.set(job.id, { ...job });
  return job;
}

async function listAll() {
  return [...jobs.values()];
}

async function listByFlag(field, limit = 100) {
  const pending = [];
  for (const job of jobs.values()) {
    if (job[field]) pending.push(job);
    if (pending.length >= limit) break;
  }
  return pending;
}

async function remove(id) {
  return jobs.delete(id);
}

async function close() {
  jobs.clear();
}

module.exports = { create, restoreRecord, get, update, remove, sweepExpired, size, listAll, listByFlag, listReferencedStorageKeys, close, STATUS, JOB_TYPES, TTL_MS, backend: "memory" };
