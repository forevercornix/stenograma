/**
 * IŠTRYNIMO ŽYMŲ OPERATORIAUS KELIAS (#155, 7.5a / #183).
 *
 * ⚠️ KODĖL ŠIS SERVISAS APSKRITAI EGZISTUOJA.
 *
 * Barjeras aktyvus nuo `deletion_pending`, o neterminalės žymos NESENSTA. Abu
 * sprendimai teisingi atskirai, bet kartu jie reiškia, kad nuolat nepavykstantis
 * ištrynimas užrakina job'ą neribotam laikui. Fail-closed be išeities yra ta
 * pati spraga, kurią 7.4c turėjo taisyti atskirai - todėl išeitis įrengiama
 * kartu su barjeru, ne po jo.
 *
 * ⚠️ MARŠRUTO NĖRA SĄMONINGAI. Užstrigusi žyma yra incidentas, ne kasdienis
 * darbas: HTTP maršrutas pridėtų autentikacijos, autorizacijos ir rate-limit
 * paviršių tam, kas daroma retai ir turint DB prieigą. Maršrutą vėliau pridėti
 * lengva, nuimti - ne. Įėjimas yra `scripts/erasure-marks.js`.
 *
 * ⚠️ AUDITAS RAŠOMAS PRIEŠ VEIKSMĄ, NE PO JO. Skirtingai nei `DATA_ERASED` ar
 * `LIFECYCLE_DELETION` (post-hoc: duomenų jau nebėra, ir atmesti nebėra ko),
 * čia veiksmas yra barjero ATIDARYMAS. Neužfiksavus, kas jį atidarė, jis
 * neatidaromas.
 */

const tombstones = require("../utils/deletionTombstones");
const { ACTOR_KIND, TOMBSTONE_STATUS } = require("../utils/deletionTombstones/states");
const { rasytiAudita } = require("../utils/auditWrite");
const { createLogger } = require("../utils/logger");

const log = createLogger("erasure-marks");

/** Nuo kada neterminalė žyma laikoma „užstrigusia". Diagnostinė riba, ne politika. */
const UZSTRIGUSI_PO_MS = 24 * 60 * 60 * 1000;

/**
 * Neterminalės žymos su amžiumi.
 *
 * Be šito barjeras būtų nematomas: operatorius apie užstrigusį job'ą sužinotų
 * tik iš vartotojo skundo, kad ištrynimas „nieko nedaro".
 */
async function listStuck({ olderThanMs = UZSTRIGUSI_PO_MS, limit = 100 } = {}) {
  const zymos = await tombstones.listUnresolved({ olderThanMs, limit });

  return zymos.map((z) => ({
    jobId: z.jobId,
    status: z.status,
    reason: z.reason,
    actorKind: z.actorKind,
    attempts: z.attempts,
    lastFailureKind: z.lastFailureKind,
    ageMs: z.ageMs,
    ageHours: Math.round((z.ageMs / 3600000) * 10) / 10,
  }));
}

/**
 * EKSPLICITINIS retry: `deletion_failed → deletion_pending`.
 *
 * Pats ištrynimas NEVYKDOMAS čia - žyma tik grąžinama į būseną, iš kurios
 * įprastas ištrynimo kelias gali ją užbaigti. Taip retry lieka vienas, o ne
 * tampa antru lygiagrečiu trynimo mechanizmu.
 */
async function retryMark(jobId, { actor = null } = {}) {
  const esama = await tombstones.get(jobId);

  if (!esama) return { changed: false, reason: "no_mark" };
  if (esama.status !== TOMBSTONE_STATUS.FAILED) {
    return { changed: false, reason: "not_failed", status: esama.status };
  }

  await rasytiAudita({
    event: "ERASURE_MARK_RETRIED",
    jobId,
    actor: actor || undefined,
    success: true,
    details: `from=${esama.status} attempts=${esama.attempts}`,
  });

  const zyma = await tombstones.retry(jobId, { actorKind: ACTOR_KIND.OPERATOR });

  log.info("Ištrynimo žyma grąžinta į pakartojimą", { jobId, status: zyma && zyma.status });
  return { changed: Boolean(zyma), status: zyma ? zyma.status : esama.status };
}

/**
 * DOKUMENTUOTAS force-resolve: neterminalė žyma paskelbiama išspręsta.
 *
 * ⚠️ TAI NĖRA IŠTRYNIMAS. Operatorius patvirtina, kad duomenų nebėra (arba kad
 * jų niekada nebuvo), ir prisiima tai auditu. Būsena tampa `deleted`, tad
 * barjeras lieka - žyma niekur nedingsta, tik nustoja būti „užstrigusi".
 *
 * `reason` privalo būti perduota kvietėjo laisvu tekstu NEGALIMA: į žymą ji
 * nepatenka, o į auditą eina tik `details` su kategorijomis.
 */
async function forceResolveMark(jobId, { actor = null, note = null } = {}) {
  const esama = await tombstones.get(jobId);

  if (!esama) return { changed: false, reason: "no_mark" };
  if (esama.status === TOMBSTONE_STATUS.DELETED) {
    return { changed: false, reason: "already_terminal", status: esama.status };
  }

  /**
   * ⚠️ AUDITAS PIRMA. Kritus rašymui `rasytiAudita` meta, ir žyma LIEKA
   * neterminalė - t. y. blogiausiu atveju operatorius pakartoja, o ne atidaro
   * barjerą be pėdsako.
   */
  await rasytiAudita({
    event: "ERASURE_MARK_FORCE_RESOLVED",
    jobId,
    actor: actor || undefined,
    success: true,
    details:
      `from=${esama.status} attempts=${esama.attempts} ` +
      `lastFailure=${esama.lastFailureKind || "none"}${note ? " note=pateikta" : ""}`,
  });

  const zyma = await tombstones.forceResolve(jobId, { actorKind: ACTOR_KIND.OPERATOR });

  log.warn("Ištrynimo žyma išspręsta rankiniu būdu", { jobId, from: esama.status });
  return { changed: Boolean(zyma), status: zyma ? zyma.status : esama.status };
}

module.exports = {
  listStuck,
  retryMark,
  forceResolveMark,
  UZSTRIGUSI_PO_MS,
};
