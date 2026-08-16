const crypto = require("crypto");

/**
 * KREDENCIALŲ SAUGYKLA (#18 PR1).
 *
 * Pilotui pakanka minimalaus modelio: vartotojai konfigūruojami per aplinkos
 * kintamuosius, ne per registracijos srautą. Tai sąžiningas MVP apribojimas,
 * ne praleidimas – jį reikia dokumentuoti, ne apsimesti, kad yra daugiau.
 *
 * FORMATAS: `AUTH_USERS` – kableliais atskirtas sąrašas
 * `vardas:rolė:scrypt$N$r$p$saltHex$hashHex:userId` (TIKSLIAI 4 laukai).
 * Slaptažodžio maiša generuojama atskiru skriptu (žr. `scripts/hash-password.js`),
 * niekada nelaikoma tekstu.
 *
 * `userId` (#158) yra STABILUS tapatybės raktas: vardas gali pasikeisti, ID – ne.
 * Juo remiasi job aktoriaus sprendimas (`utils/jobAuthorization.js`), todėl
 * pervadinimas nebenutraukia eilėje laukiančių darbų.
 *
 * KODĖL scrypt: šis projektas jau naudoja `crypto.scryptSync` API rakto
 * pseudonimizavimui (`utils/requestContext.js`). Ta pati priklausomybių
 * mažinimo logika galioja ir čia – papildomos bibliotekos (bcrypt, argon2)
 * nereikia, kai Node built-in API jau tinka.
 *
 * ROLĖS šiame PR yra TIK duomenų laukas – jos NĖRA vykdomos (tai #18 PR2
 * darbas). Čia jos saugomos ir grąžinamos, kad PR2 turėtų ant ko statyti, o
 * PR1 apimtis liktų aiški: „kas yra vartotojas", ne „ką jam leidžiama".
 */

const SCRYPT_N = 1 << 14; // ~16 MB, ~50-100 ms - tas pats parametrų rinkinys kaip actorFingerprint
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

/** Druskos ir maišos formos apribojimai - abu generuojami mūsų pačių, tad forma žinoma tiksliai. */
const SALT_HEX_PATTERN = /^[0-9a-f]{32}$/; // crypto.randomBytes(16).toString("hex")
const HASH_HEX_PATTERN = /^[0-9a-f]{128}$/; // KEY_LEN=64 baitai = 128 hex simboliai

/** Vardo formos apribojimas – jis patenka į logus ir auditą. */
const USERNAME_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;

/**
 * UUIDv4 – stabilaus `userId` forma (#158).
 *
 * Tikrinama VERSIJA (`4`) ir variantas (`[89ab]`), ne vien 36 simbolių forma:
 * ID generuojame su `crypto.randomUUID()`, tad ranka sugalvota teisingo ilgio
 * eilutė neturi tyliai praeiti kaip tapatybė.
 */
const USER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * BET KURIOS versijos UUID forma – naudojama TIK vardui atmesti (#158).
 *
 * Sąmoningai platesnis už `USER_ID_PATTERN`: `userId` turi būti griežtai v4,
 * bet vardo draudimas yra defense-in-depth, ir UUIDv1 ar v7 formos vardas
 * loguose bei audite klaidintų lygiai taip pat. Naudojant v4 šabloną abiem
 * tikslams, draudimas tyliai apimtų tik vieną versiją.
 */
const UUID_LIKE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KNOWN_ROLES = ["administrator", "operator"];

class CredentialConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "CredentialConfigError";
  }
}

