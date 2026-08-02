#!/usr/bin/env node
/**
 * PO-TESTINĖ ŠVAROS PATIKRA (#15).
 *
 * Naudojimas:
 *   node scripts/verify-clean.mjs --snapshot   prieš testus
 *   node scripts/verify-clean.mjs --verify     po testų
 *
 * Kodėl to reikia: testas, kuris po savęs nesutvarko, ilgainiui slepia tikrus
 * nutekėjimus. Kai `/tmp` pilnas senų `stenograma-*` katalogų, niekas nebemato,
 * kad produkcinis kodas kažko neištrina - visi pripranta prie triukšmo.
 *
 * Rasta rašant: `tests/jobRunner.test.js` kūrė `stenograma-test-storage-*` ir
 * jo netrindavo, tad kiekvienas paleidimas palikdavo naują katalogą.
 *
 * Patikra tikslinga, ne bendra: ji žiūri TIK į mūsų prefiksus. Bendras `/tmp`
 * skaičiavimas duotų klaidingus signalus, nes ten rašo ir kiti procesai.
 */

import { readdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Prefiksai, kuriuos kuria ŠIS projektas.
 *
 * Sąrašas neplatus sąmoningai: bendras `/tmp` skaičiavimas duotų klaidingus
 * signalus, nes ten rašo ir kiti procesai.
 *
 * ⚠️ Bet siauras sąrašas turi savo riziką: testas, sukūręs
 * `mano-naujas-katalogas-*`, liktų nepastebėtas, o patikra rodytų „švaru".
 * Todėl `--verify` papildomai SKENUOJA testų failus ir tikrina, ar jie
 * nenaudoja prefiksų, kurių čia nėra (žr. `verifyPrefixCoverage`).
 */
const PREFIXES = ["stenograma-"];

const SNAPSHOT = join(tmpdir(), ".stenograma-clean-snapshot.json");

function currentArtefacts() {
  return readdirSync(tmpdir())
    .filter((name) => PREFIXES.some((prefix) => name.startsWith(prefix)))
    .filter((name) => !name.startsWith(".stenograma-clean-snapshot"))
    .sort();
}

/**
 * Ar testai nenaudoja laikinų prefiksų, kurių `PREFIXES` neapima?
 *
 * Be šito README teiginys „testai nepalieka artefaktų" būtų platesnis nei
 * tikrinimas: realiai tikrinama tik „artefaktų su ŠIAIS prefiksais". Skenavimas
 * tą atotrūkį uždaro - naujas prefiksas sulaužo patikrą, o ne prasprūsta.
 */
function verifyPrefixCoverage() {
  const testsDir = join(backendRoot, "tests");
  const problems = [];

  // `mkdtemp(join(tmpdir(), "kazkas-"))` ir `join(tmpdir(), "kazkas-" + ...)`.
  const PREFIX_PATTERN = /tmpdir\(\)[^;\n]{0,80}?"([a-z][a-z0-9]{2,}[a-z0-9-]*-)"/g;

  for (const file of readdirSync(testsDir)) {
    if (!file.endsWith(".test.js")) continue;

    const source = readFileSync(join(testsDir, file), "utf8");

    for (const match of source.matchAll(PREFIX_PATTERN)) {
      const prefix = match[1];
      if (!PREFIXES.some((known) => prefix.startsWith(known))) {
        problems.push(`${file}: laikinas prefiksas "${prefix}" nėra PREFIXES sąraše`);
      }
    }
  }

  return problems;
}

const mode = process.argv[2];

if (mode === "--snapshot") {
  const before = currentArtefacts();
  writeFileSync(SNAPSHOT, JSON.stringify(before));

  console.log(`Švaros momentinė kopija: ${before.length} artefaktų prieš testus.`);
  process.exit(0);
}

if (mode !== "--verify") {
  console.error("Naudojimas: node scripts/verify-clean.mjs --snapshot | --verify");
  process.exit(2);
}

if (!existsSync(SNAPSHOT)) {
  console.error("Nėra momentinės kopijos. Prieš testus paleiskite --snapshot.");
  process.exit(2);
}

const uncovered = verifyPrefixCoverage();

if (uncovered.length > 0) {
  console.error("Testai naudoja laikinų failų prefiksus, kurių patikra nemato:\n");
  for (const problem of uncovered) console.error(`  - ${problem}`);
  console.error(
    "\nPridėkite prefiksą į PREFIXES (scripts/verify-clean.mjs) arba naudokite " +
      "esamą - kitaip likučiai su juo liktų nepastebėti."
  );
  process.exit(1);
}

const before = new Set(JSON.parse(readFileSync(SNAPSHOT, "utf8")));
const leaked = currentArtefacts().filter((name) => !before.has(name));

if (leaked.length > 0) {
  console.error(`Testai paliko ${leaked.length} artefaktų ${tmpdir()} kataloge:\n`);
  for (const name of leaked.slice(0, 20)) console.error(`  - ${name}`);
  if (leaked.length > 20) console.error(`  … ir dar ${leaked.length - 20}`);

  console.error(
    "\nTestas, kuris po savęs nesutvarko, ilgainiui slepia tikrus nutekėjimus.\n" +
      "Pridėkite `test.after` valymą tam testui, kuris šiuos artefaktus kuria."
  );
  process.exit(1);
}

console.log(`Švara: testai nepaliko artefaktų (prefiksai: ${PREFIXES.join(", ")}).`);
