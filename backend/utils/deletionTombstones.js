const { createLogger } = require("./logger");

const log = createLogger("tombstones");

/**
 * IŠTRYNIMO ŽYMOS (tombstones) – #19 PR2.
 *
 * KODĖL ATSKIRA SAUGYKLA, o ne laukas jobo įraše.
 *
 * Žyma turi ATSAKYTI Į KLAUSIMĄ PO TO, kai jobo įrašo nebėra: „ar šis ID buvo
 * ištrintas?". Jei ji gyventų pačiame įraše, ji dingtų kartu su juo – ir
 * vėluojanti eilės žinutė ar pasenęs worker'is sukurtų artefaktus ištrintam
 * jobui, nes niekas nebeturėtų kaip to pastebėti.
 *
 * Būtent to reikalauja #19: „A deleted job identifier cannot be recreated by
 * delayed queue messages or stale workers."
 *
 * ⚠️ Šis modulis žymą TIK LAIKO. Jos TIKRINIMAS worker'iuose ir eilėse yra
 * kito etapo darbas – čia svarbu, kad žyma atsirastų PRIEŠ šalinimą ir
 * išgyventų jį.
 */

/**
 * ŽYMOS BŪSENOS.
 *
 * ⚠️ Žyma NEGALI reikšti vien „viskas ištrinta".
 *
 * Pirmoji versija turėjo tik vieną reikšmę – „pažymėta" – ir tai sukūrė dvi
 * regresijas: dalinio ištrynimo nebebuvo galima pakartoti (antras kvietimas
 * matydavo žymą ir grįždavo `already_deleted`), o lygiagretus kvietimas gaudavo
 * patvirtinimą, kad duomenys ištrinti, dar nepasibaigus pirmajam trynimui.
 *
 * Todėl žyma turi ATSKIRTI „ištrynimas pradėtas" nuo „ištrynimas baigtas":
 * pirmoji reikšmė stabdo artefaktų kūrimą, antroji – leidžia trumpinti kelią.
 */
const TOMBSTONE_STATUS = {
  /** Ištrynimas pradėtas. Artefaktų kurti NEGALIMA, bet kartoti trynimą – galima. */
  PENDING: "deletion_pending",
  /** Patvirtintai ištrinta. Tik ši būsena leidžia trumpinti kelią. */
  DELETED: "deleted",
  /** Nepavyko. Artefaktų kurti negalima, kartojimas leidžiamas. */
  FAILED: "deletion_failed",
};

/** Atmintinė saugykla: jobId -> { status, requestedAt, completedAt, actor, expiresAt }. */
const tombstones = new Map();

/**
 * Kiek laiko žyma galioja.
 *
 * Turi VIRŠYTI ilgiausią eilės įrašo gyvavimo trukmę – kitaip vėluojanti
 * žinutė ateitų jau po žymos galiojimo ir vėl galėtų kurti artefaktus.
 * BullMQ užbaigtus jobus laiko iki 24 val., tad numatytoji reikšmė su atsarga.
 */
const DEFAULT_TTL_MS = 72 * 60 * 60 * 1000; // 72 val.

