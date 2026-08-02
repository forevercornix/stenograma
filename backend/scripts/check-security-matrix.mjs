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

// 2. Ar kiekvienas saugumo/privatumo testas paminėtas?
for (const suite of ["privacy", "security"]) {
  for (const name of suites[suite]) {
    if (!mentioned.has(name)) {
      problems.push(
        `testas "${name}" (${suite}) NEPAMINĖTAS matricoje - ` +
          "kiekvienas saugumo testas turi turėti garantiją, kurią saugo"
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

console.log(`Saugumo matrica: ${mentioned.size} nuorodų, visos sutampa su tests/suites.js.`);
