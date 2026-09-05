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

/**
 * ⚠️ PARAMETRIZUOTA, NE NUKOPIJUOTA (#157, PR-2).
 *
 * S3 rinkiniui reikia TOS PAČIOS garantijos su kitu rinkinio vardu ir kita
 * praleidimo žyma. Antra šio failo kopija ilgainiui išsiskirtų su pirmąja, ir
 * skirtumas pasimatytų tik tada, kai vienas iš dviejų sargų nustotų ginti.
 *
 * Numatytosios reikšmės palieka esamą `postgres` iškvietimą nepakitusį.
 */
const katalogas = process.argv[2];
const RINKINYS = process.argv[3] || "postgres";
const PRALEIDIMO_ZYMA = process.argv[4] || "DATABASE_URL";

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
 * Vieno failo TAP įvertinimas.
 *
 * ⚠️ SKAIČIUOJAMI TESTAI, NE `ok` EILUTĖS (#233 Codex raundas 2, #4).
 *
 * Kai failas naudoja `describe()`/`suite()`, Node TAP išveda ir APVALKALO
 * įrašą: `ok 1 - <suite>` su `type: 'suite'` YAML bloke. Tas įrašas NETURI
 * `# SKIP` žymos net tada, kai visi vaikai praleisti - tad `ok` eilučių
 * skaičiavimas jį užskaito kaip įvykdytą testą, ir VISIŠKAI praleistas failas
 * praeina per-failo patikrą.
 *
 * Tai tiksliai tas gedimo režimas, dėl kurio buvo atmesta ankstesnė kriterijaus
 * versija: „failas nutyla, o kiti sukasi". Garantija, kuri jo nepagauna, negina
 * to, ko reikalauja #231 DoD 14.
 *
 * ⚠️ Praleidimai atpažįstami pagal `postgresGuard` pranešime esantį
 * `DATABASE_URL`, ne pagal bet kokį `# SKIP`. Testas gali būti praleistas ir dėl
 * kitos priežasties (Redis, tyčinis `skip: true`), o tokie čia nesvarbūs -
 * klausimas siauras: ar praleista dėl TRŪKSTAMOS DUOMENŲ BAZĖS.
 */
function ivertintiFaila(turinys) {
  const eilutes = turinys.split("\n");

  let ivykdyti = 0;
  let praleistiDelDb = 0;

  for (let i = 0; i < eilutes.length; i += 1) {
    const eilute = eilutes[i];
    if (!/^\s*ok \d+ - /.test(eilute)) continue;

    /** Po `ok` einantis YAML blokas: nuo `---` iki `...`. */
    const yamlEilutes = [];
    let j = i + 1;

    if (/^\s*---\s*$/.test(eilutes[j] === undefined ? "" : eilutes[j])) {
      j += 1;
      while (j < eilutes.length && !/^\s*\.\.\.\s*$/.test(eilutes[j])) {
        yamlEilutes.push(eilutes[j]);
        j += 1;
      }
    }

    /** Apvalkalas nėra testas: jis tik apibendrina vaikus. */
    if (/^\s*type:\s*'suite'\s*$/m.test(yamlEilutes.join("\n"))) continue;

    if (/#\s*SKIP/i.test(eilute)) {
      if (eilute.includes(PRALEIDIMO_ZYMA)) praleistiDelDb += 1;
      continue;
    }

    ivykdyti += 1;
  }

  return { ivykdyti, praleistiDelDb };
}

const klaidos = [];

if (!suites[RINKINYS]) {
  console.error(`Nežinomas rinkinys "${RINKINYS}". Galimi: ${Object.keys(suites).join(", ")}.`);
  process.exit(2);
}

if (suites[RINKINYS].length === 0) {
  klaidos.push(
    `Rinkinys "${RINKINYS}" TUŠČIAS. Išvedimas (sargo importai) nieko nerado - ` +
      "arba testai pervadinti, arba importo forma pasikeitė."
  );
}

for (const testas of suites[RINKINYS]) {
  const kelias = path.join(katalogas, `${testas}.tap`);

  if (!fs.existsSync(kelias)) {
    klaidos.push(`${testas}: TAP failo nėra - šis failas NEBUVO paleistas.`);
    continue;
  }

  const { ivykdyti, praleistiDelDb } = ivertintiFaila(fs.readFileSync(kelias, "utf8"));

  if (praleistiDelDb > 0) {
    klaidos.push(
      `${testas}: ${praleistiDelDb} test. praleista dėl trūkstamo \`${PRALEIDIMO_ZYMA}\`.`
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
    `Rinkinys "${RINKINYS}" NEBUVO realiai įvykdytas:\n\n` +
      klaidos.map((k) => `  - ${k}`).join("\n") +
      "\n\nŽalias job'as su praleistais testais nėra sėkmė."
  );
  process.exit(1);
}

console.log(
  `PostgreSQL rinkinys: visi ${suites.postgres.length} failai realiai įvykdyti ` +
    "(kiekvienas turi bent vieną nepraleistą `ok`, nė vieno praleidimo dėl DB)."
);
