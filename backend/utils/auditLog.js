const crypto = require("node:crypto");

/**
 * Privacy-safe audit log.
 *
 * MVP saugykla lieka atmintyje, tačiau įrašomi tik aiškiai leidžiami
 * techniniai metaduomenys. Transkriptai, promptai, failų vardai,
 * autentifikacijos duomenys ir kitas laisvos formos turinys nesaugomi.
 *
 * Produkcijoje šią saugyklą galima pakeisti SQLite/Postgres adapteriu,
 * nekeičiant record()/getAll() sąsajos.
 */

const log = [];
const DEFAULT_RETENTION_DAYS = 30;

function getRetentionDays() {
  const configured = Number(process.env.AUDIT_RETENTION_DAYS);

  return Number.isFinite(configured) && configured >= 1
    ? configured
    : DEFAULT_RETENTION_DAYS;
}

function purgeExpired(now = Date.now()) {
  const cutoff =
    now - getRetentionDays() * 24 * 60 * 60 * 1000;

  const originalLength = log.length;

  for (let index = log.length - 1; index >= 0; index -= 1) {
    const timestamp = Date.parse(log[index].timestamp);

    if (!Number.isFinite(timestamp) || timestamp < cutoff) {
      log.splice(index, 1);
    }
  }

  return originalLength - log.length;
}


const MAX_ERROR_LENGTH = 300;
const MAX_PROVIDER_LENGTH = 80;
const MAX_EVENT_LENGTH = 64;

const EVENT_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;

const SENSITIVE_KEY_PATTERN =
  /authorization|api[-_]?key|token|secret|password|cookie|transcript|prompt|audio|filename|filepath|requestbody/i;

function redactString(value) {
  if (typeof value !== "string") return value;

  let sanitized = value;

  // Bearer ir panašūs autentifikacijos duomenys.
  sanitized = sanitized.replace(
    /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
    "$1 [REDACTED]"
  );

  // Dažni secret/token/key užrašymo variantai.
  sanitized = sanitized.replace(
    /\b(api[-_ ]?key|token|secret|password|authorization)\b\s*[:=]\s*["']?[^\s,"'}]+/gi,
    "$1=[REDACTED]"
  );

  // El. pašto adresai.
  sanitized = sanitized.replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    "[EMAIL_REDACTED]"
  );

  // Lietuvos asmens kodas: 11 skaitmenų, prasidedantis 1–6.
  sanitized = sanitized.replace(
    /\b[1-6]\d{10}\b/g,
    "[PERSONAL_CODE_REDACTED]"
  );

  // Telefono numeriai – konservatyvus bendras variantas.
  sanitized = sanitized.replace(
    /(?<!\w)(?:\+?\d[\d\s().-]{6,}\d)(?!\w)/g,
    "[PHONE_REDACTED]"
  );

  // Absoliutūs Unix ir Windows failų keliai.
  sanitized = sanitized.replace(
    /(?:[A-Za-z]:\\|\/)(?:[^/\s\\]+[\/\\])+[^/\s\\]*/g,
    "[PATH_REDACTED]"
  );

  return sanitized;
}

function sanitizeScalar(value, maxLength = MAX_ERROR_LENGTH) {
  if (value === null || value === undefined) return null;

  const sanitized = redactString(String(value))
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!sanitized) return null;

  return sanitized.slice(0, maxLength);
}

function pseudonymizeIdentifier(value) {
  if (value === null || value === undefined || value === "") return null;

  const salt = process.env.AUDIT_ID_SALT || "stenograma-local-audit-v1";

  return crypto
    .createHmac("sha256", salt)
    .update(String(value))
    .digest("hex")
    .slice(0, 20);
}

function normalizeEvent(entry) {
  if (
    typeof entry.event === "string" &&
    EVENT_PATTERN.test(entry.event)
  ) {
    return entry.event.slice(0, MAX_EVENT_LENGTH);
  }

  if (entry.transcriptionProvider) {
    return entry.success === false
      ? "TRANSCRIPTION_FAILED"
      : "TRANSCRIPTION_COMPLETED";
  }

  if (entry.llmProvider) {
    return entry.success === false
      ? "PROTOCOL_FAILED"
      : "PROTOCOL_COMPLETED";
  }

  return entry.success === false ? "PROCESSING_FAILED" : "PROCESSING_COMPLETED";
}

function finiteNonNegativeNumber(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function sanitizeForLogging(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return redactString(value);
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: sanitizeScalar(value.name, 80),
      message: sanitizeScalar(value.message),
    };
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeForLogging(item, seen));
  }

  if (typeof value === "object") {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);

    const result = {};

    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        result[key] = "[REDACTED]";
        continue;
      }

      result[key] = sanitizeForLogging(item, seen);
    }

    seen.delete(value);
    return result;
  }

  return sanitizeScalar(value);
}

function record(entry = {}) {
  purgeExpired();
  const row = Object.freeze({
    id: log.length + 1,
    timestamp: new Date().toISOString(),
    event: normalizeEvent(entry),

    // Niekada nesaugome tiesioginio meeting/job identifikatoriaus.
    subjectId: pseudonymizeIdentifier(
      entry.jobId ?? entry.meetingId ?? null
    ),

    result: entry.success === false ? "failure" : "success",

    promptVersion: sanitizeScalar(entry.promptVersion, 40),
    llmProvider: sanitizeScalar(entry.llmProvider, MAX_PROVIDER_LENGTH),
    llmModel: sanitizeScalar(entry.llmModel, MAX_PROVIDER_LENGTH),
    transcriptionProvider: sanitizeScalar(
      entry.transcriptionProvider,
      MAX_PROVIDER_LENGTH
    ),
    diarizationProvider: sanitizeScalar(
      entry.diarizationProvider,
      MAX_PROVIDER_LENGTH
    ),

    processingTimeMs: finiteNonNegativeNumber(entry.processingTimeMs),
    inputTokens: finiteNonNegativeNumber(entry.usage?.inputTokens),
    outputTokens: finiteNonNegativeNumber(entry.usage?.outputTokens),
    estimatedCostUsd: finiteNonNegativeNumber(entry.estimatedCostUsd),
    jsonRepairAttempts:
      Number.isInteger(entry.jsonRepairAttempts) &&
      entry.jsonRepairAttempts >= 0
        ? entry.jsonRepairAttempts
        : 0,

    // Klaida naudinga diagnostikai, bet prieš saugojimą išvaloma ir trumpinama.
    error:
      entry.success === false
        ? sanitizeScalar(entry.error)
        : null,
  });

  log.push(row);
  return row;
}

function getAll() {
  // Negrąžiname vidinio masyvo, kad išorinis kodas jo nepakeistų.
  return log.map((entry) => ({ ...entry }));
}

function clear() {
  log.length = 0;
}

module.exports = {
  record,
  getAll,
  clear,
  sanitizeForLogging,
  pseudonymizeIdentifier,
  purgeExpired,
  getRetentionDays,
};
