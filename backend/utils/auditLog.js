const crypto = require("node:crypto");
const { createLogger } = require("../utils/logger");
const logger = createLogger("audit");

/**
 * Privacy-safe audit log.
 *
 * MVP saugykla lieka atmintyje, tačiau įrašomi tik aiškiai leidžiami
 * techniniai metaduomenys. Transkriptai, promptai, failų vardai,
 * autentifikacijos duomenys ir kitas laisvos formos turinys nesaugomi.
 *
 * Produkcijoje šią saugyklą galima pakeisti SQLite/Postgres adapteriu,
 * nekeičiant record()/getAll() sąsajos.
 *
 * SVARBU dėl dviejų skirtingų valymo lygių:
 *   - KONTROLIUOJAMI laukai (provider/model/promptVersion) ateina IŠ KODO ar iš
 *     whitelist'u patvirtinto override - jiems taikomas tik simbolių allowlist,
 *     BE PII heuristikų. Anksčiau čia veikė ir telefono numerių regex'as, kuris
 *     "claude-3-5-sonnet-20241022" paversdavo "claude-3-5-sonnet-[PHONE_REDACTED]"
 *     ir sugadindavo būtent tuos duomenis, dėl kurių auditas ir egzistuoja.
 *   - LAISVO TEKSTO laukai (error) gali turėti tiekėjo grąžintą turinį - jiems
 *     taikoma pilna redakcijos grandinė.
 */

const log = [];
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_ENTRIES = 5000;

let saltWarningShown = false;

/**
 * Atsitiktinė druska, sugeneruojama VIENĄ kartą procese, kai `AUDIT_ID_SALT`
 * nenustatytas.
 *
 * Anksčiau čia buvo vieša repozitorijos reikšmė ("stenograma-local-audit-v1") -
 * tai reiškė, kad bet kas, žinantis ar spėjantis job/meeting ID, galėjo
 * apskaičiuoti tą patį HMAC, ir pseudonimizacija nesaugojo nieko. Vėliau tai
 * buvo pakeista į startą blokuojančią klaidą produkcijoje, bet ji sulaužė
 * dokumentuotą `docker compose up` kelią (image'e ENV NODE_ENV=production, o
 * druskos niekas nenustato) - konteineris tiesiog nebepasileisdavo.
 *
 * Atsitiktinė druska sprendžia abu dalykus: viešos reikšmės nebėra, o startas
 * nenutrūksta. Kaina - pseudonimai nestabilūs tarp perkrovimų ir tarp replikų;
 * šiandien tai nieko nekainuoja, nes audito žurnalas ir taip yra ATMINTYJE ir
 * po restarto tuščias. Persistentinei audito saugyklai (Milestone 2)
 * `AUDIT_ID_SALT` privalo būti nustatytas eksplicitiškai.
 */
let generatedSalt = null;

function resolveSalt() {
  const configured = process.env.AUDIT_ID_SALT;
  if (configured) return configured;

  if (!generatedSalt) {
    generatedSalt = crypto.randomBytes(32).toString("hex");

    if (!saltWarningShown) {
      saltWarningShown = true;
      logger.warn(
        "[stenograma] AUDIT_ID_SALT nenustatytas - sugeneruota ATSITIKTINĖ druska šiam procesui. " +
          "Pseudonimai nebus vienodi po perkrovimo ar kitoje replikoje. Tai priimtina, kol auditas " +
          "yra atmintyje; persistentinei saugyklai nustatykite AUDIT_ID_SALT (openssl rand -hex 32)."
      );
    }
  }

  return generatedSalt;
}
let privacyPurgeWarningShown = false;

function isPrivacyModeEnabled() {
  return String(process.env.PRIVACY_MODE || "").toLowerCase() === "true";
}

function getRetentionDays() {
  const configured = Number(process.env.AUDIT_RETENTION_DAYS);

  return Number.isFinite(configured) && configured >= 1
    ? configured
    : DEFAULT_RETENTION_DAYS;
}

