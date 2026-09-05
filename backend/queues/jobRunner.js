const { AuditWriteError } = require("../utils/auditWrite");
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
 * DU REŽIMAI (parenkama per `jobStore.hasQueueBackend()`: REDIS_URL IR bendra saugykla):
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

  /**
   * KRITIŠKA (nuoseklumas): BullMQ naudojamas TIK jei jobStore REALIAI turi BENDRĄ
   * saugyklą. Jei jobStore Redis connect nepavyko ir jis fallback'ino į memory, o
   * jobRunner vis tiek naudotų BullMQ, gautume NESUDERINTĄ sistemą: HTTP procesas
   * job'ą kuria atmintyje, siunčia į BullMQ, worker jo neranda.
   *
   * ⚠️ ATSARGINIS KELIAS NEBEREMIASI `REDIS_URL` BUVIMU (#155, 7.2a).
   *
   * Anksčiau čia buvo `!!process.env.REDIS_URL`. Šiandien `server.js` visada
   * perduoda `persistentStoreAvailable`, tad kelias negyvas - bet negyvas
   * netiesiogiai, o ne pagal konstrukciją: pirmas kvietėjas, praleidęs
   * argumentą, gautų `true` VIEN dėl to, kad nustatytas `REDIS_URL`, net jei
   * metaduomenys atmintyje arba PostgreSQL'e be bendros eilės sąlygos.
   *
   * `hasQueueBackend()` yra tas pats autoritetas, kurį naudoja `server.js` ir
   * `workers/index.js` - tad numatytoji reikšmė sutampa su eksplicitine.
   */
  const persistentStore =
    options.persistentStoreAvailable !== undefined
      ? options.persistentStoreAvailable
      : jobStore.hasQueueBackend();

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
  /**
   * ⚠️ TAS PATS SPRENDIMAS KAIP `server.js` ir `workers/index.js` (#155, 7.2a).
   * `getBackend() === "redis"` čia reikštų, kad PostgreSQL metaduomenys
   * nukreiptų tinginį inicijavimą į inline režimą, nors Redis eilė veikia.
   */
  return init({ persistentStoreAvailable: jobStore.hasQueueBackend() });
}

async function enqueueTranscription(jobId, payload) {
  await ensureInitialized();
  if (_mode === "bullmq") {
    const { addTranscriptionJob } = require("./transcriptionQueue");
    await addTranscriptionJob(jobId, payload);
  } else {
    // Inline: vykdom po atsakymo (setImmediate), kad neblokuotų HTTP atsakymo.
    setImmediate(() => _paleistiInline("transcription", jobId, payload));
  }
}

async function enqueueProtocol(jobId, payload) {
  await ensureInitialized();
  if (_mode === "bullmq") {
    const { addProtocolJob } = require("./protocolQueue");
    await addProtocolJob(jobId, payload);
  } else {
    setImmediate(() => _paleistiInline("protocol", jobId, payload));
  }
}

/**
 * Inline vykdymas - naudoja tą patį processor'ių, kaip BullMQ worker'iai, kad
 * kodas nesidubliuotų. Būsena rašoma per jobStore (kaip ir worker'iuose).
 */
/**
 * INLINE PALEIDĖJO SARGAS (#155, 7.4a).
 *
 * ⚠️ `setImmediate(() => _runInline(...))` GRĄŽINTO PROMISE NIEKAS NELAIKO.
 *
 * `_runInline` viduje yra `await` kvietimų (autorizacija, `jobStore.system.finish`),
 * kurių atmetimas be šio sargo taptų `unhandledRejection`. Tai NĖRA tylus
 * nurijimas: kelias jau turi savo deterministinį perėjimą, o čia lieka tik
 * paskutinė riba, kuri gedimą PARODO, o ne paslepia.
 */
