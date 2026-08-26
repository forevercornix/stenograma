const { eraseJob } = require("../utils/jobErasure");
const tombstones = require("../utils/deletionTombstones");
const { ARTEFACT_TYPES } = require("../utils/artefactInventory");
const { createLogger } = require("../utils/logger");
const { rasytiAudita } = require("../utils/auditWrite");

const log = createLogger("lifecycle");

/**
 * GYVAVIMO CIKLO SERVISAS – VIENAS ĮĖJIMO TAŠKAS IŠTRYNIMUI (#19 PR2).
 *
 * KODĖL NE TIESIOG `eraseJob`.
 *
 * `utils/jobErasure.js` trina teisingai, bet grąžina PLOKŠČIUS loginius laukus
 * (`jobRemoved`, `storageRemoved`, …) ir vieną `criticalFailure` vėliavą. Iš to
 * negalima atsakyti į klausimus, kurių reikalauja #19:
 *
 *   – kurios artefaktų KATEGORIJOS liko?
 *   – ar likusios gedimo priežastys yra KARTOTINOS, ar galutinės?
 *   – ar žyma atsirado PRIEŠ šalinimą?
 *   – ar pakartotinis kvietimas duos tą patį rezultatą?
 *
 * Šis servisas nieko netrina pats – jis KOORDINUOJA: uždeda žymą, iškviečia
 * esamą ištrynimą ir paverčia jo rezultatą stabiliu struktūrizuotu atsakymu.
 * Trynimo logika lieka ten, kur jau buvo išbandyta.
 */

/** Galutinės ištrynimo būsenos. */
const DELETION_STATUS = {
  /** Visos kategorijos pašalintos. */
  DELETED: "deleted",
  /** Dalis liko; galima kartoti. */
  PARTIAL: "partial",
  /** Nepavyko ir kartojimas nepadės – reikia žmogaus. */
  FAILED: "failed",
  /** Nieko nebuvo – jobas jau ištrintas anksčiau. */
  ALREADY_DELETED: "already_deleted",
};

/**
 * GEDIMŲ KLASIFIKACIJA.
 *
 * Skirtumas praktinis: kartotiną gedimą galima suplanuoti iš naujo, o
 * galutinis reikalauja žmogaus. Sumaišius juos, arba kartojam amžinai, arba
 * tyliai nurašom tai, kas dar pataisoma.
 */
const RETRYABLE_PATTERNS = [
  /ECONNREFUSED|ETIMEDOUT|ECONNRESET|EPIPE/i, // tinklas
  /ENOTFOUND|EAI_AGAIN/i, // DNS
  /EBUSY|EAGAIN|EMFILE|ENFILE/i, // laikinai užimti resursai
  /Connection is closed|Stream isn't writeable|max retries/i, // Redis/BullMQ
];

/**
 * KLAIDOS, KURIOS IŠTRYNIMO KONTEKSTE REIŠKIA SĖKMĘ.
 *
 * `ENOENT` („failo nėra") bendrai yra galutinis gedimas, bet TRINANT jis
 * reiškia, kad tikslas jau pasiektas – failo nebėra, o būtent to ir siekėm.
 * Klasifikavus jį kaip `permanent`, sėkmingas ištrynimas atrodytų kaip
 * gedimas, reikalaujantis žmogaus įsikišimo.
 *
 * ⚠️ Tai kontekstinė taisyklė, ne bendra: tas pats `ENOENT` skaitant failą
 * būtų tikras gedimas. Todėl ji galioja TIK čia.
 */
const SUCCESS_IN_DELETION_PATTERNS = [/ENOENT|no such file|not found|does not exist/i];

/**
 * @returns {"retryable"|"permanent"|"already_absent"}
 */
function classifyFailure(message) {
  const text = String(message || "");

  if (SUCCESS_IN_DELETION_PATTERNS.some((pattern) => pattern.test(text))) return "already_absent";
  return RETRYABLE_PATTERNS.some((pattern) => pattern.test(text)) ? "retryable" : "permanent";
}

