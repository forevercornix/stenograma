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
 * ⚠️ RIBA: užraktas gyvena ATMINTYJE, viename procese – ta pati riba kaip
 * ištrynimo žymų (#19) ir sesijų (#18). Keliems worker'ių procesams reikėtų
 * Redis užrakto; iki tol atkūrimą galima saugiai daryti tik tada, kai veikia
 * vienas backend procesas.
 */

let _lock = null;

/** Kiek ilgiausiai užraktas gali galioti, kad gedimas neužblokuotų sistemos amžiams. */
const DEFAULT_MAX_HOLD_MS = 10 * 60 * 1000; // 10 min

/**
 * Uždeda užraktą.
 *
 * @returns {{acquired: boolean, reason?: string}}
 */
function acquire(reason, { maxHoldMs = DEFAULT_MAX_HOLD_MS } = {}) {
  if (isLocked()) {
    return { acquired: false, reason: "priežiūros operacija jau vykdoma" };
  }

  _lock = { reason, acquiredAt: Date.now(), expiresAt: Date.now() + maxHoldMs };
  log.warn("Priežiūros užraktas uždėtas – naujų darbų priėmimas sustabdytas", { reason });

  return { acquired: true };
}

function release() {
  if (!_lock) return;

  log.info("Priežiūros užraktas nuimtas", { heldMs: Date.now() - _lock.acquiredAt });
  _lock = null;
}

/**
 * Ar užraktas galioja?
 *
 * Pasibaigęs užraktas NEBEGALIOJA ir automatiškai išvalomas: procesui nukritus
 * vidury atkūrimo (ar užmiršus `release`) sistema kitaip liktų užblokuota
 * neribotai, ir vienintelė išeitis būtų restartas.
 */
function isLocked() {
  if (!_lock) return false;

  if (_lock.expiresAt <= Date.now()) {
    log.warn("Priežiūros užraktas pasibaigė automatiškai", { reason: _lock.reason });
    _lock = null;
    return false;
  }

  return true;
}

/** Užrakto būsena diagnostikai – be jokio turinio. */
function status() {
  if (!isLocked()) return { locked: false };

  return {
    locked: true,
    reason: _lock.reason,
    heldMs: Date.now() - _lock.acquiredAt,
  };
}

/**
 * Vykdo operaciją su užraktu ir GARANTUOTAI jį nuima.
 *
 * `finally` čia būtinas: be jo nepavykęs atkūrimas paliktų sistemą
 * užblokuotą, o operatorius matytų „priežiūros operacija jau vykdoma" po to,
 * kai ji seniai baigėsi.
 */
async function withLock(reason, operation, options = {}) {
  const result = acquire(reason, options);
  if (!result.acquired) return { locked: false, reason: result.reason };

  try {
    return { locked: true, value: await operation() };
  } finally {
    release();
  }
}

/** Testams. */
function _resetForTests() {
  _lock = null;
}

module.exports = { acquire, release, isLocked, status, withLock, DEFAULT_MAX_HOLD_MS, _resetForTests };
