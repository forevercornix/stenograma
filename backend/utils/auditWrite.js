const { createLogger } = require("./logger");
const {
  arBlokuojantis,
  kategorija,
  MalformedAuditEventError,
  EVENT_PATTERN,
} = require("./auditEvents");
const { getRequestId } = require("./requestContext");

const log = createLogger("audit-write");

/**
 * VIENAS AUDITO RAŠYMO MECHANIZMAS (#155, 7.4a).
 *
 * ⚠️ KODĖL NE PER CALL SITE'US.
 *
 * Po `record()` async cutover kiekvienas iš 28 produkcinių kvietimų gauna
 * klausimą „ką daryti su Promise". Palikus atsakymą call site'ui, atsirastų trys
 * elgesiai: `await` + throw, `catch` + tęsti, ir - dažniausiai - tylus
 * ignoravimas. #210 to neleidžia: kategoriją nustato `utils/auditEvents.js`, o
 * ŠIS modulis ją vykdo.
 *
 * ⚠️ VIENAS MECHANIZMAS IR HTTP, IR WORKER KELIUI. Timeout tik route lygyje
 * paliktų tą patį kontraktą neapsaugotą worker'iuose ir servisuose, kur audito
 * kvietimų yra daugiau nei maršrutuose.
 */

const DEFAULT_AUDIT_WRITE_TIMEOUT_MS = 2000;

/**
 * `AUDIT_WRITE_TIMEOUT_MS` su saugia numatytąja reikšme.
 *
 * ⚠️ SKAITOMA KIEKVIENO KVIETIMO METU, ne modulio įkėlimo. Testai ribą keičia
 * per `process.env`, ir modulio lygio konstanta reikštų, kad deterministinis
 * timeout testas priklauso nuo `require` tvarkos.
 */
