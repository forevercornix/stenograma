const express = require("express");
const jobStore = require("../utils/jobStore");
const jobRunner = require("../queues/jobRunner");
const rateLimiter = require("../middleware/rateLimiter");
const { pollRateLimiter } = require("../middleware/rateLimiter");
const authenticate = require("../middleware/authenticate");
const { requirePermission } = require("../middleware/authorize");
const { PERMISSIONS } = require("../utils/permissions");
const { eraseOrphanedJobData } = require("../utils/jobErasure");
const lifecycleService = require("../services/lifecycleService");
const { getRequestId, getActor } = require("../utils/requestContext");
const { getOwnerScope } = require("../utils/ownerScope");
const { createLogger } = require("../utils/logger");
const { validate, schemas } = require("../middleware/validate");
const log = createLogger("route:jobs");

/**
 * SVETIMO JOB'O APDOROJIMAS (#159).
 *
 * `jobStore.get()` grąžina TRIS skirtingus rezultatus: job'ą, `null` (nėra) ir
 * `jobStore.FORBIDDEN` (yra, bet svetimas). `FORBIDDEN` yra `Symbol`, o
 * `Symbol` yra TRUTHY – todėl įprasta `if (!job)` patikra jo NEPAGAUNA ir
 * svetimas įrašas praeitų toliau kaip savas.
 *
 * FAIL-CLOSED, LAIKINAI 404. Galutinę 403 vs 404 politiką (ir admin override)
 * sprendžia #160. Iki tol grąžinamas 404: jis neatskleidžia, ar job'as
 * egzistuoja, tad saugesnis pasirinkimas neapsisprendus. Store informacijos
 * nepraranda – skirtumas tarp `null` ir `FORBIDDEN` išlieka kontrakte, tad
 * #160 galės jį pakeisti nekeisdamas duomenų sluoksnio.
 *
 * @returns {boolean} ar užklausa jau atsakyta (kvietėjas privalo grįžti)
 */
function denyIfForbidden(job, res) {
  if (job === jobStore.FORBIDDEN) {
    res.status(404).json({ error: "Jobas nerastas." });
    return true;
  }
  return false;
}


/**
 * Job'o AKTORIUS (#158).
 *
 * `schemaVersion: 2` įrašuose `actor` yra STABILUS `userId`, ne vardas –
 * todėl pervadinimas nebenutraukia eilėje laukiančio darbo.
 *
 * API rakto kelyje `req.user` nėra, ir `getActor()` grąžina rakto atspaudą
 * (`key_<hex>`) – tai teisinga, nes tokį įrašą sprendžia `resolveApiKeyRole`.
 *
 * ANOMALIJA: sesija YRA, bet be `userId`. Po #158 diegimo taip neturi būti –
 * `verifyCredentials()` visada grąžina `id`, o sesijos gyvena atmintyje ir
 * restarto neišgyvena.
 *
 * KODĖL FAIL-FAST, NE ĮSPĖJIMAS. `newJob()` tokiam įrašui vis tiek duotų
 * `schemaVersion: 2`, tad `jobAuthorization` aiškintų įrašytą VARDĄ kaip
 * `userId`, ID paieška nepavyktų, ir darbas žūtų `ACTOR_UNKNOWN` – jau
 * suvartojęs eilės vietą ir vartotojo laukimą. Iš anksto pasmerktas job'as
 * yra blogesnis už atmestą užklausą, tad anomalija sustabdoma PRIEŠ enqueue.
 *
 * Desktop / no-auth režimas čia nepatenka: ten `req.user` išvis nėra.
 *
 * @returns {{ok: true, actor: string} | {ok: false}}
 */
function jobActor(req, log) {
  if (req.user) {
    if (req.user.id) return { ok: true, actor: req.user.id };

    log.error(
      { username: req.user.username },
      "Sesija be stabilaus userId - job'as neku­riamas (#158 anomalija). " +
        "Tikėtina priežastis: sesija sukurta iš tapatybės be AUTH_USERS userId lauko."
    );
    return { ok: false };
  }
  return { ok: true, actor: getActor() };
}

const router = express.Router();

