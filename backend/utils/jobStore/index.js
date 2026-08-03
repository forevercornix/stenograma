const memoryStore = require("./memoryStore");
const { STATUS, JOB_TYPES, TTL_MS } = require("./common");
const { createLogger } = require("../../utils/logger");
const tombstones = require("../deletionTombstones");

/**
 * VIDINIS gyvavimo ciklo raktas (#19 PR3).
 *
 * TIK ištrynimo keliams, kurie privalo galėti keisti jobą po žymos uždėjimo.
 * `Symbol` pasirinktas sąmoningai: jo negalima atspėti, atsitiktinai įrašyti
 * ar perduoti iš konfigūracijos – reikia eksplicitiškai importuoti, o tai
 * matoma peržiūroje.
 *
 * ⚠️ NENAUDOTI produkciniame kode už `services/lifecycleService.js` ribų.
 * Struktūrinis testas tikrina, kurie failai jį mini.
 */
const LIFECYCLE_INTERNAL = Symbol("jobStore.lifecycleInternal");
const log = createLogger("job-store");

/**
 * Job store įėjimo taškas su AUTOMATINIU backend'o parinkimu:
 *
 *   REDIS_URL nustatytas + prisijungimas pavyksta  -> Redis (persistentus)
 *   REDIS_URL nenustatytas ARBA prisijungimas krito -> in-memory (fallback)
 *
 * Fallback logika sąmoninga: jei kažkas nustato REDIS_URL, bet Redis neprieinamas
 * (pvz. dev be Docker), sistema NEUŽLŪŽTA - grįžta į in-memory su AIŠKIU įspėjimu.
 * Tai geriau nei kietas gedimas paleidimo metu. Produkcijoje, kur persistencija
 * privaloma, REDIS_REQUIRED=true paverčia fallback kritine klaida.
 *
 * Visa sąsaja ASYNC (create/get/update/sweepExpired/size grąžina Promise), tad
 * routes kodas vienodas nepriklausomai nuo backend'o.
 */

let store = memoryStore; // numatyta, kol init() nepakeičia
let initPromise = null;   // bendras inicijavimo Promise (žr. init() komentarą)
let _redisFactoryForTests = null; // TESTAMS: injektuota Redis factory (žr. eksportus)

/**
 * RACE CONDITION APSAUGA: anksčiau `initialized = true` buvo nustatomas IŠKART, o Redis
 * prisijungimas (await) vyko vėliau. Tuo tarpu kita užklausa matydavo initialized=true,
 * NElaukdavo Redis, ir naudodavo memoryStore. Job'as sukurtas atmintyje, po to store
 * pakeičiamas į Redis, polling job'o Redis neranda -> "Jobas nerastas", nors buvo priimtas.
 *
 * Sprendimas: init() grąžina BENDRĄ initPromise. Visi create/get/update per ensureInit
 * laukia TO PATIES vykstančio inicijavimo (ne boolean flag'o), tad store būna galutinis
 * PRIEŠ pirmą operaciją.
 */
async function init() {
  if (initPromise) return initPromise;
  initPromise = initializeStore().catch((error) => {
    initPromise = null; // leidžiam pakartoti init po nesėkmės (ne užrakinam amžinai)
    throw error;
  });
  return initPromise;
}

