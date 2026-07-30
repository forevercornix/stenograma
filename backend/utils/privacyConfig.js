const { describeSelection } = require("./providerPrivacy");

/**
 * CENTRALIZUOTA PRIVATUMO KONFIGURACIJA (GDPR issue #5).
 *
 * Tikslas: viena vieta, kur nuskaitomos privatumo nuostatos, ir viena vieta,
 * kuri pasako, ar konfigūracija savaime neprieštaringa.
 *
 * DĖL PAVADINIMŲ: jau egzistuojantis `PRIVACY_MODE=true` reiškia "audito žurnalas
 * išjungtas" (žr. utils/auditLog.js). Jo semantikos NEKEIČIAM ir į jį nekraunam
 * antros reikšmės - tai būtų būtent tas dviprasmiškumas, kurio šiame projekte
 * vengiam. Tiekėjų ribojimui naudojamas ATSKIRAS `PRIVACY_PROFILE`.
 */

const PROFILES = { STANDARD: "standard", LOCAL_ONLY: "local_only" };

const RETENTION_LIMITS = { minDays: 1, maxDays: 365 };

/**
 * Skaitinės nuostatos ir jų ribos. Neteisinga reikšmė NĖRA tyliai pakeičiama
 * numatytąja: administratoriui atrodytų, kad nustatė 1 val. retenciją, o sistema
 * naudotų 24 - būtent tokia tyli neatitiktis yra privatumo problema.
 */
const NUMERIC_SETTINGS = [
  { key: "AUDIT_RETENTION_DAYS", min: RETENTION_LIMITS.minDays, max: RETENTION_LIMITS.maxDays },
  { key: "AUDIT_MAX_ENTRIES", min: 1, max: 1000000 },
  { key: "JOB_TTL_MINUTES", min: 1, max: 525600 },
  { key: "AUDIO_RETENTION_HOURS", min: 1, max: 8760 },
  { key: "RETENTION_SWEEP_INTERVAL_MINUTES", min: 1, max: 10080 },
  { key: "DELETION_RETRY_INTERVAL_MINUTES", min: 1, max: 10080 },
];

const BOOLEAN_SETTINGS = ["PRIVACY_MODE", "ALLOW_EXTERNAL_PROVIDERS"];

function _bool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return String(value).toLowerCase() === "true";
}