/**
 * Kategorijos, kurias dengia esamas `eraseJob`.
 *
 * Susiejimas EKSPLICITINIS, ne spėjamas iš laukų pavadinimų: kai atsiras nauja
 * kategorija, ji turės būti pridėta ČIA, o ne likti tyliai nepastebėta.
 */
const COVERED_CATEGORIES = [
  { type: ARTEFACT_TYPES.QUEUE_RECORD.id, outcomeKey: "queueJobRemoved" },
  { type: ARTEFACT_TYPES.SOURCE_AUDIO.id, outcomeKey: "storageRemoved" },
  { type: ARTEFACT_TYPES.JOB_RECORD.id, outcomeKey: "jobRemoved" },
];

/**
 * Artefaktai, SAUGOMI JOBO ĮRAŠE.
 *
 * Transkripcija ir protokolas neturi atskiro fizinio saugojimo vieneto – jie
 * gyvena `job.result` viduje. Pašalinus `job_record`, jie pašalinami kartu.
 *
 * Bet rezultate juos reikia ĮVARDYTI: #19 tikslas yra patvirtinti KIEKVIENĄ
 * kategoriją, o nutylėti artefaktai neatskiriami nuo pamirštų. Todėl jie
 * deklaruojami ištrintais TIK tada, kai ištrintas jų konteineris.
 */
const STORED_IN_JOB_RECORD = [ARTEFACT_TYPES.TRANSCRIPT.id, ARTEFACT_TYPES.PROTOCOL.id];

/**
 * LAIKINI artefaktai, kurių šis etapas dar NETIKRINA.
 *
 * `upload_temp` ir `conversion_temp` turi išnykti patys apdorojimo pabaigoje,
 * bet po kritimo gali „pakibti". Jų valymas ir patikra yra kito etapo darbas.
 *
 * Rezultate jie rodomi atskirai, o ne nutylimi: „dar nepatikrinta" ir
 * „patikrinta ir švaru" turi atrodyti skirtingai.
 */
const UNVERIFIED_TEMPORARY = [ARTEFACT_TYPES.UPLOAD_TEMP.id, ARTEFACT_TYPES.CONVERSION_TEMP.id];

/**
 * EFEMERIŠKOS kategorijos – jų nėra ko trinti.
 *
 * Redaguota transkripcija ir eksportai perskaičiuojami kiekvienam
 * panaudojimui ir niekada nesaugomi (žr. `docs/artefact-lifecycle.md`). Jie
 * rezultate rodomi atskirai, kad atsakymas neatrodytų, tarsi jie buvo
 * praleisti – „nėra ko trinti" ir „pamiršome ištrinti" turi atrodyti skirtingai.
 */
const EPHEMERAL_CATEGORIES = [
  ARTEFACT_TYPES.TRANSCRIPT_REDACTED.id,
  ARTEFACT_TYPES.EXPORT_REDACTED.id,
  ARTEFACT_TYPES.EXPORT_ORIGINAL.id,
];

/**
 * VYKDOMOS OPERACIJOS vienam jobId.
 *
 * Be jos lygiagretus kvietimas matydavo žymą ir IŠ KARTO grąžindavo
 * `complete: true`, nors pirmasis trynimas dar vyko ir galėjo baigtis daline
 * nesėkme. Klientas gaudavo patvirtinimą, kurio niekas nebuvo davęs.
 *
 * Dabar antras kvietimas LAUKIA to paties rezultato, tad visi gauna FAKTINĘ
 * galutinę būseną.
 *
 * ⚠️ Koordinavimas galioja tik ŠIAM PROCESUI. Kelioms replikoms reikėtų Redis
 * užrakto – ta pati riba kaip žymų saugykloje.
 */
const inFlight = new Map();

/**
 * Koordinuotas jobo artefaktų ištrynimas.
 *
 * @param {object|null} job - jobo įrašas arba `null`, jei jo nebėra
 * @param {string} jobId
 * @param {{actor?: string}} options
 * @returns {Promise<object>} stabilus struktūrizuotas rezultatas
 */
