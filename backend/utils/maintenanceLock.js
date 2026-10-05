const { createLogger } = require("./logger");

const log = createLogger("maintenance");

/**
 * PRIEŽIŪROS UŽRAKTAS (#20 PR4).
 *
 * KODĖL VIEN 409 NEUŽTENKA.
 *
 * Atkūrimas perrašo būseną, tad prieš jį tikrinama, ar nėra aktyvių darbų. Bet
 * tarp tos patikros ir realaus pritaikymo praeina laikas – per jį worker'is
 * gali paimti naują darbą iš eilės arba vartotojas jį sukurti.
 *
 * Tai klasikinė TOCTOU: patikra buvo teisinga tuo momentu, kai ją atlikom, ir
 * neteisinga tada, kai ja rėmėmės.
 *
 * Užraktas uždaro langą: jį uždėjus naujų darbų nebeįmanoma nei sukurti, nei
 * pradėti, tad patikros rezultatas lieka galiojantis iki pat pabaigos.
 *
 * ⚠️ RIBA: UŽRAKTAS GYVENA ATMINTYJE, VIENAME PROCESE – ta pati riba kaip
 * ištrynimo žymų (#19) ir sesijų (#18). Bet riba yra NE ten, kur ilgai buvo
 * užrašyta (#440 §0.1): pavojus yra ne worker'ių skaičius, o GAMINTOJO
 * (API) proceso dauginimas.
 *
 * ⚠️ WORKER'IŲ SKALAVIMAS SAUGUS. Worker'iai job'ų NEGAMINA – jie tik vartoja
 * eilę. `docker compose ... up --scale transcription-worker=3` šios garantijos
 * nepažeidžia, nors ankstesnė šio komentaro redakcija būtent tai ir teigė.
 *
 * KAS IŠ TIKRŲJŲ UŽDARO LANGĄ – dvi dalys kartu:
 *
 *   1. VIENINTELIS GAMINTOJAS TAME PAČIAME PROCESE. Job'ą sukuria ir į eilę
 *      įkelia tik du HTTP maršrutai – `routes/jobs.js:96`/`:112` ir
 *      `routes/transcribeJobs.js:191`/`:209` – t. y. tas pats procesas, kuris
 *      laiko šį užraktą. Todėl `jobStore.create()` patikra (`jobStore/index.js`)
 *      yra TINKAMAME procese ir realiai blokuoja.
 *   2. BARJERAS UŽRAKTO VIDUJE (`routes/backup.js:259`). `countActiveJobs()`
 *      skaičiuoja VISAS nebaigtas būsenas globaliai, įskaitant BullMQ retry
 *      pauzę (tarpinis bandymas sąmoningai lieka `processing`, žr.
 *      `workers/index.js`). Grąžinus nulį, eilėje nėra ko paimti.
 *
 * Vietinio užrakto PAKANKA būtent todėl, kad gamyba yra vienaprocesė – ne
 * todėl, kad užraktas būtų bendras.
 *
 * ⚠️ TAI NĖRA VYKDOMA SĄLYGA. Niekas netikrina, kad gamintojo procesas būtų
 * vienas: suskalavus `backend` iki dviejų replikų, antrojo proceso `create()`
 * tikrintų savo `_lock = null` ir kurtų job'us atkūrimo metu. Sargas tam yra
 * atskiras darbas (#440 follow-up); iki tol tai operacinė sąlyga.
 */

/**
 * ⚠️ NUOMA SU FENCING TOKEN'U (#440 §0.2).
 *
 * Anksčiau užraktas buvo fiksuota 10 min nuoma be pratęsimo ir be savininko
 * tapatybės. Iš to kilo dvi grandinės, abi išmatuotos:
 *
 *   A. Ilgesnis nei nuoma atkūrimas tyliai tęsdavosi BE užrakto: `create()`
 *      vėl priimdavo darbus, abu worker'iai vėl pradėdavo vykdymą, o
 *      `restoreService` tuo metu vis dar rašydavo. Barjeras
 *      (`routes/backup.js`) savo darbą jau būdavo padaręs ir nebesikartodavo.
 *   B. `acquire()` nurašydavo pasibaigusią nuomą, tad ANTRAS atkūrimas
 *      galėdavo ją paimti, kol pirmas dar rašo. O `release()` savininko
 *      netikrindavo – pirmosios operacijos `finally` nuimdavo ANTROSIOS
 *      nuomą. Klasikinė nuoma be fencing'o.
 *
 * Todėl: nuoma pratęsiama, kol operacija gyva (A), ir kiekviena nuoma turi
 * token'ą, be kurio jos nuimti negalima (B).
 */