function auditWriteTimeoutMs(env = process.env) {
  const raw = Number(env.AUDIT_WRITE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AUDIT_WRITE_TIMEOUT_MS;
}

/** Audito rašymo gedimas - atskira klasė, kad kvietėjas jį atskirtų nuo domeno klaidų. */
class AuditWriteError extends Error {
  constructor(event, priezastis) {
    super(`Audito įrašo "${event}" nepavyko patvirtinti: ${priezastis}`);
    this.name = "AuditWriteError";
    this.code = "AUDIT_WRITE_FAILED";
    this.event = event;
  }
}

/**
 * OBSERVABILITY SKAITIKLIS.
 *
 * ⚠️ REPO NETURI BENDROS METRIKŲ INFRASTRUKTŪROS. `utils/qualityMetrics.js` yra
 * apie transkripcijos kokybę, o `observabilityEvents` testas - apie audito
 * įvykių metaduomenis; nė vienas nėra skaitiklių registras. Todėl čia laikomas
 * MINIMALUS skaitiklis šalia mechanizmo, kurį jis matuoja, o ne kuriama
 * lygiagreti metrikų sistema.
 *
 * ⚠️ SKAITIKLIS NEDVIGUBINAMAS. Jis didinamas TIK `rasytiAudita()` viduje -
 * vienintelėje vietoje, kur neblokuojantis gedimas apdorojamas. Helperiai
 * (`lifecycleService.writeAudit`, `authorizeJobOrAudit`) kviečia tą pačią
 * funkciją, tad viena klaida per kelis sluoksnius lieka vienu inkrementu.
 */
const skaitikliai = { auditWriteFailures: 0 };

function getAuditCounters() {
  return { ...skaitikliai };
}

function _resetAuditCountersForTests() {
  skaitikliai.auditWriteFailures = 0;
}

/**
 * BAIGTINIS LAUKIMAS.
 *
 * ⚠️ VĖLUOJANTI KLAIDA NEGALI TAPTI `unhandledRejection`. Po timeout originalus
 * Promise lieka gyvas; be handlerio jo vėlesnis `reject` nukristų į procesą ir
 * numuštų testus bei produkciją. Handleris NĖRA tylus - jis loguoja; gedimas
 * jau pranešatas timeout keliu, tad skaitiklis čia NEDIDINAMAS (kitaip vienas
 * gedimas būtų suskaičiuotas du kartus).
 */
function suRiba(promise, ribaMs, event, blokuojantis) {
  let laikmatis;
  const timeout = new Promise((_, reject) => {
    /**
     * ⚠️ BE `unref()`. Laikmatis PRIVALO laikyti event loop gyvą, kol riba
     * nesuveikė: jei audito backend'as kabo, o laikmatis būtų `unref`'intas,
     * procesas išsektų nesulaukęs timeout - kvietėjas niekada negautų nei
     * atsakymo, nei klaidos. `finally` bloke jis visada išvalomas, tad
     * nutekėjimo nėra.
     */
    laikmatis = setTimeout(
      () => reject(new AuditWriteError(event, `timeout po ${ribaMs} ms`)),
      ribaMs
    );
  });

  /**
   * ⚠️ `Promise.race` NENUTRAUKIA rašymo - jis tik nustoja jo laukti.
   *
   * Todėl abi vėluojančios baigtys turi būti apdorotos, ir jos NĖRA
   * lygiavertės:
   *
   *  - vėluojanti KLAIDA: gedimas jau praneštas timeout keliu, tad ji tik
   *    logginama (skaitiklis nedidinamas - kitaip vienas gedimas būtų
   *    suskaičiuotas du kartus);
   *
   *  - vėluojanti SĖKMĖ: kvietėjui jau pasakyta, kad nepavyko, o blokuojančiu
   *    atveju veiksmas jau ATŠAUKTAS (pvz. `LOGIN_SUCCESS` → sesija revokuota,
   *    503). Jei įrašas vis tiek įsirašo, audito pėdsakas tvirtina įvykus tai,
   *    kas buvo atsukta. Ištrinti jo negalim, tad jis daromas MATOMU:
   *    `error` logas visada, o skaitiklis - TIK blokuojančiam keliui.
   *
   * ⚠️ INVARIANTAS: VIENAS rašymo bandymas → NE DAUGIAU KAIP VIENAS skaitiklio
   * didinimas.
   *
   *   neblokuojantis: timeout jau padidino (`rasytiAudita` politikoje),
   *                   tad vėluojanti sėkmė NEBEDIDINA;
   *   blokuojantis:   timeout NEDIDINA (skaitiklis - neblokuojančių signalas,
   *                   žr. `getAuditCounters` testus), tad vėluojanti sėkmė
   *                   lieka vienintelis didinimas.
   *
   * Be šio atskyrimo vienas lėtas `EXPORT_*` ar `UPLOAD_REJECTED` rašymas
   * praneštų DU gedimus ir iškreiptų bet kokį stebėjimą, pastatytą ant šio
   * skaitiklio.
   *
   * ⚠️ TIKRAS SPRENDIMAS - deadline'o perdavimas į saugyklą arba atšaukiamas
   * rašymas - priklauso nuo backend'o, kurio dar nėra. Namai: SUBISSUES-155.md
   * [7.4b] (`audit_log` schema) ir [7.5b] („AUDITO RAŠYMO KLAIDOS
   * NEPRARANDAMOS").
   */
  promise.then(
    (eilute) => {
      if (laikmatis) return; // spėjo laiku - rezultatą grąžino `Promise.race`
      if (eilute === null) return; // privacy mode - nieko neįrašyta
      /** ⚠️ Žr. invariantą aukščiau: neblokuojančiam keliui timeout jau padidino. */
      if (blokuojantis) skaitikliai.auditWriteFailures += 1;
      log.error("Audito įrašas įsirašė JAU PO timeout - kvietėjui pasakyta, kad nepavyko", {
        event,
        blokuojantis,
        irasoId: eilute && eilute.id,
      });
    },
    (klaida) => {
      if (laikmatis) return; // dar nepasibaigė - klaidą apdoros `Promise.race`
      log.error("Audito rašymas krito jau po timeout", {
        event,
        klaida: klaida && klaida.message,
      });
    }
  );

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(laikmatis);
    laikmatis = null;
  });
}

/**
 * VIENINTELIS produkcinis audito rašymo kelias.
 *
 * Blokuojantis įvykis: klaida ar timeout → METAMA `AuditWriteError`, tad
 * saugomas veiksmas negali deklaruoti sėkmės.
 *
 * ⚠️ „Sėkmė nedeklaruojama" NĖRA tas pats, kas „veiksmas atmetamas". Ten, kur
 * auditas rašomas po negrįžtamo veiksmo (`auditEvents.POST_HOC_IVYKIAI`),
 * galioja tik pirmasis - žr. to rinkinio komentarą.
 *
 * Neblokuojantis įvykis: klaida ar timeout → `error` logas (su `request_id` iš
 * request konteksto per `utils/logger.js`), skaitiklis +1, ir kvietimas
 * grąžinamas NORMALIAI, kad pagrindinė operacija tęstųsi.
 *
 * ⚠️ ABIEM ATVEJAIS KVIETĖJAS `await`ina. Fire-and-forget nėra nė vienoje
 * šakoje: neblokuojantis kelias irgi laukia, tik gedimą paverčia stebimu, o ne
 * lemtingu.
 *
 * @returns {Promise<object|null>} įrašyta eilutė arba `null` (privacy mode /
 *   neblokuojantis gedimas).
 */
