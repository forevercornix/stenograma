require("dotenv").config();
const express = require("express");

const generateRoute = require("./routes/generate");
const transcribeRoute = require("./routes/transcribe");
const transcribeJobsRoute = require("./routes/transcribeJobs");
const auditRoute = require("./routes/audit");
const exportsRoute = require("./routes/exports");
const jobsRoute = require("./routes/jobs");
const authRoute = require("./routes/auth");
/**
 * ⚠️ MODULIO LYGYJE, ne `startServer()` viduje: `/api/ready` zondas kviečia
 * `sessionStore.probe()` KIEKVIENOS užklausos metu, tad nuoroda turi egzistuoti
 * ir tada, kai `startServer()` šiame procese nevykdomas (testai, embedded).
 */
const sessionStore = require("./utils/sessionStore");
const auditStore = require("./utils/auditStore");
const deletionTombstones = require("./utils/deletionTombstones");
const jobStore = require("./utils/jobStore");
const jobRunner = require("./queues/jobRunner");
const { validateConfig, runSelfChecks } = require("./utils/startupChecks");
const { pollRateLimiter, generalApiLimiter } = require("./middleware/rateLimiter");
const { initPrivacyPolicy } = require("./utils/privacyPolicy");
const { requestContextMiddleware } = require("./utils/requestContext");
const { applySecurityBaseline } = require("./utils/securityBaseline");
const { createLogger } = require("./utils/logger");

const log = createLogger("server");

// KIETA konfigūracijos validacija (vartotojo prašymas po realaus diegimo: "jei
// kažko trūksta - aiškiai parašyti ir nestartuoti", o ne griūti pirmoje užklausoje).
// Testų aplinkoje (mock provideriai) klaidų nebūna, tad testai nepaveikiami.
if (process.env.SKIP_CONFIG_VALIDATION !== "true") {
  // Politika sukuriama VIENĄ kartą ir nuo čia yra vienintelis šaltinis visiems
  // komponentams (GDPR #5 DoD). Bloga konfigūracija = serveris nestartuoja.
  initPrivacyPolicy();


  const { errors, warnings } = validateConfig();
  for (const w of warnings) log.warn(`⚠️  ${w}`);
  if (errors.length > 0) {
    log.error("❌ Konfigūracijos klaidos - serveris NESTARTUOJA:");
    for (const e of errors) log.error(`❌ ${e}`);
    log.error("Pataisykite .env (žr. .env.example komentarus) arba, kraštutiniu atveju, SKIP_CONFIG_VALIDATION=true.");
    if (require.main === module) process.exit(1);
    throw new Error("Konfigūracijos validacija nepavyko: " + errors.join(" | "));
  }
}

const app = express();

/**
 * PIRMAS middleware: request ID turi egzistuoti dar prieš CORS, rate limitą ir
 * maršrutus - kad ir atmesta užklausa turėtų identifikatorių (GDPR #17).
 */
app.use(requestContextMiddleware);

/**
 * SAUGUMO BAZĖ (#14): trust proxy, saugumo antraštės, CORS allow-list, kūno
 * limitai. Viskas viename modulyje ir PRIEŠ maršrutus - kad naujas endpointas
 * bazę gautų automatiškai, o ne tada, kai kas nors prisimena ją pridėti.
 * Žr. utils/securityBaseline.js.
 */
applySecurityBaseline(app);

// Bendra riba VISIEMS /api maršrutams; griežtesnės lieka atskiruose endpointuose.
app.use("/api", generalApiLimiter);

