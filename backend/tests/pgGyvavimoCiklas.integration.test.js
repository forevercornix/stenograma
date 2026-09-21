const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");

const { skipWithoutPostgres, testDatabaseUrl, adminDatabaseUrl } = require("./helpers/postgresGuard");
const { poolasTestui, uzdarytiPoola, poolKlaidos } = require("./helpers/resourceStack");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * `pg` GYVAVIMO CIKLAS SU TIKRA BAZE (#380 D1, D7).
 *
 * ⚠️ KĄ ŠIS FAILAS ĮRODO, KO `resursuKruva` NEĮRODO. Anas tikrina mechanizmą su pool'o
 * dubliu — deterministiškai, bet apie tikrą `pg` elgseną nieko nepasako. Čia tikrinama,
 * kad tas pats mechanizmas veikia su TIKRU pool'u: kad grąžintas klientas leidžia
 * uždaryti be ribos, ir kad nutraukta jungtis pasiekia klausytoją kaip TIKRA klaida.
 *
 * ⚠️ ŠIS FAILAS VIETOJE NEVYKDOMAS — reikia tikros PostgreSQL.
 */

const DB_URL = testDatabaseUrl("pggyvavimo");
const PRALEISTI = skipWithoutPostgres();

function dbVardas() {
  return new URL(DB_URL).pathname.replace(/^\//, "");
}

async function adminPg(sql) {
  const c = new Client({ connectionString: adminDatabaseUrl() });
  await c.connect();
  try {
    return await c.query(sql);
  } finally {
    await c.end();
  }
}

/**
 * ⚠️ SAVA BAZĖ, NE BENDRA. Testai čia sąmoningai palieka nutekėjusį klientą ir nutraukia
 * backend'ą; bendroje bazėje tai būtų šalutinis poveikis gretimiems failams.
 *
 * ⚠️ SCHEMOS ČIA NEREIKIA. Tikrinamas jungčių gyvavimo ciklas, ne SQL semantika, tad
 * `SELECT 1` pakanka, o migracijos tik pailgintų failą be jokio tvirtinimo.
 */
before(async () => {
  if (PRALEISTI) return;
  await adminPg(`DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`);
  await adminPg(`CREATE DATABASE "${dbVardas()}"`);
});

after(async () => {
  if (PRALEISTI) return;
  await adminPg(`DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`).catch(() => {});
});

test(
  "#380 D1: paimtas ir GRĄŽINTAS klientas — uždarymas praeina be ribos",
  { skip: PRALEISTI, timeout: 120000 },
  async (t) => {
    /**
     * ⚠️ TAI KONTROLĖ MUTACIJAI M2. Be jos „nutekėjimas pagaunamas" suderinamas su
     * realizacija, kuri kiekvieną uždarymą laiko nutekėjimu — tokia praeitų mutacijos
     * testą ir nuverstų visus likusius.
     */
    const { pool } = poolasTestui(t, { dsn: DB_URL, vardas: "kontrolė" });

    const klientas = await pool.connect();
    try {
      const { rows } = await klientas.query("SELECT 1 AS x");
      assert.equal(rows[0].x, 1);
    } finally {
      klientas.release();
    }

    assert.equal(pool.totalCount - pool.idleCount, 0, "grąžinus klientą pool'e nieko neturi likti");
  }
);

test(
  "#380 D1: NEGRĄŽINTAS klientas — uždarymas krenta per ribą su ĮVARDYTA diagnostika",
  { skip: PRALEISTI, timeout: 120000 },
  async () => {
    /**
     * ⚠️ POOL'AS ČIA NEREGISTRUOJAMAS `t.after` — uždaroma RANKOMIS, kad kritimą matytų
     * pats testas. Registruotas jis kristų `after` kabliuose, ir tvirtinimo apie
     * diagnostikos TEKSTĄ padaryti nebūtų kur.
     */
    const { Pool } = require("pg");
    const { stebetiPoola } = require("./helpers/resourceStack");
    const pool = stebetiPoola(new Pool({ connectionString: DB_URL }), {
      vardas: "nutekejes",
      dsn: DB_URL,
    });

    /** Paimam ir SĄMONINGAI negrąžinam — tiksliai tai, ką daro regresija produkcijoje. */
    const klientas = await pool.connect();
    await klientas.query("SELECT 1");

    await assert.rejects(
      () => uzdarytiPoola(pool),
      (e) =>
        /POOL_CLOSE_TIMEOUT nutekejes/.test(e.message) &&
        /paimta klientų: 1/.test(e.message) &&
        /release\(\)/.test(e.message),
      "diagnostika privalo įvardyti pool'ą, paimtų klientų skaičių ir priežastį"
    );

    klientas.release();
  }
);

test(
  "#380 D7: NUTRAUKTA jungtis ne valymo metu — registruojama kaip TIKRA klaida",
  { skip: PRALEISTI, timeout: 120000 },
  async (t) => {
    /**
     * ⚠️ TAI M4 SCENARIJUS: backend'ą nutraukia TESTAS, ne helper'io valymas. Skirtumą
     * nustato ŽYMĖ, kurią helper'is įjungia prieš savo paties `pg_terminate_backend`,
     * o ne pranešimo tekstas — abiem atvejais `pg` sako tą patį.
     */
    const { pool } = poolasTestui(t, { dsn: DB_URL, vardas: "nutraukiamas" });

    const klientas = await pool.connect();
    const { rows } = await klientas.query("SELECT pg_backend_pid() AS pid");
    const pid = rows[0].pid;

    /** Nutraukia TREČIA jungtis — testas, ne valymas. */
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    try {
      await c.query("SELECT pg_terminate_backend($1)", [pid]);
    } finally {
      await c.end().catch(() => {});
    }

    /** Klausytojas turi suspėti pamatyti nutrūkusią jungtį. */
    await new Promise((r) => setTimeout(r, 500));
    klientas.release();

    const klaidos = poolKlaidos(pool);
    assert.ok(
      klaidos.tikros.length > 0,
      `nutraukta jungtis privalo būti UŽRAŠYTA kaip tikra klaida, gauta: ${JSON.stringify(klaidos)}`
    );
    assert.deepEqual(klaidos.valymo, [], "tai NĖRA valymo sukelta klaida");
  }
);
