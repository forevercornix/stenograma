/**
 * AUDITO ĮVYKIŲ KLASIFIKACIJA (#155, 7.4a).
 *
 * ⚠️ VIENAS AUTORITETAS, NE SPRENDIMAS KIEKVIENAME CALL SITE'E.
 *
 * Iki 7.4a `record()` buvo sinchroninis, tad klausimo „ar laukiam patvirtinimo"
 * nebuvo. Async cutover jį sukuria KIEKVIENAM iš 28 produkcinių kvietimų, ir
 * jei atsakymą rinktųsi call site'as („čia turbūt svarbu, tad await"), semantika
 * priklausytų nuo to, ką tą dieną galvojo autorius. Naujas security įvykis
 * tyliai paveldėtų silpnesnę kategoriją.
 *
 * Todėl kategorija nustatoma ČIA, pagal įvykį, ir call site'as jos nesirenka.
 *
 * ⚠️ KATEGORIJOS TIK DVI. #210: „Trečios kategorijos nėra: kiekvienas
 * `record()` kvietėjas priklauso vienai iš dviejų."
 */

const KATEGORIJA = Object.freeze({
  /**
   * BLOKUOJANTIS: sėkmė negali būti deklaruota anksčiau, nei patvirtintas
   * audito įrašas. Klaida arba timeout → veiksmas atmetamas (fail-closed).
   */
  BLOKUOJANTIS: "blocking",
  /**
   * NEBLOKUOJANTIS: audito klaida NENUMUŠA pagrindinės operacijos, bet ir
   * NENUTYLIMA - `error` lygio logas su `request_id` ir skaitiklis.
   */
  NEBLOKUOJANTIS: "non-blocking",
});

/**
 * ⚠️ PRISKYRIMO TAISYKLĖ, NE SKONIS.
 *
 * #210 blokuojančių šeimų sąrašas yra BAIGTINIS: autentikacija/autorizacija,
 * GDPR ištrynimas, provider override, rakto rotacija. Kiekvienas žemiau esantis
 * `BLOKUOJANTIS` priskyrimas nurodo, kuriai iš tų šeimų įvykis priklauso;
 * visa kita yra `NEBLOKUOJANTIS`. Sąrašo plėtimas „nes irgi svarbu" būtų
 * kategorijos, o ne įvykio, keitimas - tam reikia keisti #210.
 *
 * ⚠️ `provider override` IR `rakto rotacija` ĮVYKIŲ ŠIAME `main` NĖRA.
 *
 * `ALLOW_PROVIDER_OVERRIDE=false` atmetimas (`services/transcriptionService.js`)
 * meta `HttpError` NIEKO neįrašydamas į auditą, o rakto rotacijos (`hash_key_id`,
 * istoriniai HMAC raktai) mechanizmo dar nėra - tai 7.4b darbas. #210 nuostata
 * dėl jų nustato BŪSIMĄ semantiką, ne leidimą kurti funkciją 7.4a metu, todėl
 * čia jų įrašų nėra. Atsiradus tokiam įvykiui, jis privalo būti pridėtas kaip
 * `BLOKUOJANTIS` - kitaip `record()` jį atmes (žr. `kategorija()`).
 */
const AUDIT_EVENTS = Object.freeze({
  // ── Autentikacija (#210: blokuojanti šeima) ────────────────────────────────
  LOGIN_SUCCESS: KATEGORIJA.BLOKUOJANTIS,
  LOGIN_FAILED: KATEGORIJA.BLOKUOJANTIS,
  LOGOUT: KATEGORIJA.BLOKUOJANTIS,

  // ── Autorizacija (#210: blokuojanti šeima) ─────────────────────────────────
  AUTHORIZATION_DENIED: KATEGORIJA.BLOKUOJANTIS,
  JOB_EXECUTION_DENIED: KATEGORIJA.BLOKUOJANTIS,
  ADMIN_ACCESS_DENIED: KATEGORIJA.BLOKUOJANTIS,
  /**
   * Privilegijuotas nuosavybės apėjimas - tai autorizacijos sprendimas, ne
   * priežiūros darbas. Įrašas be patvirtinimo reikštų, kad administratorius
   * ištrynė svetimą job'ą, o pėdsako nėra.
   */
  ADMIN_DELETE_OVERRIDE: KATEGORIJA.BLOKUOJANTIS,

  // ── GDPR ištrynimas (#210: blokuojanti šeima) ──────────────────────────────
  /**
   * Visi keturi ŠALINA asmens duomenis. Ištrynimas be patvirtinto audito yra
   * būtent tas atvejis, kuriam auditas ir egzistuoja: po jo nebelieka ko
   * tikrinti. Fail-closed čia reiškia „netrinam", ne „prarandam duomenis".
   */
  DATA_ERASED: KATEGORIJA.BLOKUOJANTIS,
  LIFECYCLE_DELETION: KATEGORIJA.BLOKUOJANTIS,
  RETENTION_PURGE: KATEGORIJA.BLOKUOJANTIS,
  ADMIN_ORPHAN_CLEANUP: KATEGORIJA.BLOKUOJANTIS,

  // ── Job gyvavimo ciklas (#210: neblokuojantys) ─────────────────────────────
  TRANSCRIPTION_COMPLETED: KATEGORIJA.NEBLOKUOJANTIS,
  TRANSCRIPTION_FAILED: KATEGORIJA.NEBLOKUOJANTIS,
  PROTOCOL_COMPLETED: KATEGORIJA.NEBLOKUOJANTIS,
  PROTOCOL_FAILED: KATEGORIJA.NEBLOKUOJANTIS,
  PROCESSING_COMPLETED: KATEGORIJA.NEBLOKUOJANTIS,
  PROCESSING_FAILED: KATEGORIJA.NEBLOKUOJANTIS,

  // ── Eksportas, įkėlimai, kopijos (#210 blokuojančių šeimų sąraše NĖRA) ─────
  /**
   * Eksporto ir įkėlimo įvykiai fiksuoja ĮVYKUSĮ veiksmą; sprendimą „ar leisti"
   * priima `requirePermission`, kurio atmetimas rašo `AUTHORIZATION_DENIED`
   * (blokuojantis). Todėl audito gedimas čia negali reikšti, kad vartotojo
   * failas dingsta - operacija tęsiasi, o gedimas lieka matomas.
   */
  EXPORT_STARTED: KATEGORIJA.NEBLOKUOJANTIS,
  EXPORT_COMPLETED: KATEGORIJA.NEBLOKUOJANTIS,
  EXPORT_FAILED: KATEGORIJA.NEBLOKUOJANTIS,
  UPLOAD_REJECTED: KATEGORIJA.NEBLOKUOJANTIS,
  BACKUP_CREATED: KATEGORIJA.NEBLOKUOJANTIS,
  BACKUP_REJECTED: KATEGORIJA.NEBLOKUOJANTIS,
  BACKUP_RESTORED: KATEGORIJA.NEBLOKUOJANTIS,
  BACKUP_RESTORE_FAILED: KATEGORIJA.NEBLOKUOJANTIS,
});

