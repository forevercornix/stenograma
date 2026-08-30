/**
 * IŠTRYNIMO ŽYMOS (tombstones) – #19 PR2, persistentinės nuo #155, 7.5a / #183.
 *
 * KODĖL ATSKIRA SAUGYKLA, o ne laukas jobo įraše.
 *
 * Žyma turi ATSAKYTI Į KLAUSIMĄ PO TO, kai jobo įrašo nebėra: „ar šis ID buvo
 * ištrintas?". Jei ji gyventų pačiame įraše, ji dingtų kartu su juo – ir
 * vėluojanti eilės žinutė ar pasenęs worker'is sukurtų artefaktus ištrintam
 * jobui, nes niekas nebeturėtų kaip to pastebėti. Dėl tos pačios priežasties
 * `erasure_marks` neturi FK į `jobs`.
 *
 * ⚠️ VISA SĄSAJA ASINCHRONINĖ (#183, P0).
 *
 * Persistentiniame režime kiekvienas atsakymas ateina iš DB, o `Promise` yra
 * truthy: `if (tombstones.isDeleted(jobId))` be `await` duotų `true` KIEKVIENAM
 * job'ui. Pasekmė nebūtų kritimas – būtų tyliai užblokuotas visas apdorojimas ir
 * neveikiantis atkūrimas, esamiems testams liekant žaliems. Statinis zondas
 * `deletionEnforcement.test.js` todėl reikalauja būtent `await`, ne paminėjimo.
 *
 * ⚠️ BE `DATABASE_URL` GARANTIJOS NĖRA.
 *
 * Atmintiniame režime žymos neišgyvena restarto ir nėra bendros replikoms – t. y.
 * tiksliai tas apribojimas, kurį 7.5a šalina. Fasadas tokiu atveju garsiai
 * įspėja, o `docs/deletion-guarantees.md` garantiją formuluoja SĄLYGINIAI:
 * besąlygiškas apribojimo pašalinimas būtų melagingas teiginys šiam režimui.
 */

const { Pool } = require("pg");

const { createLogger } = require("../logger");
const memoryStore = require("./memoryStore");
const {
  createErasureMarkStore,
  LOCK_NAMESPACE,
  RETENCIJOS_BATCH,
  STULPELIAI,
} = require("./postgresStore");
const states = require("./states");
const {
  TOMBSTONE_STATUS,
  ERASURE_REASON,
  ACTOR_KIND,
  FAILURE_KIND_EXECUTOR_LOST,
} = states;

const log = createLogger("tombstones");

/**
 * ⚠️ EKSPORTUOJAMA KONSTANTA, ne inline eilutė: turinį reikia tikrinti BE tikros
 * DB – ta pati priežastis kaip `auditStore.RETENCIJOS_ISPEJIMAS`.
 */
const ATMINTIES_ISPEJIMAS =
  "Ištrynimo žymos laikomos TIK ATMINTYJE (nėra DATABASE_URL). Jos neišgyvena " +
  "restarto ir nėra bendros replikoms, tad po restarto vėluojanti eilės žinutė " +
  "ištrintam job'ui vėl gali sukurti artefaktus. Persistentinė garantija galioja " +
  "tik diegimams su DATABASE_URL. Žr. docs/deletion-guarantees.md §2.";

/** Numatytoji atsarga virš prikėlimo horizonto. Vienas autoritetas. */
const SAFETY_MARGIN_MS = 24 * 60 * 60 * 1000; // 1 para

let store = memoryStore;
let _pool = null;
let _init = null;
let _ispejta = false;

function pasirinktiBackend(env) {
  return env.DATABASE_URL ? "postgres" : "memory";
}