// Readiness sekimas: /api/health yra LIVENESS (procesas gyvas ir atsako). Job store/
// runner init užbaigiamas PRIEŠ app.listen (žr. startServer), tad kai serveris priima
// užklausas, readiness jau true. Šie flag'ai + requireJobSystemReady middleware yra
// DEFENSE-IN-DEPTH: jei kada startup keistųsi (init po listen), job endpointai vis tiek
// grąžintų 503, ne kurtų jobų nesuderintoje sistemoje.
/**
 * ⚠️ TREČIA VĖLIAVA: `sessionReconcile` (#155, 7.3).
 *
 * Startinis sesijų suderinimas su `AUTH_USERS` yra READINESS BARJERAS, ne fono
 * darbas: tame lange persistentinė sesija su ATŠAUKTA role dar autorizuotų
 * užklausas. Vėliavos AUTORITETAS yra `sessionStore.isReady()` - čia laikoma
 * kopija skirta `/api/ready` išvesčiai.
 */
const readiness = {
  jobStore: false,
  jobRunner: false,
  sessionReconcile: false,
  auditStore: false,
  deletionTombstones: false,
};
app.locals.readiness = readiness; // route failai gali tikrinti be ciklinės priklausomybės

function requireJobSystemReady(req, res, next) {
  if (!readiness.jobStore || !readiness.jobRunner) {
    return res.status(503).json({ error: "Job sistema dar inicializuojama. Bandykite dar kartą po kelių sekundžių." });
  }
  next();
}

/**
 * Kopijų endpoint'ai (#20 PR4) – registruojami tik jei kopijos ĮJUNGTOS.
 *
 * Neįjungus jų maršruto apskritai nėra: administracinis endpointas, kuris
 * egzistuoja „tik grąžina 503", vis tiek yra atakos paviršius.
 */
if (require("./utils/backupPolicy").isEnabled()) {
  app.use("/api", require("./routes/backup"));
}

app.use("/api", authRoute);
app.use("/api", generateRoute);
app.use("/api", transcribeRoute);
app.use("/api", auditRoute);
app.use("/api", exportsRoute);
// requireJobSystemReady prijungtas per konkretų POST kelią (ne bendrą /api), kad
// NEliestų /api/health ir /api/ready (kurie apibrėžti žemiau).
app.post("/api/transcribe-jobs", requireJobSystemReady);
app.post("/api/jobs", requireJobSystemReady);
app.use("/api", transcribeJobsRoute);
app.use("/api", jobsRoute);

/**
 * REALAUS READINESS PATIKRA (CodeQL js/missing-rate-limiting).
 *
 * BullMQ režime kiekviena užklausa atidaro Redis ryšį (createQueueConnection +
 * ping + quit) - būtent dėl to endpointas ribojamas `pollRateLimiter` (120/min),
 * o riba parinkta plati sąmoningai: /api/ready yra Docker/K8s probe, ir 429
 * orkestruotojui reikštų nesveiką konteinerį.
 *
 * KEŠO ČIA NĖRA, ir tai sąmoningas sprendimas. Pirmoji šio pataisymo versija
 * kešavo rezultatą 2 s ir sulaužė `tests/heartbeatReadiness.integration.test.js`:
 * worker'iui mirus /api/ready dar dvi sekundes tvirtino "200 OK". Readiness,
 * kuris vėluoja, yra blogesnis už readiness, kuris kainuoja - orkestruotojas
 * tuo metu siųstų srautą į konteinerį be gyvo worker'io.
 *
 * Tikras sprendimas būtų VIENAS ilgaamžis Redis ryšys vietoj naujo kiekvienai
 * užklausai (šviežia informacija be TCP/auth kainos), bet tam reikia švaraus
 * uždarymo srauto ir paleidimo su tikru Redis - atskiras darbas.
 */
const { requirePositiveInt } = require("./utils/securityBaseline");

// Netinkama reikšmė čia reikštų NaN timeout - t. y. momentinį nutrūkimą, kuris
// atrodytų kaip pakibęs Redis. Geriau aiški startup klaida.
const READINESS_TIMEOUT_MS = requirePositiveInt(process.env, "READINESS_TIMEOUT_MS", 2000, {
  min: 100,
  max: 60_000,
});

