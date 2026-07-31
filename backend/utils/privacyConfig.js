const { describeSelection, isExternal } = require("./providerPrivacy");
const { probeRedactionComponent, isRedactionAvailable } = require("./redactionComponent");

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
 * Kai persistentinė saugykla IŠJUNGTA, nuskendusių audio failų retencija negali
 * likti 24 val. - tai prieštarautų pačiam režimui. Ribojam iki 1 val.: tiek
 * reikia, kad realiai vykstantis (bet dar nebaigtas) jobas neliktų be failo.
 */
const EPHEMERAL_AUDIO_MAX_HOURS = 1;

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

const BOOLEAN_SETTINGS = [
  "PRIVACY_MODE",
  "ALLOW_EXTERNAL_PROVIDERS",
  "PERSISTENT_STORAGE",
  "REQUIRE_REDACTION_BEFORE_EXTERNAL",
];

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

  /**
   * PERSISTENT_STORAGE yra TRIJŲ būsenų sąmoningai:
   *
   *   nenustatyta -> IŠVEDAMA iš REDIS_URL buvimo (nieko nelaužo esamiems diegimams)
   *   "false"     -> efemeriškas režimas; REDIS_URL kartu = prieštaravimas (klaida)
   *   "true"      -> reikalauja REDIS_URL; be jo "persistentinė" saugykla būtų melas
   *
   * Priežastis nepadaryti numatytosios `false`: tylus REDIS_URL ignoravimas reikštų,
   * kad administratorius mano, jog jobai išgyvena restartą, o jie neišgyvena. Būtent
   * tokios tylios neatitikties šiame projekte vengiam - geriau kieta klaida.
   */
  const persistentRaw = env.PERSISTENT_STORAGE;
  const persistentExplicit = persistentRaw !== undefined && persistentRaw !== "";
  const persistentStorage = persistentExplicit
    ? _bool(persistentRaw, false)
    : Boolean(env.REDIS_URL);

  const audioRetentionHours = _int(env.AUDIO_RETENTION_HOURS, 24);

  return {
    profile,
    localOnly,
    persistentStorage,
    persistentExplicit,

    // `local_only` profilis IMPLIKUOJA išorinių tiekėjų draudimą; be jo galima
    // uždrausti atskirai. Numatytoji tiekėjų konfigūracija (.env.example) yra
    // pilnai lokali (mock/none), tad "iš karto po klonavimo" niekas neišeina.
    allowExternalProviders: localOnly
      ? false
      : _bool(env.ALLOW_EXTERNAL_PROVIDERS, true),

    // Numatyta `false` NE dėl to, kad redakcija nesvarbi, o dėl to, kad numatytoji
    // šio projekto konfigūracija ir taip lokali (mock/none) - įjungta nuostata be
    // redakcijos modulio tik blokuotų startą visiems. Kai #4 nusileis, verta
    // svarstyti numatytąją `true` išoriniams tiekėjams.
    requireRedactionBeforeExternal: _bool(env.REQUIRE_REDACTION_BEFORE_EXTERNAL, false),

    auditEnabled: !_bool(env.PRIVACY_MODE, false),
    auditRetentionDays: _int(env.AUDIT_RETENTION_DAYS, 30),
    jobRetentionMinutes: _int(env.JOB_TTL_MINUTES, 60),
    // Efektyvi (ne konfigūruota) reikšmė: efemeriškame režime ribojama. Skirtumas
    // matomas diagnostikoje, kad administratorius nesvarstytų, kodėl "24" neveikia.
    // Ribojama TIK kai persistencija išjungta AIŠKIAI. Išvestas `false` (tiesiog
    // nėra REDIS_URL) yra numatytoji šio projekto būsena - jai elgsenos nekeičiam,
    // kitaip atnaujinimas tyliai pakeistų retenciją visiems esamiems diegimams.
    audioRetentionHours: persistentExplicit && !persistentStorage
      ? Math.min(audioRetentionHours, EPHEMERAL_AUDIO_MAX_HOURS)
      : audioRetentionHours,
    audioRetentionHoursConfigured: audioRetentionHours,
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

  // --- Persistentinė saugykla (GDPR #5: "persistent storage can be disabled") ---
  const redisConfigured = Boolean(env.REDIS_URL);

  if (config.persistentExplicit && !config.persistentStorage && redisConfigured) {
    errors.push(
      "PERSISTENT_STORAGE=false, bet nustatytas REDIS_URL - prieštaringa konfigūracija. " +
        "Jobų būsena ir rezultatai (transkripcija, protokolas) atsidurtų Redis'e, nors " +
        "prašoma nieko nesaugoti. Pašalinkite REDIS_URL arba nustatykite PERSISTENT_STORAGE=true."
    );
  }

  if (config.persistentExplicit && !config.persistentStorage && env.REDIS_REQUIRED === "true") {
    errors.push(
      "PERSISTENT_STORAGE=false kartu su REDIS_REQUIRED=true - viena nuostata draudžia " +
        "persistenciją, kita jos reikalauja."
    );
  }

  if (config.persistentExplicit && config.persistentStorage && !redisConfigured) {
    errors.push(
      "PERSISTENT_STORAGE=true, bet REDIS_URL nenustatytas - be jo jobų būsena lieka " +
        "ATMINTYJE ir dingsta po restarto. Nustatykite REDIS_URL arba PERSISTENT_STORAGE=false."
    );
  }

  if (config.persistentExplicit && !config.persistentStorage) {
    warnings.push(
      "Persistentinė saugykla IŠJUNGTA: jobų būsena, transkripcijos ir protokolai laikomi " +
        "tik atmintyje ir dingsta perkrovus backendą (ilgas transkribavimas restarto metu - " +
        "prarandamas). Audio šalinamas iškart po jobo pabaigos."
    );

    if (config.audioRetentionHoursConfigured > EPHEMERAL_AUDIO_MAX_HOURS) {
      warnings.push(
        `AUDIO_RETENTION_HOURS=${config.audioRetentionHoursConfigured} sumažinta iki ` +
          `${EPHEMERAL_AUDIO_MAX_HOURS} val., nes PERSISTENT_STORAGE=false. Tai liečia tik ` +
          "NUSKENDUSIUS failus - normaliai audio trinamas iškart po jobo."
      );
    }
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

  /**
   * REDAKCIJA PRIEŠ IŠORINĮ APDOROJIMĄ (GDPR #5 konfigas; vykdymas - #4).
   *
   * Esminis sprendimas: `=true` be redakcijos modulio yra KLAIDA, ne įspėjimas.
   * Priešingu atveju administratorius matytų nuostatą "neredaguoti duomenys
   * neišeina", o transkripcija su asmens kodais keliautų pas Claude/GPT kaip
   * anksčiau - tyliai. Geriau serveris nestartuoja, negu duoda saugumo pažadą,
   * kurio niekas nevykdo.
   */
  if (config.requireRedactionBeforeExternal) {
    const probe = probeRedactionComponent();

    if (probe.state !== "ok") {
      // Trys skirtingos priežastys - trys skirtingi pranešimai. "Modulio nėra" ir
      // "modulis krenta įkeliant" reikalauja visiškai skirtingų veiksmų.
      const REASONS = {
        missing:
          "PII redakcijos komponento (utils/piiRedaction.js su redact()) NĖRA - jis įgyvendinamas GDPR issue #4.",
        load_error: `utils/piiRedaction.js YRA, bet neįsikelia: ${probe.detail}`,
        invalid_contract:
          "utils/piiRedaction.js yra, bet neeksportuoja redact() funkcijos - kontraktas netenkinamas.",
      };

      errors.push(
        `REQUIRE_REDACTION_BEFORE_EXTERNAL=true, bet ${REASONS[probe.state] || probe.state}. ` +
          "Kol redakcija neveikia, ši nuostata negali būti įvykdyta, tad startas stabdomas sąmoningai. " +
          "Pašalinkite nuostatą arba naudokite PRIVACY_PROFILE=local_only, jei norite, " +
          "kad duomenys apskritai neišeitų iš mašinos."
      );
    }

    /**
     * AUDIO KELIAS. Tekstinė redakcija iš principo nedengia išorinio
     * TRANSKRIBAVIMO ar debesų diarizacijos: tie tiekėjai gauna ŽALIĄ garsą su
     * vardais ir asmens kodais, ir jokio redact() ten pritaikyti neįmanoma.
     * Leisti tokį derinį reikštų vėliavą, kuri vėl žada daugiau, nei dengia.
     */
    const rawAudioExternal = ["transcription", "diarization"].filter((kind) => {
      const name =
        kind === "transcription"
          ? env.TRANSCRIPTION_PROVIDER || "mock"
          : env.DIARIZATION_PROVIDER || "none";
      return isRawAudioProviderForbidden(kind, name, env);
    });

    if (rawAudioExternal.length > 0) {
      errors.push(
        `REQUIRE_REDACTION_BEFORE_EXTERNAL=true nesuderinama su išoriniu tiekėju: ` +
          `${rawAudioExternal.join(", ")}. Šie tiekėjai gauna NEREDAGUOTĄ garso įrašą, o tekstinė ` +
          "redakcija garso dengti negali. Naudokite lokalų transkribavimą/diarizaciją " +
          "(faster-whisper, pyannote) arba PRIVACY_PROFILE=local_only."
      );
    }

    if (probe.state === "ok" && !config.allowExternalProviders) {
      warnings.push(
        "REQUIRE_REDACTION_BEFORE_EXTERNAL=true, bet išoriniai tiekėjai ir taip " +
          "uždrausti - nuostata neturi jokio efekto (nekenkia, bet ir nesaugo)."
      );
    }
  } else if (
    isRedactionAvailable() &&
    config.allowExternalProviders &&
    // Būtent LLM, o ne `selection.anyExternal`: išorinis transkribavimas irgi
    // pakeltų `anyExternal`, bet pranešimas kalba apie transkripcijos tekstą,
    // siunčiamą LLM tiekėjui - kitaip įspėtume ne apie tai, kas vyksta.
    isExternal("llm", (env.LLM_PROVIDER || "mock").toLowerCase())
  ) {
    warnings.push(
      `PII redakcija prieinama, bet REQUIRE_REDACTION_BEFORE_EXTERNAL nenustatyta - ` +
        `NEREDAGUOTA transkripcija siunčiama išoriniam LLM tiekėjui "${(env.LLM_PROVIDER || "mock").toLowerCase()}".`
    );
  }

  return { errors, warnings };
}

/**
 * RUNTIME APSAUGA AUDIO KELIUI (GDPR #5).
 *
 * Startup validacijos NEPAKANKA: transkribavimo ir diarizacijos tiekėją galima
 * pakeisti UŽKLAUSOJE (`services/transcriptionService.js` perduoda override į
 * fabriką; diarizacijos režimas ateina tiesiai iš užklausos). Serveris startuotų
 * su lokaliu audio keliu, o vėliau užklausa nurodytų `whisper` ar
 * `pyannote-cloud`, ir žalias garsas iškeliautų - garantija būtų popierinė.
 *
 * Todėl ta pati taisyklė taikoma DVIEJOSE vietose ir per TĄ PATĮ predikatą:
 * paleidžiant (aiški klaida administratoriui) ir fabrikoje (fail-closed
 * kiekvienai užklausai). Fabrikos yra vienintelis kelias iki tiekėjo, tad
 * dengiami ir inline, ir BullMQ vykdymai.
 */
class PrivacyConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PrivacyConfigurationError";
    this.code = "PRIVACY_AUDIO_PROVIDER_FORBIDDEN";
    this.statusCode = 403;
  }
}