async function initializePostgres(env) {
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    connectionTimeoutMillis: Number(env.PG_CONNECT_TIMEOUT_MS) || 5000,
  });

  /**
   * ⚠️ Neveiklios jungties klaida neturi nužudyti proceso – ta pati taisyklė
   * kaip `jobStore` ir `auditStore` pool'uose. Loginamas TIK kodas: `pg`
   * pranešime gali būti vartotojo vardas.
   */
  pool.on("error", (klaida) => {
    log.error("Žymų pool'o neveiklios jungties klaida – jungtis pašalinta", {
      klaida: klaida && klaida.code ? klaida.code : "nežinoma",
    });
  });

  try {
    /**
     * ⚠️ TIKRINAMI STULPELIAI, NE VIEN LENTELĖ (#183 Codex).
     *
     * `SELECT 1 FROM erasure_marks` pavyksta ir tada, kai diegimas nutrūko po
     * lentelės sukūrimo, bet PRIEŠ vėlesnę migraciją. Serveris tada priimtų
     * srautą, o kiekvienas `mark()` ir `get()` kristų vykdymo metu, nes
     * `claim_token` stulpelio nėra - tyliai, jau po readiness.
     *
     * `SELECT <stulpeliai> ... WHERE false` yra planavimo, ne skaitymo
     * operacija: trūkstamas stulpelis duoda `42703` dar prieš eilučių skaitymą,
     * o esantys nieko nekainuoja.
     */
    await pool.query(`SELECT ${STULPELIAI} FROM erasure_marks WHERE false`);
  } catch (err) {
    await pool.end().catch(() => {});
    throw new Error(
      `Ištrynimo žymų lentelė nepasiekiama (${err.message}). Grįžimas į atmintį čia ` +
        "būtų blogesnė pusė nei kritimas: barjeras tyliai nustotų galioti tarp replikų, " +
        "o ištrinti job'ai galėtų būti prikelti. Paleiskite migracijas (`npm run migrate:up`) - įskaitant vėlesnes už lentelės sukūrimą."
    );
  }

  return pool;
}

/**
 * Idempotentinė inicializacija.
 *
 * ⚠️ LAZY, NE STARTO PRIKLAUSOMYBĖ. Žymas skaito worker'iai, eilės, jobStore ir
 * atkūrimo kelias – dalis jų paleidžiama be HTTP starto. Reikalavimas kviesti
 * `init()` iš serverio reikštų, kad skripto ar worker'io kelyje barjeras tyliai
 * naudotų atmintį. Ta pati forma kaip `jobStore.ensureInit()`.
 */
async function init(env = process.env) {
  if (_init) return _init;

  _init = (async () => {
    if (pasirinktiBackend(env) === "memory") {
      store = memoryStore;

      if (!_ispejta) {
        log.warn(ATMINTIES_ISPEJIMAS);
        _ispejta = true;
      }

      return store;
    }

    _pool = await initializePostgres(env);
    store = createErasureMarkStore(_pool);
    return store;
  })().catch((klaida) => {
    /** Nesėkmė neįšaldoma: `init()` po pataisytos konfigūracijos privalo kartotis. */
    _init = null;
    throw klaida;
  });

  return _init;
}

async function ensureInit() {
  await init();
}

/**
 * GYVA BŪSENA READINESS KELIUI (#183 Codex, P1).
 *
 * ⚠️ „LAZY init" IR „NIEKADA NEZONDUOJAMA" NĖRA TAS PATS.
 *
 * Lazy `init()` lieka - skriptai ir worker'iai neturi HTTP starto. Bet be
 * zondo instancija su nustatytu `DATABASE_URL` ir nepasiekiama DB startuodavo,
 * praneštų `ready`, priimtų job'us, o gedimą aptiktų tik pirmo `isDeleted()`
 * metu. Tai ta pati forma kaip 7.4f `readiness.auditStore`, kurio `/api/ready`
 * netikrino.
 *
 * NIEKADA nemeta: readiness privalo atsakyti ir tada, kai atsakymas yra „ne".
 */
async function probe() {
  try {
    await init();
    return (await store.probe()) === true;
  } catch {
    return false;
  }
}

/** Ar `init()` jau įvykdytas sėkmingai (starto vėliavai). */
function isReady() {
  return _init !== null;
}

async function shutdown() {
  if (_pool) {
    await _pool.end().catch(() => {});
    _pool = null;
  }
  store = memoryStore;
  _init = null;
}

/**
 * Įrašo žymą. Idempotentinis: pakartotinis kvietimas NEPERRAŠO pirmojo
 * `requestedAt` ir negrąžina jau `deleted` žymos atgal į `pending`.
 */
