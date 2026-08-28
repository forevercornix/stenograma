#!/usr/bin/env node
/**
 * ĮRODYMAS, KAD POSTGRES RINKINYS REALIAI VYKDYTAS (#155, 7.4f / #231).
 *
 * ⚠️ ŽALIAS JOB'AS NĖRA ĮRODYMAS.
 *
 * `test:postgres` grąžina 0 ir tada, kai kiekvienas testas praleido save dėl
 * trūkstamo `DATABASE_URL`. Tokia CI būsena atrodo identiškai sėkmei, bet
 * neįrodo nieko - ir būtent ji slepia neveikiantį DB kelią.
 *
 * ⚠️ TIKRINAMA PER FAILĄ, NE PER SRAUTĄ.
 *
 * Pirmoji versija skaitė VIENĄ bendrą TAP ir bandė iš jo atpažinti failų
 * vardus. Tai neįmanoma: Node 18 `node --test <failai>` duoda plokščią srautą
 * be failų atributikos. Antroji versija to atsisakė, bet kartu susilpnino
 * kriterijų iki „rinkinyje yra bent vienas įvykdytas testas" - failas, nutilęs
 * dėl klaidingo importo ar praleisto `describe`, praeidavo, jei kiti sukasi.
 *
 * Dabar `run-tests.mjs --tap-dir` paleidžia KIEKVIENĄ failą atskiru procesu ir
 * rašo `<dir>/<vardas>.tap`. Atributika yra failo vardas, tad kriterijus
 * grįžta prie #231 formuluotės - bent vienas NEPRALEISTAS `ok` KIEKVIENAM
 * rinkinio failui - ir nebepriklauso nuo Node versijos ar reporterio.
 *
 * Naudojimas:
 *   node scripts/run-tests.mjs postgres --tap-dir=/tmp/pg-tap
 *   node scripts/verify-postgres-suite-ran.mjs /tmp/pg-tap
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { suites } = require(path.join(here, "..", "tests", "suites.js"));

const katalogas = process.argv[2];

if (!katalogas) {
  console.error("Naudojimas: verify-postgres-suite-ran.mjs <tap-katalogas>");
  process.exit(2);
}

if (!fs.existsSync(katalogas) || !fs.statSync(katalogas).isDirectory()) {
  console.error(
    `\`${katalogas}\` nėra katalogas. Šis tikrintuvas skaito PER-FAILO TAP, kurį ` +
      "rašo `run-tests.mjs --tap-dir=<katalogas>`. Vienas bendras TAP netinka: " +
      "jame nėra failų atributikos, tad per-failo įrodymo iš jo gauti neįmanoma."
  );
  process.exit(2);
}

/**
 * ⚠️ Praleidimai atpažįstami pagal `postgresGuard` pranešime esantį
 * `DATABASE_URL`, ne pagal bet kokį `# SKIP`. Testas gali būti praleistas ir dėl
 * kitos priežasties (Redis, tyčinis `skip: true`), o tokie čia nesvarbūs -
 * klausimas siauras: ar praleista dėl TRŪKSTAMOS DUOMENŲ BAZĖS.
 */
function ivertintiFaila(turinys) {
  const okEilutes = turinys.split("\n").filter((eil) => /^\s*ok \d+ - /.test(eil));

  return {
    ivykdyti: okEilutes.filter((eil) => !/#\s*SKIP/i.test(eil)).length,
    praleistiDelDb: okEilutes.filter(
      (eil) => /#\s*SKIP/i.test(eil) && eil.includes("DATABASE_URL")
    ).length,
  };
}

const klaidos = [];

if (suites.postgres.length === 0) {
  klaidos.push(
    "Postgres rinkinys TUŠČIAS. Išvedimas (`postgresGuard` importai) nieko nerado - " +
      "arba testai pervadinti, arba importo forma pasikeitė."
  );
}

for (const testas of suites.postgres) {
  const kelias = path.join(katalogas, `${testas}.tap`);

  if (!fs.existsSync(kelias)) {
    klaidos.push(`${testas}: TAP failo nėra - šis failas NEBUVO paleistas.`);
    continue;
  }

  const { ivykdyti, praleistiDelDb } = ivertintiFaila(fs.readFileSync(kelias, "utf8"));

  if (praleistiDelDb > 0) {
    klaidos.push(
      `${testas}: ${praleistiDelDb} test. praleista dėl trūkstamo \`DATABASE_URL\`.`
    );
  }

  if (ivykdyti === 0) {
    klaidos.push(
      `${testas}: nė vieno nepraleisto \`ok\`. Failas arba nulūžo dar importo metu, ` +
        "arba visi jo testai praleisti."
    );
  }
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
  `PostgreSQL rinkinys: visi ${suites.postgres.length} failai realiai įvykdyti ` +
    "(kiekvienas turi bent vieną nepraleistą `ok`, nė vieno praleidimo dėl DB)."
);
