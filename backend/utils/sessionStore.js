const crypto = require("crypto");

/**
 * SESIJŲ SAUGYKLA (#18 PR1).
 *
 * VIENAS PROCESAS, TIK ATMINTYJE - sąmoningai, ne dėl to, kad Redis integracija
 * buvo per sudėtinga.
 *
 * Šis PR patvirtino: pilotui pakanka vieno backend proceso (žr. sprendimą
 * issue #18 diskusijoje). `jobStore` turi Redis režimą, nes jobai TURI
 * išgyventi restartą (vartotojas laukia rezultato). Sesijos kitokios: jei
 * serveris persileidžia, prisijungti iš naujo yra priimtina kaina, o ne
 * duomenų praradimas.
 *
 * KAI prireiks kelių replikų (žr. docs), sesijų saugykla turės pereiti į
 * Redis - TA PATI async sąsaja čia tam paruošta, kad pakeitimas būtų
 * papildymas, ne perrašymas (žr. utils/jobStore/ kaip pavyzdį tos pačios
 * memory→Redis migracijos).
 */

const sessions = new Map();

/** Numatytieji laiko limitai (ms). Abu konfigūruojami - žr. utils/startupChecks.js. */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min neaktyvumo
const DEFAULT_ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12 val. nuo prisijungimo

function idleTimeoutMs(env = process.env) {
  const raw = Number(env.SESSION_IDLE_TIMEOUT_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw * 60 * 1000 : DEFAULT_IDLE_TIMEOUT_MS;
}

function absoluteTimeoutMs(env = process.env) {
  const raw = Number(env.SESSION_ABSOLUTE_TIMEOUT_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw * 60 * 60 * 1000 : DEFAULT_ABSOLUTE_TIMEOUT_MS;
}

/**
 * Sesijos ID: 256 bitų atsitiktinumo, URL-safe.
 *
 * Tai NE JWT ir nenešė jokios naudingosios apkrovos - jis yra tik raktas į
 * serverio pusės įrašą. Klientas negali jo perskaityti ar pakeisti; visa
 * autoritetinga informacija (vardas, rolė, galiojimas) gyvena TIK serveryje.
 * Tai yra esminis skirtumas nuo bearer tokeno, ir priežastis, kodėl revokacija
 * čia yra viena eilutė (žr. `destroy`), o ne atskira „blacklist" sistema.
 */
function generateSessionId() {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * @param {{username: string, role: string}} identity
 * @returns {{id: string, username: string, role: string, createdAt: number, lastSeenAt: number}}
 */
async function create(identity, env = process.env) {
  // Pigus "gratis" valymas - naujos sesijos kūrimas yra natūralus taškas
  // patikrinti, ar senų neprisikaupė.
  sweepExpired(env);

  const id = generateSessionId();
  const now = Date.now();

  const session = {
    id,
    username: identity.username,
    role: identity.role,
    createdAt: now,
    lastSeenAt: now,
  };

  sessions.set(id, session);
  return session;
}

/**
 * Randa ir PATVIRTINA sesiją. Pasibaigusi sesija grąžina `null` IR IŠTRINAMA -
 * ji negali „atgyti" vėlesniu kvietimu.
 *
 * `lastSeenAt` atnaujinamas ČIA (slankusis idle langas), ne atskiru metodu -
 * kitaip būtų lengva pamiršti jį iškviesti viename iš kelių maršrutų.
 */
async function touch(id, env = process.env) {
  if (!id) return null;

  const session = sessions.get(id);
  if (!session) return null;

  const now = Date.now();
  const idleExpired = now - session.lastSeenAt > idleTimeoutMs(env);
  const absoluteExpired = now - session.createdAt > absoluteTimeoutMs(env);

  if (idleExpired || absoluteExpired) {
    sessions.delete(id);
    return null;
  }

  session.lastSeenAt = now;
  return session;
}

/** Revokacija: viena sesija (atsijungimas). */
async function destroy(id) {
  return sessions.delete(id);
}

/**
 * Revokacija: VISOS vartotojo sesijos.
 *
 * Reikalinga slaptažodžio keitimui ar administratoriaus sprendimui atjungti
 * vartotoją nedelsiant - žr. #18 PR3 (revocation) diskusiją.
 */
/**
 * PERIODINIS sweep + KIEKVIENO create() metu (#18 PR1, review pastaba).
 *
 * `touch()` istrina pasibaigusia sesija TIK KAI KAS NORS JA VĖL PANAUDOJA.
 * Sesija, kurios klientas daugiau niekada nebeatsiunčia (uždarytas skirtukas,
 * pamestas cookie, tiesiog paliktas naršyklėje), liktų `sessions` žemėlapyje
 * NERIBOTĄ LAIKĄ - ilgai veikiančiame procese tai atminties nutekėjimas ir
 * pasenusių vartotojų identifikatorių kaupimasis.
 *
 * Du nepriklausomi mechanizmai, ne vienas:
 *  1. sweep KIEKVIENO create() metu - naujos sesijos retai kuriamos itin
 *     dažnai, tad tai pigus "gratis" valymas be atskiro intervalo;
 *  2. PERIODINIS intervalas - kad sesijos būtų išvalomos net jei niekas
 *     naujų nebekuria (pvz. sistema stovi be naujų prisijungimų, bet senos
 *     sesijos vis tiek turi baigtis laiku).
 */
function sweepExpired(env = process.env) {
  const now = Date.now();
  const idle = idleTimeoutMs(env);
  const absolute = absoluteTimeoutMs(env);
  let removed = 0;

  for (const [id, session] of sessions.entries()) {
    if (now - session.lastSeenAt > idle || now - session.createdAt > absolute) {
      sessions.delete(id);
      removed++;
    }
  }
  return removed;
}

const SWEEP_INTERVAL_MS = 5 * 60_000; // 5 min - pakankamai dažnai ilgam procesui, be pastebimos CPU kainos
let _sweepTimer = null;

function _startPeriodicSweep() {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(() => sweepExpired(), SWEEP_INTERVAL_MS);
  _sweepTimer.unref(); // NEBLOKUOJA proceso išjungimo - grynai higienos darbas
}
_startPeriodicSweep();

async function destroyAllForUser(username) {
  let removed = 0;
  for (const [id, session] of sessions.entries()) {
    if (session.username === username) {
      sessions.delete(id);
      removed++;
    }
  }
  return removed;
}

async function size() {
  return sessions.size;
}

/** Testams: pilnas išvalymas be serverio restarto. */
async function _clearForTests() {
  sessions.clear();
}

/** Testams: paleisti sweep rankiniu būdu be laukimo intervalo. */
function _sweepForTests(env) {
  return sweepExpired(env);
}

/** Testams: sustabdyti periodinį intervalą, kad procesas galėtų baigtis testų pabaigoje be neaiškaus handle. */
function _stopPeriodicSweepForTests() {
  if (_sweepTimer) clearInterval(_sweepTimer);
  _sweepTimer = null;
}

module.exports = {
  create,
  touch,
  destroy,
  destroyAllForUser,
  sweepExpired,
  size,
  idleTimeoutMs,
  absoluteTimeoutMs,
  _clearForTests,
  _sweepForTests,
  _stopPeriodicSweepForTests,
  backend: "memory",
};