function _int(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function getPrivacyConfig(env = process.env) {
  const profile = String(env.PRIVACY_PROFILE || PROFILES.STANDARD).toLowerCase();
  const localOnly = profile === PROFILES.LOCAL_ONLY;

  return {
    profile,
    localOnly,

    // `local_only` profilis IMPLIKUOJA išorinių tiekėjų draudimą; be jo galima
    // uždrausti atskirai. Numatytoji tiekėjų konfigūracija (.env.example) yra
    // pilnai lokali (mock/none), tad "iš karto po klonavimo" niekas neišeina.
    allowExternalProviders: localOnly
      ? false
      : _bool(env.ALLOW_EXTERNAL_PROVIDERS, true),

    auditEnabled: !_bool(env.PRIVACY_MODE, false),
    auditRetentionDays: _int(env.AUDIT_RETENTION_DAYS, 30),
    jobRetentionMinutes: _int(env.JOB_TTL_MINUTES, 60),
    audioRetentionHours: _int(env.AUDIO_RETENTION_HOURS, 24),
    retentionSweepMinutes: _int(env.RETENTION_SWEEP_INTERVAL_MINUTES, 5),
  };
}

/**
 * Prieštaringos / nesaugios konfigūracijos. Grąžina { errors, warnings } -
 * formatas suderintas su utils/startupChecks.js.
 */
function validatePrivacyConfig(env = process.env) {
  const errors = [];
  const warnings = [];

  // Griežta reikšmių validacija PIRMA - kitaip toliau vertintume normalizuotas
  // (fallback) reikšmes ir praneštume apie konfigūraciją, kurios vartotojas neprašė.
  for (const { key, min, max } of NUMERIC_SETTINGS) {
    const raw = env[key];
    if (raw === undefined || raw === "") continue;

    const parsed = Number(raw);

    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      errors.push(`${key}="${raw}" nėra sveikasis skaičius.`);
      continue;
    }
    if (parsed < min || parsed > max) {
      errors.push(`${key}=${parsed} yra už leistinų ribų (${min}-${max}).`);
    }
  }

  for (const key of BOOLEAN_SETTINGS) {
    const raw = env[key];
    if (raw === undefined || raw === "") continue;

    if (!["true", "false"].includes(String(raw).toLowerCase())) {
      errors.push(`${key}="${raw}" turi būti "true" arba "false".`);
    }
  }

  if (errors.length) return { errors, warnings };

  const config = getPrivacyConfig(env);

  if (!Object.values(PROFILES).includes(config.profile)) {
    errors.push(
      `Nežinomas PRIVACY_PROFILE: "${config.profile}". Galimi: ${Object.values(PROFILES).join(", ")}.`
    );
    return { errors, warnings };
  }

  const selection = describeSelection(env);

  if (!config.allowExternalProviders && selection.anyExternal) {
    const list = selection.externalProviders
      .map((item) => `${item.kind}=${item.name} (${item.vendor || "?"}, siunčia: ${item.dataSent})`)
      .join("; ");

    errors.push(
      config.localOnly
        ? `PRIVACY_PROFILE=local_only, bet pasirinkti IŠORINIAI tiekėjai: ${list}. ` +
          "Pasirinkite lokalius (pvz. TRANSCRIPTION_PROVIDER=faster-whisper-embedded, LLM_PROVIDER=mock) arba pakeiskite profilį."
        : `ALLOW_EXTERNAL_PROVIDERS=false, bet pasirinkti išoriniai tiekėjai: ${list}.`
    );
  }

  if (config.localOnly && config.auditEnabled === false) {
    warnings.push(
      "PRIVACY_PROFILE=local_only kartu su PRIVACY_MODE=true - auditas išjungtas, " +
        "tad nebus ir įrašų apie automatinį duomenų šalinimą."
    );
  }

  // Įspėjimas apie išorinius tiekėjus, kai jie LEIDŽIAMI (issue #7 DoD).
  if (config.allowExternalProviders && selection.anyExternal) {
    for (const item of selection.externalProviders) {
      warnings.push(
        `${item.kind.toUpperCase()} tiekėjas "${item.name}" yra IŠORINIS: ` +
          `${item.dataSent === "audio" ? "garso įrašas" : "transkripcijos tekstas"} ` +
          `siunčiamas į ${item.vendor || "trečiąją šalį"}. Duomenų rezidencija ir subtiekėjai ` +
          "priklauso nuo jūsų sutarties su tiekėju, ne nuo šio projekto."
      );
    }
  }

  return { errors, warnings };
}

/**
 * Ką rodyti diagnostikoje (`GET /api/health`). Be paslapčių - tik efektyvios
 * nuostatos, kurias administratoriui reikia matyti.
 */
function describeForDiagnostics(env = process.env) {
  const config = getPrivacyConfig(env);
  const selection = describeSelection(env);

  return {
    profile: config.profile,
    localOnly: config.localOnly,
    externalProviders: selection.anyExternal ? selection.externalProviders : false,
    auditEnabled: config.auditEnabled,
    retention: {
      audit: `${config.auditRetentionDays}d`,
      jobs: `${config.jobRetentionMinutes}m`,
      audio: `${config.audioRetentionHours}h`,
    },
  };
}

module.exports = {
  PROFILES,
  RETENTION_LIMITS,
  NUMERIC_SETTINGS,
  BOOLEAN_SETTINGS,
  getPrivacyConfig,
  validatePrivacyConfig,
  describeForDiagnostics,
};
