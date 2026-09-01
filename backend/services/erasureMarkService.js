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
/**
 * ⚠️ IŠTRYNIMO ADMINISTRAVIMO ĮVYKIAI NĖRA SUSIETI SU SUBJEKTU (#155, 7.4e / #216).
 *
 * Šio failo `rasytiAudita()` kvietimai SĄMONINGAI neperduoda `jobId`, tad
 * `subjectId` lieka `null`.
 *
 * KODĖL. 7.4e barjeras atmeta subjektui susietą audito rašymą, kai `job_id`
 * pažymėtas `erasure_marks`. Šie įvykiai pagal apibrėžimą rašomi apie PAŽYMĖTĄ
 * job'ą - `ERASURE_MARK_RETRIED` rašomas iškart po `tombstones.retry()`. Palikus
 * subject binding, operatoriaus ir administratoriaus keliai nustotų veikti
 * visiškai (patikrinta: 17 testų).
 *
 * ⚠️ TAI NE IŠIMTIS BARJERUI, O TA PATI TAISYKLĖ, KURIĄ REPO JAU TAIKO.
 * `DATA_ERASED` (`utils/jobErasure.js`), `LIFECYCLE_DELETION`
 * (`services/lifecycleService.js`) ir `RETENTION_PURGE` subjekto neturi nuo
 * pat pradžių - ištrynimo KVITAS negali būti ištrinamas savo paties
 * dokumentuojamo ištrynimo. Šie septyni prisijungia prie tos pačios šeimos.
 *
 * ⚠️ KAINA, ĮVARDYTA: `GET /api/audit?jobId=` filtruoja per `candidateSubjectIds`,
 * tad šie įrašai iš to filtro iškrenta. Koreliacija lieka per `requestId` ir per
 * ištrynimo kvitus, kurie tame filtre nebuvo IR ANKSČIAU.
 */
/**
 * ⚠️ IŠTRYNIMO ADMINISTRAVIMO ĮVYKIAI NĖRA SUSIETI SU SUBJEKTU (#155, 7.4e / #216).
 *
 * Šio failo `rasytiAudita()` kvietimai SĄMONINGAI neperduoda `jobId`, tad
 * `subjectId` lieka `null`.
 *
 * KODĖL. 7.4e barjeras atmeta subjektui susietą audito rašymą, kai `job_id`
 * pažymėtas `erasure_marks`. Šie įvykiai pagal apibrėžimą rašomi apie PAŽYMĖTĄ
 * job'ą - `ERASURE_MARK_RETRIED` rašomas iškart po `tombstones.retry()`. Palikus
 * subject binding, operatoriaus ir administratoriaus keliai nustotų veikti
 * visiškai (patikrinta mutacija: krinta 17 testų).
 *
 * ⚠️ TAI NE IŠIMTIS BARJERUI, O TA PATI TAISYKLĖ, KURIĄ REPO JAU TAIKO.
 * `DATA_ERASED` (`utils/jobErasure.js`), `LIFECYCLE_DELETION`
 * (`services/lifecycleService.js`) ir `RETENTION_PURGE` subjekto neturi nuo pat
 * pradžių - ištrynimo KVITAS negali būti ištrinamas savo paties dokumentuojamo
 * ištrynimo. Šie septyni prisijungia prie tos pačios šeimos.
 *
 * ⚠️ KAINA, ĮVARDYTA: `GET /api/audit?jobId=` filtruoja per `candidateSubjectIds`,
 * tad šie įrašai iš to filtro iškrenta. Koreliacija lieka per `requestId` ir per
 * ištrynimo kvitus, kurie tame filtre nebuvo IR ANKSČIAU.
 */
async function retryMark(jobId, { actor = null } = {}) {
  const esama = await tombstones.get(jobId);

  if (!esama) return { changed: false, reason: "no_mark" };
  if (esama.status !== TOMBSTONE_STATUS.FAILED) {
    return { changed: false, reason: "not_failed", status: esama.status };
  }

  /**
   * ⚠️ AUDITAS PO PERĖJIMO, IR `success` PAGAL JO REZULTATĄ (#183 Codex, P2).
   *
   * Anksčiau įrašas eidavo PIRMAS su `success: true`. Du operatoriai, kartojantys
   * tą pačią `deletion_failed` žymą, abu perskaitydavo būseną ir abu įrašydavo
   * sėkmę, bet sąlyginis `failed → pending` perėjimas pavyksta TIK vienam. Liktų
   * patvarus sėkmės įrašas veiksmui, kurio nebuvo - tas pats „deklaruoti sėkmę
   * prieš patvirtintą write", kurį 7.4a auditui uždraudė.
   *
   * Bandymas pėdsako nepraranda: nepavykęs perėjimas irgi rašomas, tik
   * `success: false` su priežastimi. `rasytiAudita` blokuoja, tad audito klaida
   * po įvykusio perėjimo iškyla kvietėjui - ta pati semantika kaip
   * `RETENTION_PURGE`, rašomame po ištrynimo.
   */
  const zyma = await tombstones.retry(jobId, { actorKind: ACTOR_KIND.OPERATOR });
  const changed = Boolean(zyma);

  await rasytiAudita({
    event: "ERASURE_MARK_RETRIED",
    actor: actor || undefined,
    success: changed,
    details: `from=${esama.status} attempts=${esama.attempts} changed=${changed}`,
  });

  log.info("Ištrynimo žyma grąžinta į pakartojimą", { jobId, status: zyma && zyma.status, changed });
  return { changed, status: zyma ? zyma.status : esama.status };
}