/**
 * Laukia pažado, bet ne ilgiau nei nurodyta.
 *
 * Redis klientas turi savo timeout'us, bet jie taikomi ryšiui, ne komandai -
 * pakibusi komanda pakibtų kartu su užklausa.
 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Readiness timeout (${label}, ${ms} ms)`)), ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function probeRuntimeReadiness() {
  let redisReachable = true;
  let workers = { transcription: true, protocol: true };

  /**
   * SESIJŲ AUTORITETO GYVA BŪSENA (#155, 7.3; #181 „SESSION STORE GEDIMAS").
   *
   * ⚠️ `readiness.sessionReconcile` YRA STARTO VĖLIAVA, NE SVEIKATA. Ji
   * užsidega kartą ir nebekinta. Nukritus DB po starto, sesijų middleware
   * grąžina 503 kiekvienai cookie autentikuotai užklausai, o `/api/ready` be
   * šio zondo toliau sakytų 200 - orkestruotojas laikytų konteinerį sveiku ir
   * siųstų į jį srautą, kuriame neveikia autentikacija.
   *
   * ⚠️ FAIL-CLOSED PAGAL NUTYLĖJIMĄ: `false` tampa `true` TIK po sėkmingo ir
   * laiku grąžinusio zondo. Atminties režime zondas visada teigiamas, tad
   * elgesys nesikeičia.
   *
   * Riba ta pati kaip Redis keliui - readiness privalo atsakyti VISADA, net jei
   * priklausomybė kabo (žr. `withTimeout` komentarą žemiau).
   */
  let sessionStoreReachable = false;
  try {
    sessionStoreReachable = await withTimeout(
      sessionStore.probe(),
      READINESS_TIMEOUT_MS,
      "sesijų saugykla"
    );
  } catch {
    sessionStoreReachable = false;
  }

  /**
   * AUDITO AUTORITETO GYVA BŪSENA (#155, 7.4f / #231).
   *
   * ⚠️ `readiness.auditStore` YRA STARTO VĖLIAVA, NE SVEIKATA - lygiai kaip
   * `sessionReconcile`. DB kritimas ar teisių atėmimas PO starto ja nesimato, o
   * instancija toliau priima audito generuojančias užklausas (pvz.
   * prisijungimus), kurių blokuojantis auditas kris su `AUDIT_WRITE_FAILED`.
   *
   * ⚠️ ZONDAS TIKRINA TEISES, ne vien ryšį - žr. `auditStore/postgresStore.js`.
   * Atminties režime jis visada teigiamas, tad elgesys nesikeičia.
   */
  let auditStoreReachable = false;
  try {
    auditStoreReachable = await withTimeout(
      auditStore.probe(),
      READINESS_TIMEOUT_MS,
      "audito saugykla"
    );
  } catch {
    auditStoreReachable = false;
  }

  /**
   * ⚠️ IŠTRYNIMO ŽYMŲ ZONDAS (#155, 7.5a / #183).
   *
   * Be jo instancija su nustatytu `DATABASE_URL` ir nepasiekiama DB (arba be
   * migracijos) startuodavo, praneštų `ready` ir priimtų job'us, o gedimą
   * aptiktų tik pirmo `isDeleted()` metu - jau vykdydama darbą, kurį barjeras
   * turėjo sustabdyti. Ta pati forma kaip 7.4f `readiness.auditStore`.
   */
  let tombstonesReachable = false;
  try {
    tombstonesReachable = await withTimeout(
      deletionTombstones.probe(),
      READINESS_TIMEOUT_MS,
      "ištrynimo žymos"
    );
  } catch {
    tombstonesReachable = false;
  }

  /**
   * ⚠️ NEIŠSPRENDŽIAMOS GENERACIJOS → NOT READY, NORS PROCESAS PAKILO.
   *
   * `AUDIT_ALLOW_UNRESOLVABLE_KEY_GENERATIONS=true` leidžia STARTUOTI, kad
   * operatorius turėtų langą išvalyti senas eilutes. Bet sveikatos ji
   * nedeklaruoja: tų įrašų `removeBySubjectIdentifier()` nepasiekia, tad
   * instancija negali būti laikoma paruošta srautui.
   *
   * ⚠️ LIVENESS (`/api/health`) LIEKA 200. Priešingu atveju orkestruotojas
   * perkraudinėtų podą cikle, ir atsistatymo langas, dėl kurio vėliavėlė
   * egzistuoja, niekada neatsivertų - ji būtų paneigta.
   */
  const nasliaites = auditStore.nasliaitesGeneracijos();
  const auditKeysResolvable = nasliaites.length === 0;

  if (jobRunner.getMode && jobRunner.getMode() === "bullmq") {
    let conn = null;
    try {
      const { createQueueConnection } = require("./queues/config");
      const { getWorkerStatus } = require("./utils/workerHeartbeat");
      conn = createQueueConnection();

      /**
       * RIBOTAS LAUKIMAS (#14: „Readiness Redis operations have a bounded timeout").
       *
       * Be jo pakibęs Redis pakabina ir `/api/ready`: orkestruotojas vietoj
       * aiškaus 503 gauna timeout, o konteineris kabo „tikrinamas" būsenoje.
       * Readiness turi atsakyti VISADA - net jei atsakymas yra „neparuošta".
       */
      await withTimeout(conn.ping(), READINESS_TIMEOUT_MS, "redis ping");
      workers = await withTimeout(getWorkerStatus(conn), READINESS_TIMEOUT_MS, "worker status");
    } catch {
      redisReachable = false;
    } finally {
      if (conn) await conn.quit().catch(() => {});
    }
  }

  return {
    redisReachable,
    workers,
    sessionStoreReachable,
    auditStoreReachable,
    auditKeysResolvable,
    tombstonesReachable,
  };
}

