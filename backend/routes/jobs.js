const express = require("express");
const jobStore = require("../utils/jobStore");
const { serializeJob } = require("../utils/jobResponse");
const jobRunner = require("../queues/jobRunner");
const rateLimiter = require("../middleware/rateLimiter");
const { pollRateLimiter } = require("../middleware/rateLimiter");
const authenticate = require("../middleware/authenticate");
const { requirePermission } = require("../middleware/authorize");
const { PERMISSIONS } = require("../utils/permissions");
const lifecycleService = require("../services/lifecycleService");
const { getRequestId, getActor } = require("../utils/requestContext");
const { getOwnerScope } = require("../utils/ownerScope");
const {
  ACCESS_DECISION,
  OPERATION,
  resolveJobAccess,
  respondToDenial,
} = require("../utils/jobAccessTransport");
const adminJobService = require("../services/adminJobService");
const { createLogger } = require("../utils/logger");
const { validate, schemas } = require("../middleware/validate");
const { AuditWriteError } = require("../utils/auditWrite");
const { auditoGedimas } = require("../utils/auditHttp");
const log = createLogger("route:jobs");



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
  const { decision, job } = await resolveJobAccess(req, req.params.id, OPERATION.READ);
  if (
    respondToDenial(decision, res, {
      notFoundMessage:
        "Jobas nerastas (galbūt serveris persileido, o job store buvo tik atmintyje - persistencijai naudokite Redis).",
    })
  ) {
    return;
  }

  // #154: bendras serializatorius – fazių ir progreso kontraktas vienodas
  // abiejuose endpoint'uose (anksčiau `progress` grąžindavo tik vienas).
  res.json(serializeJob(job));
});

/**
 * DELETE /api/jobs/:id - GDPR ištrynimas protokolo jobams.
 *
 * Simetriškas DELETE /api/transcribe-jobs/:id. Buvo praleistas, nors būtent
 * protokolo jobai laiko jautriausius duomenis: payload'e - visa TRANSKRIPCIJA
 * ir dalyvių sąrašas, rezultate - sugeneruotas protokolas.
 */
router.delete("/jobs/:id", rateLimiter, authenticate, requirePermission(PERMISSIONS.JOB_DELETE), validate({ params: schemas.jobIdParam }), async (req, res) => {
  /**
   * SPRENDIMŲ MEDIS (#160).
   *
   *   job'as       → įprastas savininko DELETE (žemiau)
   *   FORBIDDEN    → session-admin: override; kitiems 404
   *   nėra (null)  → session-admin: našlaičių valymas; kitiems 404 BE VALYMO
   *
   * ⚠️ ELGESIO PAKEITIMAS: anksčiau `null` atveju našlaičių valymas vykdavo
   * BET KURIAM vartotojui. Kai store įrašo nebėra, nuosavybės patikrinti
   * neįmanoma (`ownershipVerified: false`), tad eilinis vartotojas, žinantis
   * job ID, galėjo ištrinti svetimus BullMQ ir audito pėdsakus.
   */
  const { decision, job, actor } = await resolveJobAccess(req, req.params.id, OPERATION.DELETE);
  if (respondToDenial(decision, res)) return;

  if (decision === ACCESS_DECISION.ADMIN_DELETE_OVERRIDE) {
      /**
       * ⚠️ BLOKUOJANTIS ADMIN AUDITAS GALI ATMESTI (#155, 7.4a / #210).
       *
       * `ADMIN_DELETE_OVERRIDE`, `ADMIN_ORPHAN_CLEANUP` ir `ADMIN_ACCESS_DENIED`
       * yra blokuojantys. Be šio sargo `AuditWriteError` nukristų į Express
       * numatytąjį kelią - klientas gautų 500/HTML vietoj dokumentuoto
       * sanitizuoto `503 AUDIT_WRITE_FAILED`, o ne produkcijoje atsakyme galėtų
       * atsirasti ir pirminė backend'o klaida iš stack trace.
       */
    let result;
    try {
      result = await adminJobService.adminDeleteJob(req.params.id, actor);
    } catch (error) {
      if (error instanceof AuditWriteError) return auditoGedimas(res, error, "jobs admin auditas");
      throw error;
    }
    if (result.deleted) return res.status(204).send();
    if (result.reason === "vanished") {
      return res.status(404).json({ error: "Jobas nerastas." });
    }
    return res.status(503).json({
      error: "Nepavyko visiškai ištrinti jobo duomenų. Užklausą galima pakartoti.",
      deletion: result.result,
    });
  }

  if (
    decision === ACCESS_DECISION.ADMIN_ORPHAN_CLEANUP ||
    decision === ACCESS_DECISION.DESKTOP_ORPHAN_CLEANUP
  ) {
    let result;
    try {
      result =
        decision === ACCESS_DECISION.ADMIN_ORPHAN_CLEANUP
          ? await adminJobService.adminCleanupOrphan(req.params.id, actor)
          : await adminJobService.desktopCleanupOrphan(req.params.id, actor);
    } catch (error) {
      if (error instanceof AuditWriteError) return auditoGedimas(res, error, "jobs admin auditas");
      throw error;
    }
    if (!result.cleaned) {
      log.error(
        `NEPAVYKO ištrinti likusių jobo ${req.params.id} duomenų: ${result.outcome.errors.join("; ")}`
      );
      return res.status(503).json({
        error: "Nepavyko visiškai ištrinti jobo duomenų. Užklausą galima pakartoti.",
        deletion: result.outcome,
      });
    }
    if (result.outcome.found) return res.status(204).send();
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
  /**
   * ⚠️ IŠTRYNIMO AUDITAS YRA BLOKUOJANTIS, TAD GALI ATMESTI.
   *
   * `LIFECYCLE_DELETION` (ir jo viduje `DATA_ERASED`) po 7.4a laukia
   * patvirtinto įrašo. Be šio sargo `AuditWriteError` nukristų į Express
   * numatytąjį kelią - klientas gautų 500/HTML vietoj dokumentuoto
   * `503 AUDIT_WRITE_FAILED`, o ne produkcijoje atsakyme galėtų atsirasti
   * pirminė backend'o klaida. Administraciniai keliai šį sargą jau turi;
   * savininko kelias negali būti išimtis (AGENTS.md §16).
   */
  let result;
  try {
    result = await lifecycleService.deleteJobArtefacts(job, job.id, {
      actor: req.authz ? req.authz.actor : null,
    });
  } catch (error) {
    if (error instanceof AuditWriteError) return auditoGedimas(res, error, "jobs ištrynimo auditas");
    throw error;
  }

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