/**
 * Sugeneruoja scrypt maišą duotam slaptažodžiui.
 *
 * Naudojama TIK `scripts/hash-password.mjs` skriptu, rankiniam vartotojo
 * kūrimui – nebe HTTP kelyje, tad čia kaina nereikšminga.
 */
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }).toString("hex");
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${derived}`;
}

/**
 * Pilnai išparsina ir PATVIRTINA scrypt maišos formatą - be jokio kvietimo
 * į `crypto.scryptSync`.
 *
 * KODĖL GRIEŽTAS TIKRINIMAS, NE VIEN `Number.isInteger`.
 *
 * Ankstesnė versija tikrindavo tik, kad N/r/p yra sveiki skaičiai. Bet
 * `scrypt$999999999$999999$1$...` IRGI yra sveiki skaičiai - ir toks įrašas
 * praeidavo startup validaciją, o `crypto.scryptSync` login metu mesdavo
 * neišgautą `RangeError: Invalid scrypt params` (patikrinta: 7 ms, tad ne CPU
 * išeikvojimas per se, bet betarpiškas 500 vietoj 401).
 *
 * Sprendimas: kadangi maišą generuoja TIK mūsų pačių `hashPassword()`, N/r/p
 * visada yra TIKSLIAI `SCRYPT_N/R/P`, druska - TIKSLIAI 32 hex simboliai
 * (`randomBytes(16)`), o maiša - TIKSLIAI 128 hex simbolių (`KEY_LEN=64`).
 * Bet kokia kita reikšmė reiškia sugadintą arba rankomis suklastotą įrašą, ir
 * jai užtenka grąžinti \`null\` - PRIEŠ pasiekiant \`scryptSync\`.
 */
function parseStoredHash(storedHash) {
  const parts = String(storedHash || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;

  const [, nStr, rStr, pStr, salt, hashHex] = parts;

  if (Number(nStr) !== SCRYPT_N) return null;
  if (Number(rStr) !== SCRYPT_R) return null;
  if (Number(pStr) !== SCRYPT_P) return null;
  if (!SALT_HEX_PATTERN.test(salt)) return null;
  if (!HASH_HEX_PATTERN.test(hashHex)) return null;

  return { salt, expected: Buffer.from(hashHex, "hex") };
}

/**
 * Palygina slaptažodį su maiša PASTOVIU LAIKU.
 *
 * `crypto.timingSafeEqual` reikalauja vienodo ilgio buferių – jei slaptažodis
 * neteisingas, apskaičiuojame naują maišą su TA PAČIA druska, kad ilgis
 * sutaptų, o laikas nesiskirtų priklausomai nuo to, kur tiksliai baitai
 * nesutampa.
 *
 * `try/catch` aplink `scryptSync` paliktas kaip GYNYBOS SLUOKSNIS, ne kaip
 * pirminė apsauga: `parseStoredHash` jau atmeta viską, kas nėra tiksliai mūsų
 * formatas, tad iki `scryptSync` turėtų pasiekti tik validūs parametrai. Bet
 * dvi nepriklausomos apsaugos yra pigiau nei viena, kuri kada nors gali būti
 * apeita pakeitus \`hashPassword\`.
 */
function verifyPassword(password, storedHash) {
  const parsed = parseStoredHash(storedHash);
  if (!parsed) return false;

  try {
    const actual = crypto.scryptSync(password, parsed.salt, parsed.expected.length, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });
    return crypto.timingSafeEqual(actual, parsed.expected);
  } catch {
    return false;
  }
}

/**
 * Parsina VIENĄ `AUTH_USERS` įrašą.
 *
 * Klaidos ČIA yra STARTUP klaidos, ne runtime – blogai suformuotas įrašas
 * turi sustabdyti serverį, o ne tyliai praleisti vartotoją ar leisti prisijungti
 * su nesuprastu rolės lauku.
 */
function parseUserEntry(raw, index) {
  /**
   * TIKSLIAI 4 LAUKAI (#158).
   *
   * Anksčiau maiša buvo renkama GODŽIAI (`hashParts.join(":")`) – atsarga tam
   * atvejui, jei maišoje atsirastų dvitaškis. Realiai scrypt serializacija yra
   * `scrypt$N$r$p$saltHex$hashHex` ir dvitaškių NENAUDOJA, o `parseStoredHash()`
   * tai griežtai validuoja.
   *
   * Godumas dabar tik kenktų: ketvirtas laukas (`userId`) būtų tyliai
   * priklijuotas prie maišos, o klaida pasirodytų kaip klaidinantis
   * „netinkamas scrypt formatas". Griežtą kontraktą saugo testas
   * „maiša su dvitaškiu → klaida" – jis egzistuoja būtent tam, kad ateityje
   * kas nors negrąžintų godaus parserio patogumo sumetimais.
   */
  const parts = raw.split(":");
  if (parts.length !== 4) {
    throw new CredentialConfigError(
      `AUTH_USERS įrašas #${index + 1} netinkamas: laukiama ` +
        `"vardas:rolė:maiša:userId" (4 laukai), gauta ${parts.length}.`
    );
  }

  const [username, role, passwordHash, userId] = parts;

  if (!USERNAME_PATTERN.test(username)) {
    throw new CredentialConfigError(
      `AUTH_USERS įrašas #${index + 1}: vardas "${username}" netinkamas (mažosios raidės, skaitmenys, _ -, 2-64 simboliai).`
    );
  }
  /**
   * UUID FORMOS VARDAS DRAUDŽIAMAS (defense-in-depth, #158).
   *
   * Maršrutizavimas nuo formos NEpriklauso – jį lemia job `schemaVersion`.
   * Bet `USERNAME_PATTERN` UUID formos vardą įleidžia
   * (`a1b2c3d4-e29b-41d4-a716-446655440000` prasideda raide, turi tik
   * [a-z0-9-], 36 simboliai), o vardas, neatskiriamas nuo ID, yra spąstai
   * bet kuriam būsimam kodui ir logų skaitytojui.
   *
   * Tikrinama `UUID_LIKE_PATTERN` (bet kuri versija), NE `USER_ID_PATTERN`
   * (griežtai v4): draudimas turi apimti visas UUID formas, net tas, kurių
   * `userId` lauke nepriimtume.
   */
  if (UUID_LIKE_PATTERN.test(username)) {
    throw new CredentialConfigError(
      `AUTH_USERS įrašas #${index + 1}: vardas negali būti UUID formos ` +
        "(neatskiriamas nuo userId loguose ir audite)."
    );
  }
  if (!KNOWN_ROLES.includes(role)) {
    throw new CredentialConfigError(
      `AUTH_USERS įrašas #${index + 1}: rolė "${role}" nežinoma. Galimos: ${KNOWN_ROLES.join(", ")}.`
    );
  }
  if (!USER_ID_PATTERN.test(userId)) {
    throw new CredentialConfigError(
      `AUTH_USERS įrašas #${index + 1} (vartotojas "${username}"): userId turi būti UUIDv4. ` +
        "Sugeneruokite su scripts/hash-password.js, ne rankiniu tekstu."
    );
  }
  /**
   * PILNAS formos tikrinimas startup metu - tas pats `parseStoredHash`, kurį
   * naudoja `verifyPassword`. Vien `startsWith("scrypt$")` praleisdavo
   * `scrypt$999999999$999999$1$aa$bb` - tokia reikšmė praeidavo startą, o
   * login metu `crypto.scryptSync` mesdavo neišgautą `RangeError`.
   *
   * Tikrinant čia TUO PAČIU metodu, kuris naudojamas runtime, negalima
   * atsirasti neatitikimo tarp "ką startup patvirtino" ir "ką login realiai
   * priima".
   */
  if (!parseStoredHash(passwordHash)) {
    throw new CredentialConfigError(
      `AUTH_USERS įrašas #${index + 1} (vartotojas "${username}"): maiša neatitinka scrypt formato ` +
        `(N=${SCRYPT_N}, r=${SCRYPT_R}, p=${SCRYPT_P}, 32 hex simbolių druska, 128 hex simbolių maiša). ` +
        "Sugeneruokite ją su scripts/hash-password.js, ne rankiniu tekstu."
    );
  }

  return { username, role, passwordHash, userId };
}

