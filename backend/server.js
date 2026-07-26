require("dotenv").config();
const express = require("express");
const cors = require("cors");

const generateRoute = require("./routes/generate");
const transcribeRoute = require("./routes/transcribe");
const transcribeJobsRoute = require("./routes/transcribeJobs");
const auditRoute = require("./routes/audit");
const jobsRoute = require("./routes/jobs");
const jobStore = require("./utils/jobStore");
const jobRunner = require("./queues/jobRunner");
const { validateConfig, runSelfChecks } = require("./utils/startupChecks");

// KIETA konfigūracijos validacija (vartotojo prašymas po realaus diegimo: "jei
// kažko trūksta - aiškiai parašyti ir nestartuoti", o ne griūti pirmoje užklausoje).
// Testų aplinkoje (mock provideriai) klaidų nebūna, tad testai nepaveikiami.
if (process.env.SKIP_CONFIG_VALIDATION !== "true") {
  const { errors, warnings } = validateConfig();
  for (const w of warnings) console.warn(`[stenograma] ⚠️  ${w}`);
  if (errors.length > 0) {
    console.error("[stenograma] ❌ Konfigūracijos klaidos - serveris NESTARTUOJA:");
    for (const e of errors) console.error(`[stenograma]   ❌ ${e}`);
    console.error("[stenograma] Pataisykite .env (žr. .env.example komentarus) arba, kraštutiniu atveju, SKIP_CONFIG_VALIDATION=true.");
    if (require.main === module) process.exit(1);
    throw new Error("Konfigūracijos validacija nepavyko: " + errors.join(" | "));
  }
}

const app = express();

// CORS_ORIGIN numatyta į lokalią dev adresą - "*" turi būti sąmoningas pasirinkimas
// (pvz. viešam demo), niekada numatytoji reikšmė.
const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:5173";
if (corsOrigin === "*") {
  console.warn("[stenograma] CORS_ORIGIN=* - bet koks domenas gali kviesti šį API. Naudokite tik aiškiam demo.");
}
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: "10mb" }));

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
// requireJobSystemReady prijungtas per konkretų POST kelią (ne bendrą /api), kad
// NEliestų /api/health ir /api/ready (kurie apibrėžti žemiau).
app.post("/api/transcribe-jobs", requireJobSystemReady);
app.post("/api/jobs", requireJobSystemReady);
app.use("/api", transcribeJobsRoute);
app.use("/api", jobsRoute);

app.get("/api/ready", async (req, res) => {
  const initReady = readiness.jobStore && readiness.jobRunner;
  if (!initReady) {
    return res.status(503).json({
      ready: false,
      components: { jobStore: readiness.jobStore, jobRunner: readiness.jobRunner },
    });
  }

  // BullMQ režime init flag'ai NEUŽTENKA - jie tik reiškia "režimas pasirinktas". Realiam
  // readiness reikia patikrinti, ar Redis TIKRAI pasiekiamas (kitaip queue.add pakibtų).
  // Inline režime nieko papildomo netikrinam (viskas procese). PING su trumpu timeout.
  let redisReachable = true;
  if (jobRunner.getMode && jobRunner.getMode() === "bullmq") {
    let conn = null;
    try {
      const { createQueueConnection } = require("./queues/config");
      conn = createQueueConnection();
      await conn.ping();
    } catch {
      redisReachable = false;
    } finally {
      if (conn) await conn.quit().catch(() => {});
    }
  }

  const ready = initReady && redisReachable;
  res.status(ready ? 200 : 503).json({
    ready,
    components: {
      jobStore: readiness.jobStore,
      jobRunner: readiness.jobRunner,
      redisReachable, // BullMQ režime rodo realų Redis ryšį; inline - visada true
    },
  });
});

app.get("/api/health", (req, res) => {
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

  res.json({
    status: "ok",
    transcriptionProvider: process.env.TRANSCRIPTION_PROVIDER || "mock",
    diarizationProvider: process.env.DIARIZATION_PROVIDER || "none",
    llmProvider: process.env.LLM_PROVIDER || "mock",
  });
});

