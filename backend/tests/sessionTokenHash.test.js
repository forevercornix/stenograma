const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const {
  SESSION_TOKEN_BYTES,
  generateSessionToken,
  hashSessionToken,
} = require("../utils/sessionStore/tokens");
const {
  palaikomaSchemaVersija,
  PALAIKOMOS_SCHEMA_VERSIJOS,
  SESSION_SCHEMA_VERSION,
} = require("../utils/sessionStore/common");
const sessionStore = require("../utils/sessionStore");

/**
 * BEARER TOKEN'AS, JO MAIŠA IR EILUTĖS FORMATAS (#155, 7.3).
 *
 * ⚠️ KODĖL ČIA NĖRA `touch()` MATAVIMO.
 *
 * `touch()` apima PostgreSQL round-trip, tad bet kokia laiko riba būtų flaky
 * CI aplinkoje ir kristų prie TEISINGOS realizacijos. Matuojamas TIK izoliuotas
 * hash helperis, kur skirtumas tarp SHA-256 ir KDF yra keturios eilės, o ne
 * matavimo triukšmas.
 *
 * ⚠️ KODĖL ČIA NĖRA ŠALTINIO TEKSTO PAIEŠKOS („ar nėra `scrypt`").
 *
 * Trys žemiau esantys testai tikrina ELGESĮ, ir jų neapeis nė viena lėta ar
 * nedeterministinė realizacija. Statinė paieška (AGENTS.md §9.2) įrodytų tik
 * tai, kad eilutė egzistuoja.
 */

test("TOKEN HASH: determinizmas - tas pats token'as visada duoda tą pačią maišą", () => {
  /**
   * ⚠️ ŠIS TESTAS VIENAS JAU ATMETA `bcrypt`, `argon2` IR ĮPRASTĄ `scrypt`:
   * jie naudoja atsitiktinę druską, tad tos pačios įvesties rezultatas
   * skiriasi kaskart. Lieka pridengti tik fiksuotos druskos atvejį - tai daro
   * formato ir greičio testai.
   */
  const token = generateSessionToken();

  assert.equal(hashSessionToken(token), hashSessionToken(token));
  assert.notEqual(
    hashSessionToken(token),
    hashSessionToken(generateSessionToken()),
    "skirtingi token'ai negali duoti tos pačios maišos"
  );
});

test("TOKEN HASH: formatas yra 64 simbolių lowercase hex (SHA-256 išvestis)", () => {
  /**
   * `crypto.scryptSync` su projekto parametrais (`KEY_LEN = 64`) duotų 128 hex
   * simbolių - t. y. kitokį ilgį. Formatas čia yra ne stilius, o algoritmo
   * pirštų atspaudas.
   */
  const maisa = hashSessionToken(generateSessionToken());

  assert.match(maisa, /^[0-9a-f]{64}$/, "privalo būti 64 lowercase hex simboliai");
  assert.equal(maisa, maisa.toLowerCase());
});

test("TOKEN HASH: 1000 skaičiavimų trunka < 100 ms (lėtas KDF būtų DoS)", () => {
  /**
   * ⚠️ RIBA PARINKTA SU ~1000× ATSARGA SĄMONINGAI.
   *
   * SHA-256 tai atlieka per kelias milisekundes. `scrypt` su projekto
   * `SCRYPT_N = 1 << 14` (`utils/credentials.js`) - apie 50-100 SEKUNDŽIŲ, nes
   * vienas skaičiavimas kainuoja 50-100 ms. Kadangi `touch()` kviečiamas
   * KIEKVIENAI autentifikuotai užklausai, KDF čia išsemtų Node thread pool iš
   * karto.
   *
   * Tokia atsarga reiškia, kad testas neflakina lėtoje CI mašinoje, bet vis
   * tiek krinta bet kuriai KDF realizacijai - riba yra tarp dviejų eilių, ne
   * ties matavimo triukšmu.
   */
  const token = generateSessionToken();

  const pradzia = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) hashSessionToken(token);
  const trukmeMs = Number(process.hrtime.bigint() - pradzia) / 1e6;

  assert.ok(trukmeMs < 100, `1000 maišų truko ${trukmeMs.toFixed(1)} ms - laukta < 100 ms`);
});

