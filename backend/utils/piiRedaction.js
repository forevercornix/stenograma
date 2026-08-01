/**
 * PII REDAKCIJA (GDPR issue #4).
 *
 * APRĖPTIS - SĄMONINGAI SIAURA. Redaguojami tik IDENTIFIKATORIAI: asmens kodai,
 * el. paštas, telefonai, IBAN. Vardai NELIEČIAMI.
 *
 * Kodėl vardai paliekami: susitikimo protokole dalyviai ir atsakingi asmenys yra
 * pats dokumento turinys. „Dalyvis A įsipareigojo iki kovo 1 d." nėra protokolas.
 * GDPR prasme vardas posėdžio protokole apdorojamas teisėtu pagrindu; pavojingas
 * yra jo SUJUNGIMAS su asmens kodu, telefonu ar sąskaita - būtent tą jungtį šis
 * komponentas ir nutraukia.
 *
 * Tai reiškia, kad redaguota transkripcija NĖRA anonimizuota GDPR 26 konstatuojamosios
 * dalies prasme - ji yra PSEUDONIMIZUOTA tik dalinai. Žr. „Žinomi apribojimai"
 * README ir `LIMITATIONS` žemiau.
 *
 * Kontraktas paprastas sąmoningai: `redact(text)` grąžina eilutę. Turtingesnę
 * informaciją (statistika, artefakto metaduomenys) duoda `redactDetailed()` ir
 * `utils/redactedArtefact.js`.
 */

const POLICY_VERSION = "pii-v1";

const ALL_CATEGORIES = ["PERSONAL_CODE", "EMAIL", "PHONE", "IBAN"];

/**
 * KONFIGŪRUOJAMA ELGSENA (#4: „Make redaction behaviour configurable").
 *
 * VIENAS validatorius env ir programinei sąsajai. Anksčiau `options.categories`
 * buvo naudojamas tiesiogiai, apeidamas patikrą - `redact(text, { categories:
 * ["PERSNAL_CODE"] })` tyliai išjungdavo visą redakciją. Konfigūracijos klaida,
 * kurios rezultatas yra „neredaguoti nieko", negali būti tyli.
 */
function normalizeCategories(value, source = "PII_REDACTION_CATEGORIES") {
  const items = (Array.isArray(value) ? value : String(value ?? "").split(","))
    .map((item) => String(item).trim().toUpperCase())
    .filter(Boolean);

  const unknown = items.filter((item) => !ALL_CATEGORIES.includes(item));
  if (unknown.length > 0) {
    const error = new Error(
      `Nežinomos ${source} reikšmės: ${unknown.join(", ")}. ` +
        `Galimos: ${ALL_CATEGORIES.join(", ").toLowerCase()}.`
    );
    error.code = "PII_CATEGORIES_INVALID";
    throw error;
  }

  /**
   * TUŠČIAS efektyvus sąrašas atmetamas.
   *
   * `PII_REDACTION_CATEGORIES=","` arba `{ categories: [] }` po parsinimo duoda
   * `[]`. Tai praeidavo validaciją, artefaktas būdavo pažymimas `redacted`, o
   * realiai nebūdavo redaguota NIEKO - blogiausias įmanomas derinys: sistema
   * tvirtina, kad apsaugojo, o duomenys iškeliauja žali.
   *
   * Norint išjungti redakciją yra `REQUIRE_REDACTION_BEFORE_EXTERNAL=false`,
   * kuris tai pasako garsiai.
   */
  if (items.length === 0) {
    const error = new Error(
      `${source} negali būti tuščias sąrašas - tai reikštų "pažymėta kaip redaguota, bet neredaguota nieko". ` +
        "Redakcijai išjungti naudokite REQUIRE_REDACTION_BEFORE_EXTERNAL=false."
    );
    error.code = "PII_CATEGORIES_INVALID";
    throw error;
  }

  // Dublikatai nekenkia (Set), tad tyliai deduplikuojam.
  return [...new Set(items)];
}

/** Kategorijos iš aplinkos. Nenustatyta (arba tuščia eilutė) - visos. */
function resolveCategories(env = process.env) {
  const raw = (env.PII_REDACTION_CATEGORIES || "").trim();
  if (!raw) return [...ALL_CATEGORIES];

  return normalizeCategories(raw);
}

/** Placeholder'iai: ta pati kategorija - visada tas pats žymuo. */
const PLACEHOLDERS = {
  PERSONAL_CODE: "[ASMENS_KODAS]",
  EMAIL: "[EL_PAŠTAS]",
  PHONE: "[TELEFONAS]",
  IBAN: "[SĄSKAITA]",
};

/**
 * ŽINOMI APRIBOJIMAI (DoD: „Known limitations are documented").
 * Laikoma kode, o ne tik README, kad būtų matoma tiems, kas skaito komponentą.
 */
