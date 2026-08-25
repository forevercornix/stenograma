const crypto = require("crypto");

/**
 * BEARER TOKEN'AS IR JO MAIŠA (#155, 7.3).
 *
 * ⚠️ TRYS SKIRTINGOS REIKŠMĖS, KURIŲ NEGALIMA SUTAPATINTI.
 *
 *   1. `token`      - paslaptis, kurią turi TIK klientas (cookie);
 *   2. `token_hash` - vienkryptė jos maiša, kurią turi TIK DB;
 *   3. `sessions.id`- surogatinis raktas, kuris nėra nei viena, nei kita.
 *
 * Sutapatinus bet kurias dvi, hash-only garantija dingsta: lentelės
 * nutekėjimas virsta aktyvių sesijų perėmimu.
 */

/**
 * ⚠️ ENTROPIJA NEGALI SUMAŽĖTI.
 *
 * Iki 7.3 `generateSessionId()` buvo `crypto.randomBytes(32)` - 256 bitų
 * paslaptis. Akivaizdus perkėlimo žingsnis - `uuid` pirminį raktą siųsti į
 * cookie - būtų nuleidęs bearer'į iki 122 bitų IR padaręs jį saugoma reikšme.
 * Todėl token'as lieka 32 baitai `crypto.randomBytes`, nepriklausomas nuo `id`.
 */
const SESSION_TOKEN_BYTES = 32;

function generateSessionToken() {
  return crypto.randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
}

/**
 * `token_hash` ALGORITMAS FIKSUOTAS: SHA-256, LOWERCASE HEX.
 *
 * ⚠️ LĖTI KDF ČIA DRAUDŽIAMI - TAI DoS, NE STILIUS.
 *
 * `utils/credentials.js` naudoja `crypto.scryptSync` su `SCRYPT_N = 1 << 14`
 * (~50-100 ms vienam skaičiavimui). Tas pats helperis sesijoms reikštų, kad
 * KIEKVIENA autentifikuota užklausa kainuoja 50-100 ms CPU, nes `touch()`
 * kviečiamas kiekvienai - Node thread pool išsektų iš karto.
 *
 * Lėti KDF reikalingi MAŽOS entropijos slaptažodžiams. Bearer token'as turi
 * 256 bitus `crypto.randomBytes` ir yra atsparus brute-force pagal
 * konstrukciją, tad jam reikia GREITOS vienkryptės maišos.
 *
 * ⚠️ `timingSafeEqual()` ČIA NEREIKALINGAS. Paieška vyksta per
 * `WHERE token_hash = $1`, t. y. palyginimą daro DB indeksas - papildomas
 * pastovaus laiko sluoksnis JS pusėje nieko neapsaugotų ir tik sudarytų
 * įspūdį, kad apsauga yra ten, kur jos nėra. Esminė garantija - kad plaintext
 * niekada nepersistinamas ir nepaliekamas už autentikacijos ribos.
 *
 * ⚠️ VIENAS HELPERIS VISIEMS KELIAMS (`create`, `touch`, `destroy`). Antra
 * realizacija reikštų, kad vienas kelias ieško pagal kitokią maišą nei kitas
 * rašo, ir sesijos tyliai nustotų atsirasti.
 */
function hashSessionToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

module.exports = { SESSION_TOKEN_BYTES, generateSessionToken, hashSessionToken };
