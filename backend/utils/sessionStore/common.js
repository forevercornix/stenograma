/**
 * SESIJŲ BENDRA SEMANTIKA (#155, 7.3).
 *
 * Viskas, kas turi reikšti TĄ PATĮ abiejuose backend'uose: galiojimo langai,
 * palaikomų eilutės formatų aibė ir tapatybės patikra prieš gyvą `AUTH_USERS`.
 *
 * ⚠️ ANTRA KOPIJA - TYLI DIVERGENCIJA. Job store pusėje būtent taip išsiskyrė
 * `tenantId`, `idempotencyKey` ir tipų konvertavimas (#155): du keliai be
 * bendro autoriteto ilgainiui pradeda skirtis ten, kur skirtumo kaina
 * didžiausia.
 */

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

/** Naujai kuriamų sesijų eilutės formatas. */
const SESSION_SCHEMA_VERSION = 1;

/**
 * PALAIKOMŲ FORMATŲ AIBĖ YRA UŽDARA.
 *
 * ⚠️ `v > PALAIKOMA` NEPAKANKA. Toks palyginimas praleidžia `0`, `-1` ir bet
 * kurią neatpažintą senesnę reikšmę - t. y. būtent tas eilutes, kurių formato
 * nežinome. Nežinomas persistuotas formatas privalo kristi fail-closed, ne
 * būti aiškinamas spėjimu.
 *
 * ⚠️ NESUSIJĘ su `jobs.schema_version` (`{NULL, 2}`). Tas žymi ĮRAŠO ERĄ
 * (#158, `actor` interpretavimą), šis - SESIJOS EILUTĖS formatą. Dvi
 * nepriklausomos numeracijos; jų „suderinimas tvarkos dėlei" sulaužytų vieną.
 */
const PALAIKOMOS_SCHEMA_VERSIJOS = Object.freeze([SESSION_SCHEMA_VERSION]);
const PALAIKOMOS = new Set(PALAIKOMOS_SCHEMA_VERSIJOS);

/**
 * ⚠️ REIKŠMĖ NORMALIZUOJAMA PRIEŠ `has()`.
 *
 * `pg` `integer` grąžina skaičių, bet ta pati reikšmė gali ateiti iš JSON,
 * atkūrimo kelio ar kito draiverio kaip `"1"`, o `Set.has("1")` yra `false` -
 * GALIOJANTI sesija būtų atmesta. Konversija čia eksplicitinė, kad
 * normalizacija nebūtų kiekvieno kvietėjo atsakomybė.
 *
 * `null`, `undefined`, `"abc"` ir trupmeninės reikšmės netampa `0` - jos
 * nepalaikomos, ir tai teisinga: nežinomas formatas atmetamas.
 */
function palaikomaSchemaVersija(reiksme) {
  if (typeof reiksme === "number") return PALAIKOMOS.has(reiksme);
  if (typeof reiksme === "string" && /^-?\d+$/.test(reiksme.trim())) {
    return PALAIKOMOS.has(Number(reiksme.trim()));
  }
  return false;
}

/**
 * TAPATYBĖ PRIEŠ GYVĄ `AUTH_USERS`.
 *
 * ⚠️ STARTINIS SUDERINIMAS DENGIA TIK RESTARTĄ. Vartotojas, ištrintas iš
 * `AUTH_USERS` arba pažemintas RUNTIME metu, su galiojančia sesija toliau
 * autorizuotų užklausas SENA role iki kito restarto - privilegijų eskalavimas.
 *
 * @returns {{ok: true, user: object} | {ok: false, priezastis: string}}
 */
function patikrintiTapatybe(userId, role, env = process.env) {
  const { loadUsersById } = require("../credentials");
  const user = loadUsersById(env).get(userId);
  if (!user) return { ok: false, priezastis: "vartotojo nebėra AUTH_USERS" };
  if (user.role !== role) return { ok: false, priezastis: "rolė nesutampa su sesijos snapshot'u" };
  return { ok: true, user };
}

/**
 * VARDAS YRA `AUTH_USERS` RODINYS, NE PERSISTUOTAS LAUKAS.
 *
 * `req.user.username` naudoja keturios vietos, tarp jų AUDITO AKTORIUS
 * (`routes/jobs.js`, `routes/transcribeJobs.js`, `routes/auth.js`,
 * `middleware/authorize.js`). Nustojus vardą persistinti, kiekviena iš jų
 * privalo gauti jį iš `AUTH_USERS` pagal `user_id` - todėl išvedimas vyksta
 * ČIA, saugykloje, o ne keturis kartus kvietėjų pusėje.
 *
 * ⚠️ NIEKADA `undefined`. Vartotojas, dingęs tarp suderinimo ciklų, negali
 * virsti `undefined` aktoriumi audite - audito eilutė be aktoriaus yra būtent
 * ta, kurios prireikia incidento metu.
 */
const NEZINOMAS_VARDAS = "[nežinomas]";

module.exports = {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_ABSOLUTE_TIMEOUT_MS,
  idleTimeoutMs,
  absoluteTimeoutMs,
  SESSION_SCHEMA_VERSION,
  PALAIKOMOS_SCHEMA_VERSIJOS,
  palaikomaSchemaVersija,
  patikrintiTapatybe,
  NEZINOMAS_VARDAS,
};