async function mark(jobId, { reason = ERASURE_REASON.USER_REQUEST, actorKind = null } = {}) {
  if (!jobId) return null;

  await ensureInit();
  const irasas = await store.mark(jobId, { reason, actorKind });

  if (irasas && irasas.status === TOMBSTONE_STATUS.PENDING && irasas.attempts === 0) {
    log.info("Ištrynimo žyma įrašyta", { jobId, status: irasas.status });
  }

  return irasas;
}

/**
 * Užbaigia žymą po realaus trynimo.
 *
 * ⚠️ NELEIDŽIAMAS PERĖJIMAS NEMETAMAS, o žyma lieka ankstesnėje būsenoje –
 * elgesys nepakeistas nuo 7.4a: ištrynimas jau įvyko, ir versti jį nesėkme dėl
 * būsenos apskaitos būtų blogesnė pusė. Grąžinama AUTORITETINGA būsena.
 */
async function complete(jobId, status, { completedAt = null, failureKind = null } = {}) {
  if (!jobId) return null;

  await ensureInit();

  const rezultatas = await store.transition(jobId, status, { completedAt, failureKind });

  if (rezultatas) {
    log.info("Ištrynimo žyma užbaigta", { jobId, status });
    return rezultatas;
  }

  const esama = await store.get(jobId);

  if (esama) {
    log.warn("Neleidžiamas žymos perėjimas praleistas", {
      jobId,
      from: esama.status,
      to: status,
    });
  }

  return esama;
}

/**
 * EKSPLICITINIS retry: `deletion_failed → deletion_pending`.
 *
 * ⚠️ TIESIOGINIS `failed → deleted` UŽDARYTAS 7.5a. Anksčiau `complete()` leido
 * pasiekti `deleted` tiesiai iš `failed`, t. y. be jokio įrodymo, kad antras
 * bandymas apskritai vyko. Dabar patvirtintas ištrynimas visada turi prieš save
 * `pending` būseną, ir tai daro būseną vienareikšmę.
 */
async function retry(jobId, { actorKind = ACTOR_KIND.OPERATOR } = {}) {
  if (!jobId) return null;

  await ensureInit();

  return store.transition(jobId, TOMBSTONE_STATUS.PENDING, { actorKind });
}

/**
 * OPERATORIAUS IŠEITIS: neterminalė žyma paskelbiama išspręsta.
 *
 * ⚠️ PĖDSAKAS PRIVALOMAS, TAD ŠIS KELIAS EINA PER `erasureMarkService`.
 * Čia paliktas tik perėjimas; audito įrašą rašo servisas PRIEŠ jį (fail-closed:
 * neužfiksavus, kas nuėmė barjerą, barjeras nenuimamas).
 */
/**
 * UŽSTRIGUSIOS PRETENZIJOS ATLAISVINIMAS: `pending` → `deletion_failed` (#183).
 *
 * ⚠️ TAI NĖRA TEIGINYS APIE DUOMENIS.
 *
 * `forceResolve` tvirtina „duomenų nebėra" ir uždaro žymą į `deleted`. `release`
 * netvirtina NIEKO: po kieto proceso nužudymo nežinoma, kiek valymo spėta
 * atlikti. Jis pasako tik tai, kas tikrai žinoma - vykdytojo nebėra - ir grąžina
 * žymą į būseną, iš kurios veikia įprastas `retry`.
 *
 * ⚠️ BARJERAS NENUIMAMAS NĖ AKIMIRKAI. `deletion_pending` ir `deletion_failed`
 * abu blokuoja artefaktų kūrimą, o perėjimas tarp jų yra vienas sąlyginis
 * `UPDATE`. Tarpinės būsenos, kurioje jobas būtų praleidžiamas, nėra.
 *
 * ⚠️ AUTOMATINIO APTIKIMO NĖRA SĄMONINGAI. Lease ar heartbeat ant `pending`
 * būtų paskirstyta nuoma - būtent tai, ko 7.5a atsisakė (DoD draudžia laikyti
 * lock'ą per išorinį I/O). „Vykdytojas mirė" yra operatoriaus sprendimas, ne
 * laikmačio išvada.
 *
 * Grąžina `null`, jei žyma NE `deletion_pending`: iš `deleted` ir
 * `deletion_failed` atlaisvinti nėra ko.
 */
