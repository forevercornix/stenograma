const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Client } = require("pg");

const { skipWithoutPostgres, testDatabaseUrl, adminDatabaseUrl } = require("./helpers/postgresGuard");

/**
 * ARTEFAKTŲ SAUGYKLOS PRIJUNGIMAS PRIE `initializePostgres()` (#157, PR-7, 3 sąlyga).
 *
 * ⚠️ ČIA STEBĖTOJAS PANAUDOJAMAS PIRMĄ KARTĄ PAGAL PASKIRTĮ.
 *
 * Ankstesnis žingsnis įrodė, kad verdiktas rodo `rasymas_neprijungtas`. Šis įrodo,
 * kad TA PATI funkcija, prieš TĄ PAČIĄ bazę, po prijungimo grąžina žalią — ir abu
 * matavimai daromi VIENAME teste, kad „prieš" ir „po" nebūtų du atskiri teiginiai
 * apie skirtingas sąlygas.
 *
 * ⚠️ BENDROS BŪSENOS RIBA — KLAUSIMAS PRIEŠ, NE PO.
 *
 * Šis failas KEIČIA `process.env` (kitaip prijungimo apskritai neišbandysi: jį
 * valdo `ARTIFACT_STORE_BACKEND`) ir `jobStore` singleton'ą. Todėl kiekvienas
 * testas:
 *   — įsimena ir atstato `ARTIFACT_STORE_BACKEND`, `ARTIFACT_FS_ROOT`, `DATABASE_URL`;
 *   — išvalo `require.cache` PRIEŠ ir PO, tad singleton'as nepersineša;
 *   — uždaro store'ą `finally` bloke, įskaitant kelią, kuriame startas krito.
 * Sava DB su savo priesaga, o pool'as uždaromas PRIEŠ `DROP ... WITH (FORCE)`.
 */

const PRALEISTI = skipWithoutPostgres();
const DB_URL = PRALEISTI ? null : testDatabaseUrl("artefaktu_prijungimas");
const ŠAKNIS = path.resolve(__dirname, "..");

async function pg(url, sql, params = []) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await c.query(sql, params);
  } finally {
    await c.end();
  }
}