function _paleistiInline(type, jobId, payload) {
  return _runInline(type, jobId, payload).catch((error) =>
    log.error("Inline vykdymas nutrūko netikėtai", {
      stage: "inline_launch_failed",
      jobId,
      type,
      klaida: error && error.message,
    })
  );
}

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

      /** ⚠️ `await` PRIVALOMAS - be jo Promise truthy, ir KIEKVIENAS jobas praleidžiamas (#183). */
      if (await tombstones.isDeleted(jobId)) {
        log.warn("Praleistas ištrinto jobo vykdymas", { stage: "skipped_deleted", jobId, execution: "inline" });
        return;
      }

      /**
       * ⚠️ BLOKUOJANTIS AUDITAS GALI ATMESTI (#155, 7.4a / #210).
       *
       * `authorizeJobOrAudit()` po cutover laukia `JOB_EXECUTION_DENIED`
       * įrašo patvirtinimo. Inline režimu `_runInline` paleidžiamas per
       * `setImmediate(() => ...)`, tad jo Promise NIEKAS nelaiko: atmetimas
       * čia taptų `unhandledRejection`, job'as liktų neterminalus, o naujesnės
       * Node numatytosios nuostatos procesą nutrauktų.
       *
       * Fail-closed reiškia „nevykdom", bet job'as PRIVALO pasiekti terminalią
       * būseną - kitaip vartotojas amžinai apklausinėtų `processing`.
       * Atskiras `error_code` nuo `AUTHORIZATION_REVOKED`: ten teisės realiai
       * atimtos, o čia sprendimo tiesiog nepavyko užfiksuoti.
       */
      let decision;
      try {
        decision = await authorizeJobOrAudit(job, jobId);
      } catch (error) {
        /**
         * ⚠️ GAUDOMA VISKAS, BET ŽYMIMA TIKSLIAI (#210 peržiūra).
         *
         * `authorizeJobOrAudit()` meta ir dėl nesuderinamos PERSISTUOTOS
         * būsenos (nepalaikoma `schemaVersion`, nežinomas `actorSource`) - dar
         * PRIEŠ bet kokį audito rašymą. Vadinti tai `AUDIT_UNAVAILABLE` reikštų
         * siųsti operatorių ieškoti audito infrastruktūros problemos, kurios
         * nėra, o tikrąją priežastį - duomenų migracijos skolą - paslėpti.
         *
         * Persiųsti klaidą aukštyn NEGALIMA: šis kelias paleidžiamas per
         * `setImmediate`, tad job'as liktų NETERMINALUS. Todėl terminali
         * būsena garantuojama visada, o skiriasi tik `error_code`.
         */
        const auditoGedimas = error instanceof AuditWriteError;

        log.error("Autorizacija nepavyko - vykdymas nutraukiamas", {
          stage: auditoGedimas ? "audit_unavailable" : "authorization_error",
          jobId,
          execution: "inline",
          klaida: error && error.message,
        });
        await jobStore.system.finishFailed(jobId, {
          error_code: auditoGedimas ? "AUDIT_UNAVAILABLE" : "AUTHORIZATION_ERROR",
          error_message: auditoGedimas
            ? "Vykdymas nutrauktas: nepavyko užfiksuoti autorizacijos sprendimo."
            : "Vykdymas nutrauktas: autorizacijos nepavyko įvertinti.",
        });
        /** ⚠️ `_executeInline` `finally` čia nepasiekiamas - valom patys. */
        await _atlaisvintiSaltini(jobId, payload);
        return;
      }

      if (!decision.allowed) {
        /**
         * #154: terminalus perėjimas per state machine.
         *
         * ⚠️ Neapdorotas `update({ status })` po #154 sargo META klaidą – šis
         * kelias produkcijoje būtų kritęs. Testas to nepagavo, nes tikrino tik
         * kodo TEKSTĄ (`grep AUTHORIZATION_REVOKED`), ne elgesį.
         */
        await jobStore.system.finishFailed(jobId, {
          error_code: "AUTHORIZATION_REVOKED",
          error_message: "Vykdymas nutrauktas: aktoriaus teisės nebegalioja.",
        });
        /**
         * ⚠️ Gretima pataisa (#210 recenzija): anksčiau ši šaka grįždavo be
         * valymo. Žr. `workers/index.js` paaiškinimą - iš išorės matoma baigtis
         * nesikeičia, suvienodinamas tik resursų valymas.
         */
        await _atlaisvintiSaltini(jobId, payload);
        return;
      }

      return _executeInline(type, processor, jobId, payload);
    }
  );
}

