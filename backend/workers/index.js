/**
 * BullMQ worker procesas - ATSKIRAS nuo HTTP backend'o.
 *
 * Paleidimas:  node workers/index.js
 * Docker:      atskiras servisas (žr. docker-compose.server.yml worker)
 *
 * Ką daro: klausosi transcription ir protocol eilių, vykdo darbą, atnaujina jobStore
 * būseną. Kadangi tai atskiras procesas:
 *   - HTTP backend restartas NEnutraukia čia vykdomo darbo;
 *   - jei ŠIS worker'is krenta vykdymo metu, BullMQ (attempts/backoff) grąžina jobą
 *     į eilę - kitas worker'is (ar tas pats po restarto) jį pakartos;
 *   - keli worker'iai gali veikti lygiagrečiai (BullMQ atominis job reservation
 *     užtikrina, kad to paties jobo nepaims du).
 *
 * Būsena rašoma per jobStore (Redis), tad HTTP GET /api/jobs/:id mato progresą.
 */
const jobStore = require("../utils/jobStore");
const jobRunner = require("../queues/jobRunner");
const { DEFAULT_JOB_OPTIONS, WORKER_OPTIONS, createQueueConnection } = require("../queues/config");
const { transcriptionProcessor, protocolProcessor } = require("../queues/processors");
const { createLogger } = require("../utils/logger");
const { authorizeJobOrAudit } = require("../utils/jobAuthorization");
const tombstones = require("../utils/deletionTombstones");
const maintenanceLock = require("../utils/maintenanceLock");
const log = createLogger("worker");


// Klaidos klasifikacija su sanitizacija - naudojam tą pačią kaip inline runner'is,
// kad worker'io ir inline elgesys būtų identiškas (paslaptys nepatenka į jobStore).
const _classifyError = (e) => jobRunner._classifyError(e, "worker job");
const { assertResultWithinLimits } = require("../utils/resultLimits");

// Ištrina audio iš storage po GALUTINIO statuso (sėkmės ar išnaudotų bandymų).
// NEtrina tarp retry - kad kitas bandymas rastų failą.
async function _cleanupStorage(payload, jobId) {
  if (payload && payload.storageKey) {
    // storageKey nulinamas TIK po sėkmingo trynimo - žr. utils/audioCleanup.js.
    const { releaseAudio } = require("../utils/audioCleanup");
    await releaseAudio(jobId, payload.storageKey);
  }
}

/**
 * Sukuria BullMQ Worker vienai eilei. Processor'ius vykdo darbą; on-events atnaujina
 * jobStore būseną (started/completed/failed su attempt_count).
 */
// Privatūs Redis ryšiai, priklausantys createWorker() sukurtiems workeriams.
// WeakMap nepapildo BullMQ Worker objekto nestandartinėmis savybėmis ir
// netrukdo garbage collection, kai worker'is daugiau nebenaudojamas.
const workerConnections = new WeakMap();

