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

app.use("/api", generateRoute);
app.use("/api", transcribeRoute);
app.use("/api", transcribeJobsRoute);
app.use("/api", auditRoute);
app.use("/api", jobsRoute);

// Readiness sekimas: /api/health yra LIVENESS (procesas gyvas ir atsako), bet
// job store/runner inicijuojami ASINCHRONIŠKAI PO app.listen (kad Redis prisijungimas
// nesustabdytų starto). Tad /api/health 200 NEreiškia, kad job sistema paruošta -
// ypač Redis/BullMQ režime. /api/ready atskiria READINESS: grąžina 200 tik kai job
// store IR runner inicijuoti. Orkestratoriai (k8s, load balancer) turėtų naudoti
// /api/ready traffic'o nukreipimui, /api/health - proceso gyvybės patikrai.
const readiness = { jobStore: false, jobRunner: false };

app.get("/api/ready", (req, res) => {
  const ready = readiness.jobStore && readiness.jobRunner;
  res.status(ready ? 200 : 503).json({
    ready,
    components: {
      jobStore: readiness.jobStore,
      jobRunner: readiness.jobRunner,
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
  app.listen(PORT, () => {
    console.log(`Stenograma backend veikia ant porto ${PORT}`);
    console.log(`  TRANSCRIPTION_PROVIDER = ${process.env.TRANSCRIPTION_PROVIDER || "mock"}`);
    console.log(`  LLM_PROVIDER           = ${process.env.LLM_PROVIDER || "mock"}`);

    // MINKŠTAS self-check po starto: realiai patikrina komponentų pasiekiamumą
    // ir spausdina ✅/❌ eilutes, bet NESTABDO serverio (išorinis servisas gali
    // pasikelti vėliau). Tas pats rezultatas gaunamas per GET /api/health/deep.
    runSelfChecks()
      .then((checks) => {
        for (const c of checks) console.log(`  ${c.ok ? "✅" : "❌"} ${c.name}: ${c.detail}`);
        if (checks.some((c) => !c.ok)) {
          console.log('  ℹ️  Detalesnei diagnostikai: "npm run doctor" arba GET /api/health/deep');
        }
      })
      .catch((e) => console.warn(`[stenograma] Self-check nepavyko: ${e.message}`));
  });

  // Inicializuojam job store backend'ą (Redis jei REDIS_URL, kitaip in-memory).
  // Async, tad .then/.catch - kad paleidimas nesustotų dėl Redis prisijungimo.
  jobStore.init().then(() => {
    console.log(`[stenograma] Job store backend'as: ${jobStore.getBackend()}`);
    readiness.jobStore = true;
  }).catch((e) => {
    console.error(`[stenograma] Job store init klaida: ${e.message}`);
    if (process.env.REDIS_REQUIRED === "true") process.exit(1);
  });

  // Registruojam job processor'ius (inline režimui) ir init jobRunner (BullMQ ar inline).
  const { registerProcessors } = require("./queues/register");
  registerProcessors();
  jobRunner.init().then(() => {
    console.log(`[stenograma] Job runner režimas: ${jobRunner.getMode()}`);
    readiness.jobRunner = true;
  }).catch((e) => {
    console.error(`[stenograma] Job runner init klaida: ${e.message}`);
    if (process.env.REDIS_REQUIRED === "true") process.exit(1);
  });

  // Periodiškai valome pasenusius (completed/failed) jobus - žr. utils/jobStore/
  // TTL logiką. Redis atveju daugiausiai no-op (Redis EXPIRE pats valo). Testų metu
  // (require.main !== module) šis interval'as nesikuria, kad nepaliktų "kabančio"
  // laikmačio po testų.
  setInterval(async () => {
    const removed = await jobStore.sweepExpired();
    if (removed > 0) console.log(`[stenograma] Išvalyta ${removed} pasenusių jobų (TTL=${jobStore.TTL_MS / 60000} min).`);
  }, 5 * 60 * 1000).unref();
}

module.exports = app;