/**
 * Atlaisvina šaltinio audio TERMINALIOSE šakose, kurios grįžta anksčiau nei
 * `_executeInline()` su savo `finally`. Klaida čia nenutraukia terminalaus
 * perėjimo: job'as jau pažymėtas, o nepavykęs valymas kartojamas per
 * `deletionRetry`.
 */
async function _atlaisvintiSaltini(jobId, payload) {
  if (!payload || !payload.storageKey) return;

  /**
   * ⚠️ BARJERAS GALIOJA IR INLINE KELYJE (Codex peržiūros A grupė).
   *
   * 7.5b barjerą įdėjo tik į `workers/_cleanupStorage()`, ir tai uždarė WORKER
   * kelią. Inline vykdymas turi SAVO valymo funkciją ir savo `finally` bloką,
   * tad jis liko be barjero visiškai: `finish()` grąžinus
   * `COMPLETED_WITHOUT_RESULT`, ši šaka metė klaidą, o `finally` vis tiek
   * ištrindavo šaltinio audio — pašalindama medžiagą, kurios reikia remontui.
   *
   * Autoritetas vienas abiem keliams: `utils/audioBarrier.js`.
   */
  const { salintiAudioSuBarjeru } = require("../utils/audioBarrier");
  await salintiAudioSuBarjeru(jobId, payload, { execution: "inline" }).catch((e) =>
    log.error(`Nepavyko atlaisvinti audio nutraukus vykdymą (job ${jobId}): ${e.message}`)
  );
}