function ttlMs(env = process.env) {
  const raw = Number(env.DELETION_TOMBSTONE_TTL_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw * 60 * 60 * 1000 : DEFAULT_TTL_MS;
}

/**
 * Įrašo žymą. Idempotentinis: pakartotinis kvietimas NEPERRAŠO pirmojo
 * `deletedAt`.
 *
 * Pirmasis laikas yra tas, kuris svarbus atskaitomybei – jis atsako, KADA
 * duomenys buvo pašalinti. Perrašymas pakartotinio ištrynimo metu tą atsakymą
 * pastumtų į priekį ir padarytų kvitą netiksliu.
 */
function mark(jobId, { actor = null, env = process.env } = {}) {
  if (!jobId) return null;

  const existing = tombstones.get(jobId);
  if (existing && existing.expiresAt > Date.now()) return existing;

  const now = Date.now();
  const record = {
    jobId,
    status: TOMBSTONE_STATUS.PENDING,
    /**
     * `requestedAt` ir `completedAt` ATSKIRTI SĄMONINGAI.
     *
     * Pirmoji versija turėjo vieną `deletedAt`, nustatomą PRIEŠ trynimą, ir
     * vadino jį „kada duomenys pašalinti". Tai buvo netiesa: tuo momentu
     * trynimas dar net neprasidėjo ir galėjo visai nepavykti.
     */
    requestedAt: now,
    completedAt: null,
    actor,
    expiresAt: now + ttlMs(env),
  };

  tombstones.set(jobId, record);
  log.info("Ištrynimo žyma įrašyta", { jobId, status: record.status });

  return record;
}

/**
 * LEIDŽIAMI ŽYMOS PERĖJIMAI.
 *
 * `deleted` yra GALUTINĖ: patvirtinto ištrynimo negalima „atšaukti" į nesėkmę.
 * Priešingu atveju programavimo klaida ar pakartotinis kvietimas paverstų jau
 * įrodytą ištrynimą neapibrėžtu.
 *
 * ⚠️ `deletion_failed → deleted` LEIDŽIAMAS SĄMONINGAI – tai retry kelias.
 * Po nepavykusio trynimo pakartojimas gali pavykti, ir žyma privalo tai
 * atspindėti; be šio perėjimo dalinis ištrynimas liktų amžinai neužbaigtas.
 */
const ALLOWED_TOMBSTONE_TRANSITIONS = {
  [TOMBSTONE_STATUS.PENDING]: [TOMBSTONE_STATUS.DELETED, TOMBSTONE_STATUS.FAILED],
  [TOMBSTONE_STATUS.FAILED]: [TOMBSTONE_STATUS.DELETED, TOMBSTONE_STATUS.FAILED],
  [TOMBSTONE_STATUS.DELETED]: [], // galutinė
};

/**
 * Užbaigia žymą po realaus trynimo.
 *
 * Perėjimas VIENKRYPTIS: neleidžiamas perėjimas tyliai praleidžiamas, o žyma
 * lieka ankstesnėje būsenoje. Klaidos čia nemetam sąmoningai – ištrynimas jau
 * įvyko, ir versti jį nesėkme dėl būsenos apskaitos būtų blogesnė pusė nei
 * palikti teisingą būseną.
 *
 * @param {"deleted"|"deletion_failed"} status
 */
function complete(jobId, status) {
  const record = tombstones.get(jobId);
  if (!record) return null;

  const allowed = ALLOWED_TOMBSTONE_TRANSITIONS[record.status] || [];

  if (!allowed.includes(status)) {
    log.warn("Neleidžiamas žymos perėjimas praleistas", { jobId, from: record.status, to: status });
    return record;
  }

  record.status = status;
  // `completedAt` nustatomas TIK sėkmės atveju - nepavykęs trynimas neturi
  // apsimesti turintis ištrynimo laiką.
  record.completedAt = status === TOMBSTONE_STATUS.DELETED ? Date.now() : null;

  log.info("Ištrynimo žyma užbaigta", { jobId, status });
  return record;
}

/**
 * Ar ištrynimas PATVIRTINTAS?
 *
 * Tik ši būsena leidžia trumpinti kelią. `pending` ir `failed` reiškia, kad
 * trynimą reikia (ar galima) kartoti.
 */
function isConfirmedDeleted(jobId) {
  const record = get(jobId);
  return Boolean(record && record.status === TOMBSTONE_STATUS.DELETED);
}

/**
 * Ar šis ID pažymėtas ištrynimui BET KOKIA būsena?
 *
 * Naudojama artefaktų kūrimo blokavimui: ir `pending`, ir `failed` reiškia,
 * kad naujų artefaktų kurti negalima – priešingu atveju nepavykęs trynimas
 * leistų worker'iui prikurti dar daugiau to, ką kaip tik bandom pašalinti.
 */
function isDeleted(jobId) {
  if (!jobId) return false;

  const record = tombstones.get(jobId);
  if (!record) return false;

  if (record.expiresAt <= Date.now()) {
    tombstones.delete(jobId);
    return false;
  }

  return true;
}

function get(jobId) {
  return isDeleted(jobId) ? tombstones.get(jobId) : null;
}

/**
 * Pašalina pasibaigusias žymas.
 *
 * Ta pati logika kaip sesijų saugykloje (#18): be periodinio valymo įrašai,
 * kurių niekas nebeliečia, kauptųsi neribotai.
 */
function sweepExpired() {
  const now = Date.now();
  let removed = 0;

  for (const [jobId, record] of tombstones.entries()) {
    if (record.expiresAt <= now) {
      tombstones.delete(jobId);
      removed++;
    }
  }

  return removed;
}

const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 val.
let _sweepTimer = null;

function _startSweep() {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(sweepExpired, SWEEP_INTERVAL_MS);
  _sweepTimer.unref(); // neblokuoja proceso išjungimo
}
_startSweep();

/** Testams. */
function _clearForTests() {
  tombstones.clear();
}

function _stopSweepForTests() {
  if (_sweepTimer) clearInterval(_sweepTimer);
  _sweepTimer = null;
}

function size() {
  return tombstones.size;
}

module.exports = {
  TOMBSTONE_STATUS,
  mark,
  complete,
  isConfirmedDeleted,
  isDeleted,
  get,
  sweepExpired,
  size,
  ttlMs,
  _clearForTests,
  _stopSweepForTests,
  /**
   * ⚠️ SAUGYKLA TIK ATMINTYJE, VIENAS PROCESAS.
   *
   * Restartas žymas praranda: po jo vėluojanti eilės žinutė ištrintam jobui vėl
   * galėtų kurti artefaktus. Tai ta pati riba kaip sesijų saugykloje (#18) ir
   * ji dokumentuota – ne praleista. Kelioms replikoms ar restartui atspariam
   * variantui reikia Redis, kaip `jobStore` atveju.
   */
  backend: "memory",
};
