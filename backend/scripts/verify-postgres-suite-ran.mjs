#!/usr/bin/env node
/**
 * ĮRODYMAS, KAD PostgreSQL TESTAI TIKRAI VYKDYTI (#155, 7.4f / #231).
 *
 * ⚠️ ŽALIAS JOB'AS SU PRALEISTAIS TESTAIS NĖRA SĖKMĖ.
 *
 * `npm run test:postgres` grąžina 0 ir tada, kai KIEKVIENAS testas praleido
 * save dėl trūkstamo `DATABASE_URL`. Tokia CI būsena atrodo identiškai sėkmei,
 * bet neįrodo nieko - o būtent tai ir slepia neveikiantį DB kelią.
 *
 * Šis skriptas skaito TAP išvestį ir reikalauja, kad KIEKVIENAM išvesto
 * postgres rinkinio failui pasirodytų bent vienas NEPRALEISTAS `ok`.
 *
 * Naudojimas CI:
 *   npm run test:postgres | tee /tmp/pg.tap
 *   node scripts/verify-postgres-suite-ran.mjs /tmp/pg.tap
 */

import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { suites } = require("../tests/suites.js");

const kelias = process.argv[2];

if (!kelias) {
  console.error("Naudojimas: node scripts/verify-postgres-suite-ran.mjs <tap-failas>");
  process.exit(2);
}

const tap = fs.readFileSync(kelias, "utf8");

/**
 * TAP eilutės, kurios reiškia REALIAI įvykdytą testą.
 *
 * ⚠️ `# SKIP` ATMETAMAS SĄMONINGAI. `ok 3 - ... # SKIP reikia DATABASE_URL` yra
 * praleidimas, ne sėkmė; skaičiuoti jį reikštų tiksliai tą iliuziją, kurios
 * skriptas ir vengia.
 */
const ivykdyti = tap
  .split("\n")
  .filter((eil) => /^\s*ok \d+ - /.test(eil))
  .filter((eil) => !/#\s*SKIP/i.test(eil));

/**
 * Failo priskyrimas TAP eilutei.
 *
 * `node --test` prieš kiekvieno failo blokus rašo `# Subtest: <kelias>`, o
 * failo lygio rezultatą - `ok N - <kelias>`. Ieškom failo vardo bet kurioje
 * eilutėje, nes formatas skiriasi tarp Node versijų.
 */
const trukstami = suites.postgres.filter((testas) => {
  const sablonas = new RegExp(`${testas.replace(/\./g, "\\.")}\\.test\\.js`);
  return !ivykdyti.some((eil) => sablonas.test(eil)) && !tapTuriIvykdytaBloka(tap, testas);
});

function tapTuriIvykdytaBloka(turinys, testas) {
  /**
   * Failo lygio `ok` gali neminėti failo vardo, jei testai grupuoti. Tada
   * ieškom `# Subtest: ...<failas>` ir tikrinam, ar po jo yra nepraleistas `ok`
   * PRIEŠ kitą `# Subtest:` to paties lygio eilutę.
   */
  const eilutes = turinys.split("\n");
  const sablonas = new RegExp(`${testas.replace(/\./g, "\\.")}\\.test\\.js`);

  for (let i = 0; i < eilutes.length; i += 1) {
    if (!sablonas.test(eilutes[i])) continue;

    for (let j = i + 1; j < eilutes.length; j += 1) {
      if (/^# Subtest: /.test(eilutes[j])) break;
      if (/^\s*ok \d+ - /.test(eilutes[j]) && !/#\s*SKIP/i.test(eilutes[j])) return true;
    }
  }

  return false;
}

if (trukstami.length > 0) {
  console.error(
    "PostgreSQL rinkinys NEBUVO realiai įvykdytas. Failai be nė vieno " +
      "nepraleisto `ok`:\n" +
      trukstami.map((t) => `  - ${t}`).join("\n") +
      "\n\nDažniausia priežastis: `DATABASE_URL` nenustatytas, tad testai praleido " +
      "save, o job'as vis tiek grąžino 0. Žalias job'as su praleistais testais " +
      "nėra sėkmė."
  );
  process.exit(1);
}

console.log(
  `PostgreSQL rinkinys: visi ${suites.postgres.length} failai realiai įvykdyti ` +
    `(${ivykdyti.length} nepraleistų \`ok\`).`
);