async function release(jobId, { actorKind = ACTOR_KIND.OPERATOR } = {}) {
  if (!jobId) return null;

  await ensureInit();

  return store.transitionOverride(
    jobId,
    [TOMBSTONE_STATUS.PENDING],
    TOMBSTONE_STATUS.FAILED,
    { failureKind: FAILURE_KIND_EXECUTOR_LOST, actorKind }
  );
}

async function forceResolve(jobId, { actorKind = ACTOR_KIND.OPERATOR, completedAt = null } = {}) {
  if (!jobId) return null;

  await ensureInit();

  /** ⚠️ `transitionOverride`, ne `transition`: mašina `failed → deleted` neleidžia. */
  return store.transitionOverride(
    jobId,
    [TOMBSTONE_STATUS.PENDING, TOMBSTONE_STATUS.FAILED],
    TOMBSTONE_STATUS.DELETED,
    { completedAt, actorKind }
  );
}

/**
 * Ar šis ID pažymėtas ištrynimui BET KOKIA būsena?
 *
 * ⚠️ TIK ŽYMOS NEBUVIMAS REIŠKIA „NĖRA BARJERO". `deletion_failed` barjerą
 * IŠLAIKO: nesėkmingas ištrynimas reiškia, kad jautrūs duomenys dar gali
 * egzistuoti, ir naujų artefaktų kurti negalima.
 */
async function isDeleted(jobId) {
  if (!jobId) return false;

  await ensureInit();

  if (typeof store.isBarred === "function") return store.isBarred(jobId);
  return Boolean(await store.get(jobId));
}

/** 7.4e vardas tam pačiam klausimui – barjeras, ne „ištrinta". */
const isBarred = isDeleted;

/**
 * Ar ištrynimas PATVIRTINTAS? Tik ši būsena leidžia trumpinti kelią.
 */
async function isConfirmedDeleted(jobId) {
  if (!jobId) return false;

  await ensureInit();
  const irasas = await store.get(jobId);

  return Boolean(irasas && irasas.status === TOMBSTONE_STATUS.DELETED);
}

async function get(jobId) {
  if (!jobId) return null;

  await ensureInit();
  return store.get(jobId);
}

/** 7.4e vardas – pilna barjero būsena vienu skaitymu. */
const barrierState = get;

/**
 * Aukščiausias išleistos kopijos galiojimas, perskaitytas iš saugyklos.
 *
 * ⚠️ Talpykla, ne autoritetas: autoritetas yra `backup_horizon` lentelė.
 * Atnaujinama kaskart ją rašant ir prieš retencijos ciklą, tad sumažinta
 * `BACKUP_RETENTION_DAYS` reikšmė barjero nesutrumpina.
 */
let _kopijuHorizontas = null;

/** Užfiksuoja išleistos kopijos galiojimą. Kviečia `backupService`. */
async function recordBackupHorizon(expiresAtMs) {
  await ensureInit();

  const naujas = await store.recordBackupHorizon(expiresAtMs);
  if (Number.isFinite(naujas)) _kopijuHorizontas = naujas;

  return naujas;
}

/** Perskaito autoritetingą horizontą ir atnaujina talpyklą. */
async function refreshBackupHorizon() {
  await ensureInit();

  const reiksme = await store.backupHorizon();
  _kopijuHorizontas = Number.isFinite(reiksme) ? reiksme : null;

  return _kopijuHorizontas;
}

