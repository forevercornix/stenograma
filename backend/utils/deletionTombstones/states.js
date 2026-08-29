/**
 * IŠTRYNIMO ŽYMŲ BŪSENOS IR ALLOWLIST'AI (#155, 7.5a / #183).
 *
 * Vienas autoritetas abiem backend'ams. `erasure_marks` migracija tas pačias
 * aibes turi UŽŠALDYTAS savo kopijoje (migracija yra istorijos įrašas), o
 * paritetą tarp jų tikrina testas - ne komentaras.
 */

/**
 * ŽYMOS BŪSENOS.
 *
 * ⚠️ Žyma NEGALI reikšti vien „viskas ištrinta". Ji turi atskirti „ištrynimas
 * pradėtas" nuo „ištrynimas baigtas": pirmoji reikšmė stabdo artefaktų kūrimą,
 * antroji - leidžia trumpinti kelią.
 */
const TOMBSTONE_STATUS = {
  /** Ištrynimas pradėtas. Artefaktų kurti NEGALIMA, kartoti trynimą - galima. */
  PENDING: "deletion_pending",
  /** Patvirtintai ištrinta. Tik ši būsena leidžia trumpinti kelią. GALUTINĖ. */
  DELETED: "deleted",
  /** Nepavyko. Artefaktų kurti negalima; kartojimas - tik per eksplicitinį retry. */
  FAILED: "deletion_failed",
};

/**
 * ⚠️ `reason` YRA ALLOWLIST, NE LAISVAS LAUKAS (#183).
 *
 * Ta pati klasė kaip 7.4b `meta`: tikrinama RAŠANT, nežinoma reikšmė atmetama.
 * Be to į `erasure_marks` pro šoną patektų transkripcijos fragmentai, promptai
 * ar neapdorotos exception žinutės - t. y. tie patys duomenys, kuriuos žyma
 * turi įrodyti esant pašalintus.
 */
const ERASURE_REASON = {
  USER_REQUEST: "user_request",
  RETENTION_POLICY: "retention_policy",
  OPERATOR_CLEANUP: "operator_cleanup",
};

/**
 * ⚠️ AKTORIUS SAUGOMAS KAIP KATEGORIJA, NE IDENTIFIKATORIUS.
 *
 * `erasure_marks` pergyvena jobą ir, skirtingai nei `audit_log`, NEIŠBRAUKIAMA
 * iš atsarginių kopijų. Plikas `ownerId` ar el. paštas joje taptų asmens
 * duomenimis lentelėje, kurios paskirtis - įrodyti, kad asmens duomenys
 * pašalinti.
 *
 * Tikslus aktoriaus atsekamumas NEDINGSTA: jis lieka `LIFECYCLE_DELETION`
 * audito kvite, kur jau veikia pseudonimizacija ir rakto rotacija (7.4c).
 */
const ACTOR_KIND = {
  /** Duomenų subjektas ar jo vardu veikiantis savininko kelias. */
  USER: "user",
  /** Administracinis override, orphan valymas, rankinis retry. */
  OPERATOR: "operator",
  /** Retencija, worker'is, skriptas - be žmogaus užklausos. */
  SYSTEM: "system",
};

/**
 * LEIDŽIAMI PERĖJIMAI.
 *
 * ⚠️ `deleted` GALUTINĖ: jos nėra nė vieno perėjimo šaltinių pusėje, tad vėliau
 * užsibaigęs nesėkmingas bandymas negali panaikinti jau patvirtinto ištrynimo.
 * Postgres pusėje tai NE runtime patikra, o `UPDATE ... WHERE status = <šaltinis>`
 * forma: `deleted` neatsiranda nė viename `WHERE`.
 *
 * ⚠️ `deletion_failed → deleted` UŽDARYTAS 7.5a (#183). Iki tol jis buvo
 * leidžiamas kaip retry kelias, bet leido pasiekti `deleted` BE jokio įrodymo,
 * kad antras bandymas apskritai vyko. Dabar retry yra EKSPLICITINIS veiksmas
 * (`failed → pending`), ne šalutinis `complete()` poveikis, tad kiekvienas
 * patvirtintas ištrynimas turi prieš save įrodomą bandymą.
 */
const ALLOWED_TRANSITIONS = {
  [TOMBSTONE_STATUS.PENDING]: [TOMBSTONE_STATUS.DELETED, TOMBSTONE_STATUS.FAILED],
  [TOMBSTONE_STATUS.FAILED]: [TOMBSTONE_STATUS.PENDING],
  [TOMBSTONE_STATUS.DELETED]: [],
};

/** Atitinka `lifecycleService.classifyFailure()` išvestį. */
const FAILURE_KINDS = ["retryable", "permanent", "already_absent"];

const REASONS = Object.values(ERASURE_REASON);
const ACTOR_KINDS = Object.values(ACTOR_KIND);
const STATUSES = Object.values(TOMBSTONE_STATUS);

/**
 * ⚠️ NEŽINOMA REIKŠMĖ ATMETAMA, NE NORMALIZUOJAMA.
 *
 * Tylus pakeitimas numatytąja reikšme padarytų allowlist'ą dekoracija: kvietėjas
 * manytų įrašęs vieną priežastį, lentelėje atsirastų kita, o klaida paaiškėtų
 * tik auditui nesutapus su žyma.
 */
function assertReason(reason) {
  if (!REASONS.includes(reason)) {
    throw new TypeError(
      `Nežinoma ištrynimo priežastis "${reason}". Leidžiamos: ${REASONS.join(", ")}.`
    );
  }
  return reason;
}

function assertActorKind(actorKind) {
  if (actorKind === null || actorKind === undefined) return null;

  if (!ACTOR_KINDS.includes(actorKind)) {
    throw new TypeError(
      `Nežinoma aktoriaus kategorija "${actorKind}". Leidžiamos: ${ACTOR_KINDS.join(", ")}. ` +
        "Identifikatoriai (ownerId, el. paštas) čia NELEIDŽIAMI - jie lieka audito kvite."
    );
  }
  return actorKind;
}

function assertFailureKind(kind) {
  if (kind === null || kind === undefined) return null;
  return FAILURE_KINDS.includes(kind) ? kind : null;
}

/** Ar perėjimas leidžiamas iš duotos būsenos? Naudoja atminties backend'as. */
function canTransition(from, to) {
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

module.exports = {
  TOMBSTONE_STATUS,
  ERASURE_REASON,
  ACTOR_KIND,
  ALLOWED_TRANSITIONS,
  FAILURE_KINDS,
  REASONS,
  ACTOR_KINDS,
  STATUSES,
  assertReason,
  assertActorKind,
  assertFailureKind,
  canTransition,
};
