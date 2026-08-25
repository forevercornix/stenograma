const crypto = require("crypto");

const { generateSessionToken, hashSessionToken } = require("./tokens");
const {
  idleTimeoutMs,
  absoluteTimeoutMs,
  SESSION_SCHEMA_VERSION,
  palaikomaSchemaVersija,
  patikrintiTapatybe,
} = require("./common");

/**
 * SESIJŲ SAUGYKLA ATMINTYJE (#18 PR1, kontraktas perrašytas #155 / 7.3).
 *
 * VIENAS PROCESAS - sąmoningai. Pilotui pakanka vieno backend proceso; kai
 * reikia globalios revokacijos ar kelių replikų, backend'as parenkamas
 * eksplicitiškai (`SESSION_STORE_BACKEND=postgres`).
 *
 * ⚠️ ŠIS BACKEND'AS NEBĖRA „paprastesnis" KONTRAKTO PRASME. Po 7.3 jis vykdo
 * TĄ PATĮ scenarijų rinkinį kaip PostgreSQL (`tests/
 * sessionStoreBackendContract.integration.test.js`): loginė revokacija,
 * du atskiri galiojimo langai, retencijos politika, uždara `schemaVersion`
 * aibė ir tapatybės patikra prieš gyvą `AUTH_USERS`. Du keliai be bendro
 * rinkinio išsiskiria tyliai - job store pusėje tai jau įvyko.
 *
 * ⚠️ RAKTAS YRA `token_hash`, NE PLIKAS TOKEN'AS. Simetriška DB: plikas
 * token'as neegzistuoja niekur, išskyrus kliento cookie ir vieną kvietimo
 * argumentą.
 */

/** `token_hash` → sesijos įrašas. */
const sessions = new Map();

/**
 * LEGACY TOLERANCIJA: `userId: null`.
 *
 * #181 ją leidžia TIK atminties backend'ui ir TIK seniems testų fixture'ams -
 * produkciniame PostgreSQL `user_id` yra `NOT NULL`, tad sesijų be stabilaus
 * ID ten NĖRA. Tokioms sesijoms tapatybės patikra prieš `AUTH_USERS`
 * neatliekama (nėra pagal ką), ir vardas lieka tas, su kuriuo jos sukurtos.
 *
 * ⚠️ TUŠČIAS `AUTH_USERS` NĖRA PRALEIDIMO PRIEŽASTIS.
 *
 * Ankstesnė versija reikalavo dar ir `env.AUTH_USERS` netuštumo. Pašalinus
 * PASKUTINĮ vartotoją - t. y. atlikus stipriausią įmanomą prieigos atėmimą -
 * sąlyga tapdavo `false`, patikra būdavo praleidžiama, ir sesija toliau
 * autentifikuodavo su savo įrašytu vardu bei role. PostgreSQL tokią sesiją
 * atmeta (vartotojo nėra `loadUsersById()` rezultate), tad du backend'ai
 * išsiskirdavo būtent revokacijos kelyje.
 *
 * Dabar lemia VIENAS klausimas: ar sesija turi stabilų `userId`. Jei turi, ji
 * tikrinama prieš gyvą vartotojų sąrašą - ir tuščias sąrašas teisingai reiškia
 * „tokio vartotojo nebėra", ne „netikrinam".
 */
function arTikrintiTapatybe(session) {
  return Boolean(session.userId);
}