let _lock = null;

/**
 * ⚠️ MONOTONINIS IR PER `_resetForTests()` NENULINAMAS.
 *
 * Token'o paskirtis – atskirti nuomas. Nulinamas skaitiklis galėtų išduoti
 * token'ą, identišką pasenusiam, ir fencing nustotų veikti būtent ten, kur
 * jis tikrinamas – testuose.
 */
let _tokenSkaitiklis = 0;

/** Kiek ilgiausiai nuoma galioja BE pratęsimo, kad miręs savininkas neužblokuotų sistemos. */
const DEFAULT_MAX_HOLD_MS = 10 * 60 * 1000; // 10 min

/** Kaip dažnai `withLock()` pratęsia nuomą. Trečdalis – du praleisti ciklai dar nelemia pabaigos. */
const RENEW_INTERVAL_DIVISOR = 3;

/**
 * Ar nuoma pasibaigusi?
 *
 * ⚠️ SKAITYMAS BE ŠALUTINIO POVEIKIO. Būsenos nurašymas gyvena tik
 * `_nurasytiPasibaigusia()`.
 */
function _pasibaigusi() {
  return Boolean(_lock) && _lock.expiresAt <= Date.now();
}

/**
 * ⚠️ VIENINTELĖ VIETA, KUR PASIBAIGUSI NUOMA NURAŠOMA (#440, atviras kl. 2).
 *
 * Anksčiau nurašymas buvo `isLocked()` šalutinis poveikis, o to trys
 * išmatuotos pasekmės:
 *
 *   1. Galėdavo neįvykti NIEKADA: tyliame atkūrime `isLocked()` niekas
 *      nekviečia, tad ir žurnalo įrašas apie prarastą garantiją neatsirasdavo.
 *   2. Atribucija klaidinga: kai įvykdavo, įrašą sukeldavo nesusijęs kvietėjas
 *      (pvz. worker'is, imantis darbą), ne priežiūros kontekstas.
 *   3. Diagnostinis skaitymas MUTUODAVO būseną – `status()` irgi kviesdavo
 *      `isLocked()`.
 *
 * Nuomos pabaiga reiškia „savininkas laikomas mirusiu", ir tokiam perėjimui
 * priklauso vienas aiškus, žurnaluojamas veiksmas.
 */
function _nurasytiPasibaigusia() {
  if (!_pasibaigusi()) return false;

  log.warn("Priežiūros nuoma pasibaigė – savininkas laikomas mirusiu", {
    reason: _lock.reason,
    token: _lock.token,
    heldMs: Date.now() - _lock.acquiredAt,
  });
  _lock = null;
  return true;
}

/**
 * Uždeda užraktą ir grąžina nuomos token'ą.
 *
 * @returns {{acquired: boolean, token?: number, reason?: string}}
 */
function acquire(reason, { maxHoldMs = DEFAULT_MAX_HOLD_MS } = {}) {
  /** Pasibaigusi nuoma nurašoma AIŠKIAI, ne per `isLocked()` skaitymą. */
  _nurasytiPasibaigusia();

  if (isLocked()) {
    return { acquired: false, reason: "priežiūros operacija jau vykdoma" };
  }

  _tokenSkaitiklis += 1;
  const dabar = Date.now();
  _lock = { reason, token: _tokenSkaitiklis, acquiredAt: dabar, expiresAt: dabar + maxHoldMs };
  log.warn("Priežiūros užraktas uždėtas – naujų darbų priėmimas sustabdytas", {
    reason,
    token: _lock.token,
  });

  return { acquired: true, token: _lock.token };
}

/**
 * Pratęsia SAVO nuomą.
 *
 * ⚠️ PASIBAIGUSI NUOMA NEBEPRATĘSIAMA (fail-closed). Jei garantija jau nustojo
 * galioti, worker'iai ir `create()` tuo metu galėjo priimti darbų – atgaivinus
 * nuomą tas faktas būtų užtušuotas. Operacija apie tai sužino iš `renewed:
 * false` ir žurnalo įrašo, o ne iš tylos.
 *
 * @returns {{renewed: boolean, reason?: string}}
 */