/**
 * UŽSTRIGUSIOS PRETENZIJOS ATLAISVINIMAS (#183).
 *
 * ⚠️ KAM JIS REIKALINGAS, NORS YRA `retry` IR `force-resolve`.
 *
 * Nė vienas iš jų netinka faktinei užstrigimo formai. `retry` reikalauja
 * `deletion_failed` - o užstrigusi žyma yra `deletion_pending`. `force-resolve`
 * veda į `deleted`, t. y. TVIRTINA, kad duomenų nebėra - o po kieto proceso
 * nužudymo tai NEŽINOMA: valymas galėjo nutrūkti bet kurioje vietoje.
 *
 * `release` tvirtina TIK tai, kas žinoma: vykdytojo nebėra. Duomenų būklės jis
 * neapibrėžia, todėl ir veda į `deletion_failed`, o ne į `deleted` - iš ten
 * įprastas `retry` grąžina žymą į `pending` ir ištrynimas užbaigiamas.
 *
 * ⚠️ AUTOMATINIO APTIKIMO NĖRA IR NEBUS. Lease ar heartbeat ant `pending` būtų
 * paskirstyta nuoma - būtent tai, ko 7.5a atsisakė sąmoningai. „Vykdytojas
 * mirė" yra operatoriaus sprendimas, ne laikmačio išvada.
 */
async function releaseMark(jobId, { actor = null } = {}) {
  const esama = await tombstones.get(jobId);

  if (!esama) return { changed: false, reason: "no_mark" };

  /**
   * Iš `deleted` ir `deletion_failed` atlaisvinti nėra ko: pirmoji terminali,
   * antroji jau turi `retry` kelią. Leidus juos, `release` taptų būdu perrašyti
   * nesėkmės kategoriją - t. y. suklastoti įrašą apie tai, KAS nutiko.
   */
  if (esama.status !== TOMBSTONE_STATUS.PENDING) {
    return { changed: false, reason: "not_pending", status: esama.status };
  }

  /**
   * ⚠️ AUDITAS PO PERĖJIMO - ta pati tvarka kaip `retryMark` ir
   * `forceResolveMark`. Du operatoriai, atlaisvinantys tą pačią žymą, abu
   * perskaitytų `pending`, bet sąlyginis perėjimas pavyksta TIK vienam.
   */
  const zyma = await tombstones.release(jobId, { actorKind: ACTOR_KIND.OPERATOR });
  const changed = Boolean(zyma);

  await rasytiAudita({
    event: "ERASURE_MARK_RELEASED",
    actor: actor || undefined,
    success: changed,
    details: `from=${esama.status} attempts=${esama.attempts} changed=${changed} claim=lost`,
  });

  log.info("Užstrigusi ištrynimo pretenzija atlaisvinta", {
    jobId,
    status: zyma && zyma.status,
    changed,
  });

  return { changed, status: zyma ? zyma.status : esama.status };
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
   * ⚠️ AUDITAS PO PERĖJIMO - MAINAI, KURIE ĮVARDIJAMI (#183 Codex, P2).
   *
   * Ankstesnis komentaras gynė priešingą tvarką: „auditas pirma, kad barjeras
   * neatsidarytų be pėdsako". Argumentas galiojo, bet dengė tik VIENĄ gedimo
   * pusę. Antroji pasirodė peržiūroje: du lygiagretūs operatoriai abu įrašo
   * `success: true`, o sąlyginis perėjimas pavyksta tik vienam - lieka patvarus
   * sėkmės įrašas veiksmui, kurio nebuvo. Auditas, kuriuo negalima pasitikėti,
   * yra blogiau nei auditas, kurio trūksta: pirmuoju remiamasi.
   *
   * Todėl rašoma PO perėjimo, o `success` atspindi jo rezultatą. Kaina
   * pripažįstama: kritus audito rašymui po įvykusio perėjimo, barjeras jau
   * atidarytas, o įrašo nėra - bet `rasytiAudita` blokuoja, tad operatorius
   * gauna klaidą, ne tylą. Ta pati semantika kaip `RETENTION_PURGE`, rašomame
   * po ištrynimo (7.4d).
   */
  const zyma = await tombstones.forceResolve(jobId, { actorKind: ACTOR_KIND.OPERATOR });
  const changed = Boolean(zyma);

  await rasytiAudita({
    event: "ERASURE_MARK_FORCE_RESOLVED",
    actor: actor || undefined,
    success: changed,
    details:
      `from=${esama.status} attempts=${esama.attempts} ` +
      `lastFailure=${esama.lastFailureKind || "none"}${note ? " note=pateikta" : ""} ` +
      `changed=${changed}`,
  });

  log.warn("Ištrynimo žyma išspręsta rankiniu būdu", { jobId, from: esama.status, changed });
  return { changed, status: zyma ? zyma.status : esama.status };
}

module.exports = {
  releaseMark,
  listStuck,
  retryMark,
  forceResolveMark,
  UZSTRIGUSI_PO_MS,
};