function createWorker(queueName, processor, workerOptions = {}) {
  const { Worker } = require("bullmq");
  const connection = createQueueConnection();

  const worker = new Worker(
    queueName,
    async (job) => {
      const { jobId, payload } = job.data;

      /**
       * IŠTRYNIMO ŽYMOS PATIKRA – PIRMAS DALYKAS (#19 PR3).
       *
       * Vėluojanti eilės žinutė ar pakartotinis bandymas gali atkeliauti jau
       * po to, kai jobas ištrintas. Be šios patikros worker'is pradėtų darbą
       * ir prikurtų artefaktų tam, ko kaip tik atsikratėme.
       *
       * NEMETAM klaidos: klaida priverstų BullMQ kartoti, o kartojimas čia
       * niekada nepavyks – jobas ištrintas visam laikui. Tyliai užbaigiam,
       * kad žinutė dingtų iš eilės.
       *
       * `jobStore.update` turi tą pačią apsaugą (žr. utils/jobStore/index.js),
       * bet ji grąžintų `null`, o worker'is tai palaikytų „įrašas nerastas" ir
       * mestų klaidą – teisingas rezultatas su klaidinga priežastimi.
       */
      /**
       * PRIEŽIŪROS UŽRAKTAS (#20 PR4) – tikrinamas PRIEŠ žymą.
       *
       * Uždarome TOCTOU langą: atkūrimas patikrino, kad aktyvių darbų nėra, o
       * worker'is be šios patikros galėtų paimti naują iš eilės būtent tarp
       * patikros ir pritaikymo.
       *
       * NEMETAM klaidos – darbas lieka eilėje ir bus paimtas po priežiūros.
       * Klaida priverstų BullMQ jį pažymėti nesėkme, nors nieko nepavyko tik
       * dėl laiko.
       */
      if (maintenanceLock.isLocked()) {
        log.warn("Praleistas darbas dėl priežiūros užrakto", { stage: "skipped_maintenance", jobId });
        return;
      }

      if (tombstones.isDeleted(jobId)) {
        log.warn("Praleistas ištrinto jobo vykdymas", { stage: "skipped_deleted", jobId });
        return { skipped: "deleted" };
      }

      // Pažymim PROCESSING su realiu attempt numeriu (BullMQ job.attemptsMade).
      // update() grąžina null, jei jobo įrašo NĖRA (pvz. nesuderintas store, P1 scenarijus,
      // arba job'as pasibaigė TTL). Tada BullMQ nemato problemos, bet vartotojo jobo įrašo
      // nėra - klaidiname klientą. Todėl tikrinam ir metam, kad BullMQ pažymėtų failed +
      // retry (ne tyliai "sėkmė" be įrašo).
      // #154: `restart()` grąžina job'ą į grafo pradžią. BullMQ retry paleidžia
      // processor'ių iš naujo, o job'as gali būti bet kurioje fazėje – grįžimas
      // atgal grafe nelegalus, tad perpaleidimas yra atskira operacija.
      const processingJob = await jobStore.system.restart(jobId, {
        attempt_count: job.attemptsMade + 1,
      });
      if (!processingJob) {
        throw new Error(`Job store įrašas nerastas (PROCESSING): ${jobId}. Galimai nesuderintas store/runner arba pasibaigęs TTL.`);
      }

      /**
       * KORELIACIJA (GDPR #17): worker'is yra atskiras PROCESAS, tad HTTP
       * konteksto paveldėti negali. ID atkuriamas iš jobStore įrašo - taip
       * worker'io logai susiejami su ta pačia užklausa.
       */
      const { runWithContext } = require("../utils/requestContext");

      /**
       * Kontekstas apgaubia VISĄ likusį vykdymą, ne vien `processor()`.
       *
       * Pirmoji versija apgaubė tik procesorių - tad COMPLETED įrašymas, audio
       * valymas ir jų klaidos liktų be `requestId`. Būtent tie lifecycle įvykiai
       * yra vertingiausi tiriant, o be koreliacijos jie tampa našlaičiais logo
       * eilutėmis.
       */
      return runWithContext(
        {
          requestId: processingJob.requestId || null,
          actor: processingJob.actor || null,
          actorRole: processingJob.actorRole || null,
          execution: "worker",
        },
        async () => {
          /**
           * AUTORIZACIJA VYKDYMO METU (#18 PR3) – TA PATI logika kaip inline
           * kelyje (`queues/jobRunner.js`).
           *
           * Worker'is yra atskiras procesas, kuris jobą paima galbūt po ilgo
           * laiko. Jei per tą laiką aktorius pašalintas ar jo rolė sumažinta,
           * darbas neturi būti įvykdytas – priešingu atveju revokacija
           * negaliotų būtent ten, kur ji svarbiausia.
           */
          const decision = await authorizeJobOrAudit(processingJob, jobId);

          if (!decision.allowed) {
            /**
             * #154: terminalus perėjimas per state machine – žr. jobRunner.js.
             * Neapdorotas `update({ status })` čia irgi būtų kritęs.
             */
            await jobStore.system.finish(jobId, jobStore.STATUS.FAILED, {
              error_code: "AUTHORIZATION_REVOKED",
              error_message: "Vykdymas nutrauktas: aktoriaus teisės nebegalioja.",
            });
            return;
          }

          log.info("Darbas pradėtas", { stage: "processing", execution: "worker", jobId });
          const startedAt = Date.now();

          const result = await processor(payload, jobId);

          /**
           * REZULTATO RIBA (#153) – ta pati kaip inline kelyje.
           *
           * BullMQ kelias yra produkcijos kelias su Redis, tad be šios patikros
           * riba veiktų tik dev/desktop režime. Metama PRIEŠ `update`, tad
           * žemesnis `catch` pažymi job'ą `failed` su `RESULT_TOO_LARGE`.
           */
          /**
           * RIBOS VIRŠIJIMAS YRA NEATKARTOJAMAS (#153).
           *
           * `UnrecoverableError` sustabdo BullMQ retry grandinę iš karto. Be
           * jo per didelis rezultatas būtų kartojamas `attempts` kartų – o
           * kiekvienas bandymas reiškia PILNĄ transkribavimą arba LLM kvietimą
           * iš naujo. Rezultatas nuo kartojimo nesumažės, tad tai tik
           * švaistytų GPU/LLM darbą ir laikytų job'ą `processing` būsenoje.
           *
           * Originali klaida perduodama `cause`, kad `_classifyError()` matytų
           * `ResultLimitError` ir priskirtų `RESULT_TOO_LARGE`.
           */
          try {
            assertResultWithinLimits(result);
          } catch (limitErr) {
            const { UnrecoverableError } = require("bullmq");
            const fatal = new UnrecoverableError(limitErr.message);
            fatal.cause = limitErr;
            throw fatal;
          }

          // COMPLETED rašom čia (ne on-completed), kad rezultatas tikrai išsaugotas.
          const completedJob = await jobStore.system.finish(jobId, jobStore.STATUS.COMPLETED, { result });
          if (!completedJob) {
            throw new Error(`Nepavyko išsaugoti job rezultato (COMPLETED): ${jobId}. Job store įrašo nebėra.`);
          }

          // SĖKMĖ - audio nebereikalingas, trinam iš storage (jei transkripcija).
          await _cleanupStorage(payload, jobId);

          log.info("Darbas baigtas", {
            stage: "completed",
            execution: "worker",
            jobId,
            durationMs: Date.now() - startedAt,
          });

          return result;
        }
      );
    },
    { connection, ...WORKER_OPTIONS, ...workerOptions }
  );

  worker.on("failed", async (job, err) => {
    if (!job) return;
    const { jobId, payload } = job.data;

    /**
     * `failed` handler'is vykdomas UŽ jobo konteksto ribų (BullMQ jį kviečia
     * atskirai), tad kontekstą atkuriam iš naujo - kitaip nesėkmės kelias,
     * kuris tiriamas dažniausiai, liktų vienintelis be koreliacijos.
     */
    const { runWithContext } = require("../utils/requestContext");
    const failedJob = await jobStore.system.get(jobId).catch(() => null);

    return runWithContext(
      {
        requestId: (failedJob && failedJob.requestId) || null,
        actor: (failedJob && failedJob.actor) || null,
        execution: "worker",
      },
      () => _handleFailure(job, err, jobId, payload)
    );
  });

  async function _handleFailure(job, err, jobId, payload) {
    /**
     * NEATKARTOJAMOS klaidos yra GALUTINĖS iš karto (#153).
     *
     * `job.attemptsMade >= attempts` vieno nepakanka: `UnrecoverableError`
     * sustabdo BullMQ retry grandinę PIRMU bandymu, tad formaliai bandymai
     * lieka „neišnaudoti". Be šios šakos job'as niekada negautų `failed` ir
     * amžinai liktų `processing` – blogiausias įmanomas variantas, nes
     * vartotojas lauktų neribotai.
     */
    const neatkartojama = err && err.name === "UnrecoverableError";
    const attemptsExhausted =
      neatkartojama || job.attemptsMade >= (job.opts.attempts || DEFAULT_JOB_OPTIONS.attempts);
    const { errorCode, message } = _classifyError(err);

    /**
     * `failed` TIK galutinei nesėkmei (GDPR #17).
     *
     * BullMQ `failed` įvykis kviečiamas ir tarpiniam bandymui, po kurio jobas
     * dar bus kartojamas. Žymint jį `failed`, grandinė atrodytų taip:
     *   queued → processing → provider → failed → processing → completed
     * t. y. logas rodytų galutinę nesėkmę ten, kur jos nebuvo. Tai tas pats
     * meluojančio observability tipas, kurį jau ištaisėm inline kelyje.
     */
    log.warn(attemptsExhausted ? "Darbas nepavyko" : "Darbas bus kartojamas", {
      stage: attemptsExhausted ? "failed" : "retrying",
      execution: "worker",
      jobId,
      attempt: job.attemptsMade,
      maxAttempts: job.opts.attempts || DEFAULT_JOB_OPTIONS.attempts,
      errorCode,
    });

    if (attemptsExhausted) {
      // Galutinė nesėkmė po visų bandymų - jobas FAILED (dead-letter).
      await jobStore.system.finish(jobId, jobStore.STATUS.FAILED, { error: message, error_code: errorCode });
      // Tik dabar (po VISŲ bandymų) trinam audio - kad retry turėtų failą.
      await _cleanupStorage(payload, jobId);
    } else {
      // Dar bus retry - paliekam PROCESSING, audio NETRINAM (kitas bandymas jį naudos).
      await jobStore.system.update(jobId, { attempt_count: job.attemptsMade + 1, error: message, error_code: errorCode });
    }
  }

  worker.on("error", (err) => {
    log.error(`[worker:${queueName}] klaida:`, err.message);
  });

  workerConnections.set(worker, connection);

  return worker;
}