const LIMITATIONS = [
  "Vardai ir pavardės NEREDAGUOJAMI (sąmoningas pasirinkimas - žr. modulio komentarą).",
  "Adresai NEAPTINKAMI: lietuviški adresai transkripcijoje rašomi laisva forma " +
    "(Gedimino trisdesimt du, prie senosios mokyklos), tad patikimo šablono nėra. " +
    "Bandymas spėti duotų arba daug praleidimų, arba sugadintą tekstą.",
  "Transkripcija yra ŠNEKA: asmens kodas gali būti padiktuotas žodžiais " +
    "(trys devyni nulis nulis...) arba su tarpais tarp skaitmenų grupių. " +
    "Aptinkamos tik skaitmeninės formos.",
  "Gimimo datos, pareigos, darbovietės ir kiti netiesioginiai identifikatoriai " +
    "neredaguojami - sujungti su vardu jie vis tiek gali identifikuoti asmenį.",
  "Rezultatas yra dalinai pseudonimizuotas, NE anonimizuotas.",
];

/**
 * LIETUVIŠKAS ASMENS KODAS: GYYMMDDNNNK (11 skaitmenų).
 *
 * Vien „11 skaitmenų" būtų per plati taisyklė - į ją patenka telefonų numeriai,
 * sumos ir dokumentų numeriai. Todėl tikrinama STRUKTŪRA: lyties/amžiaus skaitmuo,
 * galiojanti data ir kontrolinė suma. Tai smarkiai sumažina klaidingus teigiamus.
 */
/**
 * Riba tik pagal SKAITMENIS, ne pagal brūkšnelius.
 *
 * Pirmoji versija turėjo `(?<![\d-])`, tad `AK-39001010000` ir
 * `asmens-kodas-39001010000` praeidavo neredaguoti - realus PII praleidimas.
 * Brūkšnelio draudimas buvo perteklinis: nuo klaidingai teigiamų jau saugo
 * kontrolinė suma, datos patikra ir lyties skaitmuo, o jie daug stipresni.
 */
const PERSONAL_CODE_CANDIDATE = /(?<!\d)(\d{11})(?!\d)/g;