async function rasytiAudita(entry, { auditLog = require("./auditLog") } = {}) {
  const { normalizeEvent } = auditLog;

  /**
   * ⚠️ NETAISYKLINGAS VARDAS ATMETAMAS PRIEŠ IŠVEDIMĄ (#210).
   *
   * Be šios sargybos `normalizeEvent()` tyliai ignoruotų neatitinkantį
   * `entry.event` ir išvestų įvykį iš kitų laukų - žr.
   * `MalformedAuditEventError` paaiškinimą. Klaida NĖRA `AuditWriteError`:
   * tai programavimo, o ne infrastruktūros gedimas, tad neturi virsti 503
   * „auditas neprieinamas" ir būti palaikyta laikina.
   * Šablonas imamas iš `auditEvents` - klasifikacijos autoriteto, o ne iš
   * `auditLog`: pastarasis testuose pakeičiamas dubliu, ir sargyba tyliai
   * nustotų veikti būtent ten, kur ją norim patikrinti.
   */
  if (typeof entry.event === "string" && !EVENT_PATTERN.test(entry.event)) {
    log.error("Netaisyklingas audito įvykio vardas", { ivykioVardas: entry.event });
    skaitikliai.auditWriteFailures += 1;
    throw new MalformedAuditEventError(entry.event);
  }

  const event = normalizeEvent(entry);

  /**
   * ⚠️ KLASIFIKACIJA NUSTATOMA PRIEŠ RAŠYMĄ. Nežinomas įvykis yra
   * kontroliuojama klaida, ne numatytoji kategorija - `kategorija()` meta.
   * Blokuojančiam keliui ji virsta veiksmo atmetimu, neblokuojančiam - logu.
   */
  let blokuojantis;
  try {
    blokuojantis = arBlokuojantis(event);
  } catch (klaida) {
    log.error("Neklasifikuotas audito įvykis", { event, klaida: klaida.message });
    skaitikliai.auditWriteFailures += 1;
    throw klaida;
  }

  const riba = auditWriteTimeoutMs();

  try {
    const eilute = await suRiba(
      Promise.resolve().then(() => auditLog.record(entry)),
      riba,
      event,
      blokuojantis
    );

    /**
     * ⚠️ `PRIVACY_MODE` YRA EKSPLICITINĖ IŠIMTIS, NE TYLUS PRAĖJIMAS.
     *
     * Įjungus `PRIVACY_MODE=true`, `auditLog.record()` SĄMONINGAI nieko
     * neįrašo ir grąžina `null`. Blokuojančiam įvykiui tai reiškia, kad
     * patvirtinti nėra ko - garantija „sėkmė tik po patvirtinto įrašo" tokiu
     * režimu neegzistuoja, nes operatorius auditą išjungė visai sistemai.
     *
     * Veiksmo ČIA neatmetame: `PRIVACY_MODE` sulaužytų prisijungimą,
     * autorizaciją ir ištrynimą, t. y. paverstų privatumo režimą neveikiančia
     * sistema. Bet tylėti irgi negalima - režimas fiksuojamas `warn` lygiu,
     * kad diegime jis nebūtų painiojamas su veikiančiu auditu.
     *
     * ⚠️ Skaitiklis NEDIDINAMAS: tai ne gedimas, o sąmoninga konfigūracija.
     * Šis kompromisas įvardytas ir `docs/security-test-matrix.md`.
     */
    if (eilute === null && blokuojantis && auditLog.isPrivacyModeEnabled()) {
      log.warn("PRIVACY_MODE: blokuojantis audito įvykis NEĮRAŠOMAS", { event });
    }

    return eilute;
  } catch (klaida) {
    if (blokuojantis) {
      /**
       * Pilna diagnostika lieka SERVERIO loge; klientui ji eina per
       * `utils/sanitizeError.js` HTTP sluoksnyje (žr. middleware/errorHandler).
       */
      log.error("Blokuojantis audito rašymas nepavyko - veiksmas atmetamas", {
        event,
        klaida: klaida && klaida.message,
      });
      throw klaida instanceof AuditWriteError
        ? klaida
        : new AuditWriteError(event, klaida && klaida.message);
    }

    skaitikliai.auditWriteFailures += 1;
    log.error("Neblokuojantis audito rašymas nepavyko - operacija tęsiama", {
      event,
      requestId: getRequestId() || null,
      klaida: klaida && klaida.message,
    });
    return null;
  }
}

module.exports = {
  DEFAULT_AUDIT_WRITE_TIMEOUT_MS,
  auditWriteTimeoutMs,
  AuditWriteError,
  rasytiAudita,
  getAuditCounters,
  _resetAuditCountersForTests,
  kategorija,
};
