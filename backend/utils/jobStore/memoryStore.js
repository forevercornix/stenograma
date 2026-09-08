const { STATUS, JOB_TYPES, TTL_MS, newJob, applyPatch, isFinished, hasPendingCleanup, matchesOwner, normalizeJob, idempotentiskasAtsakymas, metaduomenuProjekcija } = require("./common");

/**
 * In-memory job store backend'as.
 *
 * Ta pati ASYNC sąsaja kaip Redis backend'o (create/get/update/sweepExpired/size
 * grąžina Promise), kad routes kodas nesiskirtų nepriklausomai nuo to, kuris
 * backend'as naudojamas. Async čia "dirbtinis" (Map operacijos sinchroninės),
 * bet vienoda sąsaja leidžia perjungti į Redis be routes pakeitimų.
 *
 * APRIBOJIMAS (dokumentuotas): gyvena tik VIENO proceso atmintyje. Perkrovus
 * backendą jobai dingsta; keli procesai/replikos nemato vienas kito jobų. Tinka
 * dev/demo ir vieno vartotojo įrankiui. Produkcijai su restart-atsparumu ar
 * keliais worker'iais - naudokite Redis backend'ą (nustatykite REDIS_URL).
 */
const jobs = new Map();

async function create(fields = {}) {
  const job = newJob(fields);
  jobs.set(job.id, job);
  return job;
}

/**
 * ⚠️ `hydrate: false` PROJEKCIJA TURI ELGTIS VIENODAI VISUOSE BACKEND'UOSE (#157, PR-3).
 *
 * PostgreSQL kelyje ji taupo `payload` deserializavimą; atmintyje taupyti nėra ko.
 * Bet FORMA privalo sutapti: nehidratuotas job'as `result` lauko NETURI, ir kvietėjas,
 * parašytas prieš vieną backend'ą, negali tyliai sulūžti prieš kitą.
 *
 * @param {{hydrate?: boolean}} [nustatymai]
 */
async function get(id, { hydrate = true } = {}) {
  const job = jobs.get(id) || null;
  if (!job || hydrate) return job;

  /** Kopija: originalas saugykloje lieka pilnas. */
  return metaduomenuProjekcija(job);
}

/**
 * ATOMINIS progreso įrašymas (#154).
 *
 * ⚠️ REIKALINGAS IR MEMORY BACKEND'E.
 *
 * Ankstesnis komentaras teigė, kad CAS čia nereikalingas, nes „`get` ir
 * `update` vyksta be `await` tarp jų". Tai buvo neteisinga: fasado
 * `reportProgress()` daro `await store.get(id)`, ir tas `await` atveria langą.
 * Lygiagretūs progreso callback'ai abu nuskaito tą patį snapshot'ą:
 *
 *   pradžia 50, vienu metu pranešama 60 ir 55 → išsaugoma 55
 *
 * t. y. dokumentuotas monotoniškumas lūžta. Fire-and-forget progreso kelias
 * (`queues/processors.js`) tokį persidengimą sukuria natūraliai.
 *
 * Ši funkcija skaito, tikrina ir rašo BE `await` – JS vienos gijos modelyje tai
 * atominė operacija.
 *
 * @returns {object|null|"REJECTED"}
 */
function reportProgressAtomicSync(id, event, jobPhase) {
  const job = jobs.get(id);
  if (!job) return null;

  const patch = jobPhase.reportProgress(job, event);
  if (!patch) return "REJECTED";

  const next = applyPatch(job, patch);
  jobs.set(id, next);
  return next;
}

async function reportProgressAtomic(id, event) {
  // `jobPhase` importuojamas čia, kad nebūtų ciklinės priklausomybės.
  const jobPhase = require("../jobPhase");
  return reportProgressAtomicSync(id, event, jobPhase);
}

/**
 * @param {object} [options]
 * @param {number} [options.expectedVersion] optimistic lock sąlyga (#184, 7.5b)
 * @returns {object|null|"CONCURRENCY_CONFLICT"}
 */