function getMaxEntries() {
  const configured = Number(process.env.AUDIT_MAX_ENTRIES);

  return Number.isFinite(configured) && configured >= 1
    ? Math.floor(configured)
    : DEFAULT_MAX_ENTRIES;
}

function purgeExpired(now = Date.now()) {
  const cutoff = now - getRetentionDays() * 24 * 60 * 60 * 1000;

  const originalLength = log.length;

  for (let index = log.length - 1; index >= 0; index -= 1) {
    const timestamp = Date.parse(log[index].timestamp);

    if (!Number.isFinite(timestamp) || timestamp < cutoff) {
      log.splice(index, 1);
    }
  }

  return originalLength - log.length;
}

/**
 * Atminties riba. Retencija dienomis neapsaugo nuo srauto pliūpsnio per vieną
 * dieną, o logas gyvena backend'o procese - todėl seniausi įrašai išmetami
 * pasiekus AUDIT_MAX_ENTRIES.
 */
function enforceMaxEntries() {
  const max = getMaxEntries();

  if (log.length <= max) return 0;

  return log.splice(0, log.length - max).length;
}

const MAX_ERROR_LENGTH = 300;
const MAX_PROVIDER_LENGTH = 80;
const MAX_EVENT_LENGTH = 64;

const EVENT_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;

// Kontroliuojamiems laukams leidžiami simboliai. Tokių reikšmių pavyzdžiai:
// "claude-3-5-sonnet-20241022", "faster-whisper-embedded (inline)", "meeting_v3",
// "queue=deleted storage=none" (ištrynimo kvitas).
const CONTROLLED_DISALLOWED = /[^A-Za-z0-9 ._:+\-()/=]/g;

const SENSITIVE_KEY_PATTERN =
  /authorization|api[-_]?key|token|secret|password|cookie|transcript|prompt|audio|filename|filepath|requestbody/i;

