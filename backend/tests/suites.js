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
  /**
   * #184 (7.5b): worker'io įėjimo kelio idempotentiškumas ir audio barjeras.
   *
   * TIKRAS BullMQ būtinas: patikra gyvena `createWorker()` processor'iaus viduje
   * ir be tikros eilės nepasiekiama. Vienetinis testas tikrintų atkartotą
   * sąlygos KOPIJĄ, o kopija ilgainiui nuo originalo išsiskiria.
   */
  "workerIdempotency.integration",
];

/**
 * PRIVATUMAS: asmens duomenų apsauga - redakcija, retencija, ištrynimas,
 * eksporto variantai, auditas be turinio.
 */
const privacy = [
  /** #155, 7.4d: persistentinė retencija ir `PRIVACY_MODE` postgres režime. */
  "auditRetention",
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
  /**
   * #216 (7.4e): audito ištrynimo galutinumas - barjeras prieš subjektui susietą
   * rašymą po ištrynimo. Eina TEN, KUR `auditErasure.service`: ta pati garantijų
   * šeima, tik iš kitos pusės - ana tikrina, kad ištrynimas RANDA įrašus, ši -
   * kad po jo naujų NEATSIRANDA.
   */
  "auditErasureFinality",
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
  /**
   * #155, 7.5a: persistentinės ištrynimo žymos. `revivalHorizons` čia, o ne
   * `functional`, sąmoningai - jo dalykas yra ne eilių konfigūracija, o
   * klausimas „kiek ilgai žyma privalo gyvuoti", t. y. ištrynimo garantija.
   */
  "erasureMarks",
  "revivalHorizons",
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
  /**
   * #237: ištrintų testų sargas.
   *
   * Eina TEN, KUR `workflowIntegrity` - abu gina ne funkciją, o patį patikrų
   * sluoksnį, ir abiem prasminga lūžti tame pačiame žingsnyje. `security`
   * pasirinktas dar ir todėl, kad `check-security-matrix.mjs` reikalauja
   * kiekvieną šio rinkinio failą paminėti matricoje - t. y. rinkinys PRIVERČIA
   * dokumentaciją, o ne pasikliauja atmintimi.
   */
  "deletedTestsGuard",
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
  /**
   * #202: `pythonGuard` elgsenos testai eina TEN, KUR VEIKIA PATS SARGAS.
   *
   * Failas testuoja ne funkcionalumą, o testų infrastruktūrą - repo tokio
   * rinkinio neturi (`suiteDerivation` yra `privacy`, `workflowIntegrity` -
   * `security`), tad rinktis reikia iš esamų. `functional` pasirinktas dėl
   * vienos konkrečios priežasties: būtent šį rinkinį CI paleidžia su
   * `REQUIRE_PYTHON=1`, tad sargo testai vykdomi TOJE pačioje aplinkoje, kurią
   * sargas ir valdo - o ne kitame žingsnyje, kur vėliavos nėra.
   */
  "pythonGuard",
  "fasterWhisperStream",
  "filterHallucinations",
  "generate.route",
  "groundingCheck",
  "health.route",
  "jobRunner",
  "jobRunnerBullmq",
  "jobStore",
  "jobStoreRedis",
  /**
   * #205 (7.2c): kanoninių tipų normalizavimas ir backend'ų paritetas.
   *
   * Eina TEN, KUR `jobStore` ir `jobStoreRedis` - tai to paties sluoksnio
   * elgsena. Memory ir Redis (per `FakeRedis`) pusė vykdoma be išorinių
   * servisų; PostgreSQL pusė gyvena `postgresStore.integration`, kur jau yra
   * veikianti DB infrastruktūra.
   */
  "jobStoreTypeNormalization",
  /**
   * #184 (7.5b): `jobs.version` optimistic lock pariteto pagrindas.
   *
   * Tas pats sluoksnis ir tos pačios priežastys kaip `jobStoreTypeNormalization`:
   * memory ir Redis (per `FakeRedis`) tikrinami be išorinių servisų, o PostgreSQL
   * pusė lieka `migrations.integration` / `postgresStore.integration`, kur DB
   * realiai yra.
   */
  /**
   * #184 (7.5b): konflikto kontraktas — penkios atskiriamos baigtys.
   *
   * Memory ir fasado pusė be išorinių servisų; PostgreSQL klasifikacija lieka
   * `postgresStore.integration`, Redis Lua CAS — `ownershipCasRedis.integration`.
   */
  "jobConflictContract",
  /**
   * #184 (7.5b): atominis ir idempotentiškas `finish(COMPLETED)`.
   *
   * Kanoninė lygybė ir trys `completed` baigtys tikrinamos be servisų; `jsonb`
   * round-trip, transakcijos atomiškumas ir lenktynės - `postgresStore.integration`,
   * worker'io įėjimo kelias - `workerIdempotency.integration` (`redis`).
   */
  "jobFinishIdempotency",
  /**
   * #248 (7.6a): šifruotos PostgreSQL kopijos KONTRAKTAS be DB.
   *
   * Dydžio riba, rūšies antraštė ir D2 sargas („operatoriaus kelias neturi savo
   * orkestracijos") tikrinami be išorinių servisų. Pati procedūra —
   * `pgDumpBackup.integration`, kuris reikalauja ir tikros DB, ir `pg_dump`
   * binaro, tad išvedamas į `postgres` rinkinį per `postgresGuard` importą.
   */
  "pgDumpBackupContract",
  /**
   * #249 (7.6b): post-restore suderinimo KONTRAKTAS be DB.
   *
   * Fail-closed sargai (`RECONCILE_*`), terminalizavimo patch'o KILMĖ iš
   * `jobPhase` autoriteto, praleidimo predikatas ir CLI exit kodai tikrinami be
   * išorinių servisų — su padirbtu DB klientu, ne su mock'intu `jobPhase`.
   *
   * Persistentinė būsena, transakcijos atsukimas ir realus auth kelias su senais
   * cookie gyvena `postRestoreReconcile.integration`, kuris išvedamas į
   * `postgres` rinkinį per `postgresGuard` importą.
   */
  "postRestoreReconcileContract",
  /**
   * #250 (7.6c): erasure-safe atkūrimo KONTRAKTAI be DB.
   *
   * `erasureExportContract` — suliejimo taisyklė ir artefakto sargai (gryna
   * logika); `erasureReplayContract` — replay elgesys su TIKRAIS atminties
   * saugyklos keliais (`jobStore`, `deletionTombstones`, `jobErasure`), kur
   * įrodoma, kad replay pašalina job'ą ten, kur `lifecycleService` jo palieka;
   * `drCoordinatorContract` — sekos raktai ir pasenusio žurnalo override abiem
   * pėdsako laikmenomis.
   *
   * Persistavimas, transakcijos ir pilna DR seka su tikru `pg_restore` gyvena
   * `drRestore.integration`, kuris išvedamas į `postgres` rinkinį.
   */
  "drCoordinatorContract",
  /**
   * #250: `drRestore.integration` APLINKOS prielaidos, tikrinamos VIETOJE.
   *
   * Trys CI raundai iš eilės krito ne ties DR elgesiu, o ties aplinka
   * (`AUDIT_ID_SALT`, sesijos forma, base64 raktas vietoj hex). Šis testas tą
   * patį klausimą užduoda per sekundes, prieš nepasiekiamą bazę.
   */
  "drRestorePreconditions",
  /**
   * #157 (PR-2): `ArtifactStore` kontraktas ir klaidų klasifikavimas.
   *
   * `artifactStoreContract` paleidžia BENDRĄ scenarijų rinkinį prieš `fs` — jam
   * nereikia nei DB, nei tinklo, tad kontrakto pažeidimas matomas per sekundes.
   * Tas pats rinkinys prieš `inline` ir `s3` gyvena integraciniuose failuose.
   */
  "artifactStoreContract",
  "artifactStoreErrors",
  /**
   * #157 (PR-2): S3 sprendimai, tikrinami BE tinklo.
   *
   * Trys dalykai neįrodomi prieš tikrą MinIO: `NoSuchBucket` klaidos ji pagal
   * užsakymą neduoda, versijuoto kibiro CI'uje nekuriame, o checksum nustatymų
   * pašalinimo pririšta versija NESULAUŽO (išmatuota). Vietinis testas juos
   * padengia deterministiškai.
   */
  "artifactStoreS3Config",
  "erasureExportContract",
  "erasureReplayContract",
  "jobVersionParity",
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
/**
 * Failo `require()` argumentai.
 *
 * ⚠️ VIENAS PRAĖJIMAS SIMBOLIAIS, NE REGEX GRANDINĖ (#233 Codex raundas 2, #1).
 *
 * Ankstesnė versija komentarus nuimdavo PRIEŠ atpažindama literalus. Tvarka
 * neteisinga iš principo: komentaro ir literalo atpažinimas yra tarpusavyje
 * priklausomas, tad regex grandinė lūžta ABIEM kryptimis, ir abi buvo realios:
 *
 *   1. `'// require("./helpers/postgresGuard");'` - eilutė, ne komentaras. Iš
 *      jos nuimtas „komentaras" nuplėšia uždarančią kabutę, ir skeneris randa
 *      importą, kurio nėra. Šitaip `suiteDerivation` ĮKRITO į postgres rinkinį -
 *      dėl savo paties sintetinio testo duomenų.
 *   2. `const marker = '//'; require('./helpers/postgresGuard')` - čia `//` yra
 *      eilutėje, bet senoji versija nuo jos nuplėšdavo likusią eilutę kartu su
 *      TIKRU importu. Realus PostgreSQL testas tyliai iškristų iš CI.
 *
 * Todėl einama simboliais su būsena: kodas, `'`/`"`/`` ` `` literalas, eilutės
 * komentaras, bloko komentaras, reguliarusis reiškinys. Pilno JS parserio
 * nereikia - reikia tik teisingos atpažinimo tvarkos.
 *
 * ⚠️ REGULIARIEJI REIŠKINIAI ATPAŽĮSTAMI SĄMONINGAI. Testų failuose pilna
 * šablonų su kabutėmis (`/["']/`). Be šito pirmoji tokio šablono kabutė
 * pradėtų „eilutę", kuri surytų kodą iki kitos kabutės - kartu su tikrais
 * importais. Tai ta pati 2 klaida, tik kita priežastimi.
 *
 * ⚠️ Šablonas NEKONSTRUOJAMAS iš kintamųjų (CodeQL): grąžinami visi importai, o
 * kvietėjas lygina eilutes.
 *
 * RIBOS, kurias verta žinoti: šablonine eilute su `${...}`, kurioje yra dar
 * viena atgalinė kabutė, tokenizatorius suklystų; tokio kodo repozitorijoje
 * nėra, o `pg` naudojimo patikra `suiteDerivation.test.js` dengia tą kelią
 * nepriklausomai.
 */
function importuotiModuliai(saltinis) {
  const literalai = [];
  let skeletas = "";
  let i = 0;
  let pries = "";

  /** Po identifikatoriaus, skaičiaus ar uždarančio skliausto `/` yra dalyba. */
  const PO_REIKSMES = /[\w$)\]]/;

  while (i < saltinis.length) {
    const c = saltinis[i];
    const kitas = saltinis[i + 1];

    if (c === "/" && kitas === "/") {
      while (i < saltinis.length && saltinis[i] !== "\n") i += 1;
      skeletas += " ";
      continue;
    }

    if (c === "/" && kitas === "*") {
      i += 2;
      while (i < saltinis.length && !(saltinis[i] === "*" && saltinis[i + 1] === "/")) i += 1;
      i += 2;
      skeletas += " ";
      continue;
    }

    if (c === "/" && !PO_REIKSMES.test(pries)) {
      i += 1;
      let simboliuKlase = false;
      while (i < saltinis.length) {
        const r = saltinis[i];
        if (r === "\\") {
          i += 2;
          continue;
        }
        if (r === "\n") break;
        if (r === "[") simboliuKlase = true;
        else if (r === "]") simboliuKlase = false;
        else if (r === "/" && !simboliuKlase) {
          i += 1;
          break;
        }
        i += 1;
      }
      skeletas += " ";
      /** Po šablono einantis `/` yra dalyba, ne naujas šablonas. */
      pries = ")";
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      const kabute = c;
      let turinys = "";
      i += 1;
      while (i < saltinis.length) {
        const r = saltinis[i];
        if (r === "\\") {
          turinys += saltinis[i + 1] === undefined ? "" : saltinis[i + 1];
          i += 2;
          continue;
        }
        if (r === kabute) {
          i += 1;
          break;
        }
        /** Nebaigtas vienos eilutės literalas - nutraukiam, kad nesurytume failo. */
        if (kabute !== "`" && r === "\n") break;
        turinys += r;
        i += 1;
      }
      skeletas += ` ${literalai.length} `;
      literalai.push(turinys);
      pries = ")";
      continue;
    }

    skeletas += c;
    if (!/\s/.test(c)) pries = c;
    i += 1;
  }

  const rasti = [];
  const sablonas = /require\s*\(\s* (\d+) \s*\)/g;

  let atitikmuo = sablonas.exec(skeletas);
  while (atitikmuo !== null) {
    rasti.push(literalai[Number(atitikmuo[1])]);
    atitikmuo = sablonas.exec(skeletas);
  }

  return rasti;
}