async function update(id, patch, options = {}) {
  const job = jobs.get(id);
  if (!job) return null;

  /**
   * ⚠️ VERSIJOS SĄLYGA TIKRINAMA IR ATMINTYJE (#184, 7.5b).
   *
   * Atmintyje lenktynių lango nėra - `get` ir `set` vyksta be `await` tarp jų.
   * Bet sąlyga čia NĖRA nereikalinga: `expectedVersion` ateina iš FASADO
   * snapshot'o, o tarp fasado `store.get()` ir šio kvietimo `await` YRA. Be
   * patikros memory backend'as priimtų pasenusį patch'ą, kurį Redis ir
   * PostgreSQL atmestų - ir kontraktas taptų backend-priklausomas būtent ten,
   * kur bendras rinkinys jį lygina.
   */
  if (options.expectedVersion !== undefined && job.version !== options.expectedVersion) {
    return "CONCURRENCY_CONFLICT";
  }

  const next = applyPatch(job, patch);
  jobs.set(id, next);
  return next;
}

/* ─────────────────────────────────────────────────────────────────────────
 * NUOSAVYBE RIBOJAMOS OPERACIJOS (#159)
 *
 * Atmintyje atomiškumo klausimo nėra: Node vykdo šias funkcijas be `await`
 * tarp patikros ir rašymo, tad tarpo, per kurį savininkas pasikeistų,
 * neatsiranda. Redis backend'ui to nepakanka - ten naudojama Lua CAS.
 * ───────────────────────────────────────────────────────────────────────── */

/** @returns {object|null|"FORBIDDEN"} */
/**
 * @param {{hydrate?: boolean}} [nustatymai] forma vienoda visuose backend'uose (#157, PR-3)
 */
async function getOwned(id, scope, { hydrate = true } = {}) {
  const job = jobs.get(id);
  if (!job) return null;
  if (!matchesOwner(job, scope)) return "FORBIDDEN";

  return hydrate ? job : metaduomenuProjekcija(job);
}

/** @returns {object|null|"FORBIDDEN"|"CONCURRENCY_CONFLICT"} */
async function updateOwned(id, patch, scope, options = {}) {
  const job = jobs.get(id);
  if (!job) return null;
  /**
   * ⚠️ NUOSAVYBĖ PIRMA, VERSIJA PO JOS (#184, 7.5b).
   *
   * Tvarka yra kontrakto dalis, ne stiliaus pasirinkimas: svetimas savininkas su
   * pasenusia versija privalo gauti `"FORBIDDEN"`, o ne
   * `"CONCURRENCY_CONFLICT"`. Autorizacijos rezultato perklasifikavimas į
   * lygiagretumo rezultatą pasakytų kvietėjui „bandyk dar kartą" ten, kur
   * teisingas atsakymas yra „tau negalima".
   */
  if (!matchesOwner(job, scope)) return "FORBIDDEN";
  if (options.expectedVersion !== undefined && job.version !== options.expectedVersion) {
    return "CONCURRENCY_CONFLICT";
  }
  const next = applyPatch(job, patch);
  jobs.set(id, next);
  return next;
}

/** @returns {boolean|"FORBIDDEN"} */
async function removeOwned(id, scope) {
  const job = jobs.get(id);
  if (!job) return false;
  if (!matchesOwner(job, scope)) return "FORBIDDEN";
  jobs.delete(id);
  return true;
}

/** Pasenusių job'ų ID - be šalinimo. Predikatas TAS PATS kaip `sweepExpired`. */
async function listExpired(now = Date.now(), limit = 500) {
  const out = [];

  for (const [id, job] of jobs.entries()) {
    if (out.length >= limit) break;
    if (hasPendingCleanup(job)) continue;
    if (isFinished(job.status) && now - new Date(job.updatedAt).getTime() > TTL_MS) {
      out.push(id);
    }
  }

  return out;
}

async function sweepExpired(now = Date.now()) {
  let removed = 0;
  for (const [id, job] of jobs.entries()) {
    // Nebaigto valymo jobų NEIŠMETAM - kitaip prarastume vienintelę nuorodą į
    // likusį audio failą (žr. common.hasPendingCleanup).
    if (hasPendingCleanup(job)) continue;

    if (isFinished(job.status) && now - new Date(job.updatedAt).getTime() > TTL_MS) {
      jobs.delete(id);
      removed++;
    }
  }
  return removed;
}

async function size() {
  return jobs.size;
}

