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
  "auditStoreFields",
  "auditKeyRing",
  "auditCursor",
  "auditQuery.route",
  "auditRotation",
  "auditStoreBackendContract.integration",
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
  /** CI workflow struktūra: dublikuotas raktas tyliai išjungtų testų žingsnį. */
  "workflowIntegrity",
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
  /**
   * #155, 7.4a: audito fasado async cutover.
   *
   * ⚠️ `auditAsyncCutover` tikrina POLITIKĄ (klasifikacija, timeout, skaitiklis,
   * `unhandledRejection`), o `auditBlockingRoutes.route` - kad produkcinis HTTP
   * kelias ja REALIAI naudojasi. Vienas be kito praeitų su fire-and-forget
   * kvietimu maršrute.
   */
  "auditAsyncCutover",
  "auditBlockingRoutes.route",
  /** #155, 7.3: bearer token'as, SHA-256 maiša ir uždara `schemaVersion` aibė. */
  "sessionTokenHash",
  /**
   * #155, 7.3: sesijų gedimo semantika per tikrą HTTP.
   *
   * ⚠️ 503 vs 401 skirtumas yra visa šio kriterijaus esmė: `catch { return
   * null; }` paverstų DB gedimą tyliu neautorizavimu.
   */
  "sessionAuthFailClosed.route",
  /**
   * #155, 7.3: sesijų backend'ų kontrakto ekvivalentumas.
   *
   * ⚠️ REGISTRUOTAS IR `postgres` RINKINYJE. `security` paleidžia atminties
   * adapterį kiekviename `npm test`; `postgres` - PostgreSQL adapterį su tikru
   * `DATABASE_URL`. Failas, likęs tik viename, tikrintų vieną backend'ą iš
   * dviejų, o divergencija būtų būtent ta, kurios niekas nemato.
   */
  "sessionStoreBackendContract.integration",
  /**
   * ⚠️ #155, 7.4b: TAS PATS DVIGUBAS REGISTRAVIMAS. `security` paleidžia audito
   * atminties adapterį kiekviename `npm test`; `postgres` - PostgreSQL adapterį.
   */
  "auditStoreBackendContract.integration",
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
  /**
   * #155, 7.2a: trijų backend'ų parinkimo politika ir aktyvavimo barjeras.
   * DB NEREIKIA - tikrinama politika, ne saugykla (žr. failo komentarą).
   */
  "jobStoreBackendSelection",
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

/**
 * PostgreSQL integraciniai testai (#155).
 *
 * Atskiras rinkinys dėl tos pačios priežasties kaip `redis`: be `DATABASE_URL`
 * jie save praleidžia, tad `npm test` sudėtyje virstų nuolatiniu „skipped"
 * triukšmu. CI paleidžia su `REQUIRE_POSTGRES=1`, kuris praleidimą paverčia
 * klaida.
 */
const postgres = [
  "migrations.integration",
  /** #155: PostgreSQL būsena doctor/health išvestyje. */
  "postgresDoctor.integration",
  /**
   * #155, 7.2a: trečias `jobStore` backend'as.
   *
   * ⚠️ TIKRAS PostgreSQL BŪTINAS, ne mock. Testuojami dalykai gyvena būtent
   * DB pusėje: `CHECK` constraint'ų `UNKNOWN` semantika, dalinio `UNIQUE`
   * indekso elgesys su `NULL` ir `ON DELETE CASCADE`. Su mock'u jie visi
   * praeitų nieko netikrindami.
   */
  "postgresStore.integration",
  /**
   * #155, 7.2a: DB CHECK aibės vs runtime autoritetai.
   *
   * ⚠️ Sąrašai IŠVEDAMI iš runtime konstantų, ne surašomi - naujas job tipas,
   * statusas ar fazė be atitinkamos migracijos krinta iškart, o ne po to, kai
   * sugadinta kopija bus įrašyta.
   */
  "dbRuntimeParity.integration",
  /**
   * ⚠️ REGISTRUOTAS ABIEJUOSE RINKINIUOSE (`redis` ir `postgres`).
   *
   * CI turi du atskirus žingsnius su skirtingomis priklausomybėmis
   * (`test:redis` su `REDIS_URL`, `test:postgres` su `DATABASE_URL`). Failas,
   * likęs tik `redis` rinkinyje, PostgreSQL žingsnyje NEBŪTŲ paleistas, o
   * `redis` žingsnyje `DATABASE_URL` nėra - tad 7.2b pridėtas PostgreSQL
   * adapteris pats save praleistų, ir CI tikrintų du backend'us iš trijų.
   *
   * PostgreSQL adapteris vykdomas šiame rinkinyje; Redis scenarijai šiame
   * žingsnyje teisėtai praleidžiami, nes `REDIS_URL` čia nėra.
   */
  "jobStoreBackendContract.integration",
  /** #155, 7.3: bendras sesijų scenarijų rinkinys - PostgreSQL adapteris. */
  "sessionStoreBackendContract.integration",
  /** #155, 7.4b: bendras audito scenarijų rinkinys - PostgreSQL adapteris. */
  "auditStoreBackendContract.integration",
  /**
   * #155, 7.4b: garantijos, kurių atmintyje NĖRA - schema, invariantai,
   * append-only trigeris, RAW eilučių privatumas, pool'o gyvavimo ciklas,
   * išlikimas po restarto ir kelių instancijų matomumas.
   */
  "auditPersistence.integration",
  /**
   * #155, 7.3: garantijos, kurių atmintyje NĖRA - hash-only saugojimas, DB
   * laiko invariantai, viena sąlyginė autentikacijos užklausa, revokacija
   * tarp procesų ir startinis suderinimas.
   */
  "sessionPersistence.integration",
];

module.exports = {
  suites: { privacy, security, functional, redis, postgres },

  /**
   * Rinkiniai, kuriuos apima `npm test`.
   *
   * `redis` NEĮEINA sąmoningai: be `REDIS_URL` tie testai save praleidžia, ir
   * įtraukus juos čia „3 skipped" taptų nuolatiniu triukšmu, kurį visi išmoktų
   * ignoruoti. Jie paleidžiami atskirai (`npm run test:redis`) ir CI.
   */
  defaultSuites: ["privacy", "security", "functional"],
};
