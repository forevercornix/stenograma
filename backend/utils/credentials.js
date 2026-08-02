const crypto = require("crypto");

/**
 * KREDENCIALŲ SAUGYKLA (#18 PR1).
 *
 * Pilotui pakanka minimalaus modelio: vartotojai konfigūruojami per aplinkos
 * kintamuosius, ne per registracijos srautą. Tai sąžiningas MVP apribojimas,
 * ne praleidimas – jį reikia dokumentuoti, ne apsimesti, kad yra daugiau.
 *
 * FORMATAS: `AUTH_USERS` – kableliais atskirtas sąrašas
 * `vardas:rolė:scrypt$N$r$p$saltHex$hashHex`. Slaptažodžio maiša generuojama
 * atskiru skriptu (žr. `scripts/hash-password.mjs`), niekada nelaikoma tekstu.
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
  const parts = raw.split(":");
  if (parts.length < 3) {
    throw new CredentialConfigError(
      `AUTH_USERS įrašas #${index + 1} netinkamas: laukiama "vardas:rolė:maiša", gauta "${raw}".`
    );
  }

  const [username, role, ...hashParts] = parts;
  const passwordHash = hashParts.join(":");

  if (!USERNAME_PATTERN.test(username)) {
    throw new CredentialConfigError(
      `AUTH_USERS įrašas #${index + 1}: vardas "${username}" netinkamas (mažosios raidės, skaitmenys, _ -, 2-64 simboliai).`
    );
  }
  if (!KNOWN_ROLES.includes(role)) {
    throw new CredentialConfigError(
      `AUTH_USERS įrašas #${index + 1}: rolė "${role}" nežinoma. Galimos: ${KNOWN_ROLES.join(", ")}.`
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

  return { username, role, passwordHash };
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

  entries.forEach((entry, index) => {
    const user = parseUserEntry(entry, index);
    if (users.has(user.username)) {
      throw new CredentialConfigError(`AUTH_USERS: vartotojas "${user.username}" nurodytas daugiau nei kartą.`);
    }
    users.set(user.username, user);
  });

  return users;
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
  return { username: user.username, role: user.role };
}

module.exports = {
  hashPassword,
  verifyPassword,
  verifyCredentials,
  loadUsers,
  CredentialConfigError,
  USERNAME_PATTERN,
  KNOWN_ROLES,
};