/**
 * Jobai su nustatyta boolean vėliava (`deletion_pending`,
 * `audio_cleanup_pending`). Naudoja periodiniai pakartojimo procesai -
 * žr. utils/deletionRetry.js.
 */
/**
 * VISŲ gyvų jobų storage raktai - nepriklausomai nuo statuso ar vėliavų.
 *
 * Naudoja retencijos sweeper'is (utils/retentionSweeper.js). Anksčiau jis
 * rinkdavo raktus tik iš `deletion_pending`/`audio_cleanup_pending` jobų, tad
 * paprastas `queued`/`processing` jobas su senu audio (ilgas įrašas, užstrigusi
 * eilė, GPU trūkumas) buvo palaikomas orphan ir jo failas IŠTRINAMAS dar
 * apdorojant. Čia turi būti VISI jobai.
 */
/**
 * VISOS job'o REZULTATO artefaktų nuorodos (#157, PR-5).
 *
 * ⚠️ TUŠČIAS SĄRAŠAS ČIA YRA FAKTAS, NE PRIELAIDA.
 *
 * ``memory`` rezultatą persistina TIK savo įraše: external rašymo kelio (`rasymoSaugykla`,
 * bandymų registras) šis backend'as neturi, tad „job'as neturi external artefaktų" yra
 * konstrukcijos savybė, o ne spėjimas apie duomenis. Skirtumas svarbus: fasadas `null`
 * traktuoja kaip „nežinau, netrink", o `[]` — kaip „nėra ko trinti", ir pastarasis čia
 * teisingas.
 *
 * ⚠️ JEI KADA NORS ATSIRASTŲ EXTERNAL KELIAS MEMORY BACKEND'E, ŠIS METODAS PRIVALO
 * PASIKEISTI KARTU. Kontrakto testas tikrina elgesį (po `finish()` su rezultatu sąrašas
 * lieka tuščias), tad tylus praleidimas pasimatytų.
 */
async function listResultArtifacts() {
  return [];
}

/**
 * Rezultato artefaktų šalinimas — `memory` backend'e nėra ko šalinti (#157, PR-5).
 *
 * ⚠️ TAS PATS FAKTAS KAIP `listResultArtifacts()`: external rašymo kelio šis backend'as
 * neturi, tad tuščias rezultatas yra konstrukcijos savybė. Metodas egzistuoja, kad
 * erasure kelias neturėtų `typeof === "function"` šakos: tokia šaka reikštų tylų
 * praleidimą ten, kur praleidimas yra BDAR klausimas.
 */
async function deleteResultArtifacts() {
  return { pasalinti: [], jauNebuvo: [], nepavyko: [] };
}

/**
 * Šlavimo verdiktai — `memory` backend'e kandidatų nėra (#157, PR-5).
 *
 * ⚠️ TAS PATS FAKTAS KAIP `listResultArtifacts()`: bandymų registro šis backend'as
 * neturi, tad ir šluoti nėra ko. Metodas egzistuoja, kad šlavėjas neturėtų
 * `typeof === "function"` šakos.
 */
/** Registro šis backend'as neturi — kandidatų nėra, ir tai faktas (#157, PR-5). */
async function valytiniBandymai() {
  return { kandidatai: [], praleista: 0 };
}

async function pasalintiBandymus() {
  return 0;
}

async function sweepResultArtifacts() {
  return [];
}

async function listReferencedStorageKeys() {
  const keys = new Set();
  for (const job of jobs.values()) {
    if (job.storageKey) keys.add(job.storageKey);
  }
  return [...keys];
}

/**
 * VISI jobai – atsarginėms kopijoms (#20 PR2).
 *
 * Kitos enumeracijos (`listByFlag`, `listPendingDeletions`) grąžina filtruotus
 * pogrupius. Kopijai reikia pilno vaizdo, tad ši funkcija sąmoningai neturi
 * filtro – filtravimas pagal būseną yra kopijavimo serviso sprendimas, ne
 * saugyklos.
 */
/**
 * Įrašo jobą IŠSAUGANT jo ID (#20 PR2 – atkūrimui).
 *
 * `create()` generuoja naują ID; atkuriant to negalima – kopijos įrašai nurodo
 * konkrečius identifikatorius, ir naujas ID nutrauktų visas sąsajas (audio
 * raktus, audito įrašus, išvedimo grafą).
 */
