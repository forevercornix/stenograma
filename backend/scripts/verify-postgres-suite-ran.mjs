#!/usr/bin/env node
/**
 * ĮRODYMAS, KAD PostgreSQL TESTAI TIKRAI VYKDYTI (#155, 7.4f / #231).
 *
 * ⚠️ ŽALIAS JOB'AS SU PRALEISTAIS TESTAIS NĖRA SĖKMĖ.
 *
 * `npm run test:postgres` grąžina 0 ir tada, kai KIEKVIENAS testas praleido
 * save dėl trūkstamo `DATABASE_URL`. Tokia CI būsena atrodo identiškai sėkmei,
 * bet neįrodo nieko - ir būtent ji slepia neveikiantį DB kelią.
 *
 * ⚠️ GRANULIARUMO RIBA, KURIĄ BŪTINA ŽINOTI.
 *
 * Pirmoji šio skripto versija reikalavo „bent vienas nepraleistas `ok`
 * KIEKVIENAM rinkinio failui". Tai neįmanoma: Node 18 `node --test <failai>`
 * duoda PLOKŠČIĄ TAP srautą, kuriame failų vardų nėra apskritai - tik testų
 * pavadinimai. Ta versija krisdavo VISADA, nepriklausomai nuo to, ar testai
 * realiai vykdyti; CI kritimas buvo jos pačios klaida.
 *
 * Todėl tikrinama tai, ką šis formatas leidžia įrodyti, ir kas atitinka TIKRĄJĮ
 * gedimo režimą:
 *   1. nė vienas testas nepraleistas dėl trūkstamo `DATABASE_URL`;
 *   2. realiai įvykdytų testų yra.
 *
 * Su nustatytu `DATABASE_URL` postgres rinkinyje praleidimų būti neturi, tad
 * (1) yra lygiavertis reikalavimui. Failų lygio atributikos NĖRA, ir šis
 * komentaras egzistuoja tam, kad kitas skaitytojas jos čia neieškotų.
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

const eilutes = fs.readFileSync(kelias, "utf8").split("\n");

const okEilutes = eilutes.filter((eil) => /^\s*ok \d+ - /.test(eil));

/**
 * ⚠️ Praleidimai atpažįstami pagal `postgresGuard` pranešimą, ne pagal bet kokį
 * `# SKIP`. Testas gali būti praleistas ir dėl kitos priežasties (Redis, tyčinis
 * `skip: true`), o tokie čia nesvarbūs - klausimas yra siauras: ar praleista dėl
 * TRŪKSTAMOS DUOMENŲ BAZĖS.
 */
const praleistiDelDb = okEilutes.filter(
  (eil) => /#\s*SKIP/i.test(eil) && eil.includes("DATABASE_URL")
);

const realiaiIvykdyti = okEilutes.filter((eil) => !/#\s*SKIP/i.test(eil));

const klaidos = [];

if (suites.postgres.length === 0) {
  klaidos.push(
    "Postgres rinkinys TUŠČIAS. Išvedimas (`postgresGuard` importai) nieko nerado - " +
      "arba testai pervadinti, arba importo forma pasikeitė."
  );
}

if (praleistiDelDb.length > 0) {
  klaidos.push(
    `${praleistiDelDb.length} test. praleista dėl trūkstamo \`DATABASE_URL\`. Su ` +
      "nustatyta duomenų baze praleidimų būti negali. Pavyzdys:\n    " +
      praleistiDelDb[0].trim().slice(0, 120)
  );
}

if (realiaiIvykdyti.length === 0) {
  klaidos.push("Nė vieno realiai įvykdyto testo - TAP tuščias arba viskas praleista.");
}

if (klaidos.length > 0) {
  console.error(
    "PostgreSQL rinkinys NEBUVO realiai įvykdytas:\n\n" +
      klaidos.map((k) => `  - ${k}`).join("\n") +
      "\n\nŽalias job'as su praleistais testais nėra sėkmė."
  );
  process.exit(1);
}

console.log(
  `PostgreSQL rinkinys (${suites.postgres.length} failai): ` +
    `${realiaiIvykdyti.length} testų realiai įvykdyta, 0 praleista dėl DB.`
);