async function initializeStore() {
  const redisUrl = process.env.REDIS_URL;

  // GDPR #5: centralizuota privatumo nuostata NUGALI REDIS_URL. Normaliai iki čia
  // net neprieinam - validateConfig() tokį derinį atmeta paleidžiant. Tai antras
  // apsaugos sluoksnis atvejams, kai serveris paleidžiamas apeinant validaciją
  // (testai, embedded naudojimas): efemeriškas režimas privalo likti efemeriškas.
  const { getPrivacyPolicy } = require("../privacyPolicy");
  const privacy = getPrivacyPolicy();
  if (privacy.persistentExplicit && !privacy.persistentStorage) {
    if (redisUrl) {
      log.warn(
        "⚠️  PERSISTENT_STORAGE=false - REDIS_URL IGNORUOJAMAS, " +
          "job store lieka atmintyje."
      );
    }
    store = memoryStore;
    return store;
  }

  if (!redisUrl) {
    // Nėra REDIS_URL - tyliai naudojam in-memory (numatytas dev/demo režimas).
    store = memoryStore;
    return store;
  }

  try {
    // TESTAMS: injektuojama Redis factory (žr. _setRedisFactoryForTests). Produkcijoje -
    // tikras ioredis. Tai leidžia testuoti tikrą race (lėtas connect() per gate).
    const Redis = _redisFactoryForTests || require("ioredis");
    const { createRedisStore } = require("./redisStore");

    const client = new Redis(redisUrl, {
      // Nekartojam amžinai, jei Redis neprieinamas - greitai grįžtam į fallback.
      maxRetriesPerRequest: 2,
      retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
      lazyConnect: true,
    });

    // Bandom prisijungti su timeout - jei nepavyksta, fallback.
    await client.connect();
    await client.ping();

    store = createRedisStore(client);
    log.info("Job store: Redis (persistentus, atsparus restartams)");
    return store;
  } catch (err) {
    const msg = `Redis neprieinamas (${err.message}). `;
    if (process.env.REDIS_REQUIRED === "true") {
      // Produkcijoje, kur persistencija privaloma - kietas gedimas geriau nei
      // tylus darbo praradimas.
      throw new Error(
        `${msg}REDIS_REQUIRED=true, tad neparleidžiu su in-memory. Patikrinkite REDIS_URL ir Redis serverį.`
      );
    }
    log.warn(
      `⚠️  ${msg}Grįžtu į IN-MEMORY job store (jobai NEišliks perkrovus backendą). ` +
        `Produkcijai su persistencija - paleiskite Redis ir patikrinkite REDIS_URL.`
    );
    store = memoryStore;
    return store;
  }
}

// Proxy funkcijos - deleguoja į aktyvų backend'ą. init() iškviečiamas automatiškai
// pirmo naudojimo metu, jei dar nebuvo (kad veiktų ir be aiškaus init server.js).
// SVARBU: ensureInit LAUKIA init() Promise - tad store galutinis prieš operaciją.
async function ensureInit() {
  await init();
}

