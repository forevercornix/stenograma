const jobStore = require("../utils/jobStore");
const { assertResultWithinLimits } = require("../utils/resultLimits");
const { createLogger } = require("../utils/logger");
const { authorizeJobOrAudit } = require("../utils/jobAuthorization");
const tombstones = require("../utils/deletionTombstones");
const maintenanceLock = require("../utils/maintenanceLock");
const log = createLogger("job-runner");

/**
 * Job runner - abstrakcija tarp HTTP endpoint'o ir darbo vykdymo.
 *
 * DU REŽIMAI (parenkama automatiškai pagal REDIS_URL, kaip jobStore):
 *
 *  1) BULLMQ (su REDIS_URL): endpoint'as tik queue.add() ir grąžina 202. Darbą
 *     vykdo ATSKIRAS worker procesas (workers/). HTTP backend restartas nenutraukia
 *     darbo. Tai TIKRA job queue.
 *
 *  2) INLINE (be REDIS_URL): endpoint'as vykdo darbą TAME PAČIAME procese
 *     (setImmediate, po 202 atsakymo). Dabartinis elgesys - tinka dev/desktop
 *     vienam vartotojui. Backend restartas nutraukia vykdomą darbą (žinomas
 *     apribojimas, dokumentuotas). Fallback, kai Redis nėra.
 *
 * Abu režimai naudoja tą patį jobStore būsenai, tad GET /api/jobs/:id veikia vienodai.
 */

let _mode = null; // "bullmq" | "inline"

// Vykdymo funkcijos (registruojamos, kad inline režimas ir worker'iai naudotų tą patį kodą).
const _processors = {};

function registerProcessor(type, fn) {
  _processors[type] = fn;
}

async function init(options = {}) {
  if (_mode) return _mode;

  // KRITIŠKA (nuoseklumas): BullMQ naudojamas TIK jei jobStore REALIAI prisijungė prie
  // Redis. Anksčiau sprendėm vien pagal REDIS_URL buvimą - bet jei jobStore Redis connect
  // nepavyko ir jis fallback'ino į memory, o jobRunner vis tiek naudotų BullMQ, gautume
  // NESUDERINTĄ sistemą: HTTP procesas job'ą kuria atmintyje, siunčia į BullMQ, worker jo
  // neranda. persistentStoreAvailable perduodamas iš server.js po jobStore.init().
  // Jei nenurodyta (senas iškvietimas), fallback į REDIS_URL patikrą - bet server.js
  // dabar visada perduoda.
  const persistentStore =
    options.persistentStoreAvailable !== undefined
      ? options.persistentStoreAvailable
      : !!process.env.REDIS_URL;

  if (!persistentStore) {
    _mode = "inline";
    // Jei REDIS_URL buvo nustatytas, bet persistentStore=false, reiškia jobStore Redis
    // connect nepavyko - tai svarbi žinutė (ne tik "nėra REDIS_URL").
    if (process.env.REDIS_URL) {
      log.warn(
        "⚠️  REDIS_URL nustatytas, BET job store persistencija neprieinama " +
          "(Redis connect nepavyko). Job runner naudoja INLINE - suderinta su memory store."
      );
    } else {
      log.info("Job runner: inline (in-proceso; be atskirų worker'ių - nustatykite REDIS_URL BullMQ eilei)");
    }
    warnIfInlineInProduction();
    return _mode;
  }

  try {
    // Naudojam ATSKIRAS eiles (queues/transcriptionQueue.js, protocolQueue.js) -
    // pagal struktūros reikalavimą. Jos sukuriamos lazy pirmo add metu.
    require("bullmq"); // patikrinam, kad bullmq įdiegtas (mes fallback jei ne)
    _mode = "bullmq";
    log.info("Job runner: BullMQ (atskiri worker procesai; atsparu restartams)");
    return _mode;
  } catch (e) {
    if (process.env.REDIS_REQUIRED === "true") {
      throw new Error(`BullMQ init nepavyko (${e.message}), o REDIS_REQUIRED=true.`);
    }
    log.warn(`⚠️  BullMQ init nepavyko (${e.message}). Grįžtu į inline runner'į (darbas vykdomas HTTP procese).`);
    _mode = "inline";
    warnIfInlineInProduction();
    return _mode;
  }
}