function isValidPersonalCode(code) {
  if (!/^\d{11}$/.test(code)) return false;

  const century = Number(code[0]);
  if (century < 1 || century > 6) return false;

  const year = Number(code.slice(1, 3));
  const month = Number(code.slice(3, 5));
  const day = Number(code.slice(5, 7));
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;

  // Data turi realiai egzistuoti (02-30 neegzistuoja).
  const fullYear = 1800 + Math.floor((century - 1) / 2) * 100 + year;
  const date = new Date(Date.UTC(fullYear, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false;

  return _personalCodeChecksum(code) === Number(code[10]);
}

function _personalCodeChecksum(code) {
  const digits = code.slice(0, 10).split("").map(Number);

  const weighted = (weights) => digits.reduce((sum, d, i) => sum + d * weights[i], 0) % 11;

  let checksum = weighted([1, 2, 3, 4, 5, 6, 7, 8, 9, 1]);
  if (checksum === 10) checksum = weighted([3, 4, 5, 6, 7, 8, 9, 1, 2, 3]);

  return checksum === 10 ? 0 : checksum;
}

/** El. paštas. Sąmoningai konservatyvu - geriau praleisti egzotiką nei gaudyti tekstą. */
const EMAIL = /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+(?![\w-])/g;

/**
 * TELEFONAI - kandidatas + validacija, kaip ir asmens kodo atveju.
 *
 * Vienas platus regex čia neveikia: lietuviški numeriai rašomi bent penkiais
 * pavidalais (`+37060012345`, `+370 600 12345`, `860012345`, `8 600 12345`,
 * `(8-5) 212 3456`), o griežtas šablonas praleidžia, platus - gaudo sumas ir
 * datas. Todėl pirma paimam bet kokią skaitmenų+skirtukų seką, tada tikrinam.
 */
const PHONE_CANDIDATE = /(?<![\w])(\(?\+?\d[\d\s()-]{6,18}\d\)?)(?![\w])/g;

function _looksLikePhone(raw) {
  const digits = raw.replace(/\D/g, "");

  // Trumpiau nei 8 skaitmenys - tai ne numeris, o suma, metai ar punktas.
  if (digits.length < 8 || digits.length > 15) return false;

  const normalized = raw.trim().replace(/^\(/, "");

  // Tarptautinis `+` - patikimiausias ženklas.
  if (normalized.startsWith("+")) return true;

  /**
   * Be `+` reikalavimai griežtesni, nes kitaip į tinklą patenka sutarčių ir
   * dokumentų numeriai. Rasta realiai: `812345678` (sutartis), `876543210`
   * (sąskaitos dalis), `800000001` (dokumento ID) - visi buvo laikomi telefonais.
   *
   * Lietuviškas numeris po `8` turi operatoriaus arba srities kodą: 6 (mobilus),
   * 3/4/5 (Kaunas, Klaipėda, Vilnius ir kt.). `81…`, `87…`, `80…` tokių numerių
   * nėra, tad jie atmetami.
   */
  if (digits.startsWith("8") && digits.length === 9) {
    return ["3", "4", "5", "6"].includes(digits[1]);
  }

  // `370…` be pliuso priimamas tik TIKSLIU ilgiu (370 + 8 skaitmenys).
  // Bet kokio ilgio seka nuo 370 kitaip apimtų registracijos numerius.
  if (digits.startsWith("370") && digits.length === 11) return true;

  return false;
}

/** IBAN: šalies kodas + 2 kontroliniai + 11-30 raidžių/skaitmenų. */
const IBAN = /(?<![A-Z0-9])[A-Z]{2}\d{2}[A-Z0-9]{11,30}(?![A-Z0-9])/g;

/**
 * Redaguoja tekstą ir grąžina detalę.
 *
 * `stats` turi TIK skaičius, niekada aptiktų reikšmių - jis keliauja į auditą ir
 * logus (DoD: „logs record redaction status without recording detected PII values").
 *
 * @returns {{text: string, stats: Record<string, number>, policyVersion: string}}
 */
/**
 * Efektyvios kategorijos. Politika yra pirminis šaltinis; tiesioginis env
 * skaitymas lieka tik atsarginiu keliu (pvz. komponentą naudojant atskirai,
 * be serverio konteksto).
 */
function _activeCategories() {
  let policy;
  try {
    policy = require("./privacyPolicy").getPrivacyPolicy();
  } catch (e) {
    // TIK „politikos dar nėra" (atskiras skriptas, unit testas) pateisina env
    // skaitymą. Bet kokia kita klaida reiškia sulūžusią politiką, ir ją reikia
    // matyti - platus catch-all būtų tyliai pakeitęs validuotą šaltinį.
    if (e && e.code === "PRIVACY_POLICY_INVALID") throw e;
    return resolveCategories();
  }

  if (Array.isArray(policy.redactionCategories) && policy.redactionCategories.length > 0) {
    return policy.redactionCategories;
  }
  return resolveCategories();
}

function redactDetailed(input, options = {}) {
  const original = typeof input === "string" ? input : String(input ?? "");
  const stats = {};

  // Kategorijos imamos iš UŽŠALDYTOS politikos, ne iš process.env kiekvieną
  // kartą - kitaip du komponentai galėtų matyti skirtingą elgseną tame pačiame
  // procese (žr. utils/privacyPolicy.js).
  const active = new Set(
    options.categories ? normalizeCategories(options.categories, "categories") : _activeCategories()
  );
  const enabled = (category) => active.has(category);

  const count = (key) => {
    stats[key] = (stats[key] || 0) + 1;
  };

  let text = original;

  // Tvarka svarbi: IBAN ir el. paštas gali turėti skaitmenų sekas, kurias
  // telefono šablonas kitaip nukirstų viduryje.
  if (enabled("IBAN")) text = text.replace(IBAN, (match) => {
    count("IBAN");
    return PLACEHOLDERS.IBAN;
  });

  if (enabled("EMAIL")) text = text.replace(EMAIL, () => {
    count("EMAIL");
    return PLACEHOLDERS.EMAIL;
  });

  if (enabled("PERSONAL_CODE")) text = text.replace(PERSONAL_CODE_CANDIDATE, (match) => {
    if (!isValidPersonalCode(match)) return match;
    count("PERSONAL_CODE");
    return PLACEHOLDERS.PERSONAL_CODE;
  });

  if (enabled("PHONE")) text = text.replace(PHONE_CANDIDATE, (match) => {
    if (!_looksLikePhone(match)) return match;
    count("PHONE");
    return PLACEHOLDERS.PHONE;
  });

  return { text, stats, policyVersion: POLICY_VERSION };
}

/**
 * Pagrindinis kontraktas (jį tikrina `utils/redactionComponent.js`).
 * @param {string} text
 * @returns {string}
 */
function redact(text, options = {}) {
  return redactDetailed(text, options).text;
}

/**
 * Redaguoja transkripcijos segmentus IŠSAUGANT struktūrą.
 *
 * Kalbėtojo etiketė, `start` ir `end` NELIEČIAMI - redaguojamas tik `text`.
 * Priešingu atveju dingtų būtent tai, kas protokolui reikalinga (kas ir kada
 * kalbėjo), o liktų tik tai, kas jam nereikalinga.
 */
function redactSegments(segments, options = {}) {
  if (!Array.isArray(segments)) return { segments, stats: {} };

  // Kategorijos nustatomos VIENĄ kartą visam masyvui - kitaip kiekvienas
  // segmentas iš naujo skaitytų env ir galėtų gauti skirtingą politiką.
  const categories = options.categories
    ? normalizeCategories(options.categories, "categories")
    : _activeCategories();
  const stats = {};
  const redacted = segments.map((segment) => {
    if (!segment || typeof segment.text !== "string") return segment;

    const result = redactDetailed(segment.text, { categories });
    for (const [key, value] of Object.entries(result.stats)) {
      stats[key] = (stats[key] || 0) + value;
    }

    return { ...segment, text: result.text };
  });

  return { segments: redacted, stats };
}

module.exports = {
  redact,
  redactDetailed,
  redactSegments,
  isValidPersonalCode,
  resolveCategories,
  normalizeCategories,
  ALL_CATEGORIES,
  POLICY_VERSION,
  PLACEHOLDERS,
  LIMITATIONS,
};