function renew(token, { maxHoldMs = DEFAULT_MAX_HOLD_MS } = {}) {
  if (!_lock) return { renewed: false, reason: "nuomos nėra" };

  if (_lock.token !== token) {
    log.error("Atmestas SVETIMOS nuomos pratęsimas", { token, savininkas: _lock.token });
    return { renewed: false, reason: "ne jūsų nuoma" };
  }

  if (_pasibaigusi()) {
    return { renewed: false, reason: "nuoma jau pasibaigusi" };
  }

  _lock.expiresAt = Date.now() + maxHoldMs;
  return { renewed: true };
}

/**
 * Nuima SAVO nuomą.
 *
 * ⚠️ SVETIMAS ATLAISVINIMAS ATMETAMAS IR UŽFIKSUOJAMAS (#440 grandinė B).
 * Be šios patikros pasenęs savininkas nuimdavo naujojo nuomą, ir sistema
 * likdavo be jokios apsaugos, nors formaliai „užraktas buvo laikomas".
 *
 * @returns {{released: boolean, reason?: string}}
 */
function release(token) {
  if (!_lock) return { released: false, reason: "nuomos nėra" };

  if (_lock.token !== token) {
    log.error("Atmestas SVETIMOS nuomos atlaisvinimas", { token, savininkas: _lock.token });
    return { released: false, reason: "ne jūsų nuoma" };
  }

  log.info("Priežiūros užraktas nuimtas", { heldMs: Date.now() - _lock.acquiredAt, token });
  _lock = null;
  return { released: true };
}

/**
 * Ar užraktas galioja?
 *
 * ⚠️ BE ŠALUTINIO POVEIKIO (#440, atviras kl. 2). Pasibaigusi nuoma NEGALIOJA,
 * bet jos nurašymas čia nebevyksta – tai daro `_nurasytiPasibaigusia()`.
 */
function isLocked() {
  return Boolean(_lock) && !_pasibaigusi();
}

/** Užrakto būsena diagnostikai – be jokio turinio ir be būsenos keitimo. */
function status() {
  if (!isLocked()) return { locked: false };

  return {
    locked: true,
    reason: _lock.reason,
    heldMs: Date.now() - _lock.acquiredAt,
  };
}

/**
 * Vykdo operaciją su užraktu, PRATĘSDAMAS nuomą, kol ji gyva, ir garantuotai
 * nuimdamas savo nuomą.
 *
 * ⚠️ PRATĘSIMAS GYVENA ČIA, NE KVIETĖJE. Kol operacija vykdoma, „atkūrimas
 * tęsiasi" ir „užraktas galioja" nustoja būti du nepriklausomi faktai, tad
 * įrodytos maksimalios atkūrimo trukmės nebereikia (#440 D1). Palikus
 * pratęsimą kvietėjui, garantija priklausytų nuo to, ar kiekvienas jį
 * prisiminė.
 *
 * ⚠️ MIRUSIO SAVININKO ATSIGAVIMAS IŠSAUGOTAS (#440 D4): pratęsimą daro tik
 * gyvas procesas. Jam nukritus `setInterval` nustoja veikti, nuoma pasibaigia
 * kaip anksčiau, ir sistema atsilaisvina be restarto.
 */
async function withLock(reason, operation, options = {}) {
  const result = acquire(reason, options);
  if (!result.acquired) return { locked: false, reason: result.reason };

  const token = result.token;

  /** M2 MUTACIJA (#440): pratęsimo nėra — nuoma vėl fiksuota. */
  try {
    return { locked: true, value: await operation() };
  } finally {
    release(token);
  }
}

/**
 * Testams.
 *
 * ⚠️ `_tokenSkaitiklis` SĄMONINGAI NENULINAMAS – žr. jo deklaraciją.
 */
function _resetForTests() {
  _lock = null;
}

module.exports = {
  acquire,
  renew,
  release,
  isLocked,
  status,
  withLock,
  DEFAULT_MAX_HOLD_MS,
  RENEW_INTERVAL_DIVISOR,
  _resetForTests,
};
