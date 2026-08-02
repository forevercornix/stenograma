#!/usr/bin/env node
/**
 * Sugeneruoja scrypt maišą slaptažodžiui - naudojama AUTH_USERS reikšmei
 * paruošti (žr. .env.example ir README „Autentifikacija").
 *
 * Naudojimas:
 *   node scripts/hash-password.js <vardas> <rolė>
 *   (slaptažodžio paklausiama ATSKIRAI, kad nepatektų į shell istoriją ar
 *   process listą - vardas ir rolė nėra paslaptis, tad jie saugūs kaip argv)
 *
 * Rezultatą įrašykite į AUTH_USERS formatu "vardas:rolė:maiša".
 */
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const { hashPassword, USERNAME_PATTERN, KNOWN_ROLES } = require("../utils/credentials");

async function main() {
  const [username, role] = process.argv.slice(2);

  if (!username || !role) {
    console.error("Naudojimas: node scripts/hash-password.js <vardas> <rolė>");
    console.error(`Galimos rolės: ${KNOWN_ROLES.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  if (!USERNAME_PATTERN.test(username)) {
    console.error(`Netinkamas vardas "${username}" (mažosios raidės, skaitmenys, _ -, 2-64 simboliai).`);
    process.exitCode = 1;
    return;
  }
  if (!KNOWN_ROLES.includes(role)) {
    console.error(`Nežinoma rolė "${role}". Galimos: ${KNOWN_ROLES.join(", ")}.`);
    process.exitCode = 1;
    return;
  }

  // VIENAS readline klausimas - slaptažodžiui. Vardas ir rolė perduoti kaip
  // argumentai jau prieš tai, tad čia belieka vienintelė reali paslaptis.
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const password = await rl.question("Slaptažodis: ");
  rl.close();

  if (!password) {
    console.error("Slaptažodis negali būti tuščias.");
    process.exitCode = 1;
    return;
  }

  const hash = hashPassword(password);

  console.log("\nPridėkite prie AUTH_USERS (kableliais atskirtas sąrašas keliems vartotojams):\n");
  console.log(`${username}:${role}:${hash}`);
}

main();
