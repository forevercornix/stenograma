const memoryStore = require("./memoryStore");
const { STATUS, JOB_TYPES, TTL_MS } = require("./common");
const { createLogger } = require("../../utils/logger");
const tombstones = require("../deletionTombstones");
const maintenanceLock = require("../maintenanceLock");

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

/**
 * „Yra, bet ne tavo" (#159).
 *
 * ATSKIRAS nuo `null`, nes 152.3 pagal šį skirtumą sprendžia 403 vs 404.
 * Sulieti į `null` reikštų, kad transporto sluoksnis nebeturi iš ko pasirinkti,
 * o sprendimą tektų priimti iš naujo jau su prarasta informacija.
 *
 * `Symbol` - jo negalima atsitiktinai gauti iš JSON ar sumaišyti su job objektu.
 */
const FORBIDDEN = Symbol("jobStore.FORBIDDEN");

const { OWNER_KIND, assertOwnerIdentity } = require("./common");
const jobPhase = require("../jobPhase");

/**
 * FAZĖS LAUKAI VALDOMI TIK PER `jobPhase` (#154).
 *
 * Neapdorotas `update({ phase, progress })` apeitų `status × phase` invariantą:
 * fazės perėjimas turi ATOMINIAI resetinti progresą, terminalus – jį išvalyti,
 * o pavėlavęs įvykis – būti atmestas. Patch'as, sukonstruotas ranka, nė vienos
 * iš šių taisyklių nežino.
 *
 * Todėl store atmeta tokius patch'us ir siūlo `startPhase` / `reportProgress` /
 * `finish`.
 *
 * Sargas gyvena FASADE. Fazės metodai kviečia backend'ą (`store.update`)
 * tiesiogiai, tad jiems išimties nereikia – ir nereikia žymos, kurią kas nors
 * galėtų perduoti iš išorės, kad sargą apeitų.
 */
const PHASE_STATE_FIELDS = ["status", "phase", "progress", "progressKnown"];

/**
 * IŠTRYNIMO ŽYMOS PATIKRA FAZIŲ KELIUI (#154 + #19).
 *
 * ⚠️ Fazių metodai kviečia `store.update()` TIESIOGIAI, tad `update()` fasado
 * apsauga jų nedengia. Be šios patikros vėluojanti eilės žinutė galėtų
 * „atgaivinti" jau ištrintą job'ą per `startPhase()` ar `finish()` – t. y.
 * atkurti įrašą, kurio vartotojas paprašė nebeturėti.
 *
 * Grąžina `true`, jei operaciją reikia praleisti.
 */
function blockedByTombstone(id, method) {
  if (!tombstones.isDeleted(id)) return false;
  log.warn(`Atmestas jobo ${method}() po ištrynimo`, { jobId: id });
  return true;
}

/**
 * ⚠️ `status` ĮTRAUKTAS SĄMONINGAI.
 *
 * #154 invariantas nėra vien `phase`/`progress` invariantas – tai
 * `status × phase × progress × progressKnown` invariantas. Saugant tik tris
 * laukus, liktų atviras kelias:
 *
 *   update(id, { status: "completed" })
 *
 * kuris sukurtų `completed + phase=transcribing + progress=3900/4400` – būtent
 * tą būseną, kurią `finish()` turėjo padaryti neįmanomą. Dokumentacija sakytų
 * „klaidos keliai privalo eiti per finish()", bet store to neužtikrintų.
 */
function assertNoRawPhaseWrite(patch) {
  const rasti = PHASE_STATE_FIELDS.filter(
    (f) => patch && Object.prototype.hasOwnProperty.call(patch, f)
  );
  if (rasti.length === 0) return;

  throw new TypeError(
    `jobStore.update(): laukai [${rasti.join(", ")}] valdomi per jobPhase. ` +
      "Naudokite startPhase() / restart() / reportProgress() / finish(), ne neapdorotą patch'ą."
  );
}

/**
 * Vartotojo lygio metodai reikalauja EKSPLICITINIO scope objekto.
 *
 * Pozicinis `id` argumentas atmetamas sąmoningai: jis tyliai praeitų su
 * `undefined` savininku, ir filtras taptų dekoracija. Migracijos metu tai
 * pagauna kiekvieną praleistą iškvietimo vietą iš karto, o ne produkcijoje.
 *
 * `ownerId: null` yra TEISĖTA reikšmė (desktop / no-auth), todėl tikrinama
 * lauko BUVIMAS, ne truthiness.
 */