/**
 * PRETENZIJA Į IŠTRYNIMO VYKDYMĄ (#183, 7.5a DoD).
 *
 * ⚠️ VIENAS MECHANIZMAS, NE DU. Ankstesnė versija turėjo išimtį
 * (`attempts === 0`), kuri autorizuotam pakartojimui pretenzijos NETAIKĖ - tad
 * visos replikos, gavusios tą patį operatoriaus `retry`, vykdydavo lygiagrečiai.
 * DoD reikalauja vieno vykdytojo BESĄLYGIŠKAI, be išimčių.
 *
 * Pretenzija yra BŪSENA (`claim_token`), ne akimirka:
 *
 *   - šviežia žyma - pretenziją duoda `INSERT ... ON CONFLICT DO NOTHING`:
 *     eilutę grąžina tik įterpėjas;
 *   - autorizuotas pakartojimas (`retry` paliko `claim_token IS NULL`) -
 *     pretenziją duoda sąlyginis `UPDATE`; laimi vienas.
 *
 * ⚠️ Vėliau atėjusi replika mato jau nustatytą žetoną ir pretenzijos negauna,
 * NESVARBU, KIEK LAIKO PRAĖJO. Tuo tai skiriasi nuo `updated_at` palyginimo,
 * kuris atskirtų tik vienu metu skaičiusius: antroji replika perskaitytų
 * po-pretenzijos reikšmę ir ja sėkmingai pasiremtų.
 *
 * ⚠️ Miręs vykdytojas žetono neatlaisvina - tai NE nuoma, laikmačio nėra.
 * Sprendimą priima operatorius per `erasure-marks release`, kuris žymą perveda
 * į `deletion_failed` ir tuo pačiu nuvalo žetoną.
 *
 * @returns {Promise<{zyma: object|null, vykdytojas: boolean}>}
 */
async function claimForDeletion(jobId, { reason = ERASURE_REASON.USER_REQUEST, actorKind = null } = {}) {
  const zyma = await mark(jobId, { reason, actorKind });

  if (!zyma) return { zyma: null, vykdytojas: false };

  /** Žymą įrašė šis kvietėjas - pretenzija atėjo kartu su `INSERT`. */
  if (zyma.claimed) return { zyma, vykdytojas: true };

  /** `deleted` ir `deletion_failed` turi savo atsakymus - jų kvietėjas tikrina. */
  if (zyma.status !== TOMBSTONE_STATUS.PENDING) return { zyma, vykdytojas: false };

  const paimta = await store.claimRetry(jobId);

  return paimta ? { zyma: paimta, vykdytojas: true } : { zyma, vykdytojas: false };
}

/**
 * 7.4e TOCTOU PRIELAIDA.
 *
 * Persistentiniame režime patikra vykdoma KVIETĖJO transakcijoje su tuo pačiu
 * advisory lock'u, kurį ima `mark()`, tad „patikrink, tada rašyk" tampa
 * atominis. Atmintiniame režime transakcijos nėra – ir tai yra ta pati riba,
 * kurią įvardija `ATMINTIES_ISPEJIMAS`, ne atskiras gedimas.
 */
async function assertNotBarred(klientas, jobId) {
  /**
   * ⚠️ SPĄSTAI, KURIUOS ŠIS `ensureInit()` PASTATĖ VIENĄ KARTĄ (#183).
   *
   * Init jungiasi pagal `process.env.DATABASE_URL`, o `klientas` gali priklausyti
   * VISAI KITAI duomenų bazei - taip ir nutiko, kai `jobStore.restoreRecord()`
   * kvietė šį fasadą: CI testas migruoja `<bazė>_store`, o aplinka rodė į
   * `<bazė>`, ir patikra krisdavo fail-closed dėl lentelės, kurios nėra TEN,
   * nors kvietėjo DB ji buvo.
   *
   * Jei kvietėjas jau turi klientą, jam reikia
   * `postgresStore.assertNotBarredWithClient()` - ji naudoja tik tą klientą.
   * Šis kelias lieka tiems, kam reikia ir backend'o parinkimo (atminties režimo
   * fallback žemiau).
   */
  await ensureInit();

  if (typeof store.assertNotBarred === "function") {
    return store.assertNotBarred(klientas, jobId);
  }

  const irasas = await store.get(jobId);
  if (!irasas) return undefined;

  const klaida = new Error(`Job ${jobId} užbarjeruotas ištrynimo žyma (${irasas.status}).`);
  klaida.code = "ERASURE_BARRIER";
  klaida.status = irasas.status;
  throw klaida;
}