app.get("/api/ready", pollRateLimiter, async (req, res) => {
  /**
   * ⚠️ `auditStore` ĮTRAUKTAS Į `initReady` (#155, 7.4f / #231).
   *
   * Iki tol čia buvo tik `jobStore && jobRunner && sessionReconcile`. Kritus
   * `auditStore.init()` serveris grąžindavo 200 ir priimdavo srautą - t. y.
   * fail-closed audito apsauga, dėl kurios startas ir nutraukiamas, būdavo
   * apeinama readiness lygyje.
   */
  const initReady =
    readiness.jobStore &&
    readiness.jobRunner &&
    readiness.sessionReconcile &&
    readiness.auditStore &&
    readiness.deletionTombstones;
  if (!initReady) {
    return res.status(503).json({
      ready: false,
      components: {
        jobStore: readiness.jobStore,
        jobRunner: readiness.jobRunner,
        sessionReconcile: readiness.sessionReconcile,
        auditStore: readiness.auditStore,
        deletionTombstones: readiness.deletionTombstones,
      },
    });
  }

  // BullMQ režime init flag'ai NEUŽTENKA - jie tik reiškia "režimas pasirinktas". Realiam
  // readiness tikrinam: (a) ar Redis pasiekiamas (queue.add nepakibtų), (b) ar ABU
  // worker TIPAI gyvi (heartbeat raktai šviežias KIEKVIENAM atskirai - transkripcijos
  // ir protokolo worker'iai gali būti ATSKIRI procesai/konteineriai, žr.
  // utils/workerHeartbeat.js) - kitaip jobai būtų priimami, bet liktų queued, nes
  // niekas jų neapdoroja. Inline režime nieko papildomo (viskas tame pačiame procese).
  const {
    redisReachable,
    workers,
    sessionStoreReachable,
    auditStoreReachable,
    auditKeysResolvable,
    tombstonesReachable,
  } = await probeRuntimeReadiness();
  const workerAlive = workers.transcription && workers.protocol;

  const ready =
    initReady &&
    redisReachable &&
    workerAlive &&
    sessionStoreReachable &&
    auditStoreReachable &&
    auditKeysResolvable &&
    tombstonesReachable;

  res.status(ready ? 200 : 503).json({
    ready,
    components: {
      jobStore: readiness.jobStore,
      jobRunner: readiness.jobRunner,
      sessionReconcile: readiness.sessionReconcile,
      auditStore: readiness.auditStore,
      deletionTombstones: readiness.deletionTombstones,
      redisReachable, // BullMQ režime rodo realų Redis ryšį; inline - visada true
      workerAlive,    // BullMQ režime: true TIK jei ABU worker tipai gyvi; inline - visada true
      workers,        // detali būsena PER TIPĄ - kuri konkrečiai eilė (jei kuri) neturi gyvo worker'io
      sessionStoreReachable, // GYVA sesijų autoriteto būsena; atmintyje - visada true
      auditStoreReachable,   // GYVA audito saugyklos būsena su TEISIŲ patikra; atmintyje - visada true
      /**
       * ⚠️ STARTO MOMENTO SNAPSHOT'AS, ne gyva būsena. `false` reiškia, kad
       * procesas pakilo su `AUDIT_ALLOW_UNRESOLVABLE_KEY_GENERATIONS=true`, ir
       * dalies įrašų GDPR ištrynimas nebepasiekia. Generacijų sąrašas ČIA
       * NERODOMAS - jis yra `hash_key_id` etikečių aibė, o readiness atsakymas
       * yra viešesnis nei logai.
       */
      auditKeysResolvable,
      /** GYVA ištrynimo žymų būsena su TEISIŲ patikra; atmintyje - visada true. */
      tombstonesReachable,
    },
  });
});