/**
 * KŪRIMO KONTRAKTAS (#159).
 *
 * Dabartinis writer'is NETURI mokėti rašyti senos eros formato – tą pamoką
 * davė #158 (`schemaVersion`). `ownerKind = null` reiškia LEGACY įrašą iš
 * prieš #159; jei produkcinis kvietėjas jį praleistų, atsirastų naujas
 * job'as, kuris store sluoksnyje elgtųsi kaip legacy ir būtų NEPASIEKIAMAS
 * savo savininkui. Klaida būtų tyli: job'as sukuriamas sėkmingai, o dingsta
 * tik prieiga.
 *
 * Legacy įrašai turi atsirasti TIK per `restoreRecord()` arba neapdorotą Redis
 * fixture'ą – ne per normalų `create()`.
 *
 * Tikrinamas ir DERINYS, ne tik enum: `ownerKind` su nesuderinamu `ownerId`
 * yra semantiškai prieštaringas įrašas, nors `matchesOwner()` jį techniškai
 * palygintų.
 */
function assertCreateOwnership(fields) {
  assertOwnerIdentity(fields, "jobStore.create()");
}

function assertScope(scope, method) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw new TypeError(
      `jobStore.${method}() reikalauja scope objekto { jobId, ownerId }. ` +
        "Sisteminiam keliui be savininko naudokite jobStore.system." + method + "()."
    );
  }
  if (typeof scope.jobId !== "string" || !scope.jobId) {
    throw new TypeError(`jobStore.${method}(): trūksta jobId.`);
  }
  if (!("ownerId" in scope)) {
    throw new TypeError(
      `jobStore.${method}(): trūksta ownerId. Desktop režime perduokite null EKSPLICITIŠKAI - ` +
        "praleistas laukas neturi tyliai tapti „be savininko\"."
    );
  }
  /**
   * TAS PATS invariantas kaip `create()` (#159).
   *
   * `ownerId = null` yra teisėtas TRIMS skirtingoms būsenoms: desktop, bendras
   * `API_KEY` ir legacy įrašas – todėl vien jo nepakanka principalui
   * identifikuoti, o `ownerKind` be tinkamo `ownerId` yra prieštaringa tapatybė.
   *
   * Būsena, kurios negalima ĮRAŠYTI, neturi būti priimama ir kaip
   * iškviečiančiojo TAPATYBĖ – kitaip dvi taisyklės ilgainiui išsiskirtų.
   */
  assertOwnerIdentity(scope, `jobStore.${method}()`);
}