async function create(identity, env = process.env) {
  // Pigus "gratis" valymas - naujos sesijos kūrimas yra natūralus taškas
  // patikrinti, ar senų neprisikaupė.
  sweepExpired(env);

  const token = generateSessionToken();
  const now = Date.now();

  const session = {
    /**
     * ⚠️ SUROGATAS, NE BEARER TOKEN'AS. Iki 7.3 čia buvo ta pati reikšmė,
     * kuri keliavo į cookie; jos atskyrimas yra visa hash-only garantijos
     * esmė (žr. `tokens.js`).
     */
    id: crypto.randomUUID(),
    userId: identity.id || null,
    username: identity.username,
    role: identity.role,
    createdAt: now,
    lastSeenAt: now,
    /** ABSOLIUTUS langas - `touch()` jo NEPRATĘSIA. */
    expiresAt: now + absoluteTimeoutMs(env),
    /** NEVEIKLUMO langas - `touch()` pratęsia TIK jį. */
    idleExpiresAt: now + idleTimeoutMs(env),
    revokedAt: null,
    schemaVersion: SESSION_SCHEMA_VERSION,
  };

  sessions.set(hashSessionToken(token), session);
  return { session, token };
}

/**
 * AUTENTIKACIJOS OPERACIJA, ne „paieška + atnaujinimas".
 *
 * ⚠️ VIENAS SPRENDIMAS, NE SEKA. Revokacija, absoliutus galiojimas,
 * neveiklumas ir `lastSeenAt` atnaujinimas įvyksta neatskiriamai - lygiai
 * taip, kaip PostgreSQL pusėje tai daro vienas sąlyginis `UPDATE`. Tarp
 * skaitymo ir mutacijos negali atsirasti revokacijos TOCTOU lango.
 */
async function touch(token, env = process.env) {
  if (!token) return null;

  const session = sessions.get(hashSessionToken(token));
  if (!session) return null;

  /** Nežinomas eilutės formatas - fail-closed, be jokios mutacijos. */
  if (!palaikomaSchemaVersija(session.schemaVersion)) return null;

  const now = Date.now();
  if (session.revokedAt !== null) return null;
  if (session.expiresAt <= now) return null;
  if (session.idleExpiresAt <= now) return null;

  if (arTikrintiTapatybe(session)) {
    const patikra = patikrintiTapatybe(session.userId, session.role, env);
    if (!patikra.ok) {
      /** Fail-closed IR revokacija - kitaip ta pati cookie bandytų vėl kitą sekundę. */
      session.revokedAt = now;
      return null;
    }
    /** Vardas - `AUTH_USERS` rodinys, ne persistuotas laukas. */
    session.username = patikra.user.username;
  }

  session.lastSeenAt = now;
  session.idleExpiresAt = now + idleTimeoutMs(env);
  return session;
}

/**
 * LOGINĖ revokacija: viena sesija (atsijungimas).
 *
 * ⚠️ NE `Map.delete()`. Fizinis šalinimas iš karto atimtų galimybę atsakyti,
 * ar cookie buvo ATŠAUKTA, ar jos niekada nebuvo - ta pati politika kaip
 * PostgreSQL pusėje, kad backend'ų kontraktas sutaptų ne tik autentikacijos,
 * bet ir retencijos scenarijuose.
 */
async function destroy(token) {
  if (!token) return false;
  const session = sessions.get(hashSessionToken(token));
  if (!session || session.revokedAt !== null) return false;
  session.revokedAt = Date.now();
  return true;
}

/**
 * Revokacija pagal VARDĄ - suderinamumui (#158).
 *
 * Naujiems tapatybe grįstiems keliams pirmenybė teikiama
 * `destroyAllForUserId()` - po pervadinimo revokacija pagal seną vardą tampa
 * semantiškai neteisinga (sesija priklauso tam pačiam žmogui, bet vardas kitas).
 */
async function destroyAllForUser(username) {
  let removed = 0;
  const now = Date.now();
  for (const session of sessions.values()) {
    if (session.username === username && session.revokedAt === null) {
      session.revokedAt = now;
      removed++;
    }
  }
  return removed;
}

/**
 * Revokacija pagal STABILŲ `userId` (#158).
 *
 * Sesijos be `userId` NELIEČIAMOS - tyliai jas įtraukus, `null === null`
 * sutaptų ir vienas kvietimas iškirstų visas tokias sesijas iš karto.
 */
