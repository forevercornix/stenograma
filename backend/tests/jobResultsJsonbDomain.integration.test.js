const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { Client } = require("pg");

const { skipWithoutPostgres, testDatabaseUrl, adminDatabaseUrl } = require("./helpers/postgresGuard");
const { paruostiReiksme } = require("../utils/artifactStore/validation");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * `jsonb` PRIĖMIMO SRITIS - IŠMATUOTA, NE NUMANYTA (#157, PR-2).
 *
 * ⚠️ KODĖL ŠIS FAILAS EGZISTUOJA.
 *
 * `ArtifactStore` riba atmeta NUL simbolį, remdamasi teiginiu, kad PostgreSQL
 * `jsonb` jo nepriima. Tas teiginys buvo paimtas iš dokumentacijos, o ne
 * patikrintas ŠIAME repo - t. y. riba rėmėsi prielaida (AGENTS.md §14.1).
 *
 * Čia matuojama, ką `jsonb` REALIAI priima, ir tikrinamas vienas invariantas:
 *
 *   ribos priimtų reikšmių aibė PRIVALO TILPTI į `jsonb` priimtų aibę.
 *
 * Kryptis svarbi. Riba gali būti GRIEŽTESNĖ už PG (uniformizacijos kaina, žr.
 * `validation.js`), bet niekada ŠVELNESNĖ: reikšmė, kurią riba praleidžia, o PG
 * atmeta, sulaužtų inline diegimą jau po to, kai `put()` grąžino sėkmę.
 *
 * ⚠️ ŠIS FAILAS VIETOJE NEVYKDOMAS - reikia tikros PostgreSQL.
 */

const SAKNIS = path.resolve(__dirname, "..");
const DB_URL = testDatabaseUrl("jsonbdomain");
const PRALEISTI = skipWithoutPostgres();

const NUL = String.fromCharCode(0);
const VIENISAS_SUROGATAS = String.fromCharCode(0xd800);

/**
 * KANDIDATAI - REPREZENTATYVI, NE IŠSAMI APRĖPTIS (§12.1, Codex #290).
 *
 * ⚠️ ŠIS SĄRAŠAS NEĮRODO VISUOTINĖS GARANTIJOS. `jsonb` priėmimo sritis yra
 * begalinė; čia paimta po vieną atstovą kiekvienai ribos taisyklei ir po vieną
 * teisėtą reikšmę greta jos. Tai duoda REGRESIJOS aptikimą (pasikeitus PG ar
 * ribai, atstovas krenta), o ne pilną srities įrodymą - ir taip užrašyta
 * matricoje, kad eilutė neteigtų daugiau, nei testas daro.
 *
 * ⚠️ KIEKVIENA RIBOS TAISYKLĖ TURI PORĄ: draudžiama reikšmė IR jos teisėtas
 * kaimynas (tekstas, kuriame ta pati seka parašyta literaliai). Be poros būtų
 * matuojama tik viena kryptis - „riba ne švelnesnė už PG", o antroji („riba be
 * reikalo negriežtesnė") liktų nepatikrinta. Būtent joje ir buvo defektas:
 * literalus NUL escape PG praeina, o substring patikra jį atmesdavo.
 *
 * `teisetas: true` = reikšmė, kurią PRIVALO priimti abi pusės.
 */
const KANDIDATAI = [
  { vardas: "paprastas tekstas", reiksme: { t: "labas" }, teisetas: true },
  { vardas: "lietuviški rašmenys", reiksme: { t: "ąčęėįšųūž" }, teisetas: true },
  { vardas: "emoji (pilna pora)", reiksme: { t: "\u{1F469}" }, teisetas: true },
  { vardas: "gilus objektas", reiksme: { a: { b: [1, null, "x"] } }, teisetas: true },

  /** NUL taisyklė: tikras simbolis ir tekstas, kuriame seka parašyta literaliai. */
  { vardas: "NUL tekste", reiksme: { t: `a${NUL}b` } },
  { vardas: "literalus NUL escape tekste", reiksme: { t: "a \\u0000 b" }, teisetas: true },

  /** Surogato taisyklė: ta pati pora. */
  { vardas: "vienišas surogatas", reiksme: { t: `a${VIENISAS_SUROGATAS}b` } },
  { vardas: "literalus surogato escape tekste", reiksme: { t: "a \\ud800 b" }, teisetas: true },
];

async function pg(url, sql, params = []) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await c.query(sql, params);
  } finally {
    await c.end();
  }
}