test("TOKEN: entropija ≥ 256 bitų ir forma NĖRA uuid", () => {
  /**
   * ⚠️ RIZIKA NĖRA VIEN „ID TAPO TOKEN'U".
   *
   * Iki 7.3 bearer'is buvo `crypto.randomBytes(32)` - 256 bitų paslaptis.
   * Naujas `sessions.id` yra `uuid`: 122 bitai IR saugoma reikšmė. Todėl
   * tikrinama abu - ir entropijos apimtis, ir kad `uuid` formos token'as
   * nebūtų priimtas kaip pakaitalas.
   */
  const UUID_FORMA = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  assert.ok(SESSION_TOKEN_BYTES >= 32, "bearer token'as privalo turėti bent 256 bitus");

  const token = generateSessionToken();
  assert.ok(!UUID_FORMA.test(token), "uuid formos token'as atmetamas - jis būtų 122 bitai");
  assert.ok(
    Buffer.from(token, "base64url").length >= 32,
    "dekoduotas token'as privalo turėti bent 32 baitus atsitiktinumo"
  );

  /**
   * ⚠️ 200 SKIRTINGŲ REIKŠMIŲ ENTROPIJOS NEĮRODO.
   *
   * Ankstesnė šio tikrinimo versija tvirtino, kad unikalumas „atmestų fiksuotą
   * ar skaitiklinį generatorių". Skaitiklis, užkoduotas į 32 baitus, duotų
   * lygiai tokius pat 200 unikalių token'ų - teiginys buvo stipresnis už
   * įrodymą (AGENTS.md §12.1).
   *
   * Unikalumas lieka kaip pigus sargas nuo FIKSUOTOS reikšmės, o entropijos
   * ŠALTINIS tikrinamas ties riba: `generateSessionToken()` privalo kviesti
   * `crypto.randomBytes` ir prašyti ne mažiau kaip 32 baitų.
   */
  const aibė = new Set(Array.from({ length: 200 }, () => generateSessionToken()));
  assert.equal(aibė.size, 200, "fiksuota reikšmė ar per siauras šaltinis duotų dublikatų");

  /**
   * ⚠️ INTERCEPCIJA TIES RIBA, NE ŠALTINIO TEKSTO PAIEŠKA.
   *
   * `tokens.js` kviečia `crypto.randomBytes(...)` per modulio objektą, tad
   * pakeitus `crypto.randomBytes` kvietimas realiai perimamas. Skaitiklio ar
   * `Math.random()` realizacija čia nieko neužregistruotų ir testas kristų.
   */
  const cryptoModulis = require("crypto");
  const originalusRandomBytes = cryptoModulis.randomBytes;
  const prasytiBaitai = [];
  cryptoModulis.randomBytes = (n, ...likę) => {
    prasytiBaitai.push(n);
    return originalusRandomBytes(n, ...likę);
  };
  try {
    generateSessionToken();
  } finally {
    cryptoModulis.randomBytes = originalusRandomBytes;
  }

  assert.deepEqual(
    prasytiBaitai,
    [SESSION_TOKEN_BYTES],
    "token'as privalo ateiti iš VIENO crypto.randomBytes kvietimo"
  );
  assert.ok(prasytiBaitai[0] >= 32, "kriptografinis šaltinis privalo duoti bent 256 bitus");
});

test("TRYS REIKŠMĖS: cookie token'as NĖRA nei `session.id`, nei `token_hash`", async () => {
  /**
   * ⚠️ NEPAKANKA PARODYTI, KAD DB NĖRA PLIKOJO TOKEN'O.
   *
   * Realizacija, dedanti `token_hash` į cookie, praeitų hash-only kriterijų ir
   * paverstų DB turinį tiesiogiai panaudojama paslaptimi: nutekėjusi lentelė
   * duotų reikšmes, kurias galima siųsti kaip cookie.
   */
  await sessionStore._clearForTests();
  const { session, token } = await sessionStore.create({
    id: "33333333-3333-4333-8333-333333333333",
    username: "admin",
    role: "administrator",
  });

  assert.notEqual(token, session.id, "cookie reikšmė negali būti DB pirminis raktas");
  assert.notEqual(token, hashSessionToken(token), "cookie reikšmė negali būti maiša");
  assert.notEqual(session.id, hashSessionToken(token), "`id` ir `token_hash` yra skirtingos reikšmės");

  /** Visos trys reikšmės skiriasi viena nuo kitos. */
  assert.equal(new Set([token, session.id, hashSessionToken(token)]).size, 3);
  await sessionStore._clearForTests();
});