async function destroyAllForUserId(userId) {
  if (!userId) return 0;
  let removed = 0;
  const now = Date.now();
  for (const session of sessions.values()) {
    if (session.userId === userId && session.revokedAt === null) {
      session.revokedAt = now;
      removed++;
    }
  }
  return removed;
}

/**
 * RETENCIJA - FIZINIS šalinimas, atskirtas nuo revokacijos.
 *
 * ⚠️ REVOKUOTA SESIJA SAUGOMA BENT IKI SAVO `expiresAt`. Kitaip
 * `revokedAt !== null → delete` reikštų momentinį ištrynimą, ir atsakymas
 * „ar ši cookie buvo atšaukta?" dingtų kartu su eilute.
 *
 * ⚠️ NEVEIKLUMO LANGAS ŠALINA TIK NEREVOKUOTAS sesijas. Be to sąlygos
 * pusės revokuota, bet dar negaliojanti iki galo sesija dingtų anksčiau nei
 * jos `expiresAt`, ir aukščiau aprašyta politika būtų pažeista tyliai.
 *
 * Klientas, kuris cookie daugiau niekada neatsiunčia (uždarytas skirtukas,
 * pamestas cookie), be šio valymo liktų žemėlapyje neribotą laiką.
 *
 * ⚠️ `env` NEBENAUDOJAMAS, IR TAI SĄMONINGA. Iki 7.3 valymas perskaičiuodavo
 * langus iš aplinkos, tad `SESSION_IDLE_TIMEOUT_MINUTES` pakeitimas atgaline
 * data pratęsdavo ar nutraukdavo JAU SUKURTAS sesijas. Dabar terminai saugomi
 * pačioje eilutėje (kaip DB stulpeliai), tad valymas remiasi tuo, kas buvo
 * nuspręsta kūrimo metu. Parametras paliktas kvietimo suderinamumui.
 */
function sweepExpired(_env) {
  const now = Date.now();
  let removed = 0;

  for (const [hash, session] of sessions.entries()) {
    const absoliutus = session.expiresAt <= now;
    const neveiklus = session.revokedAt === null && session.idleExpiresAt <= now;
    if (absoliutus || neveiklus) {
      sessions.delete(hash);
      removed++;
    }
  }
  return removed;
}

/**
 * FIZINIS eilučių skaičius, ne „aktyvių" skaičius.
 *
 * Revokuota, bet dar nepasibaigusi sesija ČIA MATOMA - būtent tai reiškia
 * retencijos politika, ir būtent tai leidžia testui atskirti revokaciją nuo
 * ištrynimo.
 */
async function size() {
  return sessions.size;
}

/**
 * READINESS ZONDAS.
 *
 * Atminties saugykla išorinės priklausomybės neturi: jei procesas gyvas, ji
 * pasiekiama. Metodas egzistuoja tam, kad `/api/ready` kelias būtų VIENODAS
 * abiem backend'ams ir nereikėtų šakoti pagal `backend` reikšmę - toks šakojimas
 * yra vieta, kur vienas režimas tyliai lieka nepatikrintas.
 */
async function probe() {
  return true;
}

/** Testams: pilnas išvalymas be serverio restarto. */
async function _clearForTests() {
  sessions.clear();
}

/** Testams: paleisti sweep rankiniu būdu be laukimo intervalo. */
function _sweepForTests(_env) {
  return sweepExpired();
}

/** Testams: tiesioginė prieiga prie įrašo (pvz. sugadintam `schemaVersion` įrašyti). */
function _getByTokenForTests(token) {
  return sessions.get(hashSessionToken(token)) || null;
}

module.exports = {
  backend: "memory",
  create,
  touch,
  destroy,
  destroyAllForUser,
  destroyAllForUserId,
  sweepExpired,
  size,
  probe,
  _clearForTests,
  _sweepForTests,
  _getByTokenForTests,
};