/**
 * POST /api/jobs - ASINCHRONINIS variantas POST /api/generate.
 *
 * Rekomenduojamas ilgiems susitikimams (1-2 val. transkripcijoms, lėtesniems
 * tiekėjams) - klientas gauna jobId IŠ KARTO (nelaukdamas LLM atsakymo per tą
 * patį HTTP ryšį) ir toliau apklausia GET /api/jobs/:id kas kelias sekundes.
 *
 * body: tas pats kaip POST /api/generate.
 * response: { jobId, status: "queued" }
 *
 * PASTABA: šis jobStore yra atmintyje (žr. utils/jobStore.js) - MVP pavyzdys,
 * kaip struktūruoti async pipeline'ą, ne pilna production queue (Redis/BullMQ/
 * SQS) su retry politika, dead-letter queue ir keliais worker procesais.
 */
router.post("/jobs", rateLimiter, authenticate, requirePermission(PERMISSIONS.JOB_CREATE), validate({ body: schemas.protocolJobBody }), async (req, res) => {
  const body = req.validated.body;

  const actor = jobActor(req, log);
  if (!actor.ok) {
    return res.status(500).json({
      error: "Nepavyko nustatyti stabilios vartotojo tapatybės. Kreipkitės į administratorių.",
      code: "IDENTITY_UNAVAILABLE",
    });
  }

  const job = await jobStore.create({
    type: jobStore.JOB_TYPES.PROTOCOL,
    // Koreliacija su HTTP užklausa (GDPR #17).
    requestId: getRequestId(),
    // #159: DUOMENŲ nuosavybė - atskira nuo `actor` (vykdytojo tapatybės).
    ...getOwnerScope(req),
    actor: actor.actor,
    // Rolė ir mechanizmas - autorizacijai atkurti worker'yje (#18 PR3).
    // Kredencialų (tokenų, cookie, slaptažodžių) čia NĖRA ir negali būti.
    actorRole: req.authz ? req.authz.role : null,
    actorSource: req.authz ? req.authz.source : null,
  });

  // HTTP endpoint'as TIK įdeda jobą į eilę (BullMQ) arba paleidžia inline (be Redis)
  // ir grąžina 202. Protokolo generavimo (LLM) darbą vykdo worker procesas ar
  // setImmediate - ne šis HTTP handler'is. Žr. queues/jobRunner.js.
  await jobRunner.enqueueProtocol(job.id, body);

  /**
   * GRANDINĖS ĮVYKIS (GDPR #17: „Logs correlate request, queue, worker,
   * provider and completion events").
   *
   * `requestId` pridedamas AUTOMATIŠKAI iš konteksto, tad kiekviena grandis
   * pati nurodo tik savo etapą. Be šių įvykių koreliacija egzistuotų tik
   * teoriškai: ID keliautų, bet loguose nebūtų ką sujungti.
   */
  log.info("Jobas priimtas", { stage: "queued", jobType: "protocol", jobId: job.id });

  res.status(202).json({ jobId: job.id, status: job.status });
});

/**
 * GET /api/jobs/:id - būsenos/rezultato apklausa (polling).
 * response: { jobId, status: queued|processing|completed|failed, result?, error?, createdAt, updatedAt }
 */
router.get("/jobs/:id", pollRateLimiter, authenticate, requirePermission(PERMISSIONS.JOB_READ), validate({ params: schemas.jobIdParam }), async (req, res) => {
  const scope = getOwnerScope(req);
  const job = await jobStore.get({ jobId: req.params.id, ...scope });
  if (denyIfForbidden(job, res)) return;
  if (!job) return res.status(404).json({ error: "Jobas nerastas (galbūt serveris persileido, o job store buvo tik atmintyje - persistencijai naudokite Redis)." });

  res.json({
    jobId: job.id,
    status: job.status,
    result: job.result,
    error: job.error,
    error_code: job.error_code,
    attempt_count: job.attempt_count,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    started_at: job.started_at,
    completed_at: job.completed_at,
  });
});

/**
 * DELETE /api/jobs/:id - GDPR ištrynimas protokolo jobams.
 *
 * Simetriškas DELETE /api/transcribe-jobs/:id. Buvo praleistas, nors būtent
 * protokolo jobai laiko jautriausius duomenis: payload'e - visa TRANSKRIPCIJA
 * ir dalyvių sąrašas, rezultate - sugeneruotas protokolas.
 */