/**
 * GILUS health patikrinimas - realiai tikrina kiekvieno komponento pasiekiamumą
 * (Python importas, pyannote/whisper serverių HTTP, raktų buvimas), ne tik
 * grąžina konfigūraciją. Naudinga diegiant ir enterprise monitoringui.
 * Apsaugotas ta pačia detalių slėpimo logika kaip /api/health (production'e
 * infrastruktūros detalės neatskleidžiamos be x-audit-key).
 */
app.get("/api/health/deep", async (req, res) => {
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

if (require.main === module) {
  const PORT = process.env.PORT || 3001;

  // KRITIŠKA (race apsauga): infrastruktūrą (jobStore + jobRunner) inicijuojam PILNAI
  // PRIEŠ app.listen. Anksčiau listen startuodavo pirmas, o init vyko async po jo - tad
  // ankstyva HTTP užklausa galėjo laimėti race: route per lazy ensureInit nustatydavo
  // jobRunner režimą (pagal REDIS_URL) PRIEŠ mūsų sekvencinį init, ir memory+BullMQ
  // nesuderinimas įvykdavo. Init prieš listen tai UŽDARO - serveris nepriima užklausų,
  // kol job sistema nepilnai ir nuosekliai paruošta.
  async function startServer() {
    const { registerProcessors } = require("./queues/register");
    registerProcessors();

    // 1. Job store (Redis jei REDIS_URL ir connect pavyksta, kitaip in-memory fallback).
    await jobStore.init();
    console.log(`[stenograma] Job store backend'as: ${jobStore.getBackend()}`);
    readiness.jobStore = true;

    // 2. Job runner - režimas SUDERINTAS su jobStore backend'u (BullMQ tik kai tikrai Redis).
    const persistentStoreAvailable = jobStore.getBackend() === "redis";
    await jobRunner.init({ persistentStoreAvailable });
    console.log(`[stenograma] Job runner režimas: ${jobRunner.getMode()}`);
    readiness.jobRunner = true;

    // 3. TIK dabar - kai job sistema paruošta - pradedam priimti HTTP užklausas.
    await new Promise((resolve) => app.listen(PORT, resolve));
    console.log(`Stenograma backend veikia ant porto ${PORT}`);
    console.log(`  TRANSCRIPTION_PROVIDER = ${process.env.TRANSCRIPTION_PROVIDER || "mock"}`);
    console.log(`  LLM_PROVIDER           = ${process.env.LLM_PROVIDER || "mock"}`);

    // MINKŠTAS self-check po starto (NESTABDO serverio - išorinis servisas gali pakilti
    // vėliau). Tas pats per GET /api/health/deep.
    runSelfChecks()
      .then((checks) => {
        for (const c of checks) console.log(`  ${c.ok ? "✅" : "❌"} ${c.name}: ${c.detail}`);
        if (checks.some((c) => !c.ok)) {
          console.log('  ℹ️  Detalesnei diagnostikai: "npm run doctor" arba GET /api/health/deep');
        }
      })
      .catch((e) => console.warn(`[stenograma] Self-check nepavyko: ${e.message}`));

    // Periodinis pasenusių jobų valymas (Redis atveju daugiausiai no-op - EXPIRE pats valo).
    setInterval(async () => {
      const removed = await jobStore.sweepExpired();
      if (removed > 0) console.log(`[stenograma] Išvalyta ${removed} pasenusių jobų (TTL=${jobStore.TTL_MS / 60000} min).`);
    }, 5 * 60 * 1000).unref();
  }

  startServer().catch((error) => {
    console.error(`[stenograma] Serverio paleidimas nepavyko: ${error.message}`);
    process.exit(1);
  });
}

module.exports = app;
// TESTAMS: leidžia nustatyti readiness (testų kontekste startServer nevyksta, tad
// readiness liktų false ir job route'ai grąžintų 503). Testai kviečia app._setReadyForTests().
app._setReadyForTests = (value = true) => {
  readiness.jobStore = value;
  readiness.jobRunner = value;
};
