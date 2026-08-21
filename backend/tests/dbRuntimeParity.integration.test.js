const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { execFileSync } = require("child_process");
const crypto = require("crypto");
const { Pool } = require("pg");

const {
  skipWithoutPostgres,
  testDatabaseUrl,
  adminDatabaseUrl,
} = require("./helpers/postgresGuard");

const { STATUS, JOB_TYPES, OWNER_KIND } = require("../utils/jobStore/common");
const { phasesForType } = require("../utils/jobPhase");
const { assertSupportedSchemaVersion } = require("../utils/jobAuthorization");

/**
 * DB ↔ RUNTIME PARITETAS (#155, 7.2a).
 *
 * ⚠️ KODĖL ATSKIRAS FAILAS, o ne dar keli atvejai `postgresStore.integration`.
 *
 * Trys iš eilės Codex radiniai buvo TAS PATS defektas skirtingose vietose:
 * `schema_version` priėmė `1`, `type` priėmė bet ką ne-`processing` eilutėse,
 * `phase` priėmė bet ką. Kiekvieną pataisius atskirai lieka klausimas, kurio
 * niekas neatsako: KIEK DAR tokių yra?
 *
 * Šis rinkinys atsako struktūriškai. Kiekvienai UŽDARAI aibei, kurią runtime
 * laiko autoritetinga, jis:
 *
 *   1. paima leistinas reikšmes IŠ RUNTIME konstantos (ne iš rankinio sąrašo);
 *   2. įrodo, kad DB priima KIEKVIENĄ iš jų;
 *   3. įrodo, kad DB atmeta reikšmę, kurios runtime nepripažįsta.
 *
 * ⚠️ SĄRAŠAI IŠVEDAMI, NE SURAŠOMI. Pridėjus naują job tipą, statusą ar fazę
 * be atitinkamos migracijos, (2) krinta iškart - o ne po to, kai sugadinta
 * kopija bus įrašyta į produkciją. Surašyti sąrašai to negalėtų: jie liktų
 * žali, kol kas nors rankiniu būdu juos papildytų.
 *
 * ⚠️ DIVERGENCIJOS KRYPTIS SVARBI. Griežtesnė DB nei runtime atmestų teisėtą
 * įrašą (matoma iškart, garsiai). Laisvesnė DB nei runtime - tyli: eilutė
 * įrašoma sėkmingai, restore praneša sėkmę, o gedimas išlenda vėliau ir
 * kitoje vietoje. Būtent šią kryptį testai ir gaudo.
 */

const DB_URL = testDatabaseUrl("parity");

let pool;

async function vykdyti(url, sql) {
  const p = new Pool({ connectionString: url });
  try {
    await p.query(sql);
  } finally {
    await p.end();
  }
}

/** Įrašo eilutę APEINANT store'ą - tikrinamas DB, ne JS. */
async function irasyti(perrasymai = {}) {
  const now = new Date().toISOString();
  const eilute = {
    id: crypto.randomUUID(),
    type: JOB_TYPES.TRANSCRIPTION,
    status: STATUS.QUEUED,
    progress_known: false,
    schema_version: 2,
    created_at: now,
    updated_at: now,
    ...perrasymai,
  };
  const laukai = Object.keys(eilute);
  await pool.query(
    `INSERT INTO jobs (${laukai.map((l) => `"${l}"`).join(", ")})
     VALUES (${laukai.map((_, i) => `$${i + 1}`).join(", ")})`,
    laukai.map((l) => eilute[l])
  );
}

async function priima(eilute, kodel) {
  await assert.doesNotReject(
    () => irasyti(eilute),
    `DB ATMETĖ reikšmę, kurią runtime laiko teisėta: ${kodel}. ` +
      "Griežtesnė DB nei runtime blokuoja teisėtus įrašus."
  );
}

async function atmeta(eilute, kodel) {
  await assert.rejects(
    () => irasyti(eilute),
    (err) => err.code === "23514" || err.code === "23502",
    `DB PRIĖMĖ reikšmę, kurią runtime atmeta: ${kodel}. ` +
      "Laisvesnė DB nei runtime yra TYLI divergencija - įrašas praeina, " +
      "restore praneša sėkmę, o gedimas išlenda vėliau ir kitoje vietoje."
  );
}