async function _executeInline(type, processor, jobId, payload) {
  /**
   * Ar terminalus perėjimas realiai ĮSIPAREIGOTAS saugykloje? Nustatoma abiejose
   * šakose (`finish` ir `finishFailed`); `finally` pagal tai sprendžia dėl audio.
   */
  let terminalasIsipareigotas = false;
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
    // #154: darbo pradžia eina per state machine – `restart()` nustato
    // `processing` KARTU su pradine faze, tad `processing + phase=null`
    // neatsiranda net akimirkai.
    await jobStore.system.restart(jobId, { attempt_count: 1 });
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

    /**
     * ⚠️ GRĄŽINIMAS TIKRINAMAS (#184, 7.5b). `finish()` gali grąžinti
     * `CONCURRENCY_CONFLICT`, o ignoruotas konfliktas reikštų, kad `inline`
     * kelias praneša sėkmę apie rezultatą, kurio neįsipareigojo. Klaida čia yra
     * teisingas atsakymas: `catch` šaka žemiau pažymės job'ą `failed` per
     * `finishFailed()`, kuris JAU `completed` įrašo nebeperrašo.
     */
    const uzbaigtas = await jobStore.system.finish(jobId, jobStore.STATUS.COMPLETED, { result });
    terminalasIsipareigotas = typeof uzbaigtas !== "symbol" && uzbaigtas !== null;
    if (typeof uzbaigtas === "symbol") {
      /**
       * ⚠️ VISI KONFLIKTO SIMBOLIAI — VIENA ŠAKA (#184, 7.5b).
       *
       * `inline` kelias audio valymo sprendimo nepriima pats (jį daro
       * `_executeInline` `finally` per `_atlaisvintiSaltini`), tad čia
       * pakanka NEPRANEŠTI sėkmės. `typeof === "symbol"` apima ir ateities
       * baigtis: naujas simbolis negalės tyliai praeiti kaip job objektas.
       */
      throw new Error(
        `Job rezultatas NEĮSIPAREIGOTAS (${String(uzbaigtas)}): ${jobId}. Įrašą pakeitė kitas vykdytojas.`
      );
    }

    log.info("Darbas baigtas", {
      stage: "completed",
      execution: "inline",
      jobType: type,
      jobId,
      durationMs: Date.now() - started,
    });
  } catch (e) {
    const { errorCode, message } = _classifyError(e, `${type} job`);
    const nesekme = await jobStore.system.finishFailed(jobId, { error: message, error_code: errorCode });
    terminalasIsipareigotas = typeof nesekme !== "symbol" && nesekme !== null;

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
    /**
     * Inline režimas neturi retry - tad audio galima trinti iškart po galutinio
     * statuso (sėkmė ar nesėkmė).
     *
     * ⚠️ BET TIK PO ĮSIPAREIGOTO PERĖJIMO, IR TIK PER BARJERĄ.
     *
     * Dvi atskiros sąlygos, nes jos gina skirtingus dalykus:
     *
     *   · `terminalasIsipareigotas` — ar būsena APSKRITAI pasikeitė. Jei ir
     *     `finish(COMPLETED)`, ir `finishFailed()` pralaimėjo CAS, įrašas lieka
     *     `processing`, o barjeras ne-terminalį sąmoningai praleidžia (kitaip
     *     audio failai kauptųsi). Be šios sąlygos šaltinis būdavo ištrinamas
     *     paliekant AKTYVŲ job'ą be įvesties — Codex tai atkūrė.
     *   · barjeras — ar būsena, į kurią perėjom, apskritai leidžia šalinti
     *     (`completed` be rezultato yra remontuotina).
     *
     * ⚠️ SIMETRIŠKA `workers/_handleFailure()`. Tas pats sprendimas dviejuose
     * vykdymo keliuose; skiriasi tik tai, iš kur ateina baigtis.
     */
    if (terminalasIsipareigotas) {
      const { salintiAudioSuBarjeru } = require("../utils/audioBarrier");
      await salintiAudioSuBarjeru(jobId, payload, { execution: "inline" });
    } else if (payload && payload.storageKey) {
      log.error("Terminalus perėjimas NEĮSIPAREIGOTAS - audio NEŠALINAMAS", {
        stage: "finish_not_committed",
        execution: "inline",
        jobId,
      });
    }
  }
}

// Klaidos klasifikacija (bendra inline ir worker'iams). Vidinės (500/nežinomos)
// klaidos SANITIZUOJAMOS - kad paslaptys (API raktai, keliai) nepatektų į jobStore,
// kurį skaito klientas per GET /api/jobs/:id. HttpError su ne-500 statusu (validacija,
// override) yra saugu rodyti kaip yra.
/**
 * VIEŠI ARTEFAKTŲ SAUGYKLOS PRANEŠIMAI - PAGAL KODĄ (#157, PR-2, Codex #290).
 *
 * ⚠️ KIEKVIENAS KODAS TURI SAVO TEKSTĄ, IR TAI NE KOSMETIKA. „Objekto nėra"
 * siunčia remontą į atkūrimą, „turinys sugadintas" - į vientisumo tyrimą, o
 * „rezultatas nesaugotinas" reiškia, kad kartoti nėra prasmės. Vienas bendras
 * tekstas visus tris paverstų ta pačia neinformatyvia eilute.
 */