async function deleteJobArtefacts(job, jobId, options = {}) {
  /**
   * PATVIRTINTAS ištrynimas – vienintelis atvejis, kai galima trumpinti kelią.
   *
   * `pending` ir `failed` reikšmės TYČIA nepatenka čia: pirmoji reiškia, kad
   * operacija dar vyksta (laukiam žemiau), antroji – kad ją reikia kartoti.
   */
  if (tombstones.isConfirmedDeleted(jobId)) {
    const marker = tombstones.get(jobId);
    return buildResult({
      jobId,
      status: DELETION_STATUS.ALREADY_DELETED,
      actor: marker.actor,
      requestedAt: marker.requestedAt,
      completedAt: marker.completedAt,
      deleted: [],
      remaining: [],
      failures: [],
    });
  }

  // Jei operacija jau vyksta - laukiam JOS rezultato, negrąžinam savo.
  const running = inFlight.get(jobId);
  if (running) return running;

  const operation = _performDeletion(job, jobId, options).finally(() => {
    inFlight.delete(jobId);
  });

  inFlight.set(jobId, operation);
  return operation;
}

async function _performDeletion(job, jobId, { actor = null } = {}) {
  /**
   * ŽYMA PRIEŠ ŠALINIMĄ.
   *
   * #19 reikalauja autoritetingo tombstone PRIEŠ artefaktų pašalinimą. Tvarka
   * svarbi: jei žyma atsirastų po šalinimo, tarp jų liktų langas, kuriame
   * worker'is dar nematytų žymos, o duomenų jau nebūtų – ir jis juos
   * atkurtų.
   */
  const marker = tombstones.mark(jobId, { actor });

  if (!job) {
    /**
     * Jobo įrašo nebėra, bet žymą vis tiek palikom.
     *
     * Taip vėluojanti eilės žinutė nebegalės sukurti artefaktų ID, kurio
     * savininko jau nėra. Rezultatas – ne klaida: trinti nebuvo ko.
     */
    tombstones.complete(jobId, tombstones.TOMBSTONE_STATUS.DELETED);
    const finished = tombstones.get(jobId);

    return buildResult({
      jobId,
      status: DELETION_STATUS.ALREADY_DELETED,
      actor,
      requestedAt: marker.requestedAt,
      completedAt: finished ? finished.completedAt : null,
      deleted: [],
      remaining: [],
      failures: [],
    });
  }

  const outcome = await eraseJob(job);

  const deleted = [];
  const remaining = [];

  for (const { type, outcomeKey } of COVERED_CATEGORIES) {
    if (outcome[outcomeKey]) deleted.push(type);
    else remaining.push(type);
  }

  if (outcome.auditEntriesRemoved > 0) deleted.push(ARTEFACT_TYPES.AUDIT_ENTRY.id);

  /**
   * Jobo įraše saugomi artefaktai seka savo konteinerį.
   *
   * Jei `job_record` pašalintas, transkripcija ir protokolas pašalinti kartu –
   * fiziškai kito kelio nėra. Jei ne, jie lieka kartu su juo.
   */
  if (outcome.jobRemoved) deleted.push(...STORED_IN_JOB_RECORD);
  else remaining.push(...STORED_IN_JOB_RECORD);

  const failures = (outcome.errors || [])
    .map((message) => ({ category: categorizeError(message), kind: classifyFailure(message) }))
    /**
     * `already_absent` NĖRA gedimas – artefakto nebuvo, o to ir siekėm. Jis
     * nepatenka nei į `retryable`, nei į `nonRetryable`, kad nekviestų nei
     * pakartojimo, nei žmogaus.
     */
    .filter((failure) => failure.kind !== "already_absent");

  const status = resolveStatus({ outcome, remaining, failures });

  /**
   * ŽYMA UŽBAIGIAMA PAGAL FAKTINĮ REZULTATĄ.
   *
   * Tik `deleted` leidžia vėlesniems kvietimams trumpinti kelią. `partial` ir
   * `failed` palieka žymą `deletion_failed` būsenoje: artefaktų kurti vis dar
   * negalima, bet trynimą KARTOTI galima – be to dalinis ištrynimas taptų
   * negrįžtamai neužbaigtas.
   */
  const zymosBusena =
    status === DELETION_STATUS.DELETED
      ? tombstones.TOMBSTONE_STATUS.DELETED
      : tombstones.TOMBSTONE_STATUS.FAILED;

  const completedAt = status === DELETION_STATUS.DELETED ? Date.now() : null;

  const result = buildResult({
    jobId,
    status,
    actor,
    requestedAt: marker.requestedAt,
    completedAt,
    deleted,
    remaining,
    failures,
  });

  /**
   * ⚠️ AUDITAS RAŠOMAS PRIEŠ ŽYMOS UŽBAIGIMĄ (#210).
   *
   * `deleted` yra GALUTINĖ žymos būsena (žr. ALLOWED_TOMBSTONE_TRANSITIONS) -
   * atgal jos pasukti nebegalima. Jei žymą užbaigtume pirma ir tik tada kristų
   * auditas, kitas to paties jobo kvietimas `isConfirmedDeleted()` trumpuoju
   * keliu grąžintų `already_deleted` su `complete: true` ir gyvavimo ciklo
   * įvykis dingtų NEGRĮŽTAMAI - tyliai, nes atsakymas atrodytų sėkmingas.
   *
   * Kritus auditui žyma lieka `deletion_pending`: artefaktų kurti vis dar
   * negalima, trumpinimo kelio nėra, o pakartotinis kvietimas idempotentiškai
   * pakartos ir trynimą, ir auditą.
   */
  await writeAudit(result);

  tombstones.complete(jobId, zymosBusena, { completedAt });

  return result;
}