function dbVardas() {
  return new URL(DB_URL).pathname.replace(/^\//, "");
}

after(async () => {
  if (PRALEISTI) return;
  await pg(adminDatabaseUrl(), `DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`).catch(() => {});
});

test("#157 PR-2: ribos priimtų reikšmių aibė TELPA į `jsonb` aibę", { skip: PRALEISTI, timeout: 180000 }, async (t) => {
  await pg(adminDatabaseUrl(), `DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`);
  await pg(adminDatabaseUrl(), `CREATE DATABASE "${dbVardas()}"`);
  execFileSync("npx", ["node-pg-migrate", "up"], {
    cwd: SAKNIS,
    env: { ...process.env, DATABASE_URL: DB_URL },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const verdiktai = [];

  for (const kandidatas of KANDIDATAI) {
    /** Ribos verdiktas. */
    let ribaPriima = true;
    try {
      paruostiReiksme(kandidatas.reiksme);
    } catch (klaida) {
      ribaPriima = false;
      assert.equal(klaida.code, "ARTIFACT_VALUE_UNSUPPORTED", `${kandidatas.vardas}: netikėtas ribos kodas`);
    }

    /**
     * PG verdiktas - per TĄ PATĮ kelią, kurį naudoja `upsertResult()`:
     * `JSON.stringify` -> parametras -> `::jsonb`.
     */
    let pgPriima = true;
    let pgKlaida = null;
    try {
      await pg(DB_URL, "SELECT $1::jsonb AS r", [JSON.stringify(kandidatas.reiksme)]);
    } catch (klaida) {
      pgPriima = false;
      pgKlaida = klaida.code;
    }

    verdiktai.push({
      vardas: kandidatas.vardas,
      teisetas: Boolean(kandidatas.teisetas),
      ribaPriima,
      pgPriima,
      pgKlaida,
    });
  }

  await t.test("riba niekada nėra ŠVELNESNĖ už `jsonb`", () => {
    const pazeidimai = verdiktai.filter((v) => v.ribaPriima && !v.pgPriima);

    assert.deepEqual(
      pazeidimai.map((v) => `${v.vardas} (PG: ${v.pgKlaida})`),
      [],
      "riba praleido reikšmę, kurios PG nepriima - inline diegimas gautų klaidą PO sėkmingo `put()`"
    );
  });

  await t.test("riba be reikalo nėra GRIEŽTESNĖ už `jsonb` ten, kur reikšmė teisėta", () => {
    /**
     * ⚠️ ANTRA KRYPTIS, IR JI TURĖJO DEFEKTĄ (Codex, #290).
     *
     * Ankstesnis rinkinys matavo tik „riba ne švelnesnė už PG". Priešinga kryptis
     * kainuoja ne mažiau: teisėtas rezultatas, kurį PG priima, o riba atmeta,
     * niekada nebus išsaugotas - job'as krinta su `ARTIFACT_VALUE_UNSUPPORTED`
     * dėl teksto, kuris yra visiškai normalus (programinio kodo transkripcija su
     * literalia escape seka).
     */
    const beReikalo = verdiktai.filter((v) => v.teisetas && v.pgPriima && !v.ribaPriima);

    assert.deepEqual(
      beReikalo.map((v) => v.vardas),
      [],
      "riba atmetė reikšmę, kurią PG priima ir kuri yra teisėtas rezultatas"
    );
  });

  await t.test("KONTROLĖ: matavimas tikrai kažką atskiria", () => {
    /**
     * Be jos ankstesnė patikra būtų tenkinama ir tada, jei PG priimtų VISKĄ
     * (tada „riba švelnesnė" neįmanoma pagal apibrėžimą), ir tada, jei riba
     * atmestų viską.
     */
    assert.ok(
      verdiktai.some((v) => v.ribaPriima && v.pgPriima),
      "bent viena reikšmė privalo praeiti ABI puses"
    );
    assert.ok(
      verdiktai.some((v) => !v.ribaPriima),
      "bent viena reikšmė privalo būti atmesta ribos"
    );
  });

  await t.test("IŠMATUOTA: kurias reikšmes `jsonb` atmeta", () => {
    /**
     * ⚠️ ŠIS TVIRTINIMAS FIKSUOJA IŠMATUOTĄ TIESĄ, NE LŪKESTĮ.
     *
     * Jei PG elgesys kada pasikeis (versija, konfigūracija), testas kris ir
     * privers peržiūrėti ribą — o ne tyliai leis jai išsiskirti su tikrove.
     */
    const pgAtmeta = verdiktai.filter((v) => !v.pgPriima).map((v) => v.vardas).sort();

    assert.deepEqual(
      pgAtmeta,
      ["NUL tekste", "vienišas surogatas"].sort(),
      `PG atmetimų aibė pasikeitė; išmatuota: ${JSON.stringify(verdiktai, null, 2)}`
    );
  });
});
