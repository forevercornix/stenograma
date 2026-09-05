#!/usr/bin/env node
/**
 * SAUGUMO MATRICOS PATIKRA (#15).
 *
 * Matrica be patikros ilgainiui virsta sąrašu to, ką kažkada turėjom: testas
 * pervadinamas, ištrinamas ar pridedamas, o dokumentas lieka toks pat ir atrodo
 * teisingas. Tai ta pati klaidos šeima kaip sulūžęs `dependabot.yml` - failas
 * yra, tad atrodo, kad veikia.
 *
 * Tikrinamos DVI kryptys:
 *  1. kiekvienas matricoje minimas testas realiai egzistuoja;
 *  2. kiekvienas `privacy`/`security` rinkinio testas matricoje paminėtas.
 *
 * Naudojimas: node scripts/check-security-matrix.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = join(here, "..");
const repoRoot = join(backendRoot, "..");
const MATRIX = join(repoRoot, "docs", "security-test-matrix.md");

const require = createRequire(import.meta.url);
const { suites } = require(join(backendRoot, "tests", "suites.js"));

if (!existsSync(MATRIX)) {
  console.error(`Nėra ${MATRIX}. Saugumo matrica yra #15 rezultatas - be jos aprėptis nedokumentuota.`);
  process.exit(1);
}

const matrix = readFileSync(MATRIX, "utf8");
const problems = [];

/**
 * Matricoje testai minimi kaip `backtick`-uoti vardai. Imam tik tuos, kurie
 * atrodo kaip testų failai - kitaip pagautume ir env kintamuosius bei kelius.
 */
const mentioned = new Set(
  [...matrix.matchAll(/`([A-Za-z][\w.]*(?:\.route|\.integration|\.service)?)`/g)]
    .map((match) => match[1])
    .filter((name) => !name.includes("/") && !name.includes("=") && !/^[A-Z_]+$/.test(name))
);

/** Frontend testai minimi su keliu - juos tikrinam atskirai. */
for (const match of matrix.matchAll(/`(frontend\/src\/[\w.]+)`/g)) {
  const path = join(repoRoot, match[1]);
  if (!existsSync(path)) problems.push(`matricoje minimas neegzistuojantis failas: ${match[1]}`);
}

// 1. Ar kiekvienas paminėtas backend testas egzistuoja?
const allTests = new Set(Object.values(suites).flat());

for (const name of mentioned) {
  // Tikrinam tik tuos vardus, kurie panašūs į testus (yra rinkiniuose arba
  // turi būdingą priesagą) - kitaip komentuotume kiekvieną backtick'ą.
  const looksLikeTest = allTests.has(name) || /\.(route|integration|service)$/.test(name);
  if (!looksLikeTest) continue;

  if (!allTests.has(name)) {
    problems.push(`matricoje minimas testas "${name}", kurio nėra tests/suites.js`);
  }
}

// 2. Ar kiekvienas testas paminėtas?
//
// ⚠️ ANKSČIAU BUVO TIK `privacy` ir `security`.
//
// Todėl `redis` ir `postgres` rinkinių testai galėjo atsirasti be nė vieno
// įrašo matricoje, ir sargas to nematė: patikra buvo VIENPUSĖ (matrica →
// suites, bet ne atvirkščiai visiems rinkiniams). Rasta pridedant
// `postgresDoctor.integration` — matricos skaičius nepasikeitė.
//
// Integraciniai testai saugo tokias pat garantijas kaip vienetiniai; tai, kad
// jiems reikia išorinio serviso, nedaro jų mažiau dokumentuotinų.
//
// ⚠️ `functional` SĄMONINGAI NEĮTRAUKTAS. Tai SAUGUMO matrica, ne visų testų
// registras: reikalavimas dokumentuoti kiekvieną funkcinį testą (šiandien jų
// nepaminėta 20+) paverstų matricą apyvartos dokumentu ir nuvertintų įrašus,
// kurie tikrai aprašo saugumo garantiją.
//
// `redis` ir `postgres` įtraukti, nes juose gyvena nuosavybės CAS, fazių CAS ir
// backend'ų kontraktas — invariantai, ne funkcijos.
const DOKUMENTUOJAMI = ["privacy", "security", "redis", "postgres", "s3"];