/**
 * Inline režimas patogus dev/demo, BET produkcijoje pavojingas: job'ai vykdomi HTTP
 * procese ir laikomi in-memory, tad backend'o restartas/kritimas apdorojimo metu
 * PRARANDA darbą IR jo būseną, o retry nėra (skirtingai nuo BullMQ). Jei kas nors
 * paleidžia inline su NODE_ENV=production - garsiai įspėjame (bet neblokuojame, kad
 * neapribotume teisėtų small-scale scenarijų su REDIS_REQUIRED=false).
 */
function warnIfInlineInProduction() {
  if (process.env.NODE_ENV === "production") {
    log.warn(
      "⚠️  ⚠️  DĖMESIO: inline job runner PRODUKCIJOJE (NODE_ENV=production, be REDIS_URL).\n" +
      "           Job'ai vykdomi HTTP procese ir laikomi ATMINTYJE - backend'o restartas ar\n" +
      "           kritimas apdorojimo metu PRARANDA darbą ir būseną, retry NĖRA. Ilgiems failams\n" +
      "           tai reiškia, kad valandų apdorojimas gali dingti. Produkcijai nustatykite REDIS_URL\n" +
      "           (BullMQ: atskiri worker'iai, persistentus, atsparu restartams)."
    );
  }
}

function getMode() {
  return _mode || "inline";
}

/**
 * Įdeda transkribavimo jobą. BullMQ režime - į eilę (worker pasiims). Inline - vykdo
 * tame pačiame procese po grąžinimo.
 *
 * @param {string} jobId - jobStore jobo ID (jau sukurtas prieš tai)
 * @param {object} payload - { storageKey, filename, mimeType, language, diarize, ... }
 */
/**
 * Užtikrina, kad jobRunner inicijuotas NUOSEKLIAI su jobStore. Naudojamas enqueue*
 * funkcijų kaip atsarginis kelias (jei server.js startServer dar neužbaigė - nors su
 * init-prieš-listen tai nebeturėtų nutikti). SVARBU: init() kviečiamas su
 * persistentStoreAvailable iš jobStore, NE pagal REDIS_URL - kad lazy init irgi
 * negalėtų sukurti memory+BullMQ nesuderinimo.
 */
async function ensureInitialized() {
  if (_mode) return _mode;
  // jobStore.init() idempotentiškas (initPromise) - saugu kviesti; grąžina esamą store.
  const jobStore = require("../utils/jobStore");
  await jobStore.init();
  return init({ persistentStoreAvailable: jobStore.getBackend() === "redis" });
}

async function enqueueTranscription(jobId, payload) {
  await ensureInitialized();
  if (_mode === "bullmq") {
    const { addTranscriptionJob } = require("./transcriptionQueue");
    await addTranscriptionJob(jobId, payload);
  } else {
    // Inline: vykdom po atsakymo (setImmediate), kad neblokuotų HTTP atsakymo.
    setImmediate(() => _runInline("transcription", jobId, payload));
  }
}

async function enqueueProtocol(jobId, payload) {
  await ensureInitialized();
  if (_mode === "bullmq") {
    const { addProtocolJob } = require("./protocolQueue");
    await addProtocolJob(jobId, payload);
  } else {
    setImmediate(() => _runInline("protocol", jobId, payload));
  }
}

/**
 * Inline vykdymas - naudoja tą patį processor'ių, kaip BullMQ worker'iai, kad
 * kodas nesidubliuotų. Būsena rašoma per jobStore (kaip ir worker'iuose).
 */
