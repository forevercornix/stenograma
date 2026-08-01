const { getContext } = require("./requestContext");

/**
 * STRUKTŪRUOTAS LOGERIS (GDPR #17).
 *
 * KODĖL SAVAS, o ne pino. Reikia labai nedaug: lygiai, JSON eilutė, automatinis
 * request konteksto įtraukimas ir jautrių laukų redakcija. Redakciją jau turim
 * (`utils/auditLog.js` `sanitizeForLogging`), tad išorinė biblioteka atsineštų
 * ANTRĄ tiesą apie tai, kas yra jautru - du sąrašus, kurie ilgainiui išsiskirtų.
 * Projektas jau yra sąmoningai išmetęs `node-fetch` dėl to paties principo.
 *
 * KONTEKSTAS PRIDEDAMAS AUTOMATIŠKAI. `requestId` ir `actor` imami iš
 * AsyncLocalStorage, tad kviečiančiajam jų perduoti nereikia. Alternatyva -
 * reikalauti jų kiekviename kvietime - reikštų, kad pamiršta vieta duoda log
 * eilutę be koreliacijos, ir to niekas nepastebi.
 *
 * PRIVATUMAS: `data` objektas VISADA praleidžiamas pro `sanitizeForLogging`.
 * Loggeris yra paskutinė vieta, kur PII gali nutekėti po viso #4 darbo, tad
 * pasitikėti kviečiančiuoju čia negalima.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function _configuredLevel() {
  const raw = String(process.env.LOG_LEVEL || "").toLowerCase();
  if (LEVELS[raw] !== undefined) return LEVELS[raw];

  /**
   * Testuose numatytai `warn`, NE `silent`.
   *
   * Visiška tyla atrodė patrauklriai (450+ testų neteršia išvesties), bet ji
   * pakeistų elgseną: keli testai tikrina, kad įspėjimas apie apsaugos suveikimą
   * REALIAI pasiekia operatorių. Nutildžius juos, testai matuotų tylą ir praeitų
   * net apsaugai nustojus pranešti. `info` triukšmas dingsta, `warn`/`error`
   * lieka - tiek, kiek buvo iki struktūruoto logerio.
   */
  return process.env.NODE_ENV === "test" ? LEVELS.warn : LEVELS.info;
}

/** `json` mašinoms (produkcija), `pretty` žmogui (kūrimas). */
function _format() {
  const raw = String(process.env.LOG_FORMAT || "").toLowerCase();
  if (raw === "json" || raw === "pretty") return raw;
  return process.env.NODE_ENV === "production" ? "json" : "pretty";
}

/**
 * Redakcija taikoma IR `data` objektui, IR `msg` eilutei.
 *
 * Pirminis projektas sanitizavo tik `data`, remdamasis tuo, kad `msg` yra mūsų
 * pačių rašomas tekstas. Prielaida neatlaikė peržiūros: 33 kvietimo vietos
 * interpoliuoja kintamuosius į `msg`, o šešiose iš jų - `e.message`. Klaidų
 * tekstuose realiai būna failų kelių (`EACCES ... /tmp/stenograma-storage-…`),
 * tad „mūsų pačių tekstas" praktikoje reiškia „mūsų tekstas plius bet kas, kas
 * pateko į klaidą".
 *
 * Sanitizacija literalams nekenkia (ji ieško el. pašto, asmens kodų ir kelių),
 * o interpoliuotoms reikšmėms yra vienintelė gynyba. Rekomendacija dėti
 * kintamuosius į `data` lieka galioti - bet ji nebėra vienintelė apsauga.
 */
function _sanitize(data) {
  if (data === null || data === undefined) return undefined;

  try {
    const { sanitizeForLogging } = require("./auditLog");
    return sanitizeForLogging(data);
  } catch {
    // auditLog gali būti dar neįkeltas (ankstyvas paleidimo etapas) - tada
    // geriau praleisti duomenis, nei nutildyti visą log eilutę.
    return data;
  }
}

/**
 * Greitas kelias: sanitizacija kviečiama tik tada, kai eilutėje apskritai gali
 * kas nors būti.
 *
 * Dauguma pranešimų yra literalai („Worker paleistas"), kuriuose nėra nei @,
 * nei kelio, nei ilgos skaitmenų sekos. Regex patikra tokiu atveju kainuoja
 * kelis kartus mažiau nei pilnas `sanitizeForLogging` perėjimas. Filtras
 * sąmoningai PLATUS - jei kyla abejonė, sanitizuojam.
 */
const MAYBE_SENSITIVE = /[@/\\]|\d{5,}/;

function _sanitizeMessage(msg) {
  if (typeof msg !== "string") return msg;
  if (!MAYBE_SENSITIVE.test(msg)) return msg;
  return _sanitize(msg);
}

function _emit(level, component, msg, data) {
  if (LEVELS[level] < _configuredLevel()) return;

  const context = getContext();
  const entry = {
    ts: new Date().toISOString(),
    level,
    component,
    msg,
    ...(context.requestId ? { requestId: context.requestId } : {}),
    ...(context.actor ? { actor: context.actor } : {}),
    ...(context.execution ? { execution: context.execution } : {}),
  };

  const sanitized = _sanitize(data);
  if (sanitized !== undefined) entry.data = sanitized;

  // `msg` praleidžiamas pro tą pačią redakciją - žr. `_sanitize` komentarą.
  entry.msg = _sanitizeMessage(entry.msg);

  const channel = level === "error" ? console.error : level === "warn" ? console.warn : console.log;

  if (_format() === "json") {
    channel(JSON.stringify(entry));
    return;
  }

  /**
   * `pretty` rodo TĄ PATĮ laukų rinkinį kaip `json`, tik akiai patogiau.
   *
   * Pirminė versija rodė tik `requestId` ir prarasdavo `level`, `actor` bei
   * `execution` - kūrėjas lokaliai nematydavo net to, ar eilutė iš worker'io,
   * ar iš inline vykdymo. Du formatai, rodantys skirtingą informaciją, yra
   * blogesni nei vienas: klaida, matoma tik produkcijoje, ten ir liks.
   */
  const meta = [entry.requestId, entry.actor, entry.execution].filter(Boolean).join(" ");
  const correlation = meta ? ` [${meta}]` : "";
  const suffix = sanitized === undefined ? "" : ` ${JSON.stringify(sanitized)}`;
  channel(`${level.toUpperCase()} [stenograma:${component}]${correlation} ${entry.msg}${suffix}`);
}

/**
 * Komponento logeris. Komponentas yra privalomas, kad kiekviena eilutė turėtų
 * kilmę - be jo struktūruotas logas nedaug skiriasi nuo laisvo teksto.
 */
function createLogger(component) {
  if (!component || typeof component !== "string") {
    throw new Error("createLogger: komponento pavadinimas privalomas.");
  }

  return {
    debug: (msg, data) => _emit("debug", component, msg, data),
    info: (msg, data) => _emit("info", component, msg, data),
    warn: (msg, data) => _emit("warn", component, msg, data),
    error: (msg, data) => _emit("error", component, msg, data),
  };
}

module.exports = { createLogger, LEVELS, _emitForTests: _emit };