app.get("/api/health", pollRateLimiter, (req, res) => {
  const healthDetailsMode = (process.env.HEALTH_DETAILS || "").toLowerCase();
  const isProduction = process.env.NODE_ENV === "production";

  // HEALTH_DETAILS=public priverstinai rodo detales; =hidden priverstinai slepia;
  // jei nenustatyta, sprendžia NODE_ENV (production => slepiama pagal nutylėjimą).
  let showDetails;
  if (healthDetailsMode === "public") showDetails = true;
  else if (healthDetailsMode === "hidden") showDetails = false;
  else showDetails = !isProduction;

  // Net kai numatyta slėpti, teisingas x-audit-key vis tiek atskleidžia detales
  // (patogu stebėti produkcinį deploy'ą neatskleidžiant infrastruktūros viešai).
  if (!showDetails && process.env.AUDIT_API_KEY && req.header("x-audit-key") === process.env.AUDIT_API_KEY) {
    showDetails = true;
  }

  if (!showDetails) {
    return res.json({ status: "ok" });
  }

  const { describeForDiagnostics } = require("./utils/privacyConfig");

  res.json({
    status: "ok",
    transcriptionProvider: process.env.TRANSCRIPTION_PROVIDER || "mock",
    diarizationProvider: process.env.DIARIZATION_PROVIDER || "none",
    llmProvider: process.env.LLM_PROVIDER || "mock",
    // Efektyvios privatumo nuostatos (GDPR #5 DoD: "visible through diagnostics").
    // Be paslapčių - tik profilis, ar leidžiami išoriniai tiekėjai ir retencija.
    privacy: describeForDiagnostics(),
  });
});

/**
 * GILUS health patikrinimas - realiai tikrina kiekvieno komponento pasiekiamumą
 * (Python importas, pyannote/whisper serverių HTTP, raktų buvimas), ne tik
 * grąžina konfigūraciją. Naudinga diegiant ir enterprise monitoringui.
 * Apsaugotas ta pačia detalių slėpimo logika kaip /api/health (production'e
 * infrastruktūros detalės neatskleidžiamos be x-audit-key).
 */