/**
 * Nuskaito ir patikrina visą `AUTH_USERS` konfigūraciją.
 *
 * @throws {CredentialConfigError} jei bet kuris įrašas blogai suformuotas,
 *   arba jei du vartotojai turi tą patį vardą (paskutinis tyliai laimėtų).
 */
function loadUsers(env = process.env) {
  const raw = (env.AUTH_USERS || "").trim();
  if (!raw) return new Map();

  const entries = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const users = new Map();
  const seenIds = new Set();

  entries.forEach((entry, index) => {
    const user = parseUserEntry(entry, index);
    if (users.has(user.username)) {
      throw new CredentialConfigError(`AUTH_USERS: vartotojas "${user.username}" nurodytas daugiau nei kartą.`);
    }
    /**
     * DUBLIUOTAS `userId` yra pavojingesnis už dubliuotą vardą: du vardai su
     * tuo pačiu ID reikštų, kad job nuosavybė ir audito įrašai nurodo į dvi
     * skirtingas paskyras, o `loadUsersById()` tyliai grąžintų paskutinę.
     */
    if (seenIds.has(user.userId)) {
      throw new CredentialConfigError(`AUTH_USERS: userId "${user.userId}" nurodytas daugiau nei kartą.`);
    }
    seenIds.add(user.userId);
    users.set(user.username, user);
  });

  return users;
}

