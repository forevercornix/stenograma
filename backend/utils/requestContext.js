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
 * Saugom ne raktą, o jo pseudonimą: audito įrašai gyvena ilgiau nei raktas, ir
 * paslapties kopijavimas į juos būtų tas pats, kas jos logginimas.
 *
 * KODĖL scrypt, o ne HMAC.
 *
 * `API_KEY` šiame projekte nustatomas ranka `.env` faile, tad realiai gali būti
 * mažos entropijos (`slaptas123`). Greitas atspaudas audito žurnale tokiu atveju
 * brute-force'inamas: užpuolikas, gavęs žurnalą, atkurtų patį raktą.
 *
 * Pirmas bandymas buvo HMAC su druska - jis uždaro ataką tik tol, kol druska
 * lieka paslaptyje. Bet `AUDIT_ID_SALT` gyvena tame pačiame `.env` faile, kaip
 * ir raktas: kas gavo vieną, greičiausiai turi ir kitą. scrypt apsaugo net
 * TURINT druską, nes brangus yra pats skaičiavimas.
 *
 * KAINA - nulinė karštame kelyje. Raktas yra KONSTANTA, tad atspaudas
 * apskaičiuojamas VIENĄ kartą ir kešuojamas. Ankstesnis argumentas „KDF pridėtų
 * kainą kiekvienai užklausai" buvo klaidingas: jis galiotų tik tuo atveju, jei
 * kiekviena užklausa atsineštų SKIRTINGĄ slaptažodį.
 */
const N = 1 << 14; // ~16 MB, ~50-100 ms - sumokama kartą per procesą
const _fingerprintCache = new Map();

function actorFingerprint(apiKey, env = process.env) {
  if (typeof apiKey !== "string" || apiKey.length === 0) return null;

  const salt = env.AUDIT_ID_SALT || _processSalt();
  const cacheKey = `${salt}\u0000${apiKey}`;

  const cached = _fingerprintCache.get(cacheKey);
  if (cached) return cached;

  const derived = crypto.scryptSync(apiKey, salt, 32, { N, r: 8, p: 1 }).toString("hex");
  const fingerprint = `key_${derived.slice(0, 12)}`;

  // Raktų yra vienetai (bendras API_KEY), tad kešas nekontroliuojamai neauga.
  // Riba vis tiek yra - kad testai ar klaidingas naudojimas neužpildytų atminties.
  if (_fingerprintCache.size < 100) _fingerprintCache.set(cacheKey, fingerprint);

  return fingerprint;
}

/**
 * Atsitiktinė proceso druska, kai `AUDIT_ID_SALT` nenustatytas.
 *
 * Kaina: po restarto atspaudai pasikeičia, tad ilgaamžis to paties rakto
 * sekimas nutrūksta. Tai sąmoningas kompromisas - be druskos atspaudas būtų
 * lengviau atkuriamas, o tai blogiau nei prarasta koreliacija tarp paleidimų.
 */
let _salt = null;
function _processSalt() {
  if (!_salt) _salt = crypto.randomBytes(32).toString("hex");
  return _salt;
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
