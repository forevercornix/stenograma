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
 * Rezultatą įrašykite į AUTH_USERS formatu "vardas:rolė:maiša:userId".
 */
const crypto = require("node:crypto");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const { hashPassword, USERNAME_PATTERN, USER_ID_PATTERN, KNOWN_ROLES } = require("../utils/credentials");

async function main() {
  const argv = process.argv.slice(2);

  /**
   * `--user-id` IŠSAUGO ESAMĄ TAPATYBĘ (#158).
   *
   * Be jo skriptas generuoja NAUJĄ `userId`. Slaptažodžio rotacijos metu tai
   * būtų klaida: normalus operatoriaus kelias yra paleisti tą patį skriptą ir
   * nukopijuoti išvestį, tad numatytasis elgesys neturi tyliai sukurti naujos
   * tapatybės. Todėl abu keliai yra AIŠKIAI įvardyti išvestyje.
   */
  const idIndex = argv.indexOf("--user-id");
  let existingUserId = null;
  if (idIndex !== -1) {
    existingUserId = argv[idIndex + 1];
    argv.splice(idIndex, 2);
  }

  const [username, role] = argv;

  if (!username || !role) {
    console.error("Naudojimas:");
    console.error("  naujas vartotojas:      node scripts/hash-password.js <vardas> <rolė>");
    console.error("  slaptažodžio rotacija:  node scripts/hash-password.js <vardas> <rolė> --user-id <esamas-uuid>");
    console.error("");
    console.error("Be --user-id sukuriama NAUJA tapatybė. Esamam vartotojui visada");
    console.error("perduokite jo dabartinį userId iš AUTH_USERS ketvirto lauko.");
    console.error(`Galimos rolės: ${KNOWN_ROLES.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  if (idIndex !== -1 && !USER_ID_PATTERN.test(String(existingUserId || ""))) {
    console.error(`--user-id reikšmė "${existingUserId}" nėra UUIDv4.`);
    console.error("Nukopijuokite ją iš esamo AUTH_USERS įrašo ketvirto lauko.");
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
  /**
   * STABILUS `userId` (#158) generuojamas ČIA, ne paliekamas vartotojui.
   *
   * Ranka sugalvotas ID rizikuoja dublikatu tarp dviejų vartotojų – tada job
   * nuosavybė ir auditas nurodytų į dvi paskyras. `loadUsers()` tokį atvejį
   * atmeta, bet geriau jo apskritai nesukurti.
   */
  const userId = existingUserId || crypto.randomUUID();

  console.log("\nPridėkite prie AUTH_USERS (kableliais atskirtas sąrašas keliems vartotojams):\n");
  console.log(`${username}:${role}:${hash}:${userId}`);

  if (existingUserId) {
    console.log("\n✔  Išsaugota ESAMA tapatybė (--user-id). Job'ai ir audito įrašai lieka susieti.");
  } else {
    console.log(
      "\n⚠️  Sukurta NAUJA tapatybė (userId: " + userId + ").\n" +
        "    Jei tai jau esamo vartotojo slaptažodžio ar vardo keitimas, NENAUDOKITE šios eilutės –\n" +
        "    paleiskite iš naujo su jo dabartiniu ID:\n\n" +
        `      node scripts/hash-password.js ${username} ${role} --user-id <esamas-uuid>\n\n` +
        "    Naujas ID atsietų vartotojo job'us ir audito įrašus nuo jo paskyros."
    );
  }
}

main();