module.exports = {
  init,
  FORBIDDEN,
  OWNER_KIND,

  /**
   * PRIVILEGIJUOTAS NAMESPACE (#159) - be nuosavybės filtro.
   *
   * Skirtas TIK fono keliams, kurie neturi ir negali turėti owner konteksto:
   * `workers/`, `queues/`, retencijos ir valymo sweeper'iai. Jie VYKDO darbą,
   * o ne aptarnauja užklausą.
   *
   * ⚠️ NENAUDOTI `routes/` ir `services/` sluoksniuose - tai apeitų nuosavybę.
   * Draudimą prižiūri CI sargas (`tests/systemNamespaceBoundary.test.js`);
   * be jo atskiras namespace taptų patogiu privilege escalation keliu.
   */
  system: {
    get: async (id) => {
      await ensureInit();
      return store.get(id);
    },
    update: async (id, patch, options = {}) => {
      assertNoRawPhaseWrite(patch);
      await ensureInit();
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

    /**
     * Fazės pradžia. Grąžina atnaujintą job'ą arba `null`, jei jo nėra.
     *
     * ⚠️ MEMORY store atveju `get` ir `update` vyksta be `await` tarp jų, tad
     * lenktynių lango nėra. REDIS atveju to NEPAKANKA – ten patikra ir rašymas
     * turi būti viena atominė operacija (#154, 3 žingsnis).
     */
    startPhase: async (id, nextPhase, phaseOptions = {}) => {
      await ensureInit();
      if (blockedByTombstone(id, "startPhase")) return null;
      const job = await store.get(id);
      if (!job) return null;

      const { extra = {}, ...opts } = phaseOptions;
      const patch = jobPhase.startPhase(job, nextPhase, opts);
      // `extra` PIRMA – kad negalėtų perrašyti fazės invarianto.
      return store.update(id, { ...extra, ...patch });
    },

    /**
     * Darbo (per)paleidimas – grąžina job'ą į grafo pradžią (`validating`).
     *
     * Skirta BullMQ retry: worker'is paleidžia processor'ių iš naujo, o job'as
     * gali būti bet kurioje fazėje. Grįžimas atgal grafe nelegalus, tad
     * perpaleidimas modeliuojamas kaip ATSKIRA operacija.
     */
    restart: async (id, extra = {}) => {
      await ensureInit();
      if (blockedByTombstone(id, "restart")) return null;
      const job = await store.get(id);
      if (!job) return null;

      const patch = jobPhase.restart(job);
      return store.update(id, { ...extra, ...patch });
    },

    /**
     * Progreso įvykis. Grąžina atnaujintą job'ą, arba dabartinį įrašą be
     * pakeitimų, jei įvykis atmestas (pavėlavęs, ne ta fazė, regresija).
     *
     * Atmetimas NĖRA klaida: BullMQ retry ir replay tai daro reguliariai.
     */
    reportProgress: async (id, event) => {
      await ensureInit();
      if (blockedByTombstone(id, "reportProgress")) return null;
      const job = await store.get(id);
      if (!job) return null;

      const patch = jobPhase.reportProgress(job, event);
      if (!patch) return job;
      return store.update(id, patch);
    },

    /** Terminalus perėjimas – vienu patch'u išvalo fazės būseną. */
    finish: async (id, status, extra = {}) => {
      await ensureInit();
      if (blockedByTombstone(id, "finish")) return null;
      const job = await store.get(id);
      if (!job) return null;

      const patch = jobPhase.finish(job, status, extra);
      return store.update(id, patch);
    },
    listPendingDeletions: async (limit) => {
      await ensureInit();
      return typeof store.listByFlag === "function"
        ? store.listByFlag("deletion_pending", limit)
        : [];
    },
    listAll: async () => {
      await ensureInit();
      return store.listAll();
    },
    /**
     * Grąžina `null`, jei saugykla to nepalaiko - iškviečiantis kodas tada
     * NETURI nieko trinti (fail-safe), o ne laikyti, kad naudojamų failų nėra.
     * `[]` čia reikštų „nė vienas failas nenaudojamas" ir valytojas ištrintų viską.
     */
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
  },

  create: async (fields = {}) => {
    /**
     * PRIEŽIŪROS UŽRAKTAS (#20 PR4).
     *
     * Uždėtas užraktas reiškia, kad vyksta atkūrimas ar kita operacija,
     * perrašanti būseną. Naujas darbas tuo metu arba dingtų kartu su
     * perrašymu, arba liktų kaboti be konteksto – abu variantai blogesni nei
     * atviras atsisakymas.
     *
     * Patikra ČIA, o ne maršrute: `create` yra vienintelis kelias, kuriuo
     * atsiranda naujas jobas – ta pati logika kaip ištrynimo žymų patikra
     * `update` viduje (#19 PR3).
     */
    if (maintenanceLock.isLocked()) {
      const error = new Error("Vyksta priežiūros operacija – naujų darbų kurti negalima.");
      error.code = "MAINTENANCE_IN_PROGRESS";
      throw error;
    }

    assertCreateOwnership(fields);
    await ensureInit();
    return store.create(fields);
  },
  /**
   * NUOSAVYBĖS RIBOJIMAS ĮJUNGTAS PAGAL NUTYLĖJIMĄ (#159).
   *
   * @param {{jobId: string, ownerId: string|null}} scope
   * @returns {Promise<object|null|symbol>} `null` - nėra; `FORBIDDEN` - yra,
   *   bet priklauso kitam. Du ATSKIRI rezultatai, nes 152.3 pagal juos
   *   sprendžia 403 vs 404. Sulieti į `null` reikštų, kad transporto sluoksnis
   *   nebeturi iš ko pasirinkti.
   */
  get: async (scope) => {
    assertScope(scope, "get");
    await ensureInit();
    const result = await store.getOwned(scope.jobId, scope);
    return result === "FORBIDDEN" ? FORBIDDEN : result;
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
  /**
   * Terminalus perėjimas VARTOTOJO kelyje (#154).
   *
   * Maršrutams `jobStore.system` uždraustas (#159 sargas), tad jiems reikia
   * nuosavybe ribojamo varianto. Nuosavybės filtras taikomas PIRMA – svetimo
   * job'o užbaigti negalima.
   */
  finish: async (scope, status, extra = {}) => {
    assertScope(scope, "finish");
    await ensureInit();
    if (blockedByTombstone(scope.jobId, "finish")) return null;

    const job = await store.getOwned(scope.jobId, scope);
    if (!job) return null;
    if (job === "FORBIDDEN") return FORBIDDEN;

    const patch = jobPhase.finish(job, status, extra);
    return store.update(scope.jobId, patch);
  },

  update: async (scope, patch, options = {}) => {
    assertScope(scope, "update");
    // #154: sargas galioja IR vartotojo keliui – kitaip maršrutas galėtų
    // sukurti neteisingą terminalią būseną apeidamas `finish()`.
    assertNoRawPhaseWrite(patch);
    const id = scope.jobId;
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

    const result = await store.updateOwned(id, patch, scope);
    return result === "FORBIDDEN" ? FORBIDDEN : result;
  },
  /**
   * @param {{jobId: string, ownerId: string|null}} scope
   * @returns {Promise<boolean|symbol>}
   */
  remove: async (scope) => {
    assertScope(scope, "remove");
    await ensureInit();
    const result = await store.removeOwned(scope.jobId, scope);
    return result === "FORBIDDEN" ? FORBIDDEN : result;
  },
  sweepExpired: async (now) => {
    await ensureInit();
    return store.sweepExpired(now);
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