/** Ar šis audio tiekėjas draudžiamas esamoje privatumo konfigūracijoje? */
function isRawAudioProviderForbidden(kind, name, env = process.env) {
  if (!getPrivacyConfig(env).requireRedactionBeforeExternal) return false;

  const provider = String(name || "").toLowerCase();
  // none/inline atskiro API kvietimo nedaro - garsas niekur nekeliauja.
  if (kind === "diarization" && (provider === "none" || provider === "inline")) return false;

  return isExternal(kind, provider);
}

function assertRawAudioProviderAllowed(kind, name, env = process.env) {
  if (!isRawAudioProviderForbidden(kind, name, env)) return;

  throw new PrivacyConfigurationError(
    `REQUIRE_REDACTION_BEFORE_EXTERNAL=true, todėl išorinis ${kind} tiekėjas "${String(name).toLowerCase()}" ` +
      "draudžiamas: jis gauna NEREDAGUOTĄ garso įrašą, o tekstinė redakcija garso dengti negali. " +
      "Naudokite lokalų tiekėją arba PRIVACY_PROFILE=local_only."
  );
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
    persistentStorage: config.persistentStorage,
    /**
     * Kiekvienas laukas sako MAŽIAU, nei norėtųsi, ir sąmoningai:
     *  - `componentDetected` - rastas modulis su redact(), NE "redakcija veikia";
     *  - `configuredForEnforcement` - konfigūracija tokia, kad fabrika apvynios
     *    tiekėją. Tai IŠVEDAMA reikšmė, ne konkretaus objekto patikra, todėl
     *    laukas NEVADINAMAS `enforced`: toks pavadinimas žadėtų faktą, o čia yra
     *    tik prognozė. Kad prognozė ir tikrovė nesiskirtų, fabrikos elgesį dengia
     *    tests/redactionEnforcement.test.js (tikrina provider.redactionEnforced).
     */
    redaction: {
      requiredBeforeExternal: config.requireRedactionBeforeExternal,
      componentDetected: isRedactionAvailable(),
      configuredForEnforcement:
        config.requireRedactionBeforeExternal &&
        isRedactionAvailable() &&
        isExternal("llm", (env.LLM_PROVIDER || "mock").toLowerCase()),
    },
    // Kur KONKREČIAI duomenys gyvena - be to administratorius negali patikrinti,
    // ar efemeriškas režimas tikrai efemeriškas.
    storage: {
      jobState: config.persistentStorage ? "redis" : "memory",
      audit: "memory", // audito žurnalas šiame MVP visada tik atmintyje
      audio: "disk (trinamas po jobo pabaigos)",
    },
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
  EPHEMERAL_AUDIO_MAX_HOURS,
  NUMERIC_SETTINGS,
  BOOLEAN_SETTINGS,
  getPrivacyConfig,
  validatePrivacyConfig,
  describeForDiagnostics,
  // Re-eksportas patogumui; vienintelis šaltinis - utils/redactionComponent.js.
  isRedactionAvailable,
  PrivacyConfigurationError,
  isRawAudioProviderForbidden,
  assertRawAudioProviderAllowed,
};