for (const suite of DOKUMENTUOJAMI) {
  for (const name of suites[suite]) {
    if (!mentioned.has(name)) {
      problems.push(
        `testas "${name}" (${suite}) NEPAMINĖTAS matricoje - ` +
          "kiekvienas saugumo testas turi turėti garantiją, kurią saugo"
      );
    }
  }
}

/**
 * ⚠️ LENTELIŲ VIENTISUMAS.
 *
 * Rasta realiai: skriptinis redagavimas praleido eilutės lūžį, ir dvi gretimos
 * eilutės susijungė per `||`. Markdown tada traktuoja jas kaip vieną eilutę su
 * pertekliniais langeliais, o ANTROJI GARANTIJA IŠ MATRICOS TIESIOG DINGSTA -
 * ne su klaida, o tyliai. Matrica yra autoritetinis sąrašas, tad tylus eilutės
 * praradimas yra blogiau nei neteisinga eilutė: jos niekas nebeieško.
 *
 * Tikrinamos VISOS lentelės: eilučių langelių skaičius turi sutapti su tos
 * lentelės antrašte. Tuščias langelis leistinas, `||` viduryje - ne.
 */
{
  const eilutes = matrix.split("\n");
  let antrastesLangeliai = null;
  let antrastesEilute = 0;

  /** Langelių skaičius: kraštiniai `|` neskaitomi, ekranuotas `\|` - ne skirtukas. */
  const langeliai = (eilute) =>
    eilute.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).length;

  for (let i = 0; i < eilutes.length; i += 1) {
    const eilute = eilutes[i];

    if (!eilute.trim().startsWith("|")) {
      antrastesLangeliai = null;
      continue;
    }

    if (antrastesLangeliai === null) {
      antrastesLangeliai = langeliai(eilute);
      antrastesEilute = i + 1;
      continue;
    }

    /** Skirtuko eilutė (`|---|---|`) praleidžiama. */
    if (/^\|[\s:|-]+\|$/.test(eilute.trim())) continue;

    const rasta = langeliai(eilute);
    if (rasta !== antrastesLangeliai) {
      problems.push(
        `docs/security-test-matrix.md:${i + 1}: eilutėje ${rasta} langeliai, ` +
          `o lentelės antraštėje (eil. ${antrastesEilute}) - ${antrastesLangeliai}. ` +
          "Dažniausia priežastis - praleistas eilutės lūžis, sujungęs dvi eilutes per `||`."
      );
    }
  }
}

if (problems.length > 0) {
  console.error("Saugumo matrica nesutampa su tikrove:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(`\nPapildykite ${MATRIX.replace(repoRoot + "/", "")}.`);
  process.exit(1);
}

/**
 * ⚠️ Skaičiuojami UNIKALŪS testų failai, ne matricos eilutės.
 *
 * `mentioned` yra aibė: tas pats testų failas, minimas dešimtyje eilučių,
 * skaičiuojamas vieną kartą. Ankstesnis pranešimas („N nuorodų") tai
 * užtemdydavo – pridėjus eilučių tam pačiam failui skaičius nesikeisdavo, ir
 * tai atrodydavo kaip klaida.
 *
 * Painiava buvo reali: per vieną peržiūrą du nepriklausomi skaitytojai padarė
 * tą pačią neteisingą išvadą, o vienas jų dėl to „pataisė" teisingą skaičių į
 * neteisingą. Kai klysta ne žmonės, o visi vienodai – kaltas pavadinimas.
 */
console.log(`Saugumo matrica: ${mentioned.size} unikalių testų failų, visi sutampa su tests/suites.js.`);
