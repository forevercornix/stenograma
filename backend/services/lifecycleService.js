const { eraseJob } = require("../utils/jobErasure");
const tombstones = require("../utils/deletionTombstones");
const { ACTOR_KIND, ERASURE_REASON } = require("../utils/deletionTombstones/states");
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
  /**
   * Ištrynimą jau vykdo KITAS autoritetingas procesas (#183, 7.5a DoD).
   *
   * ⚠️ Nė vienas destruktyvus veiksmas NEPRADEDAMAS. Antras kvietėjas gauna
   * determinuotą atsakymą pagal autoritetingą žymos būseną, o ne kartoja tą patį
   * eilės/saugyklos/audito darbą.
   */
  IN_PROGRESS: "in_progress",
  /**
   * Duomenys ištrinti, BET barjeras liko `deletion_failed` (#183).
   *
   * ⚠️ ATSKIRAS STATUSAS, NES ABU PAPRASTESNI ATSAKYMAI MELUOTŲ. „Ištrinta"
   * teigtų patvirtintą ištrynimą, kurio persistentinis įrašas neliudija;
   * „nepavyko trynimas" teigtų, kad duomenys liko. Tikroji būsena yra trečia:
   * darbas atliktas, apskaita neužbaigta, ir ją užbaigti gali TIK operatorius
   * per `erasure-marks retry` (žr. `deletion_failed → deleted` uždarymą).
   */
  TOMBSTONE_UNRESOLVED: "tombstone_unresolved",
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
/**
 * ⚠️ KLAUSIMAS YRA „AR ARTEFAKTO NEBĖRA", NE „AR MES JĮ IŠTRYNĖME" (#250).
 *
 * `source_audio` turi DVI būsenas, reiškiančias tą patį rezultatą: objektą
 * pašalinome (`storageRemoved`) arba jo jau nebuvo (`storageAlreadyAbsent`).
 * Skaitant tik pirmąją, įprastas pakartotinis trynimas rodytų
 * `remaining: [source_audio]` prie sėkmingo statuso — likutis, kurio nėra.
 */