/**
 * Bando nustatyti, KURIOS kategorijos gedimas.
 *
 * ⚠️ Klaidos tekstas NEĮTRAUKIAMAS į rezultatą – jame gali būti failų kelių,
 * Redis raktų ar tiekėjo atsakymų (#19: „expose no filesystem paths, storage
 * keys, Redis keys, provider payloads or deleted content"). Grąžinam TIK
 * kategoriją; pilnas tekstas lieka serverio loguose.
 */
function categorizeError(message) {
  const text = String(message || "").toLowerCase();

  if (/queue|bullmq/.test(text)) return ARTEFACT_TYPES.QUEUE_RECORD.id;
  if (/storage|audio|file/.test(text)) return ARTEFACT_TYPES.SOURCE_AUDIO.id;
  if (/audit/.test(text)) return ARTEFACT_TYPES.AUDIT_ENTRY.id;
  if (/job/.test(text)) return ARTEFACT_TYPES.JOB_RECORD.id;

  return "unknown";
}

function resolveStatus({ outcome, remaining, failures }) {
  if (outcome.criticalFailure) {
    // Kritinis gedimas: jei bent vienas kartotinas - dar galima bandyti.
    return failures.some((f) => f.kind === "retryable") ? DELETION_STATUS.PARTIAL : DELETION_STATUS.FAILED;
  }

  if (remaining.length === 0) return DELETION_STATUS.DELETED;

  /**
   * LIKO KATEGORIJŲ, BET BE KLAIDŲ.
   *
   * Dažniausia priežastis – jų tiesiog nebuvo (jobas be audio, inline režimas
   * be eilės įrašo). Tai NĖRA dalinis gedimas, ir vadinti jį tokiu reikštų
   * nuolatinį klaidingą aliarmą.
   */
  if (failures.length === 0) return DELETION_STATUS.DELETED;

  return failures.some((f) => f.kind === "retryable") ? DELETION_STATUS.PARTIAL : DELETION_STATUS.FAILED;
}

/**
 * STABILUS STRUKTŪRIZUOTAS FORMATAS (#19).
 *
 * Laukai vienodi VISIEMS rezultatams – ir sėkmei, ir daliniam, ir galutiniam
 * gedimui. Kintantis formatas verstų klientą spėlioti, ką jis gavo.
 */
