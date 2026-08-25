const memoryStore = require("./memoryStore");
const { resolveSessionBackend } = require("./backendSelection");
const { idleTimeoutMs, absoluteTimeoutMs } = require("./common");
const { createLogger } = require("../logger");

const log = createLogger("sessionStore");

/**
 * SESIJŲ SAUGYKLOS FASADAS (#155, 7.3).
 *
 * Vienas kvietimo paviršius (`middleware/sessionAuth.js`,
 * `middleware/authenticate.js`, `routes/auth.js`, `routes/audit.js`), po juo -
 * eksplicitiškai parinktas backend'as.
 *
 * ⚠️ NUMATYTASIS BACKEND'AS YRA ATMINTIS, IR JIS VEIKIA BE `init()`.
 *
 * Dešimtys esamų testų kuria sesijas neinicijavę saugyklos. Reikalavimas
 * kviesti `init()` juos sulaužytų be jokios saugumo naudos: atminties režimu
 * inicijuoti nėra ko.
 */

let store = memoryStore;

/**
 * PARUOŠTUMO VĖLIAVA - PRIEIGOS SĄLYGA, NE DIAGNOSTIKA.
 *
 * ⚠️ PostgreSQL režimu autentikacija NEGALI vykti, kol neįvykdytas startinis
 * suderinimas su `AUTH_USERS`. Priešingu atveju persistentinė sesija su
 * ATŠAUKTA role autorizuotų užklausas tame lange, kol suderinimas dar sukasi -
 * lygiai tai, ką suderinimas ir turi neleisti.
 *
 * ⚠️ NE `readiness` objekte `server.js`. `authRoute` prijungtas BE
 * `requireJobSystemReady`, tad middleware sprendimas paliktų `/api/auth/login`
 * landą į pusiau inicijuotą saugyklą. Vėliava gyvena ČIA, kad kiekvienas
 * sesiją liečiantis kelias matytų tą patį atsakymą.
 */
let paruosta = false;
let initPromise = null;

/**
 * @returns {boolean} ar sesijų autoritetas paruoštas aptarnauti užklausas.
 */
function isReady(env = process.env) {
  let backend;
  try {
    backend = resolveSessionBackend(env);
  } catch {
    /** Netinkamas jungiklis - fail-closed. `startupChecks` tai pagauna anksčiau. */
    return false;
  }
  if (backend === "memory") return true;

  /**
   * ⚠️ VĖLIAVOS VIENOS NEPAKANKA - TIKRINAMA IR FAKTINĖ SAUGYKLA.
   *
   * `paruosta` lieka `true` po ankstesnio (atminties) inicijavimo. Jei
   * konfigūracija po to nurodo `postgres`, o `init()` dar neįvyko, vien
   * vėliavos patikra paskelbtų autoritetą pasiruošusiu, o užklausas
   * aptarnautų ATMINTIES saugykla - t. y. persistentinis režimas tyliai
   * veiktų kaip vienprocesis, be globalios revokacijos.
   */
  return paruosta === true && store.backend === "postgres";
}

/**
 * PostgreSQL sesijų inicijavimas - FAIL-CLOSED.
 *
 * ⚠️ JOKIO FALLBACK Į ATMINTĮ. Pasirinkus persistentines sesijas, grįžimas į
 * atmintį reikštų, kad globali revokacija tyliai nustojo veikti: atsijungimas
 * viename procese kitam nebūtų matomas, o operatorius apie tai nesužinotų.
 *
 * ⚠️ POOL UŽDAROMAS KIEKVIENAME KLAIDOS KELYJE. Be to nepavykusi inicijacija
 * paliktų atviras jungtis, ir integraciniai testai KABOTŲ vietoj kritimo -
 * tas pats modelis kaip `jobStore/index.js`.
 */
const REQUIRED_SESSION_CONSTRAINTS = [
  "sessions_expires_after_created",
  "sessions_idle_after_created",
  "sessions_last_seen_after_created",
  "sessions_revoked_after_created",
];

/**
 * `DB_CONNECT_TIMEOUT_MS` su saugia numatytąja reikšme.
 *
 * `pg` numatytasis `connectionTimeoutMillis` yra 0 = BE RIBOS: endpoint'as,
 * kuris TCP srautą tyliai numeta, paliktų startą kabantį neribotai ir
 * NIEKADA nepasiektų fail-closed klaidos.
 */
