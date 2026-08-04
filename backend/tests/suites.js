/**
 * TESTŲ RINKINIŲ MANIFESTAS (#15).
 *
 * Kodėl manifestas, o ne failų pervadinimas ar katalogai: 61 failo perkėlimas
 * sugriautų `git blame` ir kiekvieną atvirą šaką, o nauda būtų ta pati. Čia
 * priskyrimas matomas vienoje vietoje ir peržiūrimas kaip kodas.
 *
 * SVARBIAUSIA SAVYBĖ: kiekvienas `tests/*.test.js` PRIVALO priklausyti bent
 * vienam rinkiniui. `scripts/run-tests.mjs` tai tikrina ir krinta, jei naujas
 * failas liko nepriskirtas - kitaip grupavimas ilgainiui apimtų tik tuos testus,
 * kuriuos kas nors prisiminė įrašyti, o `npm run test:security` rodytų žalią
 * dėl to, kad testų tiesiog nepaleido.
 *
 * Failas gali priklausyti KELIEMS rinkiniams: privatumo garantija dažnai yra ir
 * saugumo garantija, ir dirbtinis skirstymas tik verstų rinktis.
 */

/** Testai, kuriems reikia TIKRO Redis (be jo jie patys save praleidžia). */
const redis = ["queueRecovery.integration", "heartbeatReadiness.integration", "redisConcurrency.integration"];

/**
 * PRIVATUMAS: asmens duomenų apsauga - redakcija, retencija, ištrynimas,
 * eksporto variantai, auditas be turinio.
 */
const privacy = [
  "piiRedaction",
  "privacyConfig",
  "privacyPolicy",
  "providerPrivacy",
  "redactionEnforcement",
  "redactionErrorLeak.route",
  "redactionParity.route",
  "redactionParity4.route",
  "failClosedMatrix",
  "exportPolicy",
  "exportVariants.route",
  "exports.route",
  "auditErasure.service",
  "auditLog",
  "jobErasure",
  "deletionResilience",
  "audioCleanup",
  "artefactInventory",
  "backupPolicy",
  "backupRestore",
  "backupSecurity",
  "backupRoutes.route",
  "backupDocumentation",
  "lifecycleDeletion",
  "deletionEnforcement",
  "lifecycleE2E",
  "deletionDocumentation",
  "observabilityEvents.route",
];

/**
 * SAUGUMAS: prieigos kontrolė, įvesties validacija, priėmimo kelias, klaidų
 * sanitizacija, koreliacija ir paleidimo patikros.
 */
const security = [
  "criticalGuarantees.route",
  "authFoundation",
  "rbac.route",
  "workerAuthorization",
  "authRoutes.route",
  "securityBaseline.route",
  "security.route",
  "rateLimit.route",
  "uploadPath",
  "uploadStorage",
  "uploadIngestion.route",
  "providerRegistryLookup",
  "providerOverride.route",
  "errorSanitization.route",
  "requestContext.route",
  "correlationChain.integration",
  "logger",
  "workerGuard",
  "workerRetry",
  "startupChecks",
  "startupOrder",
  "httpClient.timeout",
  "audioMagicBytes",
  "fileStorage",
];

/**
 * FUNKCINIAI: viskas kita - tiekėjai, formatai, eilės, pagalbinės funkcijos.
 * Jie nėra „mažiau svarbūs", tik ne apie saugumą ar privatumą.
 */
const functional = [
  "concurrencyLimiter",
  "diarization.route",
  "fasterWhisperConcurrency",
  "fasterWhisperEmbedded",
  "fasterWhisperStream",
  "filterHallucinations",
  "generate.route",
  "groundingCheck",
  "health.route",
  "jobRunner",
  "jobRunnerBullmq",
  "jobStore",
  "jobStoreRedis",
  "jobs.route",
  "mergeDiarization",
  "mockLLMProvider",
  "prompt.snapshot",
  "protocolSchema",
  "runWorkerProcess",
  "transcribe.route",
  "transcribeJobs.route",
  "transcriptDedup",
  "workerHeartbeat",
];

module.exports = {
  suites: { privacy, security, functional, redis },

  /**
   * Rinkiniai, kuriuos apima `npm test`.
   *
   * `redis` NEĮEINA sąmoningai: be `REDIS_URL` tie testai save praleidžia, ir
   * įtraukus juos čia „3 skipped" taptų nuolatiniu triukšmu, kurį visi išmoktų
   * ignoruoti. Jie paleidžiami atskirai (`npm run test:redis`) ir CI.
   */
  defaultSuites: ["privacy", "security", "functional"],
};