const dbVardas = () => new URL(DB_URL).pathname.replace(/^\//, "");

/** Kiek jungčių į testinę DB atvira DABAR (be mūsų pačių matavimo jungties). */
async function atvirosJungtys() {
  const { rows } = await pg(
    adminDatabaseUrl(),
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
    [dbVardas()]
  );
  return rows[0].n;
}

/**
 * Laukia, kol jungčių nebeliks, bet NE ILGIAU nei riba.
 *
 * ⚠️ TAI NE ŠVELNESNĖ ASERCIJA. `pool.end()` nutraukia jungtis grakščiai, ir
 * PostgreSQL backend'ą iš `pg_stat_activity` pašalina jam realiai pasibaigus —
 * tarp šių dviejų įvykių yra milisekundžių langas, kuris CI apkrovoje virstų
 * atsitiktiniais kritimais. Nutekėjęs pool'as laiko jungtis NEAPIBRĖŽTAI ilgai,
 * tad riba jo nepaslepia: po jos testas krenta lygiai taip pat.
 */
async function laukiantUzdarymo(ribaMs = 3000) {
  const pabaiga = Date.now() + ribaMs;
  let n = await atvirosJungtys();

  while (n > 0 && Date.now() < pabaiga) {
    await new Promise((r) => setTimeout(r, 50));
    n = await atvirosJungtys();
  }

  return n;
}

/**
 * Paleidžia `initializePostgres()` su duota aplinka ir viską atstato.
 *
 * ⚠️ `require.cache` VALOMAS IR PRIEŠ, IR PO. Tik po — nepakanka: ankstesnis
 * failo testas jau galėjo palikti įkeltą modulį su savo `store`, ir matuotume
 * ne tai, ką paleidome.
 */
async function paleistiStarta(aplinka, tikrinti) {
  const buve = {};
  for (const raktas of ["ARTIFACT_STORE_BACKEND", "ARTIFACT_FS_ROOT", "DATABASE_URL"]) {
    buve[raktas] = process.env[raktas];
  }

  const kelias = require.resolve("../utils/jobStore");
  delete require.cache[kelias];

  process.env.DATABASE_URL = DB_URL;
  for (const [raktas, reiksme] of Object.entries(aplinka)) {
    if (reiksme === undefined) delete process.env[raktas];
    else process.env[raktas] = reiksme;
  }
  delete process.env.ARTIFACT_STORE_BACKEND;
  delete process.env.ARTIFACT_FS_ROOT;
  for (const [raktas, reiksme] of Object.entries(aplinka)) {
    if (reiksme !== undefined) process.env[raktas] = reiksme;
  }

  const jobStore = require("../utils/jobStore");
  let store = null;

  try {
    return await tikrinti(jobStore, async () => {
      store = await jobStore._initializePostgresForTests();
      return store;
    });
  } finally {
    if (store) await store.close().catch(() => {});
    delete require.cache[kelias];
    for (const [raktas, reiksme] of Object.entries(buve)) {
      if (reiksme === undefined) delete process.env[raktas];
      else process.env[raktas] = reiksme;
    }
  }
}

before(async () => {
  if (PRALEISTI) return;
  const admin = adminDatabaseUrl();
  await pg(admin, `DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`);
  await pg(admin, `CREATE DATABASE "${dbVardas()}"`);
  execFileSync("npx", ["node-pg-migrate", "up"], {
    cwd: ŠAKNIS,
    env: { ...process.env, DATABASE_URL: DB_URL },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
});

after(async () => {
  if (PRALEISTI) return;
  await pg(adminDatabaseUrl(), `DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`).catch(() => {});
});

test("`fs`: saugykla prijungiama, ir stebėtojo verdiktas pavirsta iš raudono į žalią", { skip: PRALEISTI }, async () => {
  const saknis = fs.mkdtempSync(path.join(os.tmpdir(), "stenograma-prijungimas-"));

  try {
    await paleistiStarta({ ARTIFACT_STORE_BACKEND: "fs", ARTIFACT_FS_ROOT: saknis }, async (jobStore, startas) => {
      const { Pool } = require("pg");
      const { createPostgresStore } = require("../utils/jobStore/postgresStore");
      const { nustatytiPrijungimoBusena, RADINIAI } = require("../utils/artifactStore/prijungimoBusena");

      /**
       * ⚠️ „PRIEŠ" MATUOJAMAS TA PAČIA FUNKCIJA IR TA PAČIA BAZE.
       *
       * Kitaip „buvo raudona, tapo žalia" būtų du teiginiai apie dvi skirtingas
       * sąlygas, ir pokytį galėtų paaiškinti bet kuri iš jų.
       */
      const matavimoPool = new Pool({ connectionString: DB_URL });
      let pries;
      try {
        pries = await nustatytiPrijungimoBusena(matavimoPool, createPostgresStore(matavimoPool), {
          env: { ARTIFACT_STORE_BACKEND: "fs", ARTIFACT_FS_ROOT: saknis },
        });
      } finally {
        await matavimoPool.end().catch(() => {});
      }

      assert.deepEqual(pries.radiniai, [RADINIAI.RASYMAS_NEPRIJUNGTAS], "prieš prijungimą — raudona");

      const store = await startas();
      const busena = store.saugykluBusena();

      assert.equal(busena.rasymoBackend, "fs", "`rasymoSaugykla` privalo būti paduota");
      assert.deepEqual(busena.registruotiTipai, ["fs"]);

      const po = jobStore.getArtifactStoreStatus();
      assert.equal(po.ok, true, `po prijungimo privalo būti žalia: ${po.santrauka}`);
      assert.deepEqual(po.radiniai, []);
      assert.equal(po.rasymoBackend, "fs");
      assert.equal(po.parinktas, "fs");
    });
  } finally {
    fs.rmSync(saknis, { recursive: true, force: true });
  }
});

/**
 * ⚠️ `inline` SAUGYKLA NEPADUODAMA, IR TAI TIKRINAMA, NE NUMANOMA.
 *
 * `inlineStore.backend` yra `"inline"`, o rašymo kelias iš `backend` gamina
 * `storage_type` KARTU su `storage_key`; `job_results_storage_shape` inline šakai
 * reikalauja `storage_key IS NULL`. Paduota inline saugykla sulaužytų užbaigimą
 * KIEKVIENAM diegimui, kuris #157 dar nenaudoja — ir tai nutiktų tyliai iki pirmo
 * `finish()`.
 */
test("`inline` (numatytasis): saugykla NEPADUODAMA, elgesys nepakitęs", { skip: PRALEISTI }, async () => {
  await paleistiStarta({}, async (jobStore, startas) => {
    const store = await startas();
    const busena = store.saugykluBusena();

    assert.equal(busena.rasymoBackend, null, "inline rašymo saugyklos NETURI gauti");
    assert.deepEqual(busena.registruotiTipai, []);

    const verdiktas = jobStore.getArtifactStoreStatus();
    assert.equal(verdiktas.ok, true);
    assert.equal(verdiktas.parinktas, "inline");
  });
});

/**
 * ⚠️ TIKRINAMOS ABI GEDIMO PUSĖS: KAD KRITO IR KAD NIEKO NEPALIKO.
 *
 * Startas, kuris meta klaidą, bet palieka atvirą jungčių pool'ą, procese, kuris
 * vis tiek nepakils, laiko jungtis iki jo pabaigos. Matuojama `pg_stat_activity`,
 * ne kodo forma.
 */
test("netinkama konfigūracija STABDO startą ir neužlaiko jungčių", { skip: PRALEISTI }, async () => {
  await paleistiStarta({ ARTIFACT_STORE_BACKEND: "s3" }, async (jobStore, startas) => {
    await assert.rejects(startas, /ARTIFACT_STORE_BACKEND="s3", bet trūksta/);
    assert.equal(await laukiantUzdarymo(), 0, "kritęs startas privalo uždaryti pool'ą");
  });
});

/**
 * ⚠️ NETINKAMA SAUGYKLA MATOMA STARTE, NE PER PIRMĄ OPERACIJĄ.
 *
 * `patikrintiSaugykla()` yra privalomas kontrakto metodas būtent dėl to (#290):
 * be jo netinkamas `ARTIFACT_FS_ROOT` paaiškėdavo jau PO brangaus tiekėjo darbo.
 * Čia tikrinama, kad `initializePostgres()` to laukia, o ne atideda.
 */
test("netinkamas `ARTIFACT_FS_ROOT` stabdo startą, ne pirmą rašymą", { skip: PRALEISTI }, async () => {
  const failas = path.join(os.tmpdir(), `stenograma-ne-katalogas-${process.pid}`);
  fs.writeFileSync(failas, "tai failas, ne katalogas", "utf8");

  try {
    await paleistiStarta({ ARTIFACT_STORE_BACKEND: "fs", ARTIFACT_FS_ROOT: failas }, async (jobStore, startas) => {
      await assert.rejects(startas);
      assert.equal(await laukiantUzdarymo(), 0, "kritęs startas privalo uždaryti pool'ą");
    });
  } finally {
    fs.unlinkSync(failas);
  }
});