/**
 * Tvarkingai uždaro BullMQ Worker ir jam priklausantį Redis ryšį.
 *
 * `createWorker()` sukurto worker'io connection randamas privačiame WeakMap.
 * Tiesiogiai teste ar kitur sukurtam Worker galima perduoti connection
 * per options.connection.
 */
async function shutdownWorker(worker, options = {}) {
  if (!worker) return;

  const {
    force = true,
    connection: explicitConnection,
  } = options;

  const connection =
    explicitConnection || workerConnections.get(worker);

  try {
    await worker.close(force);
  } finally {
    workerConnections.delete(worker);

    if (connection) {
      try {
        await connection.quit();
      } catch {
        // Jeigu graceful QUIT nebeįmanomas, bent jau nutraukiame socketą,
        // kad procesas neliktų kabėti shutdown arba testų cleanup metu.
        connection.disconnect();
      }
    }
  }
}

function startWorkers() {
  // Naudojam ATSKIRUS worker modulius (transcriptionWorker.js, protocolWorker.js) -
  // pagal struktūros reikalavimą. index.js paleidžia ABU viename procese; atskirai
  // galima paleisti po vieną (skirtingam skalavimui).
  const { startTranscriptionWorker } = require("./transcriptionWorker");
  const { startProtocolWorker } = require("./protocolWorker");
  const workers = [startTranscriptionWorker(), startProtocolWorker()];
  log.info(`Worker'iai paleisti (concurrency=${WORKER_OPTIONS.concurrency}, stalled recovery=${WORKER_OPTIONS.stalledInterval}ms): transcription, protocol`);

  // Heartbeat: worker rašo Redis raktą su TTL, /api/ready jį tikrina - taip readiness
  // patvirtina, kad worker'is GYVAS (ne tik kad Redis pasiekiamas). Kombinuotas
  // procesas (šis, node workers/index.js) tvarko ABI eiles, tad rašo ABIEJŲ TIPŲ
  // raktus (žr. utils/workerHeartbeat.js) - readiness mato abu kaip gyvus.
  const { createQueueConnection } = require("../queues/config");
  const { startHeartbeat } = require("../utils/workerHeartbeat");
  const heartbeatConn = createQueueConnection();
  const stopHeartbeat = startHeartbeat(heartbeatConn, ["transcription", "protocol"]);

  // Graceful shutdown - laukiam vykdomo darbo pabaigos prieš uždarant. Idempotentiškas
  // (shuttingDown flag'as) - jei SIGTERM ir SIGINT ateitų beveik vienu metu (ar tas
  // pats signalas pakartotas), antras iškvietimas TIK palaukia pirmojo pabaigos, o ne
  // kviečia worker.close()/heartbeatConn.quit() dar kartą (dvigubas quit() ant to
  // paties Redis ryšio ar process.exit() lenktynės tarp dviejų shutdown() eigų).
  let shuttingDown = null;
  async function shutdown(signal) {
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
      log.info(`Worker gauna ${signal}, baigiu darbus...`);
      stopHeartbeat();
      process.removeListener("SIGTERM", onSigterm);
      process.removeListener("SIGINT", onSigint);
      await heartbeatConn.quit().catch((e) => log.error(`Heartbeat ryšio uždarymo klaida: ${e.message}`));
      await Promise.all(
        workers.map((w) => w.close().catch((e) => log.error(`Worker uždarymo klaida: ${e.message}`)))
      );
      process.exit(0);
    })();
    return shuttingDown;
  }
  function onSigterm() { shutdown("SIGTERM"); }
  function onSigint() { shutdown("SIGINT"); }
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);

  return workers;
}