/**
 * Tas pats sąrašas, indeksuotas pagal `userId` (#158).
 *
 * ATSKIRA funkcija, o ne `loadUsers()` grąžinimo tipo pakeitimas: `loadUsers()`
 * naudoja `verifyCredentials()`, `utils/jobAuthorization.js` ir
 * `utils/startupChecks.js` – kontrakto keitimas paliestų tris nesusijusius kelius.
 *
 * NAŠUMAS nesikeičia: `loadUsers()` kešo neturi ir jau dabar parsinamas
 * kiekvienos job autorizacijos metu (`jobAuthorization.js`). Ši funkcija tą
 * kvietimą PAKEIČIA, ne prideda. Kešas čia būtų atskiras darbas su savo
 * invalidacijos klausimu (`AUTH_USERS` keitimas be restarto).
 */
function loadUsersById(env = process.env) {
  const byId = new Map();
  for (const user of loadUsers(env).values()) byId.set(user.userId, user);
  return byId;
}

/**
 * Patikrina prisijungimo duomenis.
 *
 * @returns {{username: string, role: string} | null} `null` esant BET KOKIAI
 *   nesėkmei – neteisingam vardui, neteisingam slaptažodžiui ar tuščiai
 *   saugyklai. Klientui šie atvejai NESISKIRIA (žr. routes/auth.js): kitaip
 *   atsakymas nutekintų, ar vartotojo vardas egzistuoja.
 */
function verifyCredentials(username, password, env = process.env) {
  const users = loadUsers(env);
  /**
   * Ta PATI normalizacija kaip `middleware/rateLimiter.js
   * canonicalUsername()` - trim() IR toLowerCase(), ne vien pastarasis.
   *
   * Be trim(): "admin" ir "admin " būtų traktuojami kaip skirtingi rate-limit
   * raktai (žr. rateLimiter.js), bet ČIA sutaptų su tuo pačiu vartotoju - t. y.
   * paieška ir limito raktas matytų skirtingą tapatybę tam pačiam bandymui.
   */
  const user = users.get(String(username || "").trim().toLowerCase());

  /**
   * NEEGZISTUOJANČIAM vartotojui vis tiek atliekamas scrypt skaičiavimas su
   * fiksuota atrama maiša – kitaip atsako laikas išduotų, ar vartotojo vardas
   * egzistuoja (laiko atakos kanalas prieš vartotojų sąrašo išvardijimą).
   */
  /**
   * ATRAMA (decoy) turi būti TIKSLIAI TOKIO PAT FORMATO kaip tikra maiša -
   * 32 hex simbolių druska, 128 hex simbolių maiša.
   *
   * Griežtinant `verifyPassword` (žr. `parseStoredHash`) paaiškėjo, kad
   * senoji atrama (64 nulinių simbolių druska, dviženklė "maiša") NEBEATITIKO
   * naujo tikrinimo - tad ji buvo atmetama DAR PRIEŠ `scryptSync`, ir laiko
   * atakos apsauga tyliai dingo: nežinomam vartotojui skaičiavimas apskritai
   * nebevykdavo.
   */
  const DECOY_HASH =
    "scrypt$16384$8$1$00112233445566778899aabbccddeeff$" + "0".repeat(128);
  const hashToCheck = user ? user.passwordHash : DECOY_HASH;
  const valid = verifyPassword(password, hashToCheck);

  if (!user || !valid) return null;
  /**
   * `id` PIRMAS laukas – jis, o ne vardas, yra tapatybė (#158). Vardas lieka
   * grąžinamas, nes jį naudoja auditas, logai ir sesijos cookie srautas.
   */
  return { id: user.userId, username: user.username, role: user.role };
}

module.exports = {
  hashPassword,
  verifyPassword,
  verifyCredentials,
  loadUsers,
  loadUsersById,
  CredentialConfigError,
  USERNAME_PATTERN,
  USER_ID_PATTERN,
  UUID_LIKE_PATTERN,
  KNOWN_ROLES,
};