function redactString(value) {
  if (typeof value !== "string") return value;

  let sanitized = value;

  // 1) Bearer ir panašūs autentifikacijos duomenys.
  sanitized = sanitized.replace(
    /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
    "$1 [REDACTED]"
  );

  // 2) Dažni secret/token/key užrašymo variantai.
  sanitized = sanitized.replace(
    /\b(api[-_ ]?key|token|secret|password|authorization)\b\s*[:=]\s*["']?[^\s,"'}]+/gi,
    "$1=[REDACTED]"
  );

  // 3) URL prisijungimo duomenys (userinfo): `redis://naudotojas:slaptas@host`,
  //     `postgres://...`, `amqp://...`. Turi eiti PRIEŠ URL taisyklę, kitaip ta
  //    paliktų visą "origin" kartu su slaptažodžiu, o el. pašto taisyklė suėstų
  //    `slaptas@host` kaip adresą ir liktų klaidinga žymė. Rasta realiai: neveikiančio
  //     Redis klaidos pranešimas su pilnu connection string patekdavo į logą.
  sanitized = sanitized.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+(?::[^\s@/]*)?@/gi,
    "$1[CREDENTIALS_REDACTED]@"
  );

  // 4) El. pašto adresai.
  sanitized = sanitized.replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    "[EMAIL_REDACTED]"
  );

  // 5) URL: schema ir hostas paliekami (naudinga diagnostikai), kelias/query -
  //    slepiami. Turi eiti PIRMA už failų kelių taisyklę, kitaip
  //    "http://localhost:8001/diarize" virsdavo "http:/[PATH_REDACTED]".
  sanitized = sanitized.replace(
    /\b(https?:\/\/[^\s/?#]+)([/?#][^\s]*)?/gi,
    (match, origin, rest) => (rest ? `${origin}/[PATH_REDACTED]` : origin)
  );

  // 6) Absoliutūs Unix ir Windows failų keliai. Lookbehind neleidžia įsikibti į
  //    jau apdorotų URL vidų (":" arba "/" prieš atitikmenį).
  sanitized = sanitized.replace(
    /(?<![\w:/\\])(?:[A-Za-z]:\\|\/)(?:[^/\s\\]+[/\\])+[^/\s\\]*/g,
    "[PATH_REDACTED]"
  );

  // 7) IPv4 adresai (pagal BDAR - asmens duomenys). Turi eiti PRIEŠ telefonus,
  //    kitaip "127.0.0.1" būtų palaikytas telefono numeriu.
  sanitized = sanitized.replace(
    /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g,
    "[IP_REDACTED]"
  );

  // 8) Telefono numeriai. SĄMONINGAI siauras šablonas: tik tarptautinis formatas
  //    su "+" arba LT nacionalinis mobilus (8 6XX XXXXX). Ankstesnis bendras
  //    "8+ skaitmenų" variantas rydavo laiko žymas, trukmes ms, modelių versijas
  //    ir portus - t. y. sugadindavo diagnostiką be jokios privatumo naudos.
  sanitized = sanitized.replace(
    /(?<![\w.+])\+\d[\d\s().-]{5,16}\d(?![\w.])/g,
    "[PHONE_REDACTED]"
  );
  sanitized = sanitized.replace(
    /(?<![\w.+])8[\s.-]?6\d{2}[\s.-]?\d{5}(?![\w.])/g,
    "[PHONE_REDACTED]"
  );

  // 9) Lietuvos asmens kodas: 11 skaitmenų, prasidedantis 1-6.
  sanitized = sanitized.replace(/\b[1-6]\d{10}\b/g, "[PERSONAL_CODE_REDACTED]");

  // 10) Kosmetika: gretimi "[REDACTED]" (pvz. "Authorization: Bearer xxx" pataiko
  //    į dvi taisykles) sujungiami į vieną.
  sanitized = sanitized.replace(/(\[REDACTED\])(?:\s+\[REDACTED\])+/g, "$1");

  return sanitized;
}

function collapseWhitespace(value) {
  return String(value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Laisvo teksto laukams (error): pilna redakcijos grandinė + trumpinimas.
 */
function sanitizeScalar(value, maxLength = MAX_ERROR_LENGTH) {
  if (value === null || value === undefined) return null;

  const sanitized = collapseWhitespace(redactString(String(value)));

  if (!sanitized) return null;

  return sanitized.slice(0, maxLength);
}

/**
 * Kontroliuojamiems laukams (provider/model/promptVersion): tik simbolių
 * allowlist ir ilgio riba, JOKIŲ PII heuristikų - žr. paaiškinimą failo viršuje.
 */
function sanitizeControlled(value, maxLength = MAX_PROVIDER_LENGTH) {
  if (value === null || value === undefined) return null;

  const sanitized = collapseWhitespace(
    String(value).replace(CONTROLLED_DISALLOWED, "")
  );

  if (!sanitized) return null;

  return sanitized.slice(0, maxLength);
}

function pseudonymizeIdentifier(value) {
  if (value === null || value === undefined || value === "") return null;

  return crypto
    .createHmac("sha256", resolveSalt())
    .update(String(value))
    .digest("hex")
    .slice(0, 20);
}

function normalizeEvent(entry) {
  if (typeof entry.event === "string" && EVENT_PATTERN.test(entry.event)) {
    return entry.event.slice(0, MAX_EVENT_LENGTH);
  }

  if (entry.transcriptionProvider) {
    return entry.success === false
      ? "TRANSCRIPTION_FAILED"
      : "TRANSCRIPTION_COMPLETED";
  }

  if (entry.llmProvider) {
    return entry.success === false ? "PROTOCOL_FAILED" : "PROTOCOL_COMPLETED";
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

  if (typeof value === "number" || typeof value === "boolean") {
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

/**
 * Redakcijos metaduomenys auditui.
 *
 * Sąmoningai NEkopijuojam objekto: perrašom lauką po lauko. Jei ateityje
 * artefaktas įgytų naują lauką su jautriu turiniu, jis čia NEPATEKS automatiškai -
 * reikės sąmoningo veiksmo. Tai ta pati logika, dėl kurios visas auditas remiasi
 * whitelist'u, o ne juoduoju sąrašu.
 */
const { getRequestId, getActor } = require("./requestContext");

function sanitizeRedaction(redaction) {
  if (!redaction || typeof redaction !== "object") return null;

  const stats = {};
  for (const [key, value] of Object.entries(redaction.redactionStats || {})) {
    // TIK skaičiai. Eilutė čia reikštų, kad kažkas bando įrašyti reikšmę.
    if (Number.isInteger(value) && value >= 0) stats[sanitizeControlled(key, 40)] = value;
  }

  return {
    variant: sanitizeControlled(redaction.variant, 20),
    redactionStatus: sanitizeControlled(redaction.redactionStatus, 20),
    policyVersion: sanitizeControlled(redaction.policyVersion, 20),
    // Baigtis ("blocked" / "sent") - atskirai nuo statuso: statusas sako, kas
    // nutiko redakcijai, baigtis - kas nutiko duomenims.
    outcome: sanitizeControlled(redaction.outcome, 20),
    artefactId: sanitizeControlled(redaction.artefactId, 40),
    sourceArtefactId: sanitizeControlled(redaction.sourceArtefactId, 40),
    redactionStats: stats,
  };
}

function record(entry = {}) {
  if (isPrivacyModeEnabled()) {
    // Fail-safe: įjungus PRIVACY_MODE ne tik neberašom, bet ir nebelaikom to,
    // kas jau sukaupta atmintyje. Tas pats tikrinimas yra getAll() - kad
    // duomenys būtų nepasiekiami net jei naujų įvykių nebeateina.
    purgeForPrivacyMode();
    return null;
  }

  purgeExpired();

  const row = Object.freeze({
    // UUID, ne skaitiklis: `log.length + 1` kartodavosi po purge/remove, o
    // monotoniškas skaitiklis lieka unikalus tik VIENO proceso gyvavimo metu
    // (po restarto vėl nuo 1). UUID tinka ir perkėlus auditą į SQLite/Postgres.
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    event: normalizeEvent(entry),

    // Niekada nesaugome tiesioginio meeting/job identifikatoriaus.
    subjectId: pseudonymizeIdentifier(entry.jobId ?? entry.meetingId ?? null),

    result: entry.success === false ? "failure" : "success",

    promptVersion: sanitizeControlled(entry.promptVersion, 40),
    llmProvider: sanitizeControlled(entry.llmProvider),
    llmModel: sanitizeControlled(entry.llmModel),
    transcriptionProvider: sanitizeControlled(entry.transcriptionProvider),
    diarizationProvider: sanitizeControlled(entry.diarizationProvider),

    processingTimeMs: finiteNonNegativeNumber(entry.processingTimeMs),
    inputTokens: finiteNonNegativeNumber(entry.usage?.inputTokens),
    outputTokens: finiteNonNegativeNumber(entry.usage?.outputTokens),
    estimatedCostUsd: finiteNonNegativeNumber(entry.estimatedCostUsd),
    jsonRepairAttempts:
      Number.isInteger(entry.jsonRepairAttempts) && entry.jsonRepairAttempts >= 0
        ? entry.jsonRepairAttempts
        : 0,

    // Klaida naudinga diagnostikai, bet prieš saugojimą išvaloma ir trumpinama.
    error: entry.success === false ? sanitizeScalar(entry.error) : null,

    // Laisvas, bet KONTROLIUOJAMAS techninių detalių laukas. Šiuo metu naudojamas
    // tik ištrynimo kvitui ("queue=deleted storage=none ..."). Ne laisvas tekstas -
    // simbolių allowlist ir ilgio riba, kaip ir kitiems kontroliuojamiems laukams.
    details: sanitizeControlled(entry.details, 200),

    // REDAKCIJOS BŪSENA (GDPR #4). Laukai eina pro TĄ PATĮ whitelist principą
    // kaip ir visi kiti: eilutės - per sanitizeControlled, statistika - tik
    // skaičiai. Aptiktos PII reikšmės čia patekti negali net tada, jei kas nors
    // jas netyčia įdėtų į artefaktą.
    redaction: sanitizeRedaction(entry.redaction),

    /**
     * KORELIACIJA (GDPR #17). Numatytosios reikšmės imamos iš request konteksto,
     * bet EKSPLICITINIS perdavimas turi pirmenybę: worker'iai ir ištrynimo kvitai
     * kartais žino ID geriau nei aplinkinis scope (pvz. retry, vykstantis be
     * jokios HTTP užklausos).
     *
     * `actor` yra rakto ATSPAUDAS, ne raktas - žr. utils/requestContext.js.
     */
    requestId: sanitizeControlled(entry.requestId ?? getRequestId(), 64),
    actor: sanitizeControlled(entry.actor ?? getActor(), 40),
  });

  log.push(row);
  enforceMaxEntries();

  return row;
}

function getAll() {
  if (isPrivacyModeEnabled()) {
    purgeForPrivacyMode();
    return [];
  }

  // Retencija galioja ir skaitant: be šito pasenę įrašai liktų matomi
  // /api/audit tol, kol neateina naujas įvykis.
  purgeExpired();

  // Negrąžiname vidinio masyvo, kad išorinis kodas jo nepakeistų.
  return log.map((entry) => ({ ...entry }));
}

function clear() {
  log.length = 0;
}

/**
 * PRIVACY_MODE ištrynimas yra NEGRĮŽTAMAS, todėl jis nėra tylus: pirmą kartą,
 * kai dėl vėliavos realiai kažkas išmetama, į logą rašomas aiškus įspėjimas.
 * (Administratorius, laikinai įjungęs vėliavą, kitaip pamatytų tik tuščią
 * /api/audit sąrašą ir nesuprastų, kad atmintis jau išvalyta.)
 */
function purgeForPrivacyMode() {
  const removed = log.length;

  clear();

  if (removed > 0 && !privacyPurgeWarningShown) {
    privacyPurgeWarningShown = true;
    logger.warn(
      `[stenograma] PRIVACY_MODE=true - audito žurnalas išvalytas (${removed} įrašų). ` +
        "Tai negrįžtama; išjungus vėliavą įrašai neatsistato."
    );
  }

  return removed;
}

/**
 * ASYNC sąmoningai, nors saugykla in-memory: eraseJob() ir maršrutai jau dabar
 * kviečia su await, tad perkėlus auditą į SQLite/Postgres (Milestone 2) sąsaja
 * nesikeis.
 */
async function removeBySubjectIdentifier(value) {
  const subjectId = pseudonymizeIdentifier(value);
  if (!subjectId) return 0;

  const originalLength = log.length;

  for (let index = log.length - 1; index >= 0; index -= 1) {
    if (log[index].subjectId === subjectId) {
      log.splice(index, 1);
    }
  }

  return originalLength - log.length;
}

// Jei procesas startuoja jau su PRIVACY_MODE=true, nieko nekaupiame nuo pat pradžių.
if (isPrivacyModeEnabled()) clear();

module.exports = {
  record,
  getAll,
  clear,
  removeBySubjectIdentifier,
  sanitizeForLogging,
  pseudonymizeIdentifier,
  purgeExpired,
  enforceMaxEntries,
  getRetentionDays,
  getMaxEntries,
  isPrivacyModeEnabled,
};