function connectTimeoutMs() {
  const raw = Number(process.env.DB_CONNECT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 100 ? raw : 5000;
}

async function initializePostgres(env) {
  const { Pool } = require("pg");
  const { createPostgresStore } = require("./postgresStore");

  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    connectionTimeoutMillis: connectTimeoutMs(),
  });

  try {
    await pool.query("SELECT 1");

    /**
     * ⚠️ LENTELĖS BUVIMO NEPAKANKA - TIKRINAMI IR INVARIANTAI.
     *
     * DB su dalimi migracijų lentelę turi, o invariantų - ne. `jobStore`
     * PostgreSQL init'as tą pačią spragą jau uždarė (#155, 7.2a): readiness,
     * paskelbtas prieš tai, kas realiai reikalinga, yra blogesnis nei
     * readiness, kurio nėra - orkestruotojas nukreipia srautą.
     *
     * Sąrašo PILNUMĄ tikrina `tests/migrations.integration.test.js`, IŠVEDANTIS
     * jį iš šviežiai migruotos DB (`contype = 'c'` ant `sessions`), o ne
     * surašantis ranka.
     */
    const { rows: lenteles } = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'sessions'`
    );
    if (lenteles.length === 0) {
      throw new Error(
        "PostgreSQL pasiekiamas, bet trūksta `sessions` lentelės. " +
          "Paleiskite `npm run migrate:up` prieš startą."
      );
    }

    const { rows: cRows } = await pool.query(
      `SELECT c.conname
         FROM pg_constraint c
         JOIN pg_class t     ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE t.relname = 'sessions'
          AND n.nspname = current_schema()
          AND c.contype = 'c'`
    );
    const rasti = cRows.map((r) => r.conname);
    const truksta = REQUIRED_SESSION_CONSTRAINTS.filter((c) => !rasti.includes(c));

    if (truksta.length > 0) {
      throw new Error(
        `PostgreSQL sesijų schema pasenusi - trūksta invariantų: ${truksta.join(", ")}. ` +
          "Paleiskite `npm run migrate:up`: be jų DB priimtų sesijas, kurių " +
          "galiojimo langai neturi prasmės (pabaiga prieš pradžią, revokacija prieš sukūrimą)."
      );
    }
  } catch (err) {
    await pool.end().catch(() => {});
    throw err;
  }

  return { store: createPostgresStore(pool), pool };
}

let _pool = null;

/**
 * ⚠️ `init()` GRĄŽINA BENDRĄ PROMISE.
 *
 * Tas pats modelis kaip `jobStore.init()`: lygiagretūs kvietėjai laukia TO
 * PATIES vykstančio inicijavimo, ne boolean vėliavos, kuri jau `true`, kol
 * jungtis dar keliama.
 */
async function init(env = process.env) {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const backend = resolveSessionBackend(env);

    if (backend === "memory") {
      store = memoryStore;
      paruosta = true;
      log.info("Sesijų saugykla: atmintis (vienas procesas, be globalios revokacijos)");
      return store;
    }

    const { store: pgStore, pool } = await initializePostgres(env);
    store = pgStore;
    _pool = pool;
    log.info("Sesijų saugykla: PostgreSQL (persistentinė, globali revokacija)");
    return store;
  })().catch((error) => {
    initPromise = null; // leidžiam pakartoti init po nesėkmės
    paruosta = false;
    throw error;
  });
  return initPromise;
}

/**
 * STARTINIS SUDERINIMAS - READINESS BARJERAS.
 *
 * ⚠️ TIK ČIA `paruosta` TAMPA `true`. „Paleidžiant patikrinti" fone leistų
 * HTTP serveriui pakilti, o suderinimą atlikti vėliau - tame lange sena
 * persistentinė sesija su ATŠAUKTA role dar autorizuotų užklausas.
 */
async function reconcile(env = process.env) {
  if (!store.reconcile) {
    paruosta = true;
    return { patikrinta: 0, revokuota: 0, backend: store.backend };
  }
  const rezultatas = await store.reconcile(env);
  paruosta = true;
  if (rezultatas.revokuota > 0) {
    log.warn(
      `Startinis suderinimas: revokuota ${rezultatas.revokuota} sesij. iš ` +
        `${rezultatas.patikrinta} - vartotojas pašalintas iš AUTH_USERS arba rolė pasikeitė.`
    );
  }
  return { ...rezultatas, backend: store.backend };
}

/**
 * GYVA SESIJŲ AUTORITETO BŪSENA - `/api/ready` įvestis.
 *
 * ⚠️ TAI NE `isReady()`. `isReady()` atsako „ar startas baigtas ir jungiklis
 * teisingas" - tai VIENKARTINĖ vėliava. Ši funkcija atsako „ar priklausomybė
 * veikia DABAR", ir būtent to reikalauja #181 („readiness rodo, kad
 * autentikacijos priklausomybė neveikia"). Be jos DB, nukritusi PO starto,
 * paliktų `/api/ready` atsakinėjantį 200, nors kiekviena autentifikuota
 * užklausa jau gauna 503.
 *
 * ⚠️ FAIL-CLOSED IR BE IŠIMČIŲ. Grąžinama `false` bet kokiu neapibrėžtumo
 * atveju: startas nebaigtas, jungiklis netinkamas, užklausa krito. Funkcija
 * NIEKADA nemeta - readiness endpoint'as privalo atsakyti visada, net kai
 * atsakymas yra „neparuošta".
 *
 * ⚠️ KLAIDOS TEKSTAS NELOGINAMAS. `pg` pranešime gali būti vartotojo vardas
 * (`password authentication failed for user "x"`), o readiness kviečiamas
 * kiekvieno probe - tai būtų nuolatinis kredencialų srautas į logus.
 */
async function probe(env = process.env) {
  if (!isReady(env)) return false;
  try {
    /**
     * ⚠️ GRĄŽINTA REIKŠMĖ TIKRINAMA, ne vien išimties nebuvimas.
     *
     * `await store.probe(); return true;` paskelbtų saugyklą pasiekiama ir
     * tada, kai zondas eksplicitiškai atsakė `false` - fail-open, kurio
     * `try/catch` nepagauna. `=== true` reiškia, kad „pasiekiama" gali ateiti
     * TIK iš teigiamo atsakymo, ne iš klaidos nebuvimo.
     */
    return (await store.probe()) === true;
  } catch {
    return false;
  }
}

/** Švarus išjungimo kelias - be jo integraciniai testai kabotų su atviromis jungtimis. */
async function shutdown() {
  if (_pool) {
    const pool = _pool;
    _pool = null;
    await pool.end().catch(() => {});
  }
  store = memoryStore;
  paruosta = false;
  initPromise = null;
}

/**
 * PERIODINIS sweep.
 *
 * `touch()` pasibaigusios sesijos nešalina - ji tik atsisako ją autentifikuoti.
 * Sesija, kurios klientas daugiau niekada nebeatsiunčia, be šio intervalo
 * liktų saugykloje iki `expires_at` net ir tada, kai niekas nekuria naujų.
 */
const SWEEP_INTERVAL_MS = 5 * 60_000;
let _sweepTimer = null;

function _startPeriodicSweep() {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(() => {
    Promise.resolve(store.sweepExpired()).catch((e) =>
      log.warn(`Sesijų valymas nepavyko: ${e.message}`)
    );
  }, SWEEP_INTERVAL_MS);
  _sweepTimer.unref(); // NEBLOKUOJA proceso išjungimo - grynai higienos darbas
}
_startPeriodicSweep();

function _stopPeriodicSweepForTests() {
  if (_sweepTimer) clearInterval(_sweepTimer);
  _sweepTimer = null;
}

/**
 * ⚠️ DELEGAVIMAS PER FUNKCIJAS, NE PER NUORODŲ KOPIJAVIMĄ.
 *
 * `module.exports = { touch: store.touch }` užfiksuotų ATMINTIES realizaciją
 * modulio įkėlimo metu, ir `init()` po to nieko nebepakeistų: PostgreSQL
 * režimas tyliai liktų atmintimi. Tai ta pati klaidos šeima, kurią AGENTS.md
 * §9.1 aprašo kaip „spy on a destructured export".
 */
module.exports = {
  init,
  reconcile,
  shutdown,
  isReady,
  probe,
  REQUIRED_SESSION_CONSTRAINTS,

  get backend() {
    return store.backend;
  },

  create: (identity, env) => store.create(identity, env),
  touch: (token, env) => store.touch(token, env),
  destroy: (token) => store.destroy(token),
  destroyAllForUser: (username, env) => store.destroyAllForUser(username, env),
  destroyAllForUserId: (userId) => store.destroyAllForUserId(userId),
  sweepExpired: (env) => store.sweepExpired(env),
  size: () => store.size(),

  idleTimeoutMs,
  absoluteTimeoutMs,

  /**
   * TESTAMS: pakeisti FAKTINĮ backend'ą.
   *
   * ⚠️ INTERCEPCIJA VYKSTA TEN, KUR YRA TIKRINAMA RIBA (AGENTS.md §9.1).
   *
   * Gedimo scenarijai (`touch()` meta, DB nepasiekiama) turi būti matomi
   * VISIEMS kvietėjams - `middleware/sessionAuth.js`, `authenticate.js`,
   * `routes/auth.js`, `routes/audit.js`. Pakeitus `module.exports.touch`,
   * fasado vidiniai kvietimai liktų nepaliesti; pakeitus `store`, keičiasi
   * būtent tai, ką visi jie realiai kviečia.
   */
  _setStoreForTests: (naujas) => {
    const buves = store;
    store = naujas;
    return () => {
      store = buves;
    };
  },
  _setReadyForTests: (value) => {
    paruosta = value;
  },

  _clearForTests: () => memoryStore._clearForTests(),
  _sweepForTests: (env) => memoryStore._sweepForTests(env),
  _getByTokenForTests: (token) => memoryStore._getByTokenForTests(token),
  _stopPeriodicSweepForTests,
};