test("DB ↔ runtime paritetas", { skip: skipWithoutPostgres() }, async (t) => {
  const vardas = new URL(DB_URL).pathname.replace(/^\//, "");

  await vykdyti(adminDatabaseUrl(), `DROP DATABASE IF EXISTS "${vardas}" WITH (FORCE)`);
  await vykdyti(adminDatabaseUrl(), `CREATE DATABASE "${vardas}"`);

  execFileSync("npx", ["node-pg-migrate", "up"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, DATABASE_URL: DB_URL },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  pool = new Pool({ connectionString: DB_URL });

  t.after(async () => {
    await pool.end().catch(() => {});
    await vykdyti(adminDatabaseUrl(), `DROP DATABASE IF EXISTS "${vardas}" WITH (FORCE)`);
  });

  t.beforeEach(async () => {
    await pool.query("TRUNCATE jobs CASCADE");
  });

  /* ── type ────────────────────────────────────────────────────────────── */

  await t.test("type: DB priima KIEKVIENĄ JOB_TYPES reikšmę", async () => {
    for (const tipas of Object.values(JOB_TYPES)) {
      await priima({ type: tipas }, `JOB_TYPES.${tipas}`);
    }
  });

  await t.test("type: nežinomas atmetamas IR ne-processing eilutėse", async () => {
    /**
     * ⚠️ `assertConsistentJobRecord()` tipą tikrina TIK `processing` eilutėse
     * (`jobPhase.js:161`), tad `queued` ar terminalus įrašas su `"bogus"`
     * praeitų iki pirmos gyvavimo ciklo operacijos, kuri mestų
     * `UNKNOWN_JOB_TYPE`. DB aibė privalo būti uždara visoms būsenoms.
     */
    for (const status of [STATUS.QUEUED, STATUS.COMPLETED, STATUS.FAILED, STATUS.CANCELLED]) {
      await atmeta({ type: "bogus", status }, `nežinomas tipas su status=${status}`);
    }
  });

  /* ── status ──────────────────────────────────────────────────────────── */

  await t.test("status: DB priima KIEKVIENĄ STATUS reikšmę", async () => {
    for (const status of Object.values(STATUS)) {
      const extra = status === STATUS.PROCESSING ? { phase: "transcribing" } : {};
      await priima({ status, ...extra }, `STATUS.${status}`);
    }
  });

  await t.test("status: nežinomas atmetamas", async () => {
    await atmeta({ status: "paused" }, "nežinomas statusas");
  });

  /* ── phase ───────────────────────────────────────────────────────────── */

  await t.test("phase: DB priima KIEKVIENĄ phasesForType() reikšmę", async () => {
    for (const tipas of Object.values(JOB_TYPES)) {
      for (const faze of phasesForType(tipas)) {
        await priima(
          { type: tipas, status: STATUS.PROCESSING, phase: faze },
          `${tipas}/${faze}`
        );
      }
    }
  });

  await t.test("phase: kito tipo fazė atmetama", async () => {
    /**
     * Aibių persidengimas nėra atsitiktinis: `validating` teisėta abiem
     * tipams, o `transcribing` ir `generating_protocol` - ne. Testas
     * išvedamas, tad naujos fazės pridėjimas be migracijos krinta.
     */
    for (const tipas of Object.values(JOB_TYPES)) {
      const savos = new Set(phasesForType(tipas));
      const svetimos = Object.values(JOB_TYPES)
        .filter((k) => k !== tipas)
        .flatMap((k) => phasesForType(k))
        .filter((f) => !savos.has(f));

      for (const faze of svetimos) {
        await atmeta(
          { type: tipas, status: STATUS.PROCESSING, phase: faze },
          `${tipas} su svetima faze "${faze}"`
        );
      }
    }
  });

  /* ── owner_kind ──────────────────────────────────────────────────────── */

  await t.test("owner_kind: DB priima KIEKVIENĄ OWNER_KIND reikšmę", async () => {
    for (const rusis of Object.values(OWNER_KIND)) {
      const ownerId = rusis === OWNER_KIND.USER ? crypto.randomUUID() : null;
      await priima({ owner_kind: rusis, owner_id: ownerId }, `OWNER_KIND.${rusis}`);
    }
  });

  await t.test("owner_kind: nežinoma rūšis atmetama", async () => {
    await atmeta({ owner_kind: "service", owner_id: null }, "nežinoma nuosavybės rūšis");
  });

  /* ── schema_version ──────────────────────────────────────────────────── */

  await t.test("schema_version: DB aibė SUTAMPA su assertSupportedSchemaVersion()", async () => {
    /**
     * ⚠️ AUTORITETAS KLAUSIAMAS TIESIOGIAI, ne kartojamas.
     *
     * Ankstesnė constraint'o versija leido `1`, nors
     * `assertSupportedSchemaVersion()` (`jobAuthorization.js:65`) atmeta
     * KIEKVIENĄ ne-`null` reikšmę, kuri nėra `2`. Restore būtų pranešęs sėkmę,
     * o job'as niekada nepasileidęs.
     *
     * Čia kiekviena kandidatė paduodama TIKRAM autoritetui, ir DB lūkestis
     * išvedamas iš jo atsakymo - tad autoritetui pasikeitus testas kris.
     */
    /**
     * ⚠️ APSAUGA NUO TYLAUS KLAIDINGO REZULTATO. Jei autoritetas nebūtų
     * eksportuotas, `catch` KIEKVIENĄ reikšmę priskirtų „runtime atmeta", ir
     * testas kristų (ar praeitų) dėl visiškai kitos priežasties nei tikrina.
     * Pirmiausia įsitikinama, kad kviečiame tikrą funkciją.
     */
    assert.equal(
      typeof assertSupportedSchemaVersion,
      "function",
      "autoritetas neeksportuotas - testas tikrintų savo catch bloką, ne DB paritetą"
    );
    assert.doesNotThrow(
      () => assertSupportedSchemaVersion({ id: "x", schemaVersion: 2 }),
      "dabartinė era privalo būti priimama - kitaip klasifikatorius sugedęs"
    );

    for (const versija of [null, 1, 2, 3, 0, -1, 99]) {
      let runtimePriima = true;
      try {
        assertSupportedSchemaVersion({ id: "x", schemaVersion: versija });
      } catch {
        runtimePriima = false;
      }

      if (runtimePriima) {
        await priima({ schema_version: versija }, `era ${versija} (runtime priima)`);
      } else {
        await atmeta({ schema_version: versija }, `era ${versija} (runtime atmeta)`);
      }
    }
  });
});
