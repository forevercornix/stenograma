const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");

/**
 * REQUEST KONTEKSTAS IR KORELIACIJA (GDPR #17).
 *
 * Vienas identifikatorius, sujungiantis HTTP užklausą, eilės jobą, worker'io
 * vykdymą ir tiekėjo kvietimą. Be jo diagnostika ilgame async sraute
 * (`POST /api/transcribe-jobs` → BullMQ → worker → Whisper → LLM) reiškia
 * spėliojimą pagal laiko žymes.
 *
 * KODĖL AsyncLocalStorage, o ne parametras.
 * Alternatyva būtų `requestId` perduoti per kiekvieną funkciją iki pat tiekėjo.
 * Tai reikštų parašų keitimą dešimtyse vietų, o kiekviena pamiršta grandinė
 * duotų tylų „unknown" - t. y. koreliaciją, kuri veikia beveik visada. ALS
 * kontekstas keliauja pats, o worker'iai (kur HTTP užklausos nėra) ID gauna
 * eksplicitiškai iš jobo metaduomenų per `runWithContext()`.
 *
 * PRIVATUMAS: kontekste laikomas TIK identifikatorius ir aktoriaus atspaudas.
 * Jokio turinio, jokių antraščių, jokių IP - kitaip jis taptų nauju nutekėjimo
 * kanalu į kiekvieną logo eilutę.
 */

const storage = new AsyncLocalStorage();

const HEADER = "x-request-id";

/**
 * Kliento pateiktas ID priimamas, bet GRIEŽTAI ribojamas.
 *
 * Jis patenka į logus ir audito įrašus, tad be ribų taptų injekcijos vektoriumi:
 * naujos eilutės klastotų log įrašus, ilga eilutė užpildytų saugyklą, o UTF-8
 * gudrybės apsunkintų paiešką. Formatas sąmoningai siauras - raidės, skaitmenys
 * ir keli skirtukai, iki 64 simbolių.
 */
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{8,64}$/;

function isValidClientRequestId(value) {
  return typeof value === "string" && CLIENT_ID_PATTERN.test(value);
}

/**
 * Serverio generuojamas ID. Prefiksas leidžia iš karto matyti, ar ID mūsų, ar
 * kliento - tai svarbu tiriant, kai ID atrodo keistai.
 */
function generateRequestId() {
  return `req_${crypto.randomUUID()}`;
}

/**
 * @returns {{requestId: string, actor: string|null, source: "client"|"server"}}
 */
function resolveRequestId(headerValue) {
  if (isValidClientRequestId(headerValue)) {
    return { requestId: headerValue, source: "client" };
  }
  return { requestId: generateRequestId(), source: "server" };
}

/** Vykdyti funkciją su nustatytu kontekstu (HTTP middleware ir worker'iai). */
function runWithContext(context, fn) {
  return storage.run(Object.freeze({ ...context }), fn);
}

/** Dabartinis kontekstas arba tuščias objektas - niekada neišmeta klaidos. */
function getContext() {
  return storage.getStore() || {};
}

/** Trumpinys logams ir audito įrašams. */
function getRequestId() {
  return getContext().requestId || null;
}

function getActor() {
  return getContext().actor || null;
}

/**
 * Express middleware: priskiria ID, grąžina jį antraštėje ir įjungia kontekstą
 * visai užklausos gyvavimo trukmei.
 */
function requestContextMiddleware(req, res, next) {
  const { requestId, source } = resolveRequestId(req.get(HEADER));

  // Antraštė nustatoma IŠ KARTO, dar prieš maršrutą: jei užklausa kris ar bus
  // atmesta rate limiterio, klientas vis tiek gaus ID, kurį galės nurodyti.
  res.setHeader(HEADER, requestId);

  runWithContext({ requestId, requestIdSource: source, actor: null }, () => next());
}

/**
 * Aktoriaus atspaudas iš API rakto.
 *
 * Saugom HASH, ne patį raktą - audito įrašai gyvena ilgiau nei raktas, ir
 * paslapties kopijavimas į juos būtų tas pats, kas jos logginimas. Trumpas
 * prefiksas leidžia atskirti raktus tarpusavyje neatskleidžiant nė vieno.
 */
function actorFingerprint(apiKey) {
  if (typeof apiKey !== "string" || apiKey.length === 0) return null;
  return `key_${crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 12)}`;
}

/** Papildo esamą kontekstą (naudoja autentifikacijos middleware). */
function setActor(actor) {
  const current = storage.getStore();
  if (!current) return;

  // ALS saugykla užšaldyta, tad keičiam per naują objektą tame pačiame scope'e.
  storage.enterWith(Object.freeze({ ...current, actor }));
}

module.exports = {
  HEADER,
  CLIENT_ID_PATTERN,
  isValidClientRequestId,
  generateRequestId,
  resolveRequestId,
  requestContextMiddleware,
  runWithContext,
  getContext,
  getRequestId,
  getActor,
  actorFingerprint,
  setActor,
};