/** Neterminalės žymos su amžiumi – operatoriaus matomumo kelias (#183). */
async function listUnresolved(options = {}) {
  await ensureInit();
  return store.listUnresolved(options);
}

/**
 * TOMBSTONE RETENCIJA (#183).
 *
 *   max(prikėlimo horizontas, kopijų horizontas) + atsarga
 *
 * ⚠️ FAIL-SAFE: negalint patikimai apskaičiuoti bet kurios dedamosios,
 * grąžinamas `null` = ŽYMŲ NEŠALINTI. Mažesnio TTL pasirinkimas reikštų, kad
 * abejodami trinam barjerą – t. y. blogiausią įmanomą pusę.
 *
 * ⚠️ `DELETION_TOMBSTONE_TTL_HOURS` GALI TIK PAILGINTI. Iki 7.5a jis buvo
 * vienintelis terminas; palikus jį kaip autoritetą, operatorius galėtų nustatyti
 * reikšmę žemiau prikėlimo horizonto ir tyliai sulaužyti garantiją.
 */
function retentionMs(env = process.env) {
  let horizontas;

  try {
    const { revivalHorizonsMs } = require("../../queues/config");
    horizontas = revivalHorizonsMs(env).horizonMs;
  } catch (klaida) {
    log.warn("Prikėlimo horizonto apskaičiuoti nepavyko – žymos NEŠALINAMOS", {
      klaida: klaida.message,
    });
    return null;
  }

  let kopijos;

  try {
    const { retentionDays } = require("../backupPolicy");
    kopijos = Number(retentionDays(env)) * 24 * 60 * 60 * 1000;

    /**
     * ⚠️ JAU IŠLEISTA KOPIJA GALI GALIOTI ILGIAU NEI DABARTINIS NUSTATYMAS.
     *
     * `BACKUP_RETENTION_DAYS` sumažinimas neatšaukia anksčiau eksportuotos
     * kopijos: ji tebegalioja pagal savo manifestą. Skaičiuojant tik iš
     * dabartinės reikšmės, žyma būtų pašalinta anksčiau, nei nustoja galioti
     * senesnė kopija - ir atkūrimas iš jos ištrynimą atstatytų.
     *
     * `_kopijuHorizontas` yra aukščiausias KŪRIMO metu užfiksuotas galiojimas.
     * Jis niekada nemažėja, tad barjeras negali sutrumpėti dėl konfigūracijos
     * pakeitimo. `null` reiškia, kad kopijų dar nebuvo (arba jos kurtos be
     * `DATABASE_URL` - žr. `docs/deletion-guarantees.md`).
     */
    if (Number.isFinite(_kopijuHorizontas)) {
      kopijos = Math.max(kopijos, _kopijuHorizontas - Date.now());
    }
  } catch (klaida) {
    log.warn("Kopijų retencijos apskaičiuoti nepavyko – žymos NEŠALINAMOS", {
      klaida: klaida.message,
    });
    return null;
  }

  if (![horizontas, kopijos].every((v) => Number.isFinite(v) && v > 0)) {
    log.warn("Nepilni retencijos dydžiai – žymos NEŠALINAMOS", { horizontas, kopijos });
    return null;
  }

  const bazine = Math.max(horizontas, kopijos) + SAFETY_MARGIN_MS;

  const rankinis = Number(env.DELETION_TOMBSTONE_TTL_HOURS);
  if (Number.isFinite(rankinis) && rankinis > 0) {
    const rankinisMs = rankinis * 60 * 60 * 1000;
    if (rankinisMs > bazine) return rankinisMs;

    log.warn(
      "DELETION_TOMBSTONE_TTL_HOURS mažesnis už apskaičiuotą minimumą – IGNORUOJAMAS. " +
        "Trumpesnis terminas pašalintų žymą anksčiau, nei job'as nebegali būti prikeltas.",
      { rankinisMs, minimumas: bazine }
    );
  }

  return bazine;
}