/**
 * ⚠️ `normalizeEvent()` IŠVEDAMŲ ĮVYKIŲ AIBĖ.
 *
 * `auditLog.normalizeEvent()` grąžina šiuos vardus, kai kvietėjas `event`
 * nenurodo (transkripcijos ir protokolo keliai). Jie NĖRA matomi kaip
 * literalai call site'uose, tad statinė call site'ų paieška jų nerastų - o
 * neklasifikuotas įvykis turi kristi, ne praeiti.
 *
 * Sąrašas laikomas ČIA ir tikrinamas paleidimo metu (`validateAuditEvents`)
 * PRIEŠ `AUDIT_EVENTS`, todėl `normalizeEvent` šakos pakeitimas be įrašo
 * klasifikacijoje sustabdo startą.
 */
const IŠVEDAMI_ĮVYKIAI = Object.freeze([
  "TRANSCRIPTION_COMPLETED",
  "TRANSCRIPTION_FAILED",
  "PROTOCOL_COMPLETED",
  "PROTOCOL_FAILED",
  "PROCESSING_COMPLETED",
  "PROCESSING_FAILED",
]);

/** Nežinomas įvykis - kontroliuojama klaida, ne numatytoji kategorija. */
class UnclassifiedAuditEventError extends Error {
  constructor(event) {
    super(
      `Audito įvykis "${event}" neturi klasifikacijos (utils/auditEvents.js). ` +
        "Kiekvienas įvykis privalo būti eksplicitiškai blokuojantis arba neblokuojantis - " +
        "numatytoji kategorija reikštų, kad naujas security įvykis tyliai paveldi silpnesnę semantiką."
    );
    this.name = "UnclassifiedAuditEventError";
    this.code = "AUDIT_EVENT_UNCLASSIFIED";
  }
}

/**
 * @returns {"blocking"|"non-blocking"}
 * @throws {UnclassifiedAuditEventError} nežinomam įvykiui.
 */
function kategorija(event) {
  const rasta = Object.prototype.hasOwnProperty.call(AUDIT_EVENTS, event)
    ? AUDIT_EVENTS[event]
    : undefined;
  if (!rasta) throw new UnclassifiedAuditEventError(event);
  return rasta;
}

function arBlokuojantis(event) {
  return kategorija(event) === KATEGORIJA.BLOKUOJANTIS;
}

/**
 * PALEIDIMO METU: kiekvienas žinomas įvykis turi klasifikaciją.
 *
 * ⚠️ TIKRINAMI IR IŠVEDAMI ĮVYKIAI. Jie neturi literalo nė viename call site'e,
 * tad be šios patikros `normalizeEvent()` galėtų grąžinti vardą, kurio
 * klasifikacijoje nėra, ir gedimas iškiltų tik pirmo tokio job'o metu.
 *
 * @returns {string[]} klaidų sąrašas (tuščias - viskas gerai).
 */
function validateAuditEvents() {
  const klaidos = [];

  for (const įvykis of IŠVEDAMI_ĮVYKIAI) {
    if (!Object.prototype.hasOwnProperty.call(AUDIT_EVENTS, įvykis)) {
      klaidos.push(
        `Audito įvykis "${įvykis}" išvedamas normalizeEvent(), bet neklasifikuotas utils/auditEvents.js.`
      );
    }
  }

  for (const [įvykis, kat] of Object.entries(AUDIT_EVENTS)) {
    if (kat !== KATEGORIJA.BLOKUOJANTIS && kat !== KATEGORIJA.NEBLOKUOJANTIS) {
      klaidos.push(`Audito įvykis "${įvykis}" turi nežinomą kategoriją "${kat}".`);
    }
  }

  return klaidos;
}

module.exports = {
  KATEGORIJA,
  AUDIT_EVENTS,
  IŠVEDAMI_ĮVYKIAI,
  UnclassifiedAuditEventError,
  kategorija,
  arBlokuojantis,
  validateAuditEvents,
};
