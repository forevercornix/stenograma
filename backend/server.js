require("dotenv").config();
const express = require("express");
const cors = require("cors");

const generateRoute = require("./routes/generate");
const transcribeRoute = require("./routes/transcribe");
const transcribeJobsRoute = require("./routes/transcribeJobs");
const auditRoute = require("./routes/audit");
const exportsRoute = require("./routes/exports");
const jobsRoute = require("./routes/jobs");
const jobStore = require("./utils/jobStore");
const jobRunner = require("./queues/jobRunner");
const { validateConfig, runSelfChecks } = require("./utils/startupChecks");
const { pollRateLimiter, generalApiLimiter } = require("./middleware/rateLimiter");
const { initPrivacyPolicy } = require("./utils/privacyPolicy");
const { requestContextMiddleware } = require("./utils/requestContext");
const { applySecurityBaseline } = require("./utils/securityBaseline");
const { resolveTrustProxy } = require("./utils/clientIp");
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
const readiness = { jobStore: false, jobRunner: false };
app.locals.readiness = readiness; // route failai gali tikrinti be ciklinės priklausomybės

function requireJobSystemReady(req, res, next) {
  if (!readiness.jobStore || !readiness.jobRunner) {
    return res.status(503).json({ error: "Job sistema dar inicializuojama. Bandykite dar kartą po kelių sekundžių." });
  }
  next();
}

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

  return { redisReachable, workers };
}

app.get("/api/ready", pollRateLimiter, async (req, res) => {
  const initReady = readiness.jobStore && readiness.jobRunner;
  if (!initReady) {
    return res.status(503).json({
      ready: false,
      components: { jobStore: readiness.jobStore, jobRunner: readiness.jobRunner },
    });
  }

  // BullMQ režime init flag'ai NEUŽTENKA - jie tik reiškia "režimas pasirinktas". Realiam
  // readiness tikrinam: (a) ar Redis pasiekiamas (queue.add nepakibtų), (b) ar ABU
  // worker TIPAI gyvi (heartbeat raktai šviežias KIEKVIENAM atskirai - transkripcijos
  // ir protokolo worker'iai gali būti ATSKIRI procesai/konteineriai, žr.
  // utils/workerHeartbeat.js) - kitaip jobai būtų priimami, bet liktų queued, nes
  // niekas jų neapdoroja. Inline režime nieko papildomo (viskas tame pačiame procese).
  const { redisReachable, workers } = await probeRuntimeReadiness();
  const workerAlive = workers.transcription && workers.protocol;

  const ready = initReady && redisReachable && workerAlive;
  res.status(ready ? 200 : 503).json({
    ready,
    components: {
      jobStore: readiness.jobStore,
      jobRunner: readiness.jobRunner,
      redisReachable, // BullMQ režime rodo realų Redis ryšį; inline - visada true
      workerAlive,    // BullMQ režime: true TIK jei ABU worker tipai gyvi; inline - visada true
      workers,        // detali būsena PER TIPĄ - kuri konkrečiai eilė (jei kuri) neturi gyvo worker'io
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

  // 2. Job runner - režimas SUDERINTAS su jobStore backend'u (BullMQ tik kai tikrai Redis).
  const persistentStoreAvailable = jobStore.getBackend() === "redis";
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
};
