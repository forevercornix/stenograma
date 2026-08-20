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
const redis = [
  "queueRecovery.integration",
  "heartbeatReadiness.integration",
  "redisConcurrency.integration",
  /**
   * #158: trijų erų maršrutizavimas. Objektai atmintyje šito neatskleidžia -
   * `schemaVersion` per Redis grįžta kaip string, ir be tipo konversijos
   * kiekvienas job'as tyliai atrodytų kaip legacy.
   */
  "actorEraRedis.integration",
  /**
   * #159: nuosavybės CAS. Objektuose atmintyje lenktynių lango nėra – jis
   * atsiranda tik tarp Redis `get()` ir `eval()`.
   */
  "ownershipCasRedis.integration",
  /** Backend'ų kontrakto ekvivalentumas – #155 pridės trečią realizaciją. */
  "jobStoreBackendContract.integration",
  /** #154: atominis progreso CAS – TOCTOU lango uždarymas. */
  "jobPhaseCasRedis.integration",
  /**
   * #153: rezultato riba TIKRAME BullMQ worker kelyje. Statinis sargas
   * `resultLimits` rinkinyje praeitų ir su `if (false)` – šis testas tikrina
   * ELGESĮ, o BullMQ yra produkcijos kelias, kuris po #155 rašys į DB.
   */
  "resultLimitsWorker.integration",
];

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
  "incidentRunbook",
  "operationalProcedures",
  "postmortemTemplate",
  "providerGovernance",
  "providerEnforcement",
  "providerBypassGuards",
  "qualityMetrics",
  "pilotCharter",
  "protocolRubric",
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
  /** #196: nepavykę ištrynimo bandymai apskaitomi net kritus saugyklai. */
  "deletionRetryPersistence",
  /** #159: nuosavybės filtras ir privilegijuoto namespace'o riba. */
  "jobOwnership",
  "systemNamespaceBoundary",
  /** #160: prieigos politika – gryna funkcija, be store'o ir HTTP. */
  "jobAccessPolicy",
  /** #160: administracinis override – vienintelė privilegijuota vieta. */
  "adminJobService",
  /** #160: politikos → HTTP adapteris (vienas visiems maršrutams). */
  "jobAccessTransport",
  /** #153: rezultatų ir artefaktų dydžio ribos (apsauga IŠĖJIME). */
  "resultLimits",
  /** #154: fazių ir progreso state machine – gryna, be store ir HTTP. */
  "jobPhase",
  /** #154: fazių kontraktas per store – invariantai ir pavėlavę įvykiai. */
  "jobPhaseStore",
  /** #154: fazės realiame pipeline – onPhase blokuoja, onProgress ne. */
  "jobPhasePipeline",
  /** #154: terminalūs, retry ir recovery keliai. */
  "jobPhaseTerminal",
  /** #154: fazės HTTP atsakyme – vienodas kontraktas abiejuose endpoint'uose. */
  "jobPhaseApi",
  /** #154: dokumentacija, kuri negali išsiskirti su kodu. */
  "jobLifecycleDocumentation",
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
