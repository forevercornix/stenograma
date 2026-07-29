const memoryStore = require("./memoryStore");
const { STATUS, JOB_TYPES, TTL_MS } = require("./common");

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
    console.log("[stenograma] Job store: Redis (persistentus, atsparus restartams)");
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
    console.warn(
      `[stenograma] ⚠️  ${msg}Grįžtu į IN-MEMORY job store (jobai NEišliks perkrovus backendą). ` +
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
  update: async (id, patch) => {
    await ensureInit();
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
    return typeof store.listPendingDeletions === "function"
      ? store.listPendingDeletions(limit)
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
        console.warn("[test cleanup] Nepavyko uždaryti job store:", error.message);
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