const COVERED_CATEGORIES = [
  { type: ARTEFACT_TYPES.QUEUE_RECORD.id, nebera: (o) => Boolean(o.queueJobRemoved) },
  {
    type: ARTEFACT_TYPES.SOURCE_AUDIO.id,
    nebera: (o) => Boolean(o.storageRemoved || o.storageAlreadyAbsent),
  },
  { type: ARTEFACT_TYPES.JOB_RECORD.id, nebera: (o) => Boolean(o.jobRemoved) },
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
/**
 * ⚠️ PROCESUI LOKALI OPTIMIZACIJA, NE KOREKTIŠKUMO MECHANIZMAS (#155, 7.5a).
 *
 * Iki 7.5a tai buvo VIENINTELIS vienintelio vykdytojo mechanizmas, ir jis
 * galiojo tik viename procese: dvi replikos tą patį jobą trynė lygiagrečiai.
 * Nuo 7.5a autoritetas yra sąlyginis `erasure_marks` rašymas su per-`job_id`
 * advisory lock'u - jis veikia tarp procesų, replikų ir pool'ų.
 *
 * Žemėlapis paliktas todėl, kad tame pačiame procese jis sutaupo antrą pilną
 * ištrynimo eigą ir leidžia lygiagretiems kvietėjams gauti TĄ PATĮ rezultato
 * objektą. Pašalinus jį korektiškumas nenukentėtų - tik atsirastų nereikalingas
 * darbas.
 */
const inFlight = new Map();

/**
 * Koordinuotas jobo artefaktų ištrynimas.
 *
 * @param {object|null} job - jobo įrašas arba `null`, jei jo nebėra
 * @param {string} jobId
 * @param {{actor?: string, actorKind?: string, reason?: string}} options
 * @returns {Promise<object>} stabilus struktūrizuotas rezultatas
 */
async function deleteJobArtefacts(job, jobId, options = {}) {
  /**
   * PATVIRTINTAS ištrynimas – vienintelis atvejis, kai galima trumpinti kelią.
   *
   * `pending` ir `failed` reikšmės TYČIA nepatenka čia: pirmoji reiškia, kad
   * operacija dar vyksta (laukiam žemiau), antroji – kad ją reikia kartoti.
   */
  const barjeras = await tombstones.barrierState(jobId);

  /**
   * ⚠️ NEPAVYKĘS ANKSTESNIS BANDYMAS NEKARTOJAMAS AUTOMATIŠKAI (#183).
   *
   * `deletion_failed → deleted` uždarytas sąmoningai: patvirtinti ištrynimą
   * galima tik po UŽFIKSUOTO naujo bandymo. Anksčiau šis kelias vis tiek
   * pakartodavo visą destruktyvų darbą, o tada `complete()` perėjimą atmesdavo -
   * ir atsakymas skelbdavo sėkmę, kurios žyma neliudija.
   *
   * Automatinis `failed → pending` čia BŪTŲ blogesnis: jis apeitų
   * `ERASURE_MARK_RETRIED` auditą, ir `deletion_failed` nustotų reikšti
   * „operatorius turi įsikišti". Būsena, kuri išsisprendžia savaime, nebėra
   * barjeras.
   */
  if (barjeras && barjeras.status === tombstones.TOMBSTONE_STATUS.FAILED) {
    return buildResult({
      jobId,
      status: DELETION_STATUS.TOMBSTONE_UNRESOLVED,
      actor: null,
      actorKind: barjeras.actorKind,
      requestedAt: barjeras.requestedAt,
      completedAt: null,
      deleted: [],
      remaining: [],
      failures: [],
    });
  }

  if (barjeras && barjeras.status === tombstones.TOMBSTONE_STATUS.DELETED) {
    const marker = barjeras;
    return buildResult({
      jobId,
      status: DELETION_STATUS.ALREADY_DELETED,
      /**
       * ⚠️ AKTORIAUS IDENTIFIKATORIAUS ČIA NEBĖRA (#155, 7.5a).
       *
       * `erasure_marks` pergyvena jobą ir nėra išbraukiama iš kopijų, tad plikas
       * `ownerId` joje taptų asmens duomenimis lentelėje, kurios paskirtis -
       * įrodyti, kad asmens duomenys pašalinti. Saugoma tik kategorija.
       *
       * Tikslus atsekamumas NEDINGO: jis yra `LIFECYCLE_DELETION` audito kvite,
       * kur veikia pseudonimizacija ir rakto rotacija.
       */
      actor: null,
      actorKind: marker.actorKind,
      requestedAt: marker.requestedAt,
      completedAt: marker.completedAt,
      deleted: [],
      remaining: [],
      failures: [],
    });
  }

  // Jei operacija jau vyksta ŠIAME procese - laukiam JOS rezultato, negrąžinam savo.
  const running = inFlight.get(jobId);
  if (running) return running;

  /**
   * ⚠️ MESTA KLAIDA PALIEKA ŽYMĄ `deletion_failed`, NE `deletion_pending` (#183).
   *
   * Nuo tada, kai antras kvietėjas gauna 202 pagal `deletion_pending`, užstrigusi
   * `pending` žyma reikštų, kad KIEKVIENAS vėlesnis `DELETE` amžinai atsakytų
   * „jau vyksta", o ištrynimas nebeįvyktų niekada. Pagrindinis toks kelias -
   * metantis audito rašymas (`AuditWriteError`) tarp žymėjimo ir užbaigimo.
   *
   * `failed` yra teisinga būsena: bandymas TIKRAI nepavyko, barjeras lieka
   * aktyvus, `attempts` padidėja, žyma matoma `listUnresolved` sąraše, o
   * operatorius turi dokumentuotą kelią `erasure-marks retry`.
   *
   * ⚠️ Tai NEUŽDARO kieto proceso nužudymo (SIGKILL) tarp žymėjimo ir užbaigimo -
   * ten `pending` lieka, ir reikia operatoriaus. Žr. `docs/deletion-guarantees.md`
   * ir ataskaitos riziką dėl trūkstamos `release` komandos.
   */
  const operation = _performDeletion(job, jobId, options)
    .catch(async (klaida) => {
      /**
       * ⚠️ ŽYMIMA TIK SAVO PRETENZIJA (#183 Codex).
       *
       * Anksčiau šis `catch` pervesdavo žymą į `deletion_failed` BET KOKIU
       * atveju - įskaitant tą, kai klaida įvyko dar `mark()`/`claimRetry()`
       * viduje ir ši replika pretenzijos NIEKADA negavo. Tada ji nusukdavo
       * SVETIMĄ, veikiančią pretenziją: A toliau trintų, o jos `complete()`
       * būtų atmestas, ir realiai pašalinti duomenys liktų užrašyti kaip
       * neišspręsti - plius nereikalingas operatoriaus pakartojimas.
       *
       * `klaida.vykdytojas` nustato `_performDeletion` iškart po pretenzijos.
       */
      if (klaida && klaida.vykdytojas !== true) throw klaida;

      try {
        await tombstones.complete(jobId, tombstones.TOMBSTONE_STATUS.FAILED, {
          failureKind: classifyFailure(klaida && klaida.message),
        });
      } catch (zymosKlaida) {
        log.error("Nepavyko pažymėti žymos kaip `deletion_failed`", {
          jobId,
          klaida: zymosKlaida.message,
        });
      }
      throw klaida;
    })
    .finally(() => {
      inFlight.delete(jobId);
    });

  inFlight.set(jobId, operation);
  return operation;
}

async function _performDeletion(
  job,
  jobId,
  { actor = null, actorKind = ACTOR_KIND.USER, reason = ERASURE_REASON.USER_REQUEST } = {}
) {
  /**
   * ŽYMA PRIEŠ ŠALINIMĄ.
   *
   * #19 reikalauja autoritetingo tombstone PRIEŠ artefaktų pašalinimą. Tvarka
   * svarbi: jei žyma atsirastų po šalinimo, tarp jų liktų langas, kuriame
   * worker'is dar nematytų žymos, o duomenų jau nebūtų – ir jis juos
   * atkurtų.
   */
  const { zyma: marker, vykdytojas } = await tombstones.claimForDeletion(jobId, {
    reason,
    actorKind,
  });

  /**
   * ⚠️ PRETENZIJA PRIEŠ DESTRUKTYVŲ I/O (#183, 7.5a DoD).
   *
   * `claimed === false` su `pending` reiškia, kad žymą laiko KITAS vykdytojas -
   * kita replika arba kitas procesas. Viršuje esantis `barrierState` skaitymas
   * to negarantuoja: tarp jo ir šio `mark()` yra langas. Pretenzija atominė
   * pačiame `INSERT ... ON CONFLICT DO NOTHING`, tad ji, o ne skaitymas, yra
   * autoritetas.
   *
   * Grąžinam determinuotą būseną NEPRADĖJĘ nė vieno eilės, saugyklos ar audito
   * veiksmo - DoD reikalauja būtent to („jokio papildomo I/O nepradedama").
   */
  /**
   * Nuo šios vietos klaidos priklauso ŠIAI pretenzijai - žr. `deleteJobArtefacts`
   * `catch`. Vėliava keliauja su klaida, nes `catch` yra už funkcijos ribų.
   */
  const zymetiNesekme = (fn) =>
    fn().catch((e) => {
      if (vykdytojas) e.vykdytojas = true;
      throw e;
    });

  if (!vykdytojas && marker && marker.status === tombstones.TOMBSTONE_STATUS.PENDING) {
    return buildResult({
      jobId,
      status: DELETION_STATUS.IN_PROGRESS,
      actor: null,
      actorKind: marker.actorKind,
      requestedAt: marker.requestedAt,
      completedAt: null,
      deleted: [],
      remaining: [],
      failures: [],
    });
  }

  if (!job) {
    /**
     * Jobo įrašo nebėra, bet žymą vis tiek palikom.
     *
     * Taip vėluojanti eilės žinutė nebegalės sukurti artefaktų ID, kurio
     * savininko jau nėra. Rezultatas – ne klaida: trinti nebuvo ko.
     */
    await tombstones.complete(jobId, tombstones.TOMBSTONE_STATUS.DELETED);
    const finished = await tombstones.get(jobId);

    return buildResult({
      jobId,
      status: DELETION_STATUS.ALREADY_DELETED,
      actor,
      actorKind,
      requestedAt: marker.requestedAt,
      completedAt: finished ? finished.completedAt : null,
      deleted: [],
      remaining: [],
      failures: [],
    });
  }

  const outcome = await zymetiNesekme(() => eraseJob(job));

  const deleted = [];
  const remaining = [];

  for (const { type, nebera } of COVERED_CATEGORIES) {
    if (nebera(outcome)) deleted.push(type);
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
    actorKind,
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
   * ⚠️ ATSAKYMAS PASIKEITĖ SU 7.5a (#183): kritus auditui žyma tampa
   * `deletion_failed`, NE `deletion_pending`.
   *
   * #210 rėmėsi prielaida, kad „pakartotinis kvietimas idempotentiškai pakartos
   * ir trynimą, ir auditą". Nuo tada, kai antras kvietėjas gauna 202 pagal
   * `deletion_pending`, ta prielaida NEBEGALIOJA: pakartotinis kvietimas
   * pamatytų `pending`, atsakytų „jau vykdoma" ir nedarytų nieko - amžinai.
   *
   * `failed` yra tikslus: bandymas nepavyko, barjeras lieka aktyvus, žyma matoma
   * `listUnresolved` sąraše, o prarastas įvykis vis tiek užfiksuojamas - per
   * dokumentuotą `erasure-marks retry`, kuris rašo `ERASURE_MARK_RETRIED`.
   * Automatinis savaiminis išsisprendimas būtų būtent tai, ką 7.5a uždraudė.
   */
  await zymetiNesekme(() => writeAudit(result));

  /**
   * ⚠️ NESĖKMĖS KATEGORIJA, NE ŽINUTĖ. `failures` turi tik klasifikaciją
   * (`retryable` / `permanent`), o ne originalų tekstą, kuriame būna failų
   * kelių, saugyklos raktų ir tiekėjo atsakymų.
   */
  const failureKind = failures.length ? failures[0].kind : null;

  const uzbaigta = await tombstones.complete(jobId, zymosBusena, { completedAt, failureKind });

  /**
   * ⚠️ SĖKMĖ IŠVEDAMA IŠ GRĄŽINTOS ŽYMOS, NE IŠ TO, KAD `complete()` NEMETĖ (#183).
   *
   * `complete()` neleidžiamo perėjimo NEMETA - jis grąžina AUTORITETINGĄ esamą
   * būseną (elgesys nepakeistas nuo 7.4a). Ignoruojant grąžinamą reikšmę,
   * atsakymas skelbdavo patvirtintą ištrynimą, kurio persistentinis įrašas
   * neliudija.
   *
   * Trečias statusas, o ne vienas iš dviejų paprastesnių: duomenys IŠTRINTI
   * (tad „nepavyko" meluotų), bet barjeras neužtikrintas (tad „ištrinta"
   * meluotų taip pat). Užbaigti apskaitą gali tik operatorius.
   *
   * ⚠️ AUDITO ĮRAŠAS LIEKA TOKS, KOKS BUVO. Jis fiksuoja ATLIKTĄ DARBĄ, ir tas
   * darbas tikrai įvyko; atsakymas fiksuoja BARJERO būseną. Jie skiriasi
   * teisėtai, o auditą perrašyti po `#210` tvarkos būtų blogiau nei skirtumą
   * paaiškinti.
   */
  if (
    zymosBusena === tombstones.TOMBSTONE_STATUS.DELETED &&
    (!uzbaigta || uzbaigta.status !== tombstones.TOMBSTONE_STATUS.DELETED)
  ) {
    log.error("Ištrynimas atliktas, bet žymos užbaigti nepavyko", {
      jobId,
      zymosBusena: uzbaigta ? uzbaigta.status : "nėra",
    });

    return { ...result, status: DELETION_STATUS.TOMBSTONE_UNRESOLVED, complete: false };
  }

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
function buildResult({
  jobId,
  status,
  actor,
  actorKind = null,
  requestedAt,
  completedAt,
  deleted,
  remaining,
  failures,
}) {
  return {
    jobId,
    status,
    actor: actor || null,
    /** Kategorija (`user` / `operator` / `system`) - vienintelis dalykas, kurį saugo žyma. */
    actorKind: actorKind || null,

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