test("SCHEMA VERSIJA: palaikoma aibė UŽDARA - 0, -1 ir +1 atmetami", () => {
  /**
   * ⚠️ `v > PALAIKOMA` PRALEIDŽIA `0` IR `-1`.
   *
   * Realizacija su tokiu palyginimu praeitų testą, tikrinantį TIK
   * `PALAIKOMA + 1`. Todėl tikrinamos abi pusės ir dar kelios reikšmės už
   * aibės ribų.
   */
  assert.deepEqual(PALAIKOMOS_SCHEMA_VERSIJOS, [1], "sesijų palaikomų versijų aibė yra {1}");
  assert.equal(SESSION_SCHEMA_VERSION, 1);

  assert.ok(palaikomaSchemaVersija(1));
  for (const bloga of [0, -1, 2, 99, 1.5, NaN, Infinity, null, undefined, "", "abc", {}, []]) {
    assert.ok(!palaikomaSchemaVersija(bloga), `versija ${String(bloga)} turėjo būti atmesta`);
  }
});

test("SCHEMA VERSIJA: reikšmė NORMALIZUOJAMA - `1` ir `\"1\"` abi palaikomos", () => {
  /**
   * Draiveris ar atkūrimo kelias gali grąžinti eilutę. `Set.has("1")` yra
   * `false`, tad be eksplicitinės konversijos GALIOJANTI sesija būtų atmesta -
   * tylus prisijungimų praradimas, kurio niekas nesusietų su tipų skirtumu.
   */
  assert.ok(palaikomaSchemaVersija(1), "skaičius");
  assert.ok(palaikomaSchemaVersija("1"), "eilutė");
  assert.ok(palaikomaSchemaVersija(" 1 "), "eilutė su tarpais");
  assert.ok(!palaikomaSchemaVersija("2"), "nepalaikoma versija eilute lieka nepalaikoma");
  assert.ok(!palaikomaSchemaVersija("0"), "eilutė `0` negali praeiti");
});

test("SCHEMA VERSIJA: sesija su nepalaikoma versija NEAUTENTIFIKUOJA", async () => {
  /**
   * MUTACIJOS ĮRODYMAS: pašalinus `palaikomaSchemaVersija()` patikrą iš
   * `touch()`, ši sesija būtų autentifikuota, nors jos eilutės formato
   * nepažįstame.
   */
  await sessionStore._clearForTests();
  const { token } = await sessionStore.create({ username: "admin", role: "administrator" });

  assert.ok(await sessionStore.touch(token), "prielaida: šviežia sesija galioja");

  const irasas = sessionStore._getByTokenForTests(token);
  irasas.schemaVersion = SESSION_SCHEMA_VERSION + 1;

  assert.equal(await sessionStore.touch(token), null, "nežinomas formatas - fail-closed");
  await sessionStore._clearForTests();
});

test("SARGAS: `findByToken()` NEEGZISTUOJA nė viename sesijų kelyje", () => {
  /**
   * ⚠️ DRAUDIMAS TURI SARGĄ, NE TIK FORMULUOTĘ.
   *
   * Reikalavimas „`sessionAuth` negali naudoti `findByToken()`" be patikros yra
   * komentaras: pirmas refaktoringas jį apeis, o TOCTOU langas grįš tyliai.
   * Pasirinktas variantas (1) iš #181: metodo apskritai nėra, tad jo panaudoti
   * fiziškai neįmanoma - nei fasade, nei kuriame nors backend'e.
   */
  const memoryStore = require("../utils/sessionStore/memoryStore");
  const { createPostgresStore } = require("../utils/sessionStore/postgresStore");
  const pgStore = createPostgresStore({ query: async () => ({ rows: [], rowCount: 0 }) });

  for (const [vardas, modulis] of [
    ["fasadas", sessionStore],
    ["memory", memoryStore],
    ["postgres", pgStore],
  ]) {
    assert.equal(modulis.findByToken, undefined, `${vardas}: findByToken negali egzistuoti`);
    assert.equal(modulis._findByToken, undefined, `${vardas}: paslėpto varianto taip pat negali būti`);
  }
});
