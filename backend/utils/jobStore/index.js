const memoryStore = require("./memoryStore");
const { STATUS, JOB_TYPES, TTL_MS, isFinished } = require("./common");
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

const {
  canUseQueue,
  resolveBackendChoice,
  applyActivationBarrier,
  selectBackend,
} = require("./backendSelection");

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

  const choice = selectBackend();

  if (choice.barjeras) {
    log.warn(
      `⚠️  DATABASE_URL nustatytas, bet job metaduomenys LIEKA "${choice.norimas}" backend'e. ` +
        "PostgreSQL kaip autoritetinga saugykla dar neaktyvuota (#155 aktyvavimo barjeras). " +
        (choice.norimas === "memory"
          ? "Job'ai NEIŠGYVENS restarto - persistencijai reikia REDIS_URL."
          : "Job'ai saugomi Redis'e, kaip iki šiol.")
    );
  }

  if (choice.norimas === "postgres") return initializePostgres();

  if (choice.norimas === "memory" || !redisUrl) {
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

/**
 * PostgreSQL inicijavimas — FAIL-CLOSED.
 *
 * ⚠️ JOKIO FALLBACK Į MEMORY. Redis kelias krinta į atmintį sąmoningai:
 * prarandami tik nauji job'ai, o Redis įrašai lieka. Su PostgreSQL tas pats
 * elgesys reikštų, kad NAUJI job'ai rašomi į atmintį, o AUTORITETINGI lieka
 * DB — split-brain, kuris „išnyksta" DB atsistačius, palikdamas dvi tikroves.
 *
 * Todėl prisijungimo klaida nutraukia startą. Tai galioja jau dabar, nors
 * barjeras PostgreSQL dar neparenka — kad barjerą atidarant nereikėtų keisti
 * šio kelio.
 *
 * ⚠️ BARJERO NEATIDARO NEI 7.2a, NEI 7.2b. 7.2b užbaigia atominių operacijų
 * kontraktą, bet aktyvavimas priklauso VISOMS ADR prielaidoms
 * (`docs/decisions/155-postgres-authority.md`, „AKTYVAVIMO BARJERAS").
 */
/**
 * `DB_CONNECT_TIMEOUT_MS` su saugia numatytąja reikšme.
 *
 * ⚠️ Parsuojama VIETOJE, ne per `utils/securityBaseline`. Tas modulis traukia
 * `cors` ir kitą Express infrastruktūrą; `jobStore` nuo jos priklausyti neturi -
 * jį įkelia ir worker procesai, kuriems HTTP sluoksnio nereikia.
 */
function connectTimeoutMs() {
  const raw = Number(process.env.DB_CONNECT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 100 ? raw : 5000;
}

/**
 * VISI `jobs` lentelės `CHECK` invariantai, be kurių saugykla negali veikti.
 *
 * ⚠️ SĄRAŠAS PILNAS, NE PAVYZDINIS. Dalinis sąrašas leistų pasenusiai ar
 * nukrypusiai schemai praeiti startą, nors ji priima būsenas, kurias runtime
 * kontraktas atmeta (nežinomas statusas, progresas ant baigto job'o).
 *
 * Pilnumą tikrina `tests/migrations.integration.test.js`: jis nuskaito VISUS
 * `contype = 'c'` constraint'us iš šviežiai migruotos DB ir lygina su šiuo
 * sąrašu. Pridėjus constraint'ą migracijoje ir pamiršus čia - testas krinta.
 */
const REQUIRED_JOB_CONSTRAINTS = [
  "jobs_actor_source_values",
  "jobs_owner_identity",
  "jobs_progress_invariants",
  "jobs_progress_known",
  "jobs_progress_only_processing",
  "jobs_schema_version_supported",
  "jobs_status_phase",
  "jobs_status_values",
  "jobs_type_values",
  /**
   * ⚠️ SĄMONINGAS SPRENDIMAS, NE AUTOMATINIS ĮRAŠAS (#184, 7.5b).
   *
   * `version integer NOT NULL DEFAULT 1` pats jokio VARDINIO constraint'o
   * nesukuria, tad pasirinkimas buvo dvejetainis: arba `jobs_version_positive`
   * migracijoje IR čia, arba nė vieno. Tylus „įrašom version į sąrašą" be
   * migracijos sulaužytų readiness (žemiau, `trukstaC`), o constraint be įrašo
   * sulaužytų `migrations.integration.test.js` pilnumo patikrą.
   *
   * Pasirinkta pirma: DB lygmens `version >= 1` pašalina falsy-nulio klasę ten,
   * kur JS `expectedVersion` patikra jos nepasiektų.
   */
  "jobs_version_positive",
];

/**
 * `job_results` INVARIANTAI, BŪTINI STARTUI (#157, PR-1).
 *
 * ⚠️ KODĖL ATSKIRAS SĄRAŠAS, O NE ĮRAŠAI VIRŠUJE. Readiness užklausa filtravo
 * `t.relname = 'jobs'`, tad `job_results` invariantai NEBUVO tikrinami išvis:
 * diegimas, pritaikęs tik pirmąją #157 migraciją arba praradęs constraint'ą dėl
 * schemos nukrypimo, startuodavo sėkmingai — o vėlesni rašytojai ir restore
 * verifikacija remiasi būtent jais (Codex #289).
 *
 * ⚠️ SĄRAŠAS PILNAS, NE PAVYZDINIS — pilnumą tikrina
 * `migrations.integration.test.js`, ta pačia forma kaip `jobs` pusėje.
 */
const REQUIRED_JOB_RESULT_CONSTRAINTS = [
  "job_results_integrity_shape",
  "job_results_storage_shape",
  "job_results_storage_type_values",
];

async function initializePostgres() {
  const { Pool } = require("pg");
  const { createPostgresStore } = require("./postgresStore");

  /**
   * ⚠️ BAIGTINIS PRISIJUNGIMO LAUKIMAS.
   *
   * `pg` numatytasis `connectionTimeoutMillis` yra 0 = BE RIBOS. Endpoint'as,
   * kuris TCP srautą tyliai numeta (o ne atmeta), paliktų startą kabantį
   * neribotai ir NIEKADA nepasiektų `catch` bloko, kuris pateikia aiškią
   * fail-closed klaidą - procesas liktų nepasiekiamas be jokio paaiškinimo.
   *
   * Simetriška Redis keliui, kuris irgi neleidžia sau laukti amžinai
   * (`maxRetriesPerRequest`, `retryStrategy`).
   */
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: connectTimeoutMs(),
  });

  /**
   * ⚠️ NEVEIKLIOS JUNGTIES KLAIDA NETURI NUŽUDYTI PROCESO (#155, 7.4b peržiūra).
   *
   * `pg-pool` klaidą neveiklioje jungtyje (PostgreSQL restartas, tinklo trūkis)
   * skelbia kaip `error` įvykį ANT POOL'O. `EventEmitter` neapdorotą `error`
   * meta, tad Node nutraukia visą procesą - ne užklausą, o serverį ar worker'į.
   * Klausytojas paverčia tai tuo, kas jis ir yra: pašalinta jungtis plius logas.
   *
   * ⚠️ LOGINAMAS TIK KODAS: `pg` pranešime gali būti vartotojo vardas
   * (`password authentication failed for user "x"`).
   */
  pool.on("error", (klaida) => {
    log.error("Job pool'o neveiklios jungties klaida - jungtis pašalinta", {
      klaida: klaida && klaida.code ? klaida.code : "nežinoma",
    });
  });

  try {
    await pool.query("SELECT 1");
  } catch (err) {
    await pool.end().catch(() => {});
    throw new Error(
      `PostgreSQL neprieinamas (${err.message}). Pasirinkus PostgreSQL job ` +
        "metaduomenims, grįžimas į atmintį sukurtų split-brain (nauji job'ai " +
        "atmintyje, autoritetingi - DB), todėl startas nutraukiamas."
    );
  }

  /**
   * ⚠️ PASIEKIAMUMO NEPAKANKA - SCHEMA PRIVALO EGZISTUOTI.
   *
   * `SELECT 1` pavyksta ir tada, kai DB veikia, bet migracijos nepaleistos.
   * Tokiu atveju `server.js` pažymėtų `readiness.jobStore = true`, serveris
   * imtų klausytis, o PIRMA job operacija kristų su
   * `relation "jobs" does not exist` - jau priėmus vartotojo failą.
   *
   * Readiness, kuris teigia „pasiruošęs" prieš tai, kas iš tikrųjų reikalinga,
   * yra blogesnis nei readiness, kurio nėra: orkestruotojas nukreipia srautą.
   */
  const BUTINOS = ["jobs", "job_results"];
  try {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = ANY($1)`,
      [BUTINOS]
    );
    const rastos = rows.map((r) => r.table_name);
    const truksta = BUTINOS.filter((t) => !rastos.includes(t));

    if (truksta.length > 0) {
      throw new Error(
        `PostgreSQL pasiekiamas, bet trūksta lentelių: ${truksta.join(", ")}. ` +
          "Paleiskite `npm run migrate:up` prieš startą."
      );
    }

    /**
     * ⚠️ LENTELIŲ BUVIMO NEPAKANKA - TIKRINAMI IR INVARIANTAI.
     *
     * DB, kurioje paleista TIK `1755000000000`, abi lenteles jau turi, tad
     * pirmoji patikra praeitų. Bet `jobs_type_values` tada dar nėra, o
     * `jobs_schema_version_supported` vis dar priima `1`. Diegimas, praleidęs
     * naujausią `migrate:up`, paskelbtų saugyklą pasiruošusia ir priiminėtų
     * būtent tuos įrašus, kuriuos vėlesnė migracija turi blokuoti.
     *
     * Tikrinami CONSTRAINT'AI, ne `pgmigrations` eilučių skaičius: migracijų
     * sąrašas auga, o šis rinkinys įvardija tai, kas realiai būtina saugyklai
     * veikti teisingai.
     */
    /**
     * ⚠️ TIKRINAMOS ABI LENTELĖS (#157, PR-1).
     *
     * Anksčiau filtras buvo `t.relname = 'jobs'`, tad `job_results` invariantai
     * nebuvo tikrinami išvis — diegimas be `job_results_storage_shape` ar be
     * vientisumo sargo skelbdavosi pasiruošęs, nors rezultatų rašymo ir restore
     * verifikacijos keliai jais remiasi.
     */
    const { rows: cRows } = await pool.query(
      `SELECT t.relname, c.conname
         FROM pg_constraint c
         JOIN pg_class t     ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE t.relname IN ('jobs', 'job_results')
          AND n.nspname = current_schema()
          AND c.contype = 'c'`
    );

    const rastiC = cRows.filter((r) => r.relname === "jobs").map((r) => r.conname);
    const rastiR = cRows.filter((r) => r.relname === "job_results").map((r) => r.conname);

    const trukstaInvariantu = [
      ...REQUIRED_JOB_CONSTRAINTS.filter((c) => !rastiC.includes(c)),
      ...REQUIRED_JOB_RESULT_CONSTRAINTS.filter((c) => !rastiR.includes(c)),
    ];

    if (trukstaInvariantu.length > 0) {
      throw new Error(
        `PostgreSQL schema pasenusi - trūksta invariantų: ${trukstaInvariantu.join(", ")}. ` +
          "Paleiskite `npm run migrate:up`: be jų DB priimtų įrašus, kurių " +
          "runtime nepripažįsta (nežinomas tipas, nepalaikoma era, nežinomas actor " +
          "source, rezultato eilutė be vientisumo metaduomenų)."
      );
    }
  } catch (err) {
    await pool.end().catch(() => {});
    throw err;
  }

  store = createPostgresStore(pool);
  log.info("Job store: PostgreSQL (autoritetinga metaduomenų saugykla)");
  return store;
}

/**
 * Ar galima naudoti BullMQ eilę? Sprendimą priima gryna `canUseQueue()`
 * (`backendSelection.js`) — čia tik surenkamos jos dvi įvestys.
 *
 * ⚠️ SĄLYGOS ČIA NEKARTOTI. Įrašyta tiesiogiai, ji taptų antra taisyklės
 * kopija, kurios testai nepasiekia: jie tikrina grynąją funkciją.
 */
function hasQueueBackend() {
  return canUseQueue(process.env, store.backend);
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

/**
 * „Įrašas pasikeitė nuo tada, kai jį matei" - optimistic lock konfliktas
 * (#184, 7.5b).
 *
 * ⚠️ KONTRAKTAS PRAPLEČIAMAS, NE PERRAŠOMAS. #180 forma lieka nepajudinta:
 * `null` = nerastas, `FORBIDDEN` = svetimas. Šis simbolis pridedamas TA PAČIA
 * forma ir toje pačioje vertimo vietoje (saugykla grąžina eilutę, fasadas -
 * simbolį), tad nė vienas metodas neįgyja savo atskiros konflikto formos.
 *
 * ⚠️ KUO SKIRIASI NUO `FORBIDDEN`. Nuosavybės neatitikimas NIEKADA neverčiamas
 * į šitą: tai autorizacijos, ne lygiagretumo rezultatas. Saugyklose nuosavybė
 * tikrinama PIRMA būtent dėl to.
 *
 * ⚠️ KUO SKIRIASI NUO `JobPhaseError`. Gyvavimo ciklo konfliktas (neleistinas
 * perėjimas) lieka `JobPhaseError` - jau esantis TIPIZUOTAS `jobPhase`
 * autoritetas, kurio #184 nekeičia. Skirtumas kvietėjui yra veiksmas:
 * `CONCURRENCY_CONFLICT` reiškia „perskaityk naują būseną ir spręsk iš naujo",
 * `JobPhaseError` - „šis perėjimas neteisėtas, aklai nekartok".
 *
 * `Symbol` - dėl tos pačios priežasties kaip `FORBIDDEN`: jo negalima gauti iš
 * JSON ar sumaišyti su job objektu.
 */
const CONCURRENCY_CONFLICT = Symbol("jobStore.CONCURRENCY_CONFLICT");

/**
 * „Jau `completed`, bet KITU rezultatu" — consistency conflict (#184, 7.5b).
 *
 * ⚠️ ATSKIRAS NUO `CONCURRENCY_CONFLICT`. Versijos konfliktas reiškia „perskaityk
 * iš naujo ir spręsk"; šitas reiškia „du vykdytojai pagamino SKIRTINGUS
 * rezultatus tam pačiam darbui" — pakartojimas to neišspręs. Esamas rezultatas
 * NEPERRAŠOMAS jokiomis aplinkybėmis.
 */
const RESULT_CONFLICT = Symbol("jobStore.RESULT_CONFLICT");

/**
 * „`jobs.status = completed`, bet rezultato saugykloje NĖRA" (#184, 7.5b).
 *
 * ⚠️ TAI NĖRA SĖKMĖ, IR TAI NĖRA KONFLIKTAS. Tai REMONTUOTINA būsena: nutrūkusi
 * transakcija, ranka redaguota eilutė, atkūrimas iš nepilnos kopijos.
 *
 * ⚠️ KODĖL JI PRIVALO BŪTI ATSKIRIAMA. Audio valymo sprendimas priimamas iš
 * `finish()` grąžinamos reikšmės. Su bendru gyvavimo ciklo konfliktu kvietėjas
 * negalėtų atskirti „tas pats rezultatas, no-op, audio galima" nuo „rezultato
 * nėra, audio LIEKA" — ir vienas iš dviejų atvejų neišvengiamai elgtųsi
 * neteisingai. Šaltinio audio yra vienintelė medžiaga, iš kurios būseną dar
 * galima suremontuoti.
 */
const COMPLETED_WITHOUT_RESULT = Symbol("jobStore.COMPLETED_WITHOUT_RESULT");

/**
 * Saugyklos eilutė → fasado forma. VIENAS vertimas visiems keliams (#184).
 *
 * ⚠️ Kopijos kiekviename metode būtų tiksliai tai, ką issue draudžia: „nė vienas
 * metodas negrąžina konfliktui savo formos".
 */
const SAUGYKLOS_BAIGTYS = Object.freeze({
  FORBIDDEN,
  CONCURRENCY_CONFLICT,
  RESULT_CONFLICT,
  COMPLETED_WITHOUT_RESULT,
});

function fasadoRezultatas(result) {
  if (typeof result === "string" && result in SAUGYKLOS_BAIGTYS) {
    return SAUGYKLOS_BAIGTYS[result];
  }
  return result;
}

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
async function blockedByTombstone(id, method) {
  /**
   * ⚠️ `await` PRIVALOMAS (#155, 7.5a / #183).
   *
   * Persistentiniame režime atsakymas ateina iš `erasure_marks`, o `Promise` yra
   * truthy: be `await` KIEKVIENAS job'as atrodytų ištrintas, visas apdorojimas
   * būtų tyliai užblokuotas, o esami testai liktų žali.
   */
  if (!(await tombstones.isDeleted(id))) return false;
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

/**
 * ATKURIAMO ĮRAŠO TAPATYBĖ.
 *
 * ⚠️ `restoreRecord()` PRIIMA KOPIJOS TURINĮ PAŽODŽIUI.
 *
 * `memoryStore.restoreRecord()` daro `jobs.set(job.id, { ...job })`, o Redis -
 * `hset` be jokios `id` patikros. Anksčiau čia buvo tik `!job.id` (truthiness),
 * tad ranka redaguota kopija galėjo įrašyti BET KOKIĄ eilutę kaip identifikatorių
 * ir ji gyventų saugykloje: ją grąžintų `get()`, `listAll()`, ji patektų į
 * atsakymus, žurnalus ir vėlesnes kopijas.
 *
 * Tai išaiškėjo iš CodeQL „Regular expression injection" pėdsako: taint kelias
 * ėjo per BENDRĄ `memoryStore` `Map` - t. y. iš atkurtos kopijos į bet kurį
 * `job.id` skaitytoją. Produkcijoje šiandien nė vienas kelias iš `job.id`
 * nekuria reguliariojo reiškinio, tad tai gynyba į gylį, ne aktyvi spraga.
 *
 * ⚠️ UUID, NE „NETUŠČIA". `newJob()` visada generuoja `crypto.randomUUID()`, o
 * PostgreSQL stulpelis yra `uuid` - tad tai nesusiaurina nė vienos TEISĖTOS
 * formos, tik uždaro memory/Redis kelią, kuriame tikrinimo nebuvo.
 */
const RESTORE_ID_FORMA =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertRestorableId(job) {
  if (!job || typeof job !== "object" || typeof job.id !== "string" ||
      !RESTORE_ID_FORMA.test(job.id)) {
    const error = new Error(
      "Atkuriamas jobas be galiojančio identifikatoriaus (laukiamas UUID)."
    );
    error.code = "RESTORE_RECORD_INVALID";
    throw error;
  }
}

/**
 * Sisteminis terminalus perėjimas – VIENAS bandymas, be politikos (#184, 7.5b).
 *
 * Iškeltas iš `system.finish()`, kad `system.finishFailed()` galėtų jį pakartoti
 * NEDUBLIUODAMAS nei tombstone barjero, nei snapshot'o sąlygos.
 */
async function sisteminisFinishBandymas(store, id, status, extra) {
  /**
   * ⚠️ ATSARGINIO KELIO NĖRA SĄMONINGAI (#184, 7.5b).
   *
   * `finishAtomic` deklaruoja visi trys backend'ai (kontrakto rinkinys tikrina
   * metodų aibės tapatumą), tad `typeof === "function"` patikra čia reikštų tylų
   * grįžimą į NEATOMINĮ kelią, jei kuris nors backend'as metodą prarastų. Toks
   * grįžimas būtų nematomas: elgesys atrodytų teisingas, kol neįvyktų lenktynės.
   */
  return fasadoRezultatas(await store.finishAtomic(id, status, extra));
}

module.exports = {
  init,
  /**
   * Prieiga prie backend'o TESTAMS.
   *
   * Reikalinga #154 TOCTOU testui: langą tarp `get()` ir rašymo galima atidaryti
   * tik perimant patį backend'ą. Bandymas „paleisti lygiagrečiai ir tikėtis
   * lenktynių" nėra deterministinis – testas praeitų ir be atomiškumo.
   */
  _storeForTests: () => store,
  FORBIDDEN,
  CONCURRENCY_CONFLICT,
  RESULT_CONFLICT,
  COMPLETED_WITHOUT_RESULT,
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
    /**
     * @param {{hydrate?: boolean}} [nustatymai] `hydrate: false` - tik metaduomenys (#157, PR-3)
     */
    get: async (id, nustatymai = {}) => {
      await ensureInit();
      return store.get(id, nustatymai);
    },
    update: async (id, patch, options = {}) => {
      assertNoRawPhaseWrite(patch);
      await ensureInit();
      if (options.allowAfterDeletion !== LIFECYCLE_INTERNAL && (await tombstones.isDeleted(id))) {
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
     * Fazės pradžia. Grąžina atnaujintą job'ą, `null` (nėra) arba
     * `CONCURRENCY_CONFLICT` (įrašas pasikeitė nuo skaitymo).
     *
     * ⚠️ TOCTOU LANGAS UŽDARYTAS (#184, 7.5b).
     *
     * Iki 7.5b čia buvo `get` + `update` be jokios sąlygos, ir šis komentaras
     * tą spragą PRIPAŽINO: „memory atveju lenktynių lango nėra; Redis atveju to
     * NEPAKANKA". Pripažinimas nebuvo sprendimas - langas liko atviras VISIEMS
     * backend'ams, nes jis yra FASADO lygmens: tarp `store.get()` ir
     * `store.update()` yra `await`, ir jokia saugyklos SQL/Lua patobulinta
     * vidinė atomika jo neuždaro.
     *
     * Dabar sąlyga perduodama iš TO PATIES snapshot'o, kuriuo `jobPhase`
     * skaičiavo patch'ą: jei įrašas tarp skaitymo ir rašymo pasikeitė,
     * mutacija neįvyksta, o kvietėjas gauna konfliktą vietoj tylaus perrašymo.
     */
    startPhase: async (id, nextPhase, phaseOptions = {}) => {
      await ensureInit();
      if (await blockedByTombstone(id, "startPhase")) return null;
      const job = await store.get(id);
      if (!job) return null;

      const { extra = {}, ...opts } = phaseOptions;
      const patch = jobPhase.startPhase(job, nextPhase, opts);
      // `extra` PIRMA – kad negalėtų perrašyti fazės invarianto.
      return fasadoRezultatas(
        await store.update(id, { ...extra, ...patch }, { expectedVersion: job.version })
      );
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
      if (await blockedByTombstone(id, "restart")) return null;
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
      if (await blockedByTombstone(id, "reportProgress")) return null;

      const job = await store.get(id);
      if (!job) return null;

      /**
       * GRYNAS SPRENDIMAS PIRMA – jis atmeta akivaizdžiai netinkamus įvykius
       * (ne `processing`, netinkama progreso forma) ir sutaupo Redis kvietimą.
       *
       * ⚠️ BET JO NEPAKANKA. Tarp `get()` ir rašymo fazė gali pasikeisti, ir
       * pasenęs įvykis laimėtų lenktynes. Todėl, kai backend'as siūlo atominį
       * kelią, PATIKRA KARTOJAMA Lua viduje – ten ji ir yra autoritetinga.
       */
      const patch = jobPhase.reportProgress(job, event);
      if (!patch) return job;

      if (typeof store.reportProgressAtomic === "function") {
        const outcome = await store.reportProgressAtomic(id, event);
        if (outcome === "REJECTED") return store.get(id);
        return outcome;
      }

      /**
       * ⚠️ ATSARGINIS KELIAS – naudojamas tik jei backend'as atominio metodo
       * NETURI.
       *
       * Anksčiau čia buvo komentaras, teigiantis, kad memory backend'ui CAS
       * nereikalingas, nes „`get` ir `update` vyksta be `await` tarp jų". Tai
       * buvo neteisinga: `await store.get(id)` aukščiau ATVERIA langą, ir
       * lygiagretūs progreso callback'ai abu nuskaito tą patį snapshot'ą
       * (50 → vienu metu 60 ir 55 → išsaugoma 55).
       *
       * Abu backend'ai dabar turi `reportProgressAtomic()`, tad ši šaka
       * praktiškai nepasiekiama – ji lieka kaip apsauga naujam backend'ui.
       */
      return store.update(id, patch);
    },

    /**
     * Terminalus perėjimas – vienu patch'u išvalo fazės būseną.
     *
     * ⚠️ SĄLYGA IŠ TO PATIES SNAPSHOT'O (#184, 7.5b) – žr. `startPhase()`.
     * Grąžina job'ą, `null` arba `CONCURRENCY_CONFLICT`; neleistinas perėjimas
     * lieka `JobPhaseError`.
     */
    finish: async (id, status, extra = {}) => {
      await ensureInit();
      if (await blockedByTombstone(id, "finish")) return null;
      return sisteminisFinishBandymas(store, id, status, extra);
    },

    /**
     * `FAILED` žymėjimas SU KONFLIKTŲ POLITIKA (#184, 7.5b).
     *
     * ⚠️ KODĖL ATSKIRAS METODAS, O NE POLITIKA KIEKVIENAME KVIETĖJE.
     *
     * `finish(FAILED, …)` kvietėjų yra AŠTUONI (`queues/jobRunner.js` ×4,
     * `workers/index.js` ×4), ir visi jie yra klaidų apdorojimo šakos. Politika,
     * nukopijuota aštuonis kartus, išsiskirtų būtent ten, kur niekas nežiūri –
     * o šitos politikos kaina klaidingai pritaikius yra `completed` įrašo
     * pavertimas `failed`.
     *
     * KONTRAKTAS:
     *
     *   `JOB_ALREADY_TERMINAL` → job jau terminalus. NO-OP SĖKMĖ: `FAILED`
     *                      žymėjimas nebeaktualus, kas nors kitas jį jau pabaigė.
     *
     * ⚠️ VISI KITI `JobPhaseError` KODAI PERMETAMI, NE SLOPINAMI (Codex D5).
     *
     * `jobPhase` ta pačia klase meta ir `UNKNOWN_SOURCE_STATUS` (nežinomas ar
     * ateities persistentinis statusas). Jį nuslopinus, „jau terminalus"
     * verdiktas būtų MELAGINGAS, o kvietėjas eitų į audio valymą neįsipareigojęs
     * `FAILED`.
     *
     * ⚠️ IŠ TO SEKA PAREIGA KVIETĖJUI: šis metodas GALI atmesti. Kvietėjas,
     * kviečiantis jį iš `async` įvykio klausytojo, privalo turėti savo
     * `.catch()` — `EventEmitter` grąžinto Promise nelaukia, ir atmetimas taptų
     * neapdorotu (žr. `workers/index.js` `worker.on("failed", …)`). Būtent to
     * neapibrėžta ankstesnė šio kontrakto redakcija ir kainavo.
     *   konfliktas       → perskaitoma AUTORITETINGA būsena, ir:
     *                      · terminalus `COMPLETED` → žymėjimas ATMETAMAS;
     *                      · kitas terminalus       → no-op sėkmė;
     *                      · ne terminalus          → VIENAS pakartojimas;
     *                      · antras konfliktas      → `log.error`, pasitraukimas.
     *
     * ⚠️ AKLO RETRY NĖRA NĖ VIENOJE ŠAKOJE. Ciklo irgi nėra: du bandymai, po to
     * pasitraukimas. Neribotas kartojimas čia reikštų, kad nuolat atnaujinamas
     * job'as niekada negautų `failed` žymos ir kviečiantis worker'is kabėtų.
     *
     * ⚠️ `COMPLETED` NIEKADA NEVIRSTA `FAILED`. Dingęs BullMQ ack neturi teisės
     * sunaikinti sėkmingo rezultato, kuris jau guli saugykloje. Tai buvo
     * įmanoma iki 7.5b: pralaimėjęs lenktynes `finish(FAILED)` tiesiog
     * perrašydavo įrašą.
     *
     * @returns {Promise<object|null|symbol>} job'as, `null` (nėra / atmesta
     *   pagal tombstone) arba `CONCURRENCY_CONFLICT`, kai abu bandymai krito.
     */
    finishFailed: async (id, extra = {}) => {
      await ensureInit();
      if (await blockedByTombstone(id, "finish")) return null;

      for (let bandymas = 1; bandymas <= 2; bandymas++) {
        let rezultatas;
        try {
          rezultatas = await sisteminisFinishBandymas(store, id, STATUS.FAILED, extra);
        } catch (err) {
          /**
           * ⚠️ SLOPINAMAS TIK `JOB_ALREADY_TERMINAL`, NE BET KOKS `JobPhaseError`
           * (Codex peržiūros A grupė).
           *
           * Ankstesnė redakcija tikrino `err.name !== "JobPhaseError"`. Bet
           * `jobPhase` ta pačia klase meta ir `UNKNOWN_SOURCE_STATUS`
           * (`utils/jobPhase.js`), kai persistentinis įrašas turi nežinomą ar
           * ateities statusą. Tada „jau terminalus" verdiktas būdavo MELAGINGAS:
           * grąžindavom nepakeistą įrašą kaip no-op sėkmę, o worker'io nesėkmės
           * tvarkytojas eidavo toliau į audio valymą — nors `FAILED` niekada
           * nebuvo įsipareigotas.
           *
           * Kodas tikrinamas eksplicitiškai; visos kitos priežastys (nežinomas
           * statusas, DB, infrastruktūra) keliauja pro šalį, nes jų slėpimas
           * paverstų gedimą tylia sėkme.
           */
          if (err.name !== "JobPhaseError" || err.code !== "JOB_ALREADY_TERMINAL") throw err;
          const dabartinis = await store.get(id);
          log.info("finishFailed: job jau terminalus, FAILED žymėjimas nebeaktualus", {
            jobId: id,
            status: dabartinis?.status,
          });
          return dabartinis;
        }

        if (rezultatas !== CONCURRENCY_CONFLICT) return rezultatas;

        /** Konfliktas – sprendimas priimamas iš AUTORITETINGOS būsenos, ne iš snapshot'o. */
        const dabartinis = await store.get(id);
        if (!dabartinis) return null;

        if (dabartinis.status === STATUS.COMPLETED) {
          log.warn("finishFailed: job jau COMPLETED – FAILED žymėjimas ATMESTAS", {
            jobId: id,
            reason: extra.error_code || extra.error || null,
          });
          return dabartinis;
        }
        if (isFinished(dabartinis.status)) return dabartinis;

        if (bandymas === 2) {
          log.error("finishFailed: du versijos konfliktai iš eilės, pasitraukiama", {
            jobId: id,
            status: dabartinis.status,
          });
          return CONCURRENCY_CONFLICT;
        }
      }
      /* c8 ignore next */
      return CONCURRENCY_CONFLICT;
    },
    listPendingDeletions: async (limit) => {
      await ensureInit();
      return typeof store.listByFlag === "function"
        ? store.listByFlag("deletion_pending", limit)
        : [];
    },
    /**
     * ⚠️ HIDRATACIJA YRA EKSPLICITINIS ARGUMENTAS, NE NUMANOMA (#157, PR-3).
     *
     * Numatytoji reikšmė - hidratuoti, kad viešas kontraktas nepasikeistų. Metaduomenų
     * keliai (pvz. `countActiveJobs()`) perduoda `hydrate: false` ir nustoja tempti
     * `payload`, kurio niekada nežiūrėjo.
     *
     * @param {{hydrate?: boolean}} [nustatymai]
     */
    listAll: async (nustatymai = {}) => {
      await ensureInit();
      return store.listAll(nustatymai);
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
    return fasadoRezultatas(result);
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
    if (await blockedByTombstone(scope.jobId, "finish")) return null;

    const job = await store.getOwned(scope.jobId, scope);
    if (!job) return null;
    if (job === "FORBIDDEN") return FORBIDDEN;

    const patch = jobPhase.finish(job, status, extra);
    /**
     * ⚠️ `updateOwned`, NE `update` (#184, 7.5b).
     *
     * Iki 7.5b čia buvo `store.update()` – nuosavybė patikrinta `getOwned()`
     * metu, o tarp jos ir rašymo liko `await`. Sąlyginis kelias tą uždaro DVIEM
     * invariantais viename `UPDATE`: nuosavybė IR versija. Vien versijos
     * neužtektų – ji pasikeistų ir tada, kai savininkas nepasikeitė, o
     * nuosavybės perdavimo atveju atsakymas privalo likti `FORBIDDEN`.
     */
    return fasadoRezultatas(
      await store.updateOwned(scope.jobId, patch, scope, { expectedVersion: job.version })
    );
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
    if (options.allowAfterDeletion !== LIFECYCLE_INTERNAL && (await tombstones.isDeleted(id))) {
      log.warn("Atmestas jobo atnaujinimas po ištrynimo", { jobId: id });
      return null;
    }

    const result = await store.updateOwned(id, patch, scope);
    return fasadoRezultatas(result);
  },
  /**
   * @param {{jobId: string, ownerId: string|null}} scope
   * @returns {Promise<boolean|symbol>}
   */
  remove: async (scope) => {
    assertScope(scope, "remove");
    await ensureInit();
    const result = await store.removeOwned(scope.jobId, scope);
    return fasadoRezultatas(result);
  },
  listExpired: async (now, limit) => {
    await ensureInit();
    return typeof store.listExpired === "function" ? store.listExpired(now, limit) : [];
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
  /**
   * ATKŪRIMO PREFLIGHT: ar įrašas ATSTOVAUJAMAS aktyviame backend'e (#180 P2-E).
   *
   * ⚠️ KODĖL FASADE, NE STORE OBJEKTE. `jobStore` backend'ai turi tiksliai
   * sutampančią metodų aibę (kontrakto testas ją tikrina), tad metodo pridėjimas
   * tik PostgreSQL'ui tą paritetą sulaužytų. Taisyklė yra backend'o savybė, bet
   * kvietimo taškas - fasadas.
   *
   * ⚠️ VIENAS AUTORITETINGAS VALIDATORIUS. Naudojama TA PATI funkcija, kurią
   * `postgresStore.restoreRecord()` kviečia kaip gynybą giliai viduje
   * (`assertAtstovaujamasProgresas`). Antra taisyklių kopija neišvengiamai
   * išsiskirtų.
   *
   * Backend'ams, kurie įrašą atstovauja (memory, Redis), tai tuščias veiksmas.
   */
  assertRestorable: async (job) => {
    await ensureInit();
    assertRestorableId(job);
    if (!store || store.backend !== "postgres") return;
    const { assertAtstovaujamasProgresas } = require("./postgresStore");
    assertAtstovaujamasProgresas(job);
  },

  restoreRecord: async (job) => {
    await ensureInit();

    assertRestorableId(job);

    if (await tombstones.isDeleted(job.id)) {
      log.warn("Atkūrimas praleido ištrintą jobą", { jobId: job.id });
      return null;
    }

    /**
     * ⚠️ PATIKRA VIRŠUJE YRA PIGUS ANKSTYVAS IŠĖJIMAS, NE GARANTIJA (#183 Codex, P1).
     *
     * Ji ir `store.restoreRecord()` yra du atskiri veiksmai: lygiagreti replika
     * gali įterpti žymą tarp jų. Persistentiniame kelyje langą uždaro pats
     * store'as - `postgresStore.restoreRecord()` kviečia `assertNotBarred()`
     * SAVO transakcijoje su advisory lock'u.
     *
     * Kitiems backend'ams tokios transakcijos nėra, tad langas uždaromas
     * KOMPENSUOJANČIA po-rašymo patikra: jei žyma atsirado tuo metu, atkurtas
     * įrašas pašalinamas. Rezultatas toks pat kaip niekada neatkūrus, tik
     * pasiekiamas dviem žingsniais.
     */
    const atkurta = await store.restoreRecord(job);

    if (atkurta && (await tombstones.isDeleted(job.id))) {
      log.warn("Atkūrimas ATŠAUKTAS: žyma atsirado rašymo metu", { jobId: job.id });

      /**
       * ⚠️ NEPAVYKĘS VALYMAS PROPAGUOJAMAS, NE NUTYLIMAS (#183 Codex).
       *
       * Anksčiau `remove()` klaida buvo suloginama, o funkcija vis tiek
       * grąžindavo `null` - t. y. praneštų, kad atkūrimas SAUGIAI praleistas,
       * nors užbarjeruotas job'as LIEKA saugykloje. Praradus atminties žymą
       * (restartas atminties režime) jis atgytų, o atkūrimo kvietėjas apie tai
       * nebūtų sužinojęs: būsena blogesnė nei prieš, o pranešimas - sėkmingas.
       *
       * Dabar klaida keliauja kvietėjui: atkūrimas krinta matomai ir gali būti
       * ištaisytas. `null` reiškia „neatkurta IR nieko nepalikta"; nieko kito
       * jis reikšti negali.
       */
      try {
        await store.remove(job.id);
      } catch (klaida) {
        log.error("Atšaukto atkūrimo nepavyko išvalyti", { jobId: job.id, klaida: klaida.message });
        klaida.message =
          `Atkūrimas atšauktas dėl ištrynimo žymos, bet įrašo pašalinti nepavyko ` +
          `(job ${job.id}): ${klaida.message}. Užbarjeruotas įrašas LIKO saugykloje.`;
        throw klaida;
      }

      return null;
    }

    return atkurta;
  },

  size: async () => {
    await ensureInit();
    return store.size();
  },
  close: async () => {
    if (store && typeof store.close === "function") await store.close();
  },
  getBackend: () => store.backend || "memory",
  /**
   * Eilės (BullMQ) prieinamumas — ATSKIRAS klausimas nuo metaduomenų
   * backend'o. Žr. `hasQueueBackend()` komentarą.
   */
  hasQueueBackend,
  /**
   * Backend'o parinkimo politika be šalutinių efektų — kad testai galėtų
   * tikrinti KIEKVIENĄ env derinį neinicijuodami tikros saugyklos.
   */
  resolveBackendChoice,
  applyActivationBarrier,
  /**
   * ⚠️ EKSPORTUOJAMA TESTAMS, nes produkcijoje ši funkcija dar NEPASIEKIAMA.
   *
   * Vienintelį jos kvietimo tašką (`initializeStore()`) uždaro aktyvavimo
   * barjeras, tad be eksporto fail-closed elgesys neturėtų JOKIO įrodymo -
   * nei runtime, nei testo. Neišbandytas gedimo kelias, kuris įsijungs
   * barjerą atidarius, yra blogesnis nei neparašytas: jis atrodo padengtas.
   *
   * Unit lygmuo įrodo, KAD prisijungimo klaida atmetama ir NĖRA fallback į
   * memory. Produkcinio kelio (`DATABASE_URL` → startas nutrūksta) galutinis
   * acceptance priklauso aktyvavimo etapui, ne šiam PR.
   */
  _initializePostgresForTests: initializePostgres,
  REQUIRED_JOB_CONSTRAINTS,
  REQUIRED_JOB_RESULT_CONSTRAINTS,
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
