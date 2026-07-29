const { STATUS, JOB_TYPES, TTL_MS, newJob, applyPatch, isFinished } = require("./common");

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

async function remove(id) {
  return jobs.delete(id);
}

async function close() {
  jobs.clear();
}

module.exports = { create, get, update, remove, sweepExpired, size, close, STATUS, JOB_TYPES, TTL_MS, backend: "memory" };