/**
 * ⚠️ RINKINYS IŠVEDAMAS IŠ SARGO IMPORTO, NE RAŠOMAS RANKA.
 *
 * Rankinis sąrašas leistų naujam integraciniam testui iškristi tyliai: jis
 * nebūtų paleistas, CI liktų žalias, o kodas — nepatikrintas. Ta pati taisyklė
 * galioja abiem infrastruktūroms, tad išvedimas parametrizuotas, o ne
 * nukopijuotas (#157, PR-2).
 */
function isvestiRinkini(sargas) {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = __dirname;

  return fs
    .readdirSync(dir)
    .filter((failas) => failas.endsWith(".test.js"))
    .filter((failas) => {
      const turinys = fs.readFileSync(path.join(dir, failas), "utf8");
      return importuotiModuliai(turinys).some((kelias) => kelias.endsWith(sargas));
    })
    .map((failas) => failas.replace(/\.test\.js$/, ""))
    .sort();
}

function isvestiPostgresRinkini() {
  return isvestiRinkini("postgresGuard");
}

const postgres = isvestiPostgresRinkini();

/**
 * ⚠️ S3 RINKINYS ATSKIRAS NUO `postgres`, NORS ABU INTEGRACINIAI.
 *
 * Jie reikalauja SKIRTINGOS infrastruktūros: `postgres` žingsnis turi
 * `DATABASE_URL`, S3 — `MINIO_ENDPOINT`. Sujungus, vienas trūkstamas servisas
 * paverstų kito garantiją praleidimu, o „rinkinys tikrai vykdytas" sargas
 * nebegalėtų pasakyti, KURIO trūko.
 */
const s3 = isvestiRinkini("minioGuard");

module.exports = {
  suites: { privacy, security, functional, redis, postgres, s3 },

  /**
   * Rinkiniai, kuriuos apima `npm test`.
   *
   * `redis` NEĮEINA sąmoningai: be `REDIS_URL` tie testai save praleidžia, ir
   * įtraukus juos čia „3 skipped" taptų nuolatiniu triukšmu, kurį visi išmoktų
   * ignoruoti. Jie paleidžiami atskirai (`npm run test:redis`) ir CI.
   */
  isvestiPostgresRinkini,
  isvestiRinkini,
  importuotiModuliai,

  defaultSuites: ["privacy", "security", "functional"],
};