router.delete("/jobs/:id", rateLimiter, authenticate, requirePermission(PERMISSIONS.JOB_DELETE), validate({ params: schemas.jobIdParam }), async (req, res) => {
  const scope = getOwnerScope(req);
  const job = await jobStore.get({ jobId: req.params.id, ...scope });
  if (denyIfForbidden(job, res)) return;

  if (!job) {
    // jobStore įrašas galėjo dingti pagal TTL (numatytai 60 min), o BullMQ (iki
    // 24 val.) ir auditas (iki 30 d.) duomenis dar laiko. Prieš 404 pabandom
    // ištrinti tai, kas dar egzistuoja - kitaip teisė ištrinti dingtų anksčiau
    // nei patys duomenys.
    const orphan = await eraseOrphanedJobData(req.params.id, { scope: "owner", ownerId: scope.ownerId, ownerKind: scope.ownerKind });

    if (orphan.criticalFailure) {
      log.error(
        `NEPAVYKO ištrinti likusių jobo ${req.params.id} duomenų: ${orphan.errors.join("; ")}`
      );
      return res.status(503).json({
        error: "Nepavyko visiškai ištrinti jobo duomenų. Užklausą galima pakartoti.",
        deletion: orphan,
      });
    }

    if (orphan.found) return res.status(204).send();

    return res.status(404).json({ error: "Jobas nerastas." });
  }

  // Tipo patikra: abu endpoint'ai naudoja TĄ PATĮ jobStore, tad be jos transkripcijos
  // jobo ID, pateiktas šiam endpoint'ui, būtų surastas, ištrintas iš jobStore, o
  // valymas vyktų NE TOJE BullMQ eilėje - duomenys liktų, klientas gautų 204.
  // Legacy jobai (sukurti prieš `type` įvedimą) lauko neturi - jų neatmetam,
  // kitaip po deployment'o jau egzistuojantys jobai taptų neištrinami. Jiems
  // eraseJob() valo ABI eiles (žr. utils/jobErasure.js).
  if (job.type && job.type !== jobStore.JOB_TYPES.PROTOCOL) {
    return res.status(404).json({ error: "Jobas nerastas." });
  }

  const deletableStatuses = new Set([
    jobStore.STATUS.COMPLETED,
    jobStore.STATUS.FAILED,
    jobStore.STATUS.CANCELLED,
  ]);

  if (!deletableStatuses.has(job.status)) {
    return res.status(409).json({
      error:
        "Aktyvaus jobo ištrinti negalima. Palaukite, kol jis bus užbaigtas arba atšauktas.",
    });
  }

  /**
   * KOORDINUOTAS IŠTRYNIMAS PER GYVAVIMO CIKLO SERVISĄ (#19 PR2).
   *
   * Vienas įėjimo taškas vietoj tiesioginio `eraseJob`: jis uždeda žymą PRIEŠ
   * šalinimą, klasifikuoja gedimus ir grąžina stabilų struktūrizuotą rezultatą.
   */
  const result = await lifecycleService.deleteJobArtefacts(job, job.id, {
    actor: req.authz ? req.authz.actor : null,
  });

  if (!result.complete) {
    /**
     * NEGRĄŽINAME 204: jobStore įrašas sąmoningai paliktas, kad operaciją būtų
     * galima pakartoti tuo pačiu ID. GDPR ištrynime serverio logas nėra
     * pakankamas patvirtinimas – klientas turi matyti, kad nepavyko.
     *
     * ⚠️ KLAIDŲ TEKSTAI NEGRĄŽINAMI. Ankstesnė versija siuntė `outcome.errors`
     * tiesiai klientui, o juose būna failų kelių, saugyklos raktų ir Redis
     * raktų – tai prieštarauja #19 („expose no filesystem paths, storage keys,
     * Redis keys, provider payloads or deleted content"). Klientas gauna TIK
     * kategorijas; pilnas tekstas lieka serverio loguose.
     */
    log.error(`NEPAVYKO visiškai ištrinti jobo ${job.id}: statusas=${result.status}`);

    return res.status(503).json({
      error:
        "Nepavyko visiškai ištrinti jobo duomenų. Jobas paliktas, kad užklausą būtų galima pakartoti.",
      deletion: {
        status: result.status,
        categories: result.categories,
      },
    });
  }

  return res.status(204).send();
});

module.exports = router;