module.exports = {
  init,
  create: async (fields = {}) => {
    await ensureInit();
    return store.create(fields);
  },
  get: async (id) => {
    await ensureInit();
    return store.get(id);
  },
  /**
   * @param {string} id
   * @param {object} patch
   * @param {{allowAfterDeletion?: boolean}} [options]
   */
  LIFECYCLE_INTERNAL,

  /**
   * @param {string} id
   * @param {object} patch
   * @param {{allowAfterDeletion?: symbol}} [options] - apėjimui reikia
   *   `jobStore.LIFECYCLE_INTERNAL`, ne `true`
   * @returns {Promise<object|null>} `null` reiškia DVI skirtingas situacijas:
   *   jobo nėra ARBA atnaujinimas atmestas dėl ištrynimo žymos. Kvietėjui abi
   *   reiškia „nerašyk toliau", tad jos nesiskiria; jei kada nors prireiks
   *   atskirti, reikės atskiro grąžinimo tipo, ne `null`.
   */
  update: async (id, patch, options = {}) => {
    await ensureInit();

    /**
     * IŠTRYNIMO ŽYMOS PATIKRA – VIENAME TAŠKE (#19 PR3).
     *
     * Žyma iki šiol buvo tik uždedama, bet niekas jos netikrino: vėluojanti
     * eilės žinutė ar pasenęs worker'is galėjo atkurti artefaktus jau
     * ištrintam jobui, ir ištrynimas tapdavo laikinu.
     *
     * KODĖL ČIA, o ne prie kiekvieno kvietimo. `jobStore.update` yra
     * VIENINTELIS kelias, kuriuo jobo įrašas keičiasi – tiek inline, tiek
     * BullMQ worker'yje, tiek retencijoje. Patikra prie kiekvieno kvietėjo
     * reikštų kelis dešimtis vietų, iš kurių viena anksčiau ar vėliau būtų
     * pamiršta – ir spraga būtų tyli.
     *
     * APĖJIMAS REIKALAUJA SIMBOLIO, ne `true`.
     *
     * Pirmoji versija priėmė `{ allowAfterDeletion: true }` – ir tai buvo per
     * galingas „escape hatch": bet kuris naujas kvietėjas galėjo jį parašyti
     * netyčia (ar bandydamas „pataisyti" atmestą atnaujinimą) ir vėl atidaryti
     * kelią artefaktų kūrimui po ištrynimo.
     *
     * `LIFECYCLE_INTERNAL` yra `Symbol` – jo negalima atspėti, atsitiktinai
     * įrašyti ar gauti iš JSON konfigūracijos. Kad juo pasinaudotum, reikia
     * eksplicitiškai importuoti iš `jobStore`, o tai matoma peržiūroje.
     */
    if (options.allowAfterDeletion !== LIFECYCLE_INTERNAL && tombstones.isDeleted(id)) {
      log.warn("Atmestas jobo atnaujinimas po ištrynimo", { jobId: id });
      return null;
    }

    return store.update(id, patch);
  },
  remove: async (id) => {
    await ensureInit();
    return store.remove(id);
  },
  sweepExpired: async (now) => {
    await ensureInit();
    return store.sweepExpired(now);
  },
  listPendingDeletions: async (limit) => {
    await ensureInit();
    return typeof store.listByFlag === "function"
      ? store.listByFlag("deletion_pending", limit)
      : [];
  },
  /**
   * Grąžina `null`, jei saugykla to nepalaiko - iškviečiantis kodas tada NETURI
   * nieko trinti (fail-safe), o ne laikyti, kad nėra naudojamų failų.
   */
  /**
   * VISI jobai – atsarginėms kopijoms (#20 PR2).
   *
   * ⚠️ Grąžina PILNĄ sąrašą, tad dideliuose diegimuose jis gali būti didelis.
   * Skirtas kopijavimui, ne užklausų keliui.
   */
  /**
   * Atkuria jobo įrašą IŠSAUGANT ID (#20 PR2).
   *
   * ⚠️ GERBIA IŠTRYNIMO ŽYMAS (#19). Jei ID pažymėtas ištrintu, atkūrimas jo
   * NEATSTATO – priešingu atveju atsarginė kopija taptų būdu apeiti GDPR
   * ištrynimą, ir visos #19 garantijos taptų laikinos.
   *
   * Tai svarbiausia šio metodo savybė, ne šalutinė: kopija atkuria BŪKLĘ, bet
   * negali atšaukti sprendimo ištrinti.
   */
  restoreRecord: async (job) => {
    await ensureInit();

    if (!job || !job.id) {
      const error = new Error("Atkuriamas jobas be identifikatoriaus.");
      error.code = "RESTORE_RECORD_INVALID";
      throw error;
    }

    if (tombstones.isDeleted(job.id)) {
      log.warn("Atkūrimas praleido ištrintą jobą", { jobId: job.id });
      return null;
    }

    return store.restoreRecord(job);
  },

  listAll: async () => {
    await ensureInit();
    return store.listAll();
  },

  listReferencedStorageKeys: async () => {
    await ensureInit();
    return typeof store.listReferencedStorageKeys === "function"
      ? store.listReferencedStorageKeys()
      : null;
  },
  listPendingAudioCleanups: async (limit) => {
    await ensureInit();
    return typeof store.listByFlag === "function"
      ? store.listByFlag("audio_cleanup_pending", limit)
      : [];
  },
  size: async () => {
    await ensureInit();
    return store.size();
  },
  close: async () => {
    if (store && typeof store.close === "function") await store.close();
  },
  getBackend: () => store.backend || "memory",
  STATUS,
  JOB_TYPES,
  TTL_MS,

  // --- TIK TESTAMS (dependency injection tikrai race patikrai) ---
  _resetForTests: async () => {
    // Uždarom aktyvų store (jei Redis) prieš pametant nuorodą - kitaip liktų atvira
    // jungtis / kabantis handle (testų procesas galėtų neužsibaigti).
    if (store && typeof store.close === "function") {
      try {
        await store.close();
      } catch (error) {
        // Netylim visiškai - realus close() defektas (mock ar Redis) neturi likti paslėptas.
        log.warn("[test cleanup] Nepavyko uždaryti job store:", error.message);
      }
    }
    initPromise = null;
    store = memoryStore;
    _redisFactoryForTests = null;
  },
  _setRedisFactoryForTests: (factory) => {
    _redisFactoryForTests = factory;
  },
  _getStoreForTests: () => store,
};