// Registruojam processor'ius ir inline runner'iui (kad be Redis veiktų tas pats kodas).
jobRunner.registerProcessor("transcription", transcriptionProcessor);
jobRunner.registerProcessor("protocol", protocolProcessor);

/**
 * Bendra worker paleidimo apsauga (naudoja index.js, transcriptionWorker.js,
 * protocolWorker.js - kad nesidubliuotų 3 skirtingos realizacijos). Inicijuoja jobStore
 * ir MET klaidą, jei jis fallback'ino į memory. Worker'iui NĖRA prasmingo memory
 * fallback: jis klausytų Redis eilės, bet jobų būseną laikytų SAVO proceso atmintyje,
 * nematytų backend proceso sukurtų jobų -> "Job store įrašas nerastas". Todėl elgiamės
 * kaip su REDIS_REQUIRED=true nepriklausomai nuo aplinkos.
 * @throws jei nėra REDIS_URL arba jobStore backend ne "redis".
 */
async function initializeWorkerOrFail(workerName) {
  if (!process.env.REDIS_URL) {
    throw new Error(`${workerName} reikia REDIS_URL (BullMQ). Be jo naudokite inline režimą (darbas HTTP procese).`);
  }
  await jobStore.init();
  /**
   * ⚠️ TIKRINAMA EILĖS GALIMYBĖ, NE KONKRETUS BACKEND'AS (#155, 7.2a).
   *
   * Anksčiau čia buvo `getBackend() !== "redis"`. Atidarius PostgreSQL
   * aktyvavimo barjerą su nustatytais IR `DATABASE_URL`, IR `REDIS_URL`,
   * HTTP procesas dėtų job'us į BullMQ (`hasQueueBackend()` grąžintų `true`),
   * o KIEKVIENAS atskiras worker'is kristų starte - vartotojo darbas liktų
   * eilėje amžinai, be nė vieno vykdytojo.
   *
   * Sprendimą priima ta pati `canUseQueue()`, kurią naudoja `server.js`.
   */
  if (!jobStore.hasQueueBackend()) {
    throw new Error(
      `${workerName} negali veikti be BENDROS job saugyklos (dabar: ` +
      `"${jobStore.getBackend()}"). BullMQ reikia REDIS_URL ir bendro ` +
      "metaduomenų backend'o (redis arba postgres) - su atmintimi worker'is " +
      "atnaujintų savo proceso kopiją, o HTTP procesas jos nematytų."
    );
  }
}

