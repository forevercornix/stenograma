const { STATUS, JOB_TYPES, TTL_MS, newJob, applyPatch, isFinished, hasPendingCleanup, matchesOwner, normalizeJob } = require("./common");

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

/**
 * ATOMINIS progreso įrašymas (#154).
 *
 * ⚠️ REIKALINGAS IR MEMORY BACKEND'E.
 *
 * Ankstesnis komentaras teigė, kad CAS čia nereikalingas, nes „`get` ir
 * `update` vyksta be `await` tarp jų". Tai buvo neteisinga: fasado
 * `reportProgress()` daro `await store.get(id)`, ir tas `await` atveria langą.
 * Lygiagretūs progreso callback'ai abu nuskaito tą patį snapshot'ą:
 *
 *   pradžia 50, vienu metu pranešama 60 ir 55 → išsaugoma 55
 *
 * t. y. dokumentuotas monotoniškumas lūžta. Fire-and-forget progreso kelias
 * (`queues/processors.js`) tokį persidengimą sukuria natūraliai.
 *
 * Ši funkcija skaito, tikrina ir rašo BE `await` – JS vienos gijos modelyje tai
 * atominė operacija.
 *
 * @returns {object|null|"REJECTED"}
 */
function reportProgressAtomicSync(id, event, jobPhase) {
  const job = jobs.get(id);
  if (!job) return null;

  const patch = jobPhase.reportProgress(job, event);
  if (!patch) return "REJECTED";

  const next = applyPatch(job, patch);
  jobs.set(id, next);
  return next;
}

async function reportProgressAtomic(id, event) {
  // `jobPhase` importuojamas čia, kad nebūtų ciklinės priklausomybės.
  const jobPhase = require("../jobPhase");
  return reportProgressAtomicSync(id, event, jobPhase);
}

async function update(id, patch) {
  const job = jobs.get(id);
  if (!job) return null;
  const next = applyPatch(job, patch);
  jobs.set(id, next);
  return next;
}

/* ─────────────────────────────────────────────────────────────────────────
 * NUOSAVYBE RIBOJAMOS OPERACIJOS (#159)
 *
 * Atmintyje atomiškumo klausimo nėra: Node vykdo šias funkcijas be `await`
 * tarp patikros ir rašymo, tad tarpo, per kurį savininkas pasikeistų,
 * neatsiranda. Redis backend'ui to nepakanka - ten naudojama Lua CAS.
 * ───────────────────────────────────────────────────────────────────────── */

/** @returns {object|null|"FORBIDDEN"} */
async function getOwned(id, scope) {
  const job = jobs.get(id);
  if (!job) return null;
  return matchesOwner(job, scope) ? job : "FORBIDDEN";
}

/** @returns {object|null|"FORBIDDEN"} */
async function updateOwned(id, patch, scope) {
  const job = jobs.get(id);
  if (!job) return null;
  if (!matchesOwner(job, scope)) return "FORBIDDEN";
  const next = applyPatch(job, patch);
  jobs.set(id, next);
  return next;
}

/** @returns {boolean|"FORBIDDEN"} */
async function removeOwned(id, scope) {
  const job = jobs.get(id);
  if (!job) return false;
  if (!matchesOwner(job, scope)) return "FORBIDDEN";
  jobs.delete(id);
  return true;
}

/** Pasenusių job'ų ID - be šalinimo. Predikatas TAS PATS kaip `sweepExpired`. */
async function listExpired(now = Date.now(), limit = 500) {
  const out = [];

  for (const [id, job] of jobs.entries()) {
    if (out.length >= limit) break;
    if (hasPendingCleanup(job)) continue;
    if (isFinished(job.status) && now - new Date(job.updatedAt).getTime() > TTL_MS) {
      out.push(id);
    }
  }

  return out;
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
  /**
   * ⚠️ NORMALIZUOJAMA IR ČIA (#205, 7.2c) - žr. `redisStore.restoreRecord()`.
   * Kopijos turinys yra savavališkas, o `applyPatch()` šio kelio nedengia.
   */
  const kanoninis = normalizeJob(job);
  jobs.set(kanoninis.id, kanoninis);
  return kanoninis;
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

module.exports = { create, restoreRecord, get, update, remove, reportProgressAtomic, getOwned, updateOwned, removeOwned, listExpired, sweepExpired, size, listAll, listByFlag, listReferencedStorageKeys, close, STATUS, JOB_TYPES, TTL_MS, backend: "memory" };
