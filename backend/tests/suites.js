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
  "suiteDerivation",
  "auditReadiness.route",
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
/**
 * TESTAI, KURIEMS REIKIA TIKRO PostgreSQL - IŠVEDAMI, NE SURAŠOMI (#155, 7.4f / #231).
 *
 * ⚠️ RANKINIS SĄRAŠAS ČIA BUVO REALI SPRAGA.
 *
 * Naujas integracinis testas, kurio kas nors nepridėtų ranka, NIEKADA nebūtų
 * paleistas: `npm run test:postgres` jo nematytų, CI liktų žalias, o kodas -
 * nepatikrintas. Skirtingai nuo kitų rinkinių, čia klaida nematoma - failas
 * priklauso `privacy` ar `security`, tad manifesto pilnumo patikra nesiskundžia,
 * o vienintelis dalykas, kurio trūksta, yra vykdymas su tikra DB.
 *
 * ⚠️ KRITERIJUS - `postgresGuard` IMPORTAS, NE `.integration` VARDAS.
 *
 * Spec'as siūlė „vardas su `.integration` ARBA `postgresGuard` importas", bet
 * vardo kriterijus surenka ir REDIS integracinius testus (`actorEraRedis`,
 * `queueRecovery`, `ownershipCasRedis`...), kuriems PostgreSQL nereikia. Jie
 * postgres žingsnyje praleistų save dėl `REDIS_URL` trūkumo, ir vykdymo
 * įrodymas („kiekvienam failui bent vienas `ok`") kristų dėl testų, kurie ten
 * apskritai nepriklauso.
 *
 * `postgresGuard` importas yra TIKROJI priklausomybė ir duoda tiksliai tą aibę,
 * kuri anksčiau buvo surašyta ranka. Nuo naujo PG testo, pamiršusio guard'ą,
 * saugo atskira patikra `tests/suiteDerivation.test.js`: kiekvienas failas,
 * importuojantis `pg` arba guard'ą, privalo atsidurti šiame rinkinyje.
 *
 * ⚠️ VYKDYMO ĮRODYMAS ATSKIRAI. Sąrašo sudarymas neįrodo, kad testai pasileido:
 * su `REQUIRE_POSTGRES=1` kiekvienam rinkinio failui privalo pasirodyti bent
 * vienas `ok` (žr. `tests/suiteDerivation.test.js`). Žalias job'as su
 * praleistais testais nėra sėkmė.
 */
function isvestiPostgresRinkini() {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = __dirname;

  return fs
    .readdirSync(dir)
    .filter((failas) => failas.endsWith(".test.js"))
    .filter((failas) => {
      const turinys = fs.readFileSync(path.join(dir, failas), "utf8");
      return /require\((["'])[^"']*postgresGuard\1\)/.test(turinys);
    })
    .map((failas) => failas.replace(/\.test\.js$/, ""))
    .sort();
}

const postgres = isvestiPostgresRinkini();

module.exports = {
  suites: { privacy, security, functional, redis, postgres },

  /**
   * Rinkiniai, kuriuos apima `npm test`.
   *
   * `redis` NEĮEINA sąmoningai: be `REDIS_URL` tie testai save praleidžia, ir
   * įtraukus juos čia „3 skipped" taptų nuolatiniu triukšmu, kurį visi išmoktų
   * ignoruoti. Jie paleidžiami atskirai (`npm run test:redis`) ir CI.
   */
  isvestiPostgresRinkini,

  defaultSuites: ["privacy", "security", "functional"],
};