/**
 * Šalina TIK `deleted` žymas, senesnes už retencijos terminą.
 *
 * ⚠️ KVIEČIAMA IŠ `retentionSweeper`, NE IŠ SAVO TIMER'IO – ta pati taisyklė
 * kaip 7.4d audito retencijoje. Antras timer'is reikštų antrą konfigūraciją,
 * antrą laikrodį ir įrašą, rodantį tik vieno jų darbą.
 */
async function purgeExpired(now = Date.now(), env = process.env) {
  await ensureInit();

  /**
   * ⚠️ HORIZONTAS PERSKAITOMAS PRIEŠ TERMINO SKAIČIAVIMĄ.
   *
   * Kopiją galėjo sukurti KITA replika, tad proceso talpykla be šio skaitymo
   * būtų pasenusi, ir žymos būtų šalinamos pagal trumpesnį terminą nei tikrasis
   * išleistų kopijų galiojimas.
   */
  await refreshBackupHorizon().catch((klaida) =>
    log.warn("Kopijų horizonto perskaityti nepavyko", { klaida: klaida.message })
  );

  const terminas = retentionMs(env);
  if (terminas === null) return { removed: 0, skipped: true };

  /**
   * ⚠️ RIBĄ SKAIČIUOJA SAUGYKLA (#183 Codex, P2).
   *
   * `updated_at` rašomas DB `now()`, tad riba privalo ateiti iš to paties
   * laikrodžio - kitaip skubanti replika ištrintų barjerus anksčiau laiko.
   * Atmintyje ta pati funkcija remiasi įleidžiamu `now`, tad kontroliuojamas
   * laiko šaltinis galioja abiem pusėms.
   */
  const cutoff = await store.retencijosRiba(terminas, now);
  let pasalinta = 0;

  try {
    for (;;) {
      const kiek = await store.purgeExpired(cutoff, RETENCIJOS_BATCH);
      pasalinta += kiek;
      if (kiek < RETENCIJOS_BATCH) break;
    }
  } catch (klaida) {
    /**
     * ⚠️ JAU ĮVYKDYTI BATCH'AI NEDINGSTA IŠ ATASKAITOS (#183 Codex, P2).
     *
     * Kiekvienas batch'as commit'inasi atskirai. Kritus vėlesniam, be šito
     * `RETENTION_PURGE` praneštų `tombstones=0`, nors barjerai jau negrįžtamai
     * pašalinti. Gretimas audito retencijos kelias tą patį daro nuo 7.4d.
     */
    klaida.pasalinta = pasalinta;
    throw klaida;
  }

  return { removed: pasalinta, skipped: false };
}

async function size() {
  await ensureInit();
  return store.size();
}

/** Testams. */
async function _clearForTests() {
  await ensureInit();
  await store.clear();
}

/**
 * ⚠️ LIKO KAIP NO-OP SĄMONINGAI.
 *
 * Iki 7.5a modulis turėjo savo `setInterval` valymą, ir dešimtys testų jį
 * stabdo `before` bloke. Timer'io nebėra (valymas persikėlė į `retentionSweeper`),
 * bet kvietimo pašalinimas iš visų testų būtų triukšmas be naudos, o funkcijos
 * nebuvimas juos sulaužytų.
 */
function _stopSweepForTests() {}

module.exports = {
  TOMBSTONE_STATUS,
  ERASURE_REASON,
  ACTOR_KIND,
  ALLOWED_TRANSITIONS: states.ALLOWED_TRANSITIONS,
  ATMINTIES_ISPEJIMAS,
  SAFETY_MARGIN_MS,
  LOCK_NAMESPACE,
  RETENCIJOS_BATCH,

  init,
  ensureInit,
  probe,
  isReady,
  shutdown,
  mark,
  complete,
  retry,
  forceResolve,
  release,
  isDeleted,
  isBarred,
  isConfirmedDeleted,
  get,
  barrierState,
  claimForDeletion,
  recordBackupHorizon,
  refreshBackupHorizon,
  assertNotBarred,
  listUnresolved,
  retentionMs,
  purgeExpired,
  size,

  _clearForTests,
  _stopSweepForTests,

  /** Kuris backend'as realiai aptarnauja žymas. Testams ir readiness. */
  get backend() {
    return store.backend;
  },
};