async function _runInline(type, jobId, payload) {
  const processor = _processors[type];
  if (!processor) {
    log.error(`Nėra processor'iaus tipui '${type}'`);
    return;
  }

  /**
   * Inline vykdymas `setImmediate` metu jau NEBETURI HTTP užklausos konteksto -
   * AsyncLocalStorage scope baigėsi kartu su atsakymu. Todėl kontekstą
   * atkuriam iš jobo metaduomenų, lygiai kaip tai daro BullMQ worker'iai.
   * Kitaip inline ir worker keliai duotų skirtingą koreliaciją.
   */
  const { runWithContext } = require("../utils/requestContext");

  // Koreliacijos metaduomenys yra PAPILDOMI: jei jų gauti nepavyksta, darbas
  // vis tiek turi vykti. Observability niekada negali tapti vykdymo sąlyga.
  let job = null;
  try {
    if (typeof jobStore.get === "function") job = await jobStore.system.get(jobId);
  } catch {
    job = null;
  }

  return runWithContext(
    {
      requestId: (job && job.requestId) || null,
      actor: (job && job.actor) || null,
      // Rolė keliauja kartu su kontekstu, kad servisai galėtų ja remtis
      // nekviesdami saugyklos iš naujo (#18 PR3).
      actorRole: (job && job.actorRole) || null,
      execution: "inline",
    },
    async () => {
      /**
       * AUTORIZACIJA VYKDYMO METU (#18 PR3).
       *
       * HTTP sluoksnis patikrino teisę jobo KŪRIMO metu. Bet tarp kūrimo ir
       * vykdymo gali praeiti daug laiko, per kurį vartotojas gali būti
       * pašalintas ar jo rolė sumažinta. Tikrinam DABARTINĘ būklę - kitaip
       * revokacija neveiktų eilėje laukiantiems darbams.
       */
      /**
       * IŠTRYNIMO ŽYMA – TIKRINAMA PIRMA (#19 PR3).
       *
       * Ta pati apsauga kaip BullMQ worker'yje. Abu keliai turi elgtis
       * vienodai: priešingu atveju ištrynimo garantija priklausytų nuo to, ar
       * sukonfigūruotas Redis – t. y. būtų nenuspėjama.
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
        log.warn("Praleistas darbas dėl priežiūros užrakto", { stage: "skipped_maintenance", jobId, execution: "inline" });
        return;
      }

      if (tombstones.isDeleted(jobId)) {
        log.warn("Praleistas ištrinto jobo vykdymas", { stage: "skipped_deleted", jobId, execution: "inline" });
        return;
      }

      const decision = authorizeJobOrAudit(job, jobId);

      if (!decision.allowed) {
        await jobStore.system.update(jobId, {
          status: jobStore.STATUS.FAILED,
          error_code: "AUTHORIZATION_REVOKED",
          error_message: "Vykdymas nutrauktas: aktoriaus teisės nebegalioja.",
        });
        return;
      }

      return _executeInline(type, processor, jobId, payload);
    }
  );
}

async function _executeInline(type, processor, jobId, payload) {
  /**
   * GRANDINĖS ĮVYKIAI rašomi ČIA, kur baigtis realiai žinoma (GDPR #17).
   *
   * Pirmoji versija apvyniojo šią funkciją iš išorės ir sprendė pagal tai, ar
   * ji metė klaidą. Bet ji klaidas apdoroja VIDUJE - jobas pažymimas `failed`,
   * o iškvietimas grįžta normaliai. Rezultatas: logas rašė `stage: completed`
   * jobui, kurio statusas `failed`. Meluojantis observability įvykis blogesnis
   * už jokio - juo remiantis tyrimas nueitų ne ta kryptimi.
   */
  const started = Date.now();
  log.info("Darbas pradėtas", { stage: "processing", execution: "inline", jobType: type, jobId });

  try {
    await jobStore.system.update(jobId, { status: jobStore.STATUS.PROCESSING, attempt_count: 1 });
    const result = await processor(payload, jobId);

    /**
     * REZULTATO RIBA PRIEŠ RAŠYMĄ Į STORE (#153).
     *
     * Vienoje vietoje SĄMONINGAI: taip memory ir Redis backend'ai matuoja
     * vienodai, ir riba nepriklauso nuo serializacijos detalių. Matuojamas TIK
     * `result` payload'as – ne visas job objektas su laiko žymomis, statusu ir
     * audito laukais, kitaip riba imtų priklausyti nuo sistemos pridėtų
     * metaduomenų, o ne nuo tiekėjo atsakymo dydžio.
     *
     * Metama PRIEŠ `update`, tad `catch` žemiau pažymi job'ą `failed` su
     * `RESULT_TOO_LARGE`, o rezultato artefaktas neišsaugomas.
     */
    assertResultWithinLimits(result);

    await jobStore.system.update(jobId, { status: jobStore.STATUS.COMPLETED, result });

    log.info("Darbas baigtas", {
      stage: "completed",
      execution: "inline",
      jobType: type,
      jobId,
      durationMs: Date.now() - started,
    });
  } catch (e) {
    const { errorCode, message } = _classifyError(e, `${type} job`);
    await jobStore.system.update(jobId, { status: jobStore.STATUS.FAILED, error: message, error_code: errorCode });

    // Pranešimas jau sanitizuotas `_classifyError`; kodas yra enum.
    log.warn("Darbas nepavyko", {
      stage: "failed",
      execution: "inline",
      jobType: type,
      jobId,
      errorCode,
      durationMs: Date.now() - started,
    });
  } finally {
    // Inline režimas neturi retry - tad audio galima trinti iškart po galutinio
    // statuso (sėkmė ar nesėkmė). Trinam tik jei payload turi storageKey (transkripcija).
    if (payload && payload.storageKey) {
      // storageKey nulinamas TIK po sėkmingo trynimo - žr. utils/audioCleanup.js.
      const { releaseAudio } = require("../utils/audioCleanup");
      await releaseAudio(jobId, payload.storageKey);
    }
  }
}

// Klaidos klasifikacija (bendra inline ir worker'iams). Vidinės (500/nežinomos)
// klaidos SANITIZUOJAMOS - kad paslaptys (API raktai, keliai) nepatektų į jobStore,
// kurį skaito klientas per GET /api/jobs/:id. HttpError su ne-500 statusu (validacija,
// override) yra saugu rodyti kaip yra.
function _classifyError(e, context = "job") {
  const { sanitizeServerError } = require("../utils/sanitizeError");

  /**
   * RIBOS VIRŠIJIMAS TURI DOMENINĮ KODĄ (#153).
   *
   * Be šios šakos `ResultLimitError` būtų klasifikuotas kaip `internal_error`,
   * o pranešimas – sanitizuotas. Vartotojas ir operatorius nematytų, KODĖL
   * darbas nepavyko, nors priežastis yra visiškai konkreti ir ne serverio
   * klaida: tiekėjo atsakymas per didelis.
   *
   * `kind`, `limit` ir `actual` yra saugūs rodyti – tai nėra vidinė
   * informacija, o konfigūracijos reikšmės ir išmatuotas dydis.
   */
  /**
   * `UnrecoverableError` gali gaubti `ResultLimitError` (#153): worker'is taip
   * sustabdo retry grandinę. Originali klaida perduodama per `cause`, tad
   * domeninis kodas turi būti imamas iš jos, ne iš gaubiančios klaidos.
   */
  const domeninė = e && e.cause && e.cause.name === "ResultLimitError" ? e.cause : e;

  if (domeninė && domeninė.name === "ResultLimitError") {
    return {
      errorCode: domeninė.code,
      message: `${domeninė.message} (riba: ${domeninė.kind})`,
    };
  }

  if (e && e.statusCode && e.statusCode !== 500) {
    return { errorCode: `http_${e.statusCode}`, message: e.message };
  }
  return { errorCode: "internal_error", message: sanitizeServerError(e, context) };
}

async function close() {
  if (_mode === "bullmq") {
    const { closeTranscriptionQueue } = require("./transcriptionQueue");
    const { closeProtocolQueue } = require("./protocolQueue");
    await closeTranscriptionQueue().catch(() => {});
    await closeProtocolQueue().catch(() => {});
  }
}

module.exports = {
  init,
  getMode,
  registerProcessor,
  enqueueTranscription,
  enqueueProtocol,
  close,
  _classifyError, // eksportuojama testams
  _runInline, // eksportuojama testams (audio valymo regresija)
};

// AUTO-registracija: processor'iai užregistruojami vos įkėlus modulį, kad inline
// režimas veiktų ir tada, kai importuojamas tik `app` (pvz. testuose per supertest),
// ne visas server.js. Reikalaujame čia (o ne viršuje) - kad išvengtume ciklinės
// priklausomybės (processors -> services, ne atgal į jobRunner).
try {
  const { transcriptionProcessor, protocolProcessor } = require("./processors");
  registerProcessor("transcription", transcriptionProcessor);
  registerProcessor("protocol", protocolProcessor);
} catch {
  // Jei processors dar neįkeliami (pvz. dalinė testų aplinka), tylим - server.js
  // vis tiek registruos per registerProcessors().
}