function buildResult({ jobId, status, actor, requestedAt, completedAt, deleted, remaining, failures }) {
  return {
    jobId,
    status,
    actor: actor || null,

    /** Kada ištrynimo PAPRAŠYTA. Visada yra. */
    requestedAt: requestedAt || null,
    /**
     * Kada ištrynimas FAKTIŠKAI baigtas. `null`, jei nepavyko ar liko dalis –
     * nesėkmė neturi apsimesti turinti ištrynimo laiką.
     */
    completedAt: completedAt || null,

    categories: {
      deleted,
      remaining,
      /** Kategorijos, kurias dar verta bandyti trinti. */
      retryable: failures.filter((f) => f.kind === "retryable").map((f) => f.category),
      /** Kategorijos, kurių automatinis kartojimas nepadės. */
      nonRetryable: failures.filter((f) => f.kind === "permanent").map((f) => f.category),
      /** Nėra ko trinti – niekada nesaugoma (žr. docs/artefact-lifecycle.md). */
      ephemeral: EPHEMERAL_CATEGORIES,
      /**
       * Laikini artefaktai, kurių šis etapas dar NETIKRINA.
       *
       * Rodomi atskirai, o ne nutylimi: „dar nepatikrinta" ir „patikrinta ir
       * švaru" turi atrodyti skirtingai.
       */
      unverified: UNVERIFIED_TEMPORARY,
    },

    /** `true` tik tada, kai NIEKO neliko ir nebuvo galutinių gedimų. */
    complete: status === DELETION_STATUS.DELETED || status === DELETION_STATUS.ALREADY_DELETED,
  };
}

/**
 * Auditas su aktoriumi ir rezultatu, BE ištrinto turinio.
 *
 * Esamas `writeDeletionReceipt` (utils/jobErasure.js) rašo kvitą be jokios
 * sąsajos su subjektu. Šis įrašas jį PAPILDO: jis fiksuoja, KAS inicijavo
 * ištrynimą ir kuo jis baigėsi – to reikalauja #19 („audit events record
 * deletion request, actor, result and timestamp").
 */
/**
 * ⚠️ ASYNC NUO 7.4a (#210 eksplicitiškai įvardija šią funkciją).
 *
 * `LIFECYCLE_DELETION` yra BLOKUOJANTIS: gyvavimo ciklo ištrynimas be
 * patvirtinto audito reikštų asmens duomenų šalinimą be pėdsako.
 */
async function writeAudit(result) {
  /**
   * ⚠️ AUDITO KLAIDA PROPAGUOJAMA (#155, 7.4a / #210).
   *
   * Anksčiau čia buvo `catch {}` su paaiškinimu „duomenys jau pašalinti".
   * Argumentas suprantamas, bet jis paverčia `LIFECYCLE_DELETION` klasifikaciją
   * BEPRASME: `utils/auditEvents.js` sako BLOKUOJANTIS, o kodas elgiasi kaip
   * neblokuojantis. #210 GDPR ištrynimą įvardija blokuojančia šeima -
   * „klaida arba timeout → veiksmas atmetamas".
   *
   * Ištrynimo neatšauksi, bet SĖKMĖS DEKLARAVIMĄ atšaukti galima ir būtina:
   * kvietėjas gauna klaidą, ištrynimas nelaikomas patvirtintu, o pakartojimas
   * yra idempotentinis (žr. `tombstones`). Priešingu atveju asmens duomenys
   * dingtų be jokio pėdsako - būtent tai, ką auditas turi neleisti.
   */
  await rasytiAudita({
    event: "LIFECYCLE_DELETION",
    success: result.complete,
    outcome: result.status,
    /**
     * AKTORIUS PERDUODAMAS EKSPLICITIŠKAI.
     *
     * `auditLog.record` turi fallback į užklausos kontekstą (`getActor()`),
     * bet gyvavimo ciklo servisą galima kviesti IR BE HTTP konteksto –
     * retencijos valymo, worker'io ar skripto keliais. Tada aktorius tyliai
     * taptų `null`, ir audito įrašas neatsakytų į klausimą „kas ištrynė".
     */
    actor: result.actor || undefined,
    details:
      `status=${result.status} deleted=${result.categories.deleted.length} ` +
      `remaining=${result.categories.remaining.length} ` +
      `retryable=${result.categories.retryable.length} ` +
      `nonRetryable=${result.categories.nonRetryable.length}`,
  });
  log.info("Gyvavimo ciklo ištrynimas", { status: result.status, complete: result.complete });
}

module.exports = {
  deleteJobArtefacts,
  classifyFailure,
  DELETION_STATUS,
  EPHEMERAL_CATEGORIES,
};