/**
 * Paleidžia vienos eilės worker procesą (naudoja workers/transcriptionWorker.js,
 * workers/protocolWorker.js): patikrina Redis job store, paleidžia konkretaus tipo
 * heartbeat, užregistruoja graceful shutdown (SIGTERM/SIGINT).
 *
 * @param {string} workerName - žmogui skaitomas vardas klaidų pranešimams.
 * @param {() => import("bullmq").Worker} startWorker - funkcija, kuri sukuria IR
 *   grąžina VIENĄ BullMQ Worker (pvz. startTranscriptionWorker).
 * @param {string} heartbeatType - "transcription" | "protocol" (žr.
 *   utils/workerHeartbeat.js heartbeatKey) - KURIO tipo raktą šis procesas rašo.
 * @returns {Promise<{worker: import("bullmq").Worker, shutdown: (opts?: {exit?: boolean}) => Promise<void>}>}
 *   `shutdown` eksponuojama grąžinamoje reikšmėje (ne tik SIGTERM/SIGINT listener'iuose),
 *   kad testai galėtų švariai sustabdyti heartbeat/worker BE process.exit() -
 *   žr. tests/runWorkerProcess.test.js.
 */
async function runWorkerProcess(workerName, startWorker, heartbeatType) {
  await initializeWorkerOrFail(workerName);

  const worker = startWorker();

  const { createQueueConnection } = require("../queues/config");
  const { startHeartbeat } = require("../utils/workerHeartbeat");
  const heartbeatConn = createQueueConnection();
  const stopHeartbeat = startHeartbeat(heartbeatConn, heartbeatType);

  // Idempotentiškas (žr. startWorkers() aukščiau dėl priežasties) IR testuojamas -
  // { exit: false } leidžia testams sustabdyti heartbeat/worker BE process.exit(0).
  let shuttingDown = null;
  async function shutdown(signalOrOpts) {
    if (shuttingDown) return shuttingDown;
    const isTestCall = signalOrOpts && typeof signalOrOpts === "object";
    const signal = isTestCall ? "manual" : signalOrOpts;
    const shouldExit = isTestCall ? signalOrOpts.exit !== false : true;

    shuttingDown = (async () => {
      log.info(`${workerName} gauna ${signal}, baigiu darbus...`);
      stopHeartbeat();
      process.removeListener("SIGTERM", onSigterm);
      process.removeListener("SIGINT", onSigint);
      await heartbeatConn.quit().catch((e) => log.error(`Heartbeat ryšio uždarymo klaida: ${e.message}`));
      await worker.close().catch((e) => log.error(`Worker uždarymo klaida: ${e.message}`));
      if (shouldExit) process.exit(0);
    })();
    return shuttingDown;
  }
  // Pavadintos funkcijos (ne anoniminės tiesiai process.on viduje), kad shutdown()
  // galėtų jas pačias pašalinti (removeListener reikia TOS PAČIOS funkcijos
  // nuorodos) - be to, testai (žr. tests/runWorkerProcess.test.js), kviesdami
  // shutdown() rankiniu būdu, paliktų "kabančius" SIGTERM/SIGINT listener'ius ant
  // bendro `process` objekto per visą testų failo vykdymo laiką.
  function onSigterm() { shutdown("SIGTERM"); }
  function onSigint() { shutdown("SIGINT"); }
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);

  return { worker, shutdown };
}

if (require.main === module) {
  initializeWorkerOrFail("BullMQ worker")
    .then(() => startWorkers())
    .catch((error) => {
      log.error(`Worker nepaleistas: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { createWorker, shutdownWorker, startWorkers, initializeWorkerOrFail, runWorkerProcess, _cleanupStorage };