async function restoreRecord(job) {
  /**
   * ⚠️ NORMALIZUOJAMA IR ČIA (#205, 7.2c) - žr. `redisStore.restoreRecord()`.
   * Kopijos turinys yra savavališkas, o `applyPatch()` šio kelio nedengia.
   */
  const kanoninis = normalizeJob(job);
  jobs.set(kanoninis.id, kanoninis);
  return kanoninis;
}

/**
 * ATOMINIS IR IDEMPOTENTIŠKAS TERMINALUS PERĖJIMAS (#184, 7.5b).
 *
 * ⚠️ KODĖL SAUGYKLOJE, O NE FASADE.
 *
 * Fasadas negali to padaryti iš principo: sprendimas „ar tai tas pats
 * rezultatas" privalo remtis būsena, kuri nepasikeis iki įrašymo, o tarp fasado
 * `get()` ir `update()` yra `await`. Vien `expectedVersion` čia NEPADEDA:
 * idempotentiškas pakartojimas ateina su PASENUSIU snapshot'u (pirmasis
 * `finish` versiją jau padidino), tad sąlyga jį atmestų kaip konfliktą — o
 * kontraktas reikalauja TIKRO no-op.
 *
 * ⚠️ MODELIS NEIŠRASTAS. `reportProgressAtomic()` yra lygiai tas pats: fasado
 * `get` + sprendimas + `update` pora, perkelta į saugyklą kartu su GRYNĄJA
 * sprendimo funkcija (`jobPhase`). `jobPhase` lieka vienintelis perėjimų
 * autoritetas — perėjimų grafas čia neperrašomas.
 *
 * @returns {object|null|"RESULT_CONFLICT"|"COMPLETED_WITHOUT_RESULT"}
 */
async function finishAtomic(id, status, extra = {}) {
  const jobPhase = require("../jobPhase");
  const job = jobs.get(id);
  if (!job) return null;

  const jauBaigtas = idempotentiskasAtsakymas(job, status, extra);
  if (jauBaigtas !== undefined) return jauBaigtas;

  const patch = jobPhase.finish(job, status, extra);
  const next = applyPatch(job, patch);
  jobs.set(id, next);
  return next;
}

async function listAll({ hydrate = true } = {}) {
  const visi = [...jobs.values()];
  return hydrate ? visi : visi.map(metaduomenuProjekcija);
}

/**
 * ⚠️ `listByFlag()` YRA METADUOMENŲ KELIAS PAGAL APIBRĖŽIMĄ (#157, PR-3).
 *
 * Abu valymo ciklai naudoja tik vėliavą, bandymus, terminą ir `storageKey`; nė vienas
 * kvietėjas rezultato neskaito. Todėl grąžinama ta pati nehidratuota projekcija kaip
 * PostgreSQL pusėje — hidratacijos parinktis čia būtų svirtis, kurios niekam nereikia,
 * o divergencija liktų galima.
 */
async function listByFlag(field, limit = 100) {
  const pending = [];
  for (const job of jobs.values()) {
    if (job[field]) pending.push(metaduomenuProjekcija(job));
    if (pending.length >= limit) break;
  }
  return pending;
}

/**
 * ⚠️ `tiketiniAdresai` PRIIMAMAS IR IGNORUOJAMAS SĄMONINGAI (#157, PR-5).
 *
 * Artefaktų aibės CAS turi prasmę tik ten, kur yra bandymų registras. Šis backend'as
 * external rezultatų neturi, tad tikėtina aibė VISADA tuščia ir visada sutampa — tai
 * faktas, ne praleidimas. Parametras priimamas, kad kvietėjas neturėtų šakos „ar šis
 * backend'as moka".
 */
async function remove(id, _nustatymai = {}) {
  return jobs.delete(id);
}

async function close() {
  jobs.clear();
}

module.exports = { create, restoreRecord, get, update, remove, reportProgressAtomic, finishAtomic, getOwned, updateOwned, removeOwned, listExpired, sweepExpired, size, listAll, listByFlag, listReferencedStorageKeys, listResultArtifacts, deleteResultArtifacts, sweepResultArtifacts, valytiniBandymai, pasalintiBandymus, close, STATUS, JOB_TYPES, TTL_MS, backend: "memory" };