/**
 * Gilus health vykdo REALIAS patikras (tiekėjų pasiekiamumas, Redis), tad be
 * ribojimo jis yra brangiausias neautentifikuotas kelias sistemoje - tiksliai
 * tai, ko #14 reikalauja išvengti.
 */
app.get("/api/health/deep", pollRateLimiter, async (req, res) => {
  const isProduction = process.env.NODE_ENV === "production";
  const authorized = process.env.AUDIT_API_KEY && req.header("x-audit-key") === process.env.AUDIT_API_KEY;
  if (isProduction && !authorized) {
    return res.status(403).json({ error: "Gilus health production'e reikalauja x-audit-key antraštės." });
  }
  const checks = await runSelfChecks();
  const allOk = checks.every((c) => c.ok);
  res.status(allOk ? 200 : 503).json({
    status: allOk ? "ok" : "degraded",
    checks: checks.map(({ name, ok, detail }) => ({ name, ok, detail })),
  });
});

// KRITIŠKA (race apsauga): infrastruktūrą (jobStore + jobRunner) inicijuojam PILNAI PRIEŠ
// app.listen. Anksčiau listen startuodavo pirmas, o init vyko async po jo - tad ankstyva
// HTTP užklausa galėjo laimėti race per lazy ensureInit ir sukurti memory+BullMQ
// nesuderinimą. Init prieš listen tai UŽDARO. Funkcija iškelta (su injektuojamu listen)
// dėl testuojamumo - regresinis testas tikrina kvietimų TVARKĄ (store->runner->listen).
async function startServer({ port, listen, onStep } = {}) {
  // STALE ĮKĖLIMŲ VALYMAS (#13). Čia, o ne modulio lygyje: reikia `await`, o
  // CommonJS top-level await neleidžia. Ir semantiškai teisinga - valymas turi
  // baigtis PRIEŠ priimant naujus įkėlimus, kitaip valytojas ir naujas įkėlimas
  // varžytųsi dėl to paties katalogo.
  try {
    const { purgeStaleUploads } = require("./utils/uploadPath");
    const { removed } = await purgeStaleUploads();
    if (removed > 0) {
      log.info(`Paleidimas: pašalinta ${removed} likusių laikinų įkėlimo failų.`);
    }
  } catch (e) {
    // Valymo klaida NEGALI sustabdyti paleidimo - tai higiena, ne kritinis kelias.
    log.warn("Nepavyko išvalyti likusių laikinų įkėlimo failų:", e.message);
  }

  const PORT = port || process.env.PORT || 3001;
  const doListen = listen || ((p) => new Promise((resolve) => app.listen(p, resolve)));
  const step = (name) => { if (typeof onStep === "function") onStep(name); };

  const { registerProcessors } = require("./queues/register");
  registerProcessors();

  // 1. Job store (Redis jei REDIS_URL ir connect pavyksta, kitaip in-memory fallback).
  await jobStore.init();
  step("jobStore.init");
  log.info(`Job store backend'as: ${jobStore.getBackend()}`);
  readiness.jobStore = true;

  /**
   * 1b. SESIJŲ AUTORITETAS - PRIEŠ `app.listen()`.
   *
   * ⚠️ VIEN READINESS MIDDLEWARE NEPAKANKA. `authRoute` prijungtas be
   * `requireJobSystemReady`, tad middleware sprendimas paliktų
   * `/api/auth/login` landą į pusiau inicijuotą sesijų saugyklą. Todėl
   * `init()` + schemos/invariantų validacija + `AUTH_USERS` suderinimas
   * PRIVALO būti sėkmingai baigti čia; readiness vėliava lieka
   * defense-in-depth, ne pakaitalas.
   *
   * ⚠️ SUDERINIMO KLAIDA REIŠKIA, KAD `listen` NEKVIEČIAMAS APSKRITAI.
   * Klaida keliama į viršų ir `startServer()` nutrūksta - dalinis suderinimas
   * negali virsti aptarnaujamu srautu.
   */
  await sessionStore.init();
  step("sessionStore.init");
  const suderinimas = await sessionStore.reconcile();
  step("sessionStore.reconcile");
  readiness.sessionReconcile = true;
  log.info(
    `Sesijų saugykla: ${sessionStore.backend} ` +
      `(suderinta ${suderinimas.patikrinta}, revokuota ${suderinimas.revokuota})`
  );

  /**
   * 1c. AUDITO AUTORITETAS - PRIEŠ `app.listen()` (#155, 7.4b).
   *
   * ⚠️ FAIL-CLOSED. `AUDIT_BACKEND=postgres` su nepasiekiama DB, netaikyta
   * migracija, trūkstamu invariantu ar nukritusiu append-only trigeriu NUTRAUKIA
   * startą. Tylus grįžimas į atmintį reikštų, kad operatorius paprašė
   * persistentinio audito, servisas pakilo, o žurnalas dingsta per restartą -
   * ir tai paaiškėtų tik tada, kai audito prireiks.
   *
   * ⚠️ PRIEŠ `listen()`, ne po. Auditas rašomas iš `/api/auth/login` - kelio,
   * kuris prijungtas be `requireJobSystemReady`. Inicijavus jį fone, tame lange
   * blokuojantis autentikacijos įvykis kristų su `AUDIT_WRITE_FAILED`.
   */
  await auditStore.init();
  step("auditStore.init");

  /**
   * ⚠️ ŽYMOS INICIJUOJAMOS ANKSTI, NORS `init()` YRA LAZY (#183 Codex, P1).
   *
   * Lazy kelias lieka skriptams ir worker'iams, kurie HTTP starto neturi. Bet
   * HTTP procesui „pirmas kvietėjas inicijuoja" reiškia, kad neveikianti DB
   * paaiškėtų tik apdorojant job'ą - jau priėmus srautą. Fail-closed: klaida
   * nutraukia startą, kaip ir `auditStore`.
   */
  await deletionTombstones.init();
  step("deletionTombstones.init");
  readiness.deletionTombstones = true;
  log.info(`Audito saugykla: ${auditStore.backend()}`);
  readiness.auditStore = true;

  /**
   * 2. Job runner.
   *
   * ⚠️ EILĖS PASIRINKIMAS ATSIETAS NUO METADUOMENŲ BACKEND'O (#155, 7.2a).
   *
   * Anksčiau čia buvo `jobStore.getBackend() === "redis"`. Su trimis
   * backend'ais tai reikštų: pasirinkus PostgreSQL metaduomenims, vykdymas
   * nukristų į inline režimą NORS REDIS VEIKIA — sukurti BullMQ job'ai liktų
   * nesuvartoti, o naujas darbas taptų nepatvarus.
   *
   * BullMQ priklauso nuo REDIS, ne nuo to, kur laikomi metaduomenys. Todėl
   * klausiama `jobStore.hasQueueBackend()`, kuris žiūri į `REDIS_URL` ir į tai,
   * ar prisijungimas realiai pavyko.
   */
  const persistentStoreAvailable = jobStore.hasQueueBackend();
  await jobRunner.init({ persistentStoreAvailable });
  step("jobRunner.init");
  log.info(`Job runner režimas: ${jobRunner.getMode()}`);
  readiness.jobRunner = true;

  // 3. TIK dabar - kai job sistema paruošta - pradedam priimti HTTP užklausas.
  await doListen(PORT);
  step("listen");
  log.info(`Stenograma backend veikia ant porto ${PORT}`);
  log.info(`  TRANSCRIPTION_PROVIDER = ${process.env.TRANSCRIPTION_PROVIDER || "mock"}`);
  log.info(`  LLM_PROVIDER           = ${process.env.LLM_PROVIDER || "mock"}`);

  // MINKŠTAS self-check po starto (NESTABDO serverio). Tas pats per GET /api/health/deep.
  runSelfChecks()
    .then((checks) => {
      for (const c of checks) log.info(`  ${c.ok ? "✅" : "❌"} ${c.name}: ${c.detail}`);
      if (checks.some((c) => !c.ok)) {
        log.info('  ℹ️  Detalesnei diagnostikai: "npm run doctor" arba GET /api/health/deep');
      }
    })
    .catch((e) => log.warn(`Self-check nepavyko: ${e.message}`));

  // Periodinis pasenusių jobų valymas (Redis atveju daugiausiai no-op - EXPIRE pats valo).

  // Nebaigtų ištrynimų (deletion_pending) pakartojimas - kad nepavykęs GDPR
  // DELETE nepasimestų, jei klientas užklausos nebekartoja.
  const { startDeletionRetry } = require("./utils/deletionRetry");
  const deletionRetryTimer = startDeletionRetry();

  // VIENAS centralizuotas retencijos mechanizmas (GDPR #2): pasenę jobai, nuskendę
  // audio failai ir pasenę audito įrašai. Rašo RETENTION_PURGE į auditą.
  //
  // Anksčiau čia buvo ir atskiras sweepTimer, kas 5 min kvietęs
  // jobStore.sweepExpired() - tą patį, ką daro ir retentionSweeper. Darbas
  // dubliavosi, o RETENTION_SWEEP_INTERVAL_MINUTES nekontroliavo visų jobų valymo
  // kvietimų. Senasis timer'is pašalintas; kad jobų valymo tankumas nesumažėtų,
  // numatytasis retencijos intervalas yra 5 min (buvo 60).
  const { startRetentionSweeper } = require("./utils/retentionSweeper");
  const retentionTimer = startRetentionSweeper();

  return { deletionRetryTimer, retentionTimer };
}

