#!/usr/bin/env node
/**
 * TESTŲ RINKINIŲ PALEIDIKLIS (#15).
 *
 * Naudojimas:
 *   node scripts/run-tests.mjs                 - numatytieji rinkiniai
 *   node scripts/run-tests.mjs security        - vienas rinkinys
 *   node scripts/run-tests.mjs privacy security
 *   node scripts/run-tests.mjs --list          - ką apima kiekvienas rinkinys
 *
 * Prieš paleisdamas TIKRINA manifesto pilnumą. Testų grupavimas, kuriame naujas
 * failas gali tyliai likti už ribų, duoda blogiausią įmanomą rezultatą: žalią
 * `test:security`, kuris tiesiog nepaleido naujo saugumo testo.
 */

import { readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = join(here, "..");
const testsDir = join(backendRoot, "tests");

const require = createRequire(import.meta.url);
const { suites, defaultSuites } = require(join(testsDir, "suites.js"));

/** Visi realiai egzistuojantys testų failai. */
function discoverTests() {
  return readdirSync(testsDir)
    .filter((name) => name.endsWith(".test.js"))
    .map((name) => name.replace(/\.test\.js$/, ""))
    .sort();
}

/**
 * Manifesto ir tikrovės sutapimas TURI būti abipusis.
 *
 * Nepriskirtas failas reiškia testą, kurio niekas nepaleidžia rinkiniais;
 * nurodytas neegzistuojantis - manifestą, kuris apsimeta dengiantis daugiau, nei
 * dengia. Abu atvejai yra tyli spraga, tad abu stabdo paleidimą.
 */
function verifyManifest(discovered) {
  const assigned = new Set(Object.values(suites).flat());
  const problems = [];

  for (const name of discovered) {
    if (!assigned.has(name)) {
      problems.push(`testas "${name}" nepriskirtas jokiam rinkiniui (tests/suites.js)`);
    }
  }

  for (const name of assigned) {
    if (!discovered.includes(name)) {
      problems.push(`manifeste nurodytas neegzistuojantis testas "${name}"`);
    }
  }

  return problems;
}

function resolveFiles(names) {
  return names
    .map((name) => join(testsDir, `${name}.test.js`))
    .filter((path) => existsSync(path));
}

const args = process.argv.slice(2);
const discovered = discoverTests();

const problems = verifyManifest(discovered);
if (problems.length > 0) {
  console.error("Testų manifestas nesutampa su tikrove:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("\nPapildykite tests/suites.js. Naujas testas privalo turėti rinkinį.");
  process.exit(1);
}

if (args.includes("--list")) {
  for (const [name, tests] of Object.entries(suites)) {
    console.log(`${name} (${tests.length}):`);
    for (const test of tests) console.log(`  ${test}`);
    console.log();
  }
  process.exit(0);
}

const requested = args.length > 0 ? args : defaultSuites;

const unknown = requested.filter((name) => !suites[name]);
if (unknown.length > 0) {
  console.error(`Nežinomi rinkiniai: ${unknown.join(", ")}`);
  console.error(`Galimi: ${Object.keys(suites).join(", ")}`);
  process.exit(1);
}

// Dublikatai kai rinkiniai persidengia - failas paleidžiamas kartą.
const files = resolveFiles([...new Set(requested.flatMap((name) => suites[name]))]);

console.log(`Rinkiniai: ${requested.join(", ")} (${files.length} failų)\n`);

const result = spawnSync("node", ["--test", ...files], {
  cwd: backendRoot,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