const VIESI_ARTEFAKTU_PRANESIMAI = Object.freeze({
  ARTIFACT_VALUE_UNSUPPORTED: "Rezultato nepavyko išsaugoti: jo turinys neatitinka saugyklos reikalavimų.",
  ARTIFACT_KEY_INVALID: "Rezultato nepavyko išsaugoti: neteisingas saugyklos adresas.",
  ARTIFACT_NOT_FOUND: "Rezultato saugykloje nėra.",
  ARTIFACT_CORRUPT: "Rezultatas saugykloje yra, bet jo turinys neperskaitomas.",
  ARTIFACT_CONFIG_INVALID: "Artefaktų saugykla sukonfigūruota neteisingai.",
  NEZINOMA: "Rezultato saugyklos klaida.",
});

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
  const NEATKARTOJAMOS = ["ResultLimitError", "ArtifactStoreError"];
  const domeninė = e && e.cause && NEATKARTOJAMOS.includes(e.cause.name) ? e.cause : e;

  /**
   * FAZĖS KLAIDA TURI SAVO KODĄ (#154).
   *
   * Nelegalus perėjimas ar `status × phase` pažeidimas produkcijoje reiškia
   * state corruption arba programavimo klaidą – ne laikiną tiekėjo gedimą.
   * Be atskiros šakos tai virstų `internal_error` ir taptų neatskiriama nuo
   * bet kokios kitos vidinės klaidos, nors reikalauja visiškai kitokio
   * tyrimo.
   *
   * `code` yra enum (`ILLEGAL_TRANSITION`, `PHASE_NOT_ALLOWED_FOR_TYPE`,
   * `JOB_ALREADY_TERMINAL`, …), o pranešime nėra vidinės informacijos – tik
   * fazių pavadinimai ir job tipas.
   */
  if (domeninė && domeninė.name === "JobPhaseError") {
    return { errorCode: domeninė.code, message: domeninė.message };
  }

  /**
   * ARTEFAKTŲ SAUGYKLOS KLAIDA TURI SAVO KODĄ (#157, PR-2).
   *
   * ⚠️ STRUKTŪRINIS ATMETIMAS NĖRA `internal_error`. `Date` rezultate arba NUL
   * simbolis tekste nuo kartojimo neišnyks, ir operatoriui reikia matyti, KAS
   * nutiko: `ARTIFACT_VALUE_UNSUPPORTED` pasako, kad rezultatas nesaugotinas,
   * o `ARTIFACT_NOT_FOUND` — kad dingo objektas. Suplakus juos į vieną kodą,
   * abu virstų ta pačia neinformatyvia eilute.
   *
   * ⚠️ RETRY GRANDINĘ SUSTABDO KVIETĖJAS, NE ŠI ŠAKA. Klasifikatorius tik
   * įvardija; `UnrecoverableError` vyniojimas gyvena completion kelyje (PR-4),
   * kaip ir `assertResultWithinLimits` atveju.
   */
  if (domeninė && domeninė.name === "ArtifactStoreError") {
    /**
     * ⚠️ VIEŠAS PRANEŠIMAS GAMINAMAS IŠ KODO, NE IŠ `message` (Codex, #290).
     *
     * `ArtifactStoreError.message` nešasi `JSON.parse` diagnostiką, į kurią Node
     * įdeda ARTEFAKTO TURINIO fragmentą — transkripcijų atveju asmenvardžius,
     * adresus ar sveikatos informaciją. Šis laukas keliauja į job'o klaidos
     * įrašą, kurį savininkas mato per `GET /api/jobs/:id`.
     *
     * ⚠️ TAI TA PATI TAISYKLĖ KAIP `sanitizeServerError`: pilnas tekstas lieka
     * serverio loge, o kvietėjui atiduodama tik tai, kas parašyta MŪSŲ.
     * Skirtumas — kodas išsaugomas, nes pagal jį operatorius sprendžia, ar
     * ieškoti dingusio objekto, ar tirti vientisumą.
     */
    log.error("Artefaktų saugyklos klaida", {
      stage: "artifact_store",
      context,
      errorCode: domeninė.code,
      message: domeninė.message,
      priezastis: domeninė.priezastis,
    });

    return {
      errorCode: domeninė.code,
      message: VIESI_ARTEFAKTU_PRANESIMAI[domeninė.code] || VIESI_ARTEFAKTU_PRANESIMAI.NEZINOMA,
    };
  }

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