if (require.main === module) {
  startServer().catch((error) => {
    log.error(`Serverio paleidimas nepavyko: ${error.message}`);
    process.exit(1);
  });
}

module.exports = app;
// TESTAMS: elgsenos patikrai (žr. tests/securityBaseline.route.test.js).
module.exports._withTimeoutForTests = withTimeout;
app.startServer = startServer; // testams ir programiniam paleidimui
// TESTAMS: leidžia nustatyti readiness (testų kontekste startServer nevyksta, tad
// readiness liktų false ir job route'ai grąžintų 503). Testai kviečia app._setReadyForTests().
app._setReadyForTests = (value = true) => {
  readiness.jobStore = value;
  readiness.jobRunner = value;
  readiness.sessionReconcile = value;
  /**
   * ⚠️ `auditStore` ČIA PRIVALO BŪTI (#155, 7.4f).
   *
   * Nuo 7.4f `/api/ready` jo reikalauja. Palikus jį `false`, kiekvienas testas,
   * kuris tik „pažymi sistemą paruošta", gautų 503 - ir tai atrodytų kaip
   * readiness regresija, nors realiai trūktų vėliavos pačiame pagalbininke.
   */
  readiness.auditStore = value;

  /**
   * ⚠️ `deletionTombstones` - ta pati priežastis (#155, 7.5a / #183).
   *
   * Kiekvienas naujas readiness komponentas privalo atsirasti ir čia, kitaip
   * „pažymėk paruošta" nustoja reikšti paruošta, ir dešimtys nesusijusių testų
   * gauna 503 kaip tariamą regresiją.
   */
  readiness.deletionTombstones = value;
};

/**
 * ⚠️ ATSKIRAS PAGALBININKAS AUDITO VĖLIAVAI (#155, 7.4f).
 *
 * `_setReadyForTests(false)` nuleidžia VISKĄ, tad readiness kristų ir be audito.
 * Norint įrodyti, kad būtent `auditStore` įtrauktas į patikrą, reikia nuleisti
 * TIK jį, paliekant kitus žalius.
 */
app._setAuditReadyForTests = (value = true) => {
  readiness.auditStore = value;
};
