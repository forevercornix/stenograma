/**
 * PostgreSQL integracinių testų sargas (#155, 7.1).
 *
 * Simetriškas `redisGuard.js`: be `DATABASE_URL` testai praleidžiami, o
 * `REQUIRE_POSTGRES=1` paverčia praleidimą KLAIDA.
 *
 * ⚠️ KODĖL `REQUIRE_POSTGRES`. Be jo CI galėtų likti žalias niekada nepaleidęs
 * nė vieno DB testo — pakaktų, kad `DATABASE_URL` nebūtų nustatytas. Tyliai
 * praleisti integraciniai testai yra blogiau nei jų nebuvimas: jie sukuria
 * padengimo iliuziją.
 *
 * ⚠️ MIGRACIJŲ TESTAI KEIČIA SCHEMĄ. Skirtingai nei Redis testai, kurie dirba
 * su raktais, šie vykdo `CREATE`/`DROP`. Todėl jie privalo naudoti ATSKIRĄ
 * duomenų bazę, ne tą, kurioje sukasi kiti testai — žr. `testDatabaseUrl()`.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const REQUIRED = process.env.REQUIRE_POSTGRES === "1";

if (REQUIRED && !DATABASE_URL) {
  throw new Error(
    "REQUIRE_POSTGRES=1 nustatytas, bet DATABASE_URL nėra. Integraciniai testai " +
      "būtų praleisti tyliai, o CI liktų žalias jų nepaleidęs. Nustatykite " +
      "DATABASE_URL arba nuimkite REQUIRE_POSTGRES."
  );
}

/**
 * @returns {false | string} `false` - vykdyti; eilutė - praleidimo priežastis.
 */
function skipWithoutPostgres() {
  return DATABASE_URL
    ? false
    : "reikia DATABASE_URL su tikru Postgres (CI: REQUIRE_POSTGRES=1)";
}

/**
 * Grąžina URL su PAKEISTU duomenų bazės vardu.
 *
 * Migracijų testai kuria ir naikina schemą, tad negali dirbti toje pačioje DB
 * kaip kiti testai — lygiagretus vykdymas juos sugriautų. `node --test` failus
 * vykdo lygiagrečiai, ir Redis pusėje tai jau buvo realus gedimo šaltinis
 * (žr. `redisGuard.js`).
 */
function testDatabaseUrl(suffix) {
  if (!DATABASE_URL) return null;

  const url = new URL(DATABASE_URL);
  const bazė = url.pathname.replace(/^\//, "") || "postgres";
  url.pathname = `/${bazė}_${suffix}`;
  return url.toString();
}

/** URL be DB vardo – prisijungimui prie `postgres` bazės (CREATE DATABASE). */
function adminDatabaseUrl() {
  if (!DATABASE_URL) return null;

  const url = new URL(DATABASE_URL);
  url.pathname = "/postgres";
  return url.toString();
}

module.exports = {
  DATABASE_URL,
  REQUIRED,
  skipWithoutPostgres,
  testDatabaseUrl,
  adminDatabaseUrl,
  hasPostgres: !!DATABASE_URL,
};
