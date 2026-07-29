const crypto = require("crypto");

// Job statusai (bendri abiem backend'ams). `cancelled` pridėtas pagal production
// planą - jobas, kurį vartotojas ar sistema nutraukė prieš pabaigą.
const STATUS = {
  QUEUED: "queued",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
};

const TTL_MS = parseInt(process.env.JOB_TTL_MINUTES || "60", 10) * 60 * 1000;

/**
 * Sukuria naują job objektą su visais laukais. Bendra abiem backend'ams, kad
 * struktūra būtų vienoda nepriklausomai nuo saugyklos (in-memory ar Redis).
 *
 * Laukai pagal production planą:
 *  - attempt_count: kiek kartų bandyta apdoroti (retry politikai);
 *  - created_at / started_at / completed_at: gyvavimo ciklo laikai (diagnostikai);
 *  - error_code / error_message: struktūrizuota klaida (ne tik tekstas).
 */
function newJob(fields = {}) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    // Jobo TIPAS. Abu async endpoint'ai (transkripcija ir protokolas) naudoja TĄ
    // PATĮ jobStore, tad be tipo DELETE /api/transcribe-jobs/:id priimdavo ir
    // protokolo jobo ID: įrašas būdavo surandamas ir ištrinamas, o valymo kodas
    // ieškodavo NE TOJE BullMQ eilėje - duomenys likdavo, klientas gaudavo 204.
    type: fields.type || "transcription",
    // Bendro audio storage raktas. Saugomas, kol failas TIKRAI ištrintas (tada
    // nustatomas į null) - kad GDPR ištrynimas surastų likutį ir INLINE režime,
    // kur BullMQ jobo (ir jo payload'o su storageKey) apskritai nėra.
    storageKey: fields.storageKey || null,
    status: STATUS.QUEUED,
    result: null,
    progress: null,
    // Struktūrizuota klaida.
    error: null, // atgalinis suderinamumas (senas laukas) - lieka kaip error_message kopija
    error_code: null,
    error_message: null,
    // Retry / gyvavimo ciklas.
    attempt_count: 0,
    created_at: now,
    started_at: null,
    completed_at: null,
    // Atgalinis suderinamumas su senais laukais (routes/frontend jų tikisi).
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Normalizuoja `update` patch'ą: kai nustatomas status, automatiškai užpildo
 * atitinkamus laiko laukus ir sinchronizuoja senus/naujus klaidos laukus. Tai
 * daroma VIENOJE vietoje, kad abu backend'ai elgtųsi identiškai.
 */
function applyPatch(job, patch) {
  const now = new Date().toISOString();
  const next = { ...job, ...patch, updatedAt: now };

  // Laiko žymos pagal status perėjimą.
  if (patch.status === STATUS.PROCESSING && !job.started_at) {
    next.started_at = now;
  }
  if (
    (patch.status === STATUS.COMPLETED ||
      patch.status === STATUS.FAILED ||
      patch.status === STATUS.CANCELLED) &&
    !job.completed_at
  ) {
    next.completed_at = now;
  }

  // Klaidos laukų sinchronizacija (senas `error` <-> naujas `error_message`).
  if (patch.error !== undefined && patch.error_message === undefined) {
    next.error_message = patch.error;
  }
  if (patch.error_message !== undefined && patch.error === undefined) {
    next.error = patch.error_message;
  }

  return next;
}

const JOB_TYPES = { TRANSCRIPTION: "transcription", PROTOCOL: "protocol" };

function isFinished(status) {
  return status === STATUS.COMPLETED || status === STATUS.FAILED || status === STATUS.CANCELLED;
}

module.exports = { STATUS, JOB_TYPES, TTL_MS, newJob, applyPatch, isFinished };
