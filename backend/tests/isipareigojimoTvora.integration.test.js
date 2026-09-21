const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { Pool, Client } = require("pg");

const { skipWithoutPostgres, testDatabaseUrl, adminDatabaseUrl } = require("./helpers/postgresGuard");
const attemptRegistry = require("../utils/attemptRegistry");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * COMMIT'O TVORA IR ŠLAVĖJO SERIALIZAVIMAS (#351, R1–R3).
 *
 * ⚠️ KĄ ŠIS FAILAS ĮRODO. Kad `isipareigoti()` atmeta pavėlavusį rašytoją, kad
 * atmetimas ATŠAUKIA transakciją (o ne palieka pusiau įsipareigotą būseną), ir kad
 * šlavėjo pakartotinė patikra su rašytoju SERIALIZUOJASI, o ne lenktyniauja.
 *
 * ⚠️ ŠIS FAILAS VIETOJE NEVYKDOMAS — reikia tikros PostgreSQL.
 */

const SAKNIS = path.resolve(__dirname, "..");
const DB_URL = testDatabaseUrl("isipareigojimotvora");
const PRALEISTI = skipWithoutPostgres();
const MAX = attemptRegistry.MAX_RASYMO_TRUKME_MS;

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

async function perkurtiDb() {
  await adminPg(`DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`);
  await adminPg(`CREATE DATABASE "${dbVardas()}"`);
  execFileSync("npx", ["node-pg-migrate", "up"], {
    cwd: SAKNIS,
    env: { ...process.env, DATABASE_URL: DB_URL },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

after(async () => {
  if (PRALEISTI) return;
  await adminPg(`DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`).catch(() => {});
});

/** Minimalus job'as: `job_result_attempts` turi FK į `jobs`. */
async function sukurtiJoba(vykdytojas, id) {
  await vykdytojas.query(
    `INSERT INTO jobs (id, type, status, owner_kind, created_at, updated_at)
     VALUES ($1, 'protocol', 'processing', 'unowned', now(), now())`,
    [id]
  );
  return id;
}

/**
 * Bandymas su VALDOMU amžiumi. `created_at` rašomas tiesiogiai — tai vienintelis
 * būdas paduoti „prieš valandą" nesukant laikrodžio ir nekeičiant produkcinės
 * konstantos (testinio įvesties taško tam nereikia).
 */
async function sukurtiBandyma(vykdytojas, { jobId, amziusMs = 0, busena = "pending" }) {
  const attemptId = attemptRegistry.naujasBandymas();
  const raktas = attemptRegistry.bandymoRaktas(jobId, attemptId);
  await vykdytojas.query(
    `INSERT INTO job_result_attempts
       (attempt_id, job_id, storage_type, storage_key, busena, created_at, updated_at)
     VALUES ($1, $2, 'fs', $3, $4,
             clock_timestamp() - ($5::double precision * INTERVAL '1 millisecond'),
             now())`,
    [attemptId, String(jobId), raktas, busena, amziusMs]
  );
  return { attemptId, raktas };
}

async function busena(vykdytojas, attemptId) {
  const { rows } = await vykdytojas.query(
    "SELECT busena FROM job_result_attempts WHERE attempt_id = $1",
    [attemptId]
  );
  return rows.length ? rows[0].busena : null;
}

/**
 * LAUKIMAS YRA GEDIMAS, IR JIS PRIVALO KRISTI ASERCIJA (#351, po M5b/M7 matavimo).
 *
 * ⚠️ IŠMATUOTA: mutacijos M5b (`35611849584`) ir M7 (`35616863123`) nukovė build'ą ne
 * asercija, o 20 min job timeout'u — nors testai turi `timeout: 180000`. Priežastis ne
 * „jungtis laiko procesą": tai SAVITARPIO LAUKIMAS pačiame teste. Rašytojo `COMMIT`
 * stovi PO patikros `await`, tad be `NOWAIT` patikra laukia rašytojo, o rašytojas
 * niekada nepasiekia `COMMIT`. `node:test` testą nutraukia, bet `finally` nepasiekiamas,
 * pool'e lieka paimta jungtis, ir `pool.end()` laukia jos amžinai.
 *
 * ⚠️ REGRESIJA TADA ATRODO KAIP INFRASTRUKTŪROS GEDIMAS, NE KAIP KODO REGRESIJA. Būtent
 * tai šis helper'is ir taiso: laukimas paverčiamas įvardyta asercija.
 *
 * ⚠️ ❌ NE `lock_timeout` IR NE `statement_timeout`. Jiedu meta TĄ PATĮ `55P03` kaip
 * `NOWAIT`, tad M5b būtų klasifikuota kaip `uzimtas` ir PRAEITŲ ŽALIAI — testas priimtų
 * laukimą kaip įrodymą, kad laukimo nėra. Riba matuojama Node pusėje, ne DB.
 *
 * ⚠️ ATBLOKUOTI PRIVALOMA PRIEŠ `assert.fail`. Be to `finally` ir `pool.end()` vis tiek
 * nebaigtų — testas kristų teisingai, o job'as vis tiek kabėtų.
 *
 * @param {Promise<any>} zadas       jau pradėtas darbas (ne funkcija: laikas skaičiuojamas nuo starto)
 * @param {object}       o
 * @param {Function}     o.atblokuoti  paleidžia užraktą, kad `zadas` galėtų grįžti
 * @param {string}       o.pranesimas  ką operatorius turi perskaityti
 */
const LAUKIMO_RIBA_MS = 5_000;

function delsa(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ribotas(zadas, { atblokuoti, pranesimas, ms = LAUKIMO_RIBA_MS }) {
  /** Nei viena šaka nemeta: rezultatas paverčiamas duomenimis, kad `race` liktų švarus. */
  const saugus = zadas.then(
    (reiksme) => ({ ok: true, reiksme }),
    (klaida) => ({ ok: false, klaida })
  );

  const laikmatis = delsa(ms).then(() => "TIMEOUT");
  const rezultatas = await Promise.race([saugus, laikmatis]);
  if (rezultatas !== "TIMEOUT") return rezultatas;

  /**
   * ⚠️ PIRMA ATBLOKUOJAM, TADA LAUKIAM `saugus`. Antra eilutė yra ta, kuri grąžina
   * jungtį į pool'ą; be jos `pool.end()` kabėtų net ir po teisingos asercijos.
   */
  await atblokuoti();
  await saugus;

  assert.fail(pranesimas);
}

/**
 * ATBLOKAVIMAS PER `pg_terminate_backend` — kai blokuotojas nėra testo valdomas.
 *
 * ⚠️ NAUDOJAMA TEN, KUR UŽRAKTĄ LAIKO POOL'O AR PRODUKCINIO KODO JUNGTIS. Tokiai
 * `ROLLBACK` nepasiųsi: testas jos neturi. `pg_blocking_pids()` atsako, KAS konkrečiai
 * blokuoja duotą backend'ą, tad nutraukiama tiksliai, o ne visos jungtys iš eilės.
 *
 * ⚠️ TREČIA, NEPRIKLAUSOMA JUNGTIS. Pool'o klientas čia reikštų priklausomybę nuo to
 * paties pool'o, kurio jungtis ir kabo.
 *
 * @param {number} pid  UŽBLOKUOTO backend'o `pg_backend_pid()`, paimtas IŠ ANKSTO
 */
function atblokuotiPer(pid) {
  return async () => {
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    try {
      await c.query("SELECT pg_terminate_backend(p) FROM unnest(pg_blocking_pids($1)) p", [pid]);
    } finally {
      await c.end().catch(() => {});
    }
  };
}

/* ═══════════════════════ R1 — COMMIT'O TVORA ═══════════════════════ */

test(
  "#351 R1: PASENĘS `pending` — `isipareigoti()` META, nuoroda ir ankstesnis `committed` NEPAKITĘ",
  { skip: PRALEISTI, timeout: 180000 },
  async (t) => {
    /**
     * ⚠️ ŠIS TESTAS TIKRINA DU DALYKUS VIENU METU, IR TAI SĄMONINGA.
     *
     * Vien „metė" nepakanka: `isipareigoti()` PIRMASIS sakinys jau nuvertina buvusį
     * `committed`. Jei klaida būtų mesta be transakcijos atšaukimo, registras liktų be
     * NĖ VIENO gyvo bandymo, o `job_results` rodytų į objektą, kurio niekas nebegina.
     * Todėl tvirtinama ir tai, kad senasis `committed` IŠLIKO.
     */
    await perkurtiDb();
    const pool = new Pool({ connectionString: DB_URL });
    t.after(async () => pool.end().catch(() => {}));

    const jobId = await sukurtiJoba(pool, "11111111-1111-4111-8111-111111111111");
    const senas = await sukurtiBandyma(pool, { jobId, busena: "committed" });
    const pavelaves = await sukurtiBandyma(pool, { jobId, amziusMs: MAX + 60_000 });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await assert.rejects(
        () => attemptRegistry.isipareigoti(client, { jobId, attemptId: pavelaves.attemptId }),
        (e) => e.code === "ATTEMPT_COMMIT_TOO_LATE",
        "pavėlavęs rašytojas privalo būti atmestas"
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    assert.equal(await busena(pool, senas.attemptId), "committed", "senasis NELIKO nuvertintas");
    assert.equal(await busena(pool, pavelaves.attemptId), "pending", "pavėlavęs NEĮSIPAREIGOJO");
  }
);

test(
  "#351 R1: EILUTĖS NEBĖRA — meta, transakcija atšaukiama",
  { skip: PRALEISTI, timeout: 180000 },
  async (t) => {
    /**
     * Šlavėjas eilutę jau pašalino. `rowCount === 0`, ir vienintelis teisingas
     * atsakymas yra metimas: objektas nebe rašytojo.
     */
    await perkurtiDb();
    const pool = new Pool({ connectionString: DB_URL });
    t.after(async () => pool.end().catch(() => {}));

    const jobId = await sukurtiJoba(pool, "22222222-2222-4222-8222-222222222222");
    const senas = await sukurtiBandyma(pool, { jobId, busena: "committed" });
    const dinges = await sukurtiBandyma(pool, { jobId });
    await pool.query("DELETE FROM job_result_attempts WHERE attempt_id = $1", [dinges.attemptId]);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await assert.rejects(
        () => attemptRegistry.isipareigoti(client, { jobId, attemptId: dinges.attemptId }),
        (e) => e.code === "ATTEMPT_COMMIT_TOO_LATE"
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    assert.equal(await busena(pool, senas.attemptId), "committed", "nuvertinimas ATŠAUKTAS");
  }
);

test(
  "#351 R1: `abandoned` eilutė — meta (būsena yra dalis tvoros)",
  { skip: PRALEISTI, timeout: 180000 },
  async (t) => {
    /**
     * ⚠️ `abandoned` reiškia, kad šlavėjas jau laiko bandymą baigtu. Leidus jam grįžti
     * į `committed`, prikeltume nuorodą į objektą, kurio retencija nebegina — ir tai
     * nepriklauso nuo amžiaus: eilutė gali būti VISAI ŠVIEŽIA.
     */
    await perkurtiDb();
    const pool = new Pool({ connectionString: DB_URL });
    t.after(async () => pool.end().catch(() => {}));

    const jobId = await sukurtiJoba(pool, "33333333-3333-4333-8333-333333333333");
    const atmestas = await sukurtiBandyma(pool, { jobId, amziusMs: 0, busena: "abandoned" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await assert.rejects(
        () => attemptRegistry.isipareigoti(client, { jobId, attemptId: atmestas.attemptId }),
        (e) => e.code === "ATTEMPT_COMMIT_TOO_LATE"
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    assert.equal(await busena(pool, atmestas.attemptId), "abandoned");
  }
);

test(
  "#351 R1: transakcija PRASIDEDA prieš ribą, tvora vertinama PO jos — atmeta",
  { skip: PRALEISTI, timeout: 180000 },
  async (t) => {
    /**
     * ⚠️ TAI VIENINTELIS TESTAS, SKIRIANTIS `clock_timestamp()` NUO `now()`.
     *
     * Eilutė sukuriama amžiaus `MAX - 5 s` — transakcijos PRADŽIOJE ji dar tvoros
     * viduje. Tada laukiama, kol ji peržengia ribą, ir tik tada kviečiamas
     * `isipareigoti()`. `now()` (transakcijos pradžios laikas) tvorą praleistų, nes
     * jis užfiksuotas PRIEŠ laukimą; `clock_timestamp()` matuoja sakinio vykdymo
     * momentą ir atmeta.
     *
     * ⚠️ LAUKIAMA 6 s, NE MINUTĖS: riba pasiekiama laikrodžiu, o ne konstanta, todėl
     * eilutė gaminama tiksliai ties riba. Produkcinė konstanta nekeičiama.
     */
    await perkurtiDb();
    const pool = new Pool({ connectionString: DB_URL });
    t.after(async () => pool.end().catch(() => {}));

    const jobId = await sukurtiJoba(pool, "44444444-4444-4444-8444-444444444444");
    const bandymas = await sukurtiBandyma(pool, { jobId, amziusMs: MAX - 5_000 });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      /** Transakcijos `now()` užfiksuotas ČIA — kol eilutė dar tvoros viduje. */
      const { rows } = await client.query("SELECT now() AS t");
      assert.ok(rows[0].t, "transakcijos laikas paimtas");

      await new Promise((r) => setTimeout(r, 6_000));

      await assert.rejects(
        () => attemptRegistry.isipareigoti(client, { jobId, attemptId: bandymas.attemptId }),
        (e) => e.code === "ATTEMPT_COMMIT_TOO_LATE",
        "`now()` čia sužaliuotų — tvora privalo matuoti SAKINIO laiką"
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
);

test(
  "#351 R1 RIBOS: `MAX - ε` PRAEINA, `MAX + ε` ATMETAMA",
  { skip: PRALEISTI, timeout: 180000 },
  async (t) => {
    /**
     * ⚠️ VIENA KOPIJA, DVI PUSĖS (#351 R3). Paskutinis tvirtinimas tikrina būtent tai,
     * dėl ko konstanta persikėlė į `attemptRegistry`: sudubliavus ją šlavėjo pusėje su
     * kita reikšme, skirtumas nustotų būti `MAX`, ir tvoros bei atrankos ribos
     * išsiskirtų per vieną deploy'ų.
     */
    await perkurtiDb();
    const pool = new Pool({ connectionString: DB_URL });
    t.after(async () => pool.end().catch(() => {}));

    const jobId = await sukurtiJoba(pool, "55555555-5555-4555-8555-555555555555");

    const jaunas = await sukurtiBandyma(pool, { jobId, amziusMs: MAX - 60_000 });
    await pool.query("BEGIN");
    await attemptRegistry.isipareigoti(pool, { jobId, attemptId: jaunas.attemptId });
    await pool.query("COMMIT");
    assert.equal(await busena(pool, jaunas.attemptId), "committed", "`MAX - ε` privalo praeiti");

    const senas = await sukurtiBandyma(pool, { jobId, amziusMs: MAX + 60_000 });
    await assert.rejects(
      () => attemptRegistry.isipareigoti(pool, { jobId, attemptId: senas.attemptId }),
      (e) => e.code === "ATTEMPT_COMMIT_TOO_LATE",
      "`MAX + ε` privalo būti atmesta"
    );

    /**
     * ⚠️ RIBŲ SANTYKIS ČIA NETIKRINAMAS SĄMONINGAI. Pirmoji redakcija skaičiavo
     * `horizontas + attemptRegistry.MAX_RASYMO_TRUKME_MS` ir tikrino, kad skirtumas
     * lygus `MAX` — tautologija, kurios sudubliuota šlavėjo konstanta net nepaliečia.
     * Išmatuota: mutacija M8 (`retentionSweeper` sava 30 min reikšmė) šio failo
     * NENUKOVĖ. Tikrinama ten, kur reikšmė realiai gimsta — `auditRetention`,
     * perimant argumentą, kurį šlavėjas paduoda `valytiniBandymai()`.
     */
  }
);

/* ═══════════════════ R2 — ŠLAVĖJO SERIALIZAVIMAS ═══════════════════ */

test(
  "#351 R2: rašytojas laiko eilutę — patikra grįžta NEDELSIANT `55P03`, objektas nešalinamas",
  { skip: PRALEISTI, timeout: 180000 },
  async (t) => {
    /**
     * ⚠️ MATUOJAMA IR TRUKMĖ, NE TIK REZULTATAS. Be `NOWAIT` patikra LAUKTŲ, kol
     * rašytojas atleis eilutę — testas tada viršytų laiko ribą, o ne kristų aiškiai.
     * Todėl tvirtinama, kad atsakymas grįžo greičiau nei rašytojas paleido užraktą.
     */
    await perkurtiDb();
    const pool = new Pool({ connectionString: DB_URL });
    t.after(async () => pool.end().catch(() => {}));

    const jobId = await sukurtiJoba(pool, "66666666-6666-4666-8666-666666666666");
    const bandymas = await sukurtiBandyma(pool, { jobId, amziusMs: 0 });
    const kandidatas = { attempt_id: bandymas.attemptId, storage_type: "fs", storage_key: bandymas.raktas };

    const rasytojas = await pool.connect();
    try {
      await rasytojas.query("BEGIN");
      /** Rašytojas praeina tvorą ir LAIKO transakciją atvirą. */
      await attemptRegistry.isipareigoti(rasytojas, { jobId, attemptId: bandymas.attemptId });

      /**
       * ⚠️ RIBA MATUOJAMA NODE PUSĖJE, IR LAUKIMAS KRENTA ASERCIJA, NE TIMEOUT'U.
       *
       * Atblokavimas: rašytojo jungtis šiuo metu yra *idle in transaction* — ji nieko
       * nevykdo, tik laiko užraktą, — tad `ROLLBACK` ją pasiekia iš karto. Paleidus
       * užraktą patikra grįžta, jungtis sugrįžta į pool'ą, ir `pool.end()` baigiasi.
       */
      const pradzia = Date.now();
      const r = await ribotas(
        attemptRegistry.arVisDarSluotina(pool, kandidatas, { laukianciuRibaMs: 1 }),
        {
          atblokuoti: () => rasytojas.query("ROLLBACK").catch(() => {}),
          pranesimas:
            "patikra LAUKĖ užrakto ilgiau nei 5 s — `NOWAIT` pašalintas? " +
            "Su `NOWAIT` konfliktas grįžta nedelsiant kaip `55P03`.",
        }
      );

      assert.equal(r.ok, false, "užimtos eilutės patikra privalo MESTI, ne grąžinti verdiktą");
      assert.equal(r.klaida.code, "55P03", `laukiamas 55P03, gauta: ${r.klaida.code}`);
      assert.ok(Date.now() - pradzia < LAUKIMO_RIBA_MS, "atsakymas privalo būti NEDELSIANT");

      await rasytojas.query("COMMIT");
    } finally {
      rasytojas.release();
    }

    assert.equal(await busena(pool, bandymas.attemptId), "committed", "rašytojas įsipareigojo");
  }
);

test(
  "#351 R2: užraktas PALEIDŽIAMAS prieš `delete()` — patikra yra autocommit, ne transakcija",
  { skip: PRALEISTI, timeout: 180000 },
  async (t) => {
    /**
     * ⚠️ TAI TIKRINA PR-4 D4, NE #351. Patikra ima užraktą, bet ji vykdoma per `pool`,
     * tad implicit transakcija baigiasi kartu su `SELECT`. Jei kas nors kada nors
     * perkels ją į išreikštinę transakciją, užraktas nusitęs per nuotolinį I/O
     * (`delete()`), ir šis tvirtinimas kris.
     */
    await perkurtiDb();
    const pool = new Pool({ connectionString: DB_URL });
    t.after(async () => pool.end().catch(() => {}));

    const jobId = await sukurtiJoba(pool, "77777777-7777-4777-8777-777777777777");
    const bandymas = await sukurtiBandyma(pool, { jobId, amziusMs: MAX + 60_000 });
    const kandidatas = { attempt_id: bandymas.attemptId, storage_type: "fs", storage_key: bandymas.raktas };

    const verdiktas = await attemptRegistry.arVisDarSluotina(pool, kandidatas, { laukianciuRibaMs: 1 });
    assert.equal(verdiktas.sluotina, true, "sena nereferencuota eilutė yra šluotina");

    /**
     * Po patikros eilutė privalo būti LAISVA: lygiagretus `UPDATE` su `NOWAIT` praeina.
     * Būtent tokį sakinį daro rašytojas, ir būtent jis blokuotųsi, jei užraktas liktų.
     */
    const kitas = await pool.connect();
    try {
      /**
       * ⚠️ PID IMAMAS IŠ ANKSTO. Užblokavus `UPDATE`, ta pati jungtis nieko daugiau
       * nebeatsakys, tad jos `pg_backend_pid()` vėliau nebepasiekiamas.
       */
      const { rows: pidEil } = await kitas.query("SELECT pg_backend_pid() AS pid");
      const pid = pidEil[0].pid;

      await kitas.query("BEGIN");

      const pradzia = Date.now();
      const r = await ribotas(
        kitas.query("UPDATE job_result_attempts SET updated_at = now() WHERE attempt_id = $1", [
          bandymas.attemptId,
        ]),
        {
          atblokuoti: atblokuotiPer(pid),
          pranesimas:
            "lygiagretus `UPDATE` buvo UŽBLOKUOTAS ilgiau nei 5 s — užraktas laikomas " +
            "per `delete()`? Patikra privalo būti autocommit, ne išreikštinė transakcija.",
        }
      );

      assert.ok(r.ok, `\`UPDATE\` privalo praeiti: ${r.ok ? "" : r.klaida.message}`);
      assert.ok(Date.now() - pradzia < LAUKIMO_RIBA_MS, "eilutė privalo būti LAISVA");

      await kitas.query("COMMIT");
    } finally {
      /** ⚠️ Timeout šakoje `COMMIT` nepasiekiamas — transakcija uždaroma čia. */
      await kitas.query("ROLLBACK").catch(() => {});
      kitas.release();
    }
  }
);

test(
  "#351 R2: `55P03` → `uzimtas` su užrakto priežastimi; KITA klaida → `nepavyko`",
  { skip: PRALEISTI, timeout: 180000 },
  async (t) => {
    /**
     * ⚠️ KLASIFIKACIJA TIKRINAMA ABIEM KRYPTIMIS. Testas, tikrinantis tik `55P03`,
     * praeitų ir su `catch → visada uzimtas` — o tokia realizacija DB triktį paslėptų
     * kaip normalų konkurencinį darbą.
     */
    await perkurtiDb();
    const { createPostgresStore } = require("../utils/jobStore/postgresStore");
    const { createFsArtifactStore } = require("../utils/artifactStore/fsStore");
    const os = require("node:os");
    const fsp = require("node:fs/promises");

    const pool = new Pool({ connectionString: DB_URL });
    const saknis = await fsp.mkdtemp(path.join(os.tmpdir(), "stenograma-tvora-"));
    t.after(async () => {
      await pool.end().catch(() => {});
      await fsp.rm(saknis, { recursive: true, force: true });
    });

    const saugykla = createFsArtifactStore({ root: saknis });
    const store = createPostgresStore(pool, {
      artifactStores: { fs: saugykla },
      bandymuRegistras: true,
    });

    const jobId = await sukurtiJoba(pool, "88888888-8888-4888-8888-888888888888");
    const bandymas = await sukurtiBandyma(pool, { jobId, amziusMs: MAX + 60_000 });
    await saugykla.put(bandymas.raktas, Buffer.from("x"));
    const kandidatai = [{ attempt_id: bandymas.attemptId, storage_type: "fs", storage_key: bandymas.raktas }];

    /* (a) Rašytojas laiko eilutę → `uzimtas`, priežastis mini UŽRAKTĄ. */
    const rasytojas = await pool.connect();
    let uzimtas;
    try {
      await rasytojas.query("BEGIN");
      await rasytojas.query(
        "UPDATE job_result_attempts SET updated_at = now() WHERE attempt_id = $1",
        [bandymas.attemptId]
      );
      /**
       * ⚠️ TA PATI FIGŪRA KAIP TESTE 6, IR TODĖL TAS PATS SARGAS (#351, P4).
       *
       * Rašytojas laiko eilutę, o atlaisvinantis `ROLLBACK` stovi eilute žemiau — UŽ
       * `await`. Be `NOWAIT` patikra laukia rašytojo, rašytojas laukia patikros, ir
       * failas pakimba, nors testas turi `timeout: 180000`: `finally` nepasiekiamas,
       * pool'e lieka paimta jungtis, `pool.end()` nebegrįžta. Išmatuota run
       * `35625863455` — 20 min job timeout, nė vienos TAP eilutės iš šio failo.
       */
      const r8 = await ribotas(store.sweepResultArtifacts(kandidatai, { laukianciuRibaMs: 1 }), {
        atblokuoti: () => rasytojas.query("ROLLBACK").catch(() => {}),
        pranesimas:
          "`sweepResultArtifacts` LAUKĖ rašytojo užrakto ilgiau nei 5 s — `NOWAIT` " +
          "pašalintas? Patikra privalo grįžti nedelsiant kaip `55P03`.",
      });
      assert.ok(r8.ok, `šlavimas neturėjo mesti: ${r8.ok ? "" : r8.klaida.message}`);
      [uzimtas] = r8.reiksme;
      await rasytojas.query("ROLLBACK");
    } finally {
      rasytojas.release();
    }

    assert.equal(uzimtas.verdiktas, "uzimtas", "`55P03` NĖRA gedimas");
    assert.match(uzimtas.priezastis, /RAŠYTOJAS|užrakt/i, uzimtas.priezastis);

    /* (b) Kita klaida (lentelės nebėra) → `nepavyko`, ne `uzimtas`. */
    /**
     * ⚠️ `ALTER TABLE ... RENAME` IRGI YRA LAUKIMO TAŠKAS, IR TAI NE TEORIJA.
     *
     * Jam reikia `ACCESS EXCLUSIVE`, kuris konfliktuoja net su `ACCESS SHARE`. Jei
     * mutacija palieka nutekėjusią transakciją (M7 `abfc7ad` forma: `verdiktas →
     * continue` praleidžia `COMMIT`/`release`), ji `ACCESS SHARE` tebelaiko, ir
     * pervadinimas laukia amžinai. Blokuotojas čia NĖRA testo valdomas — jį laiko
     * produkcinio kodo jungtis, — tad atblokuojama `pg_terminate_backend`'u.
     */
    const perv = await pool.connect();
    try {
      const { rows: pidB } = await perv.query("SELECT pg_backend_pid() AS pid");
      const rPerv = await ribotas(
        perv.query("ALTER TABLE job_result_attempts RENAME TO job_result_attempts_slepta"),
        {
          atblokuoti: atblokuotiPer(pidB[0].pid),
          pranesimas:
            "`ALTER TABLE ... RENAME` buvo UŽBLOKUOTAS ilgiau nei 5 s — kas nors laiko " +
            "atvirą transakciją ant `job_result_attempts` (nutekėjusi pool'o jungtis?).",
        }
      );
      assert.ok(rPerv.ok, `pervadinimas privalo praeiti: ${rPerv.ok ? "" : rPerv.klaida.message}`);
    } finally {
      perv.release();
    }

    const rB = await ribotas(store.sweepResultArtifacts(kandidatai, { laukianciuRibaMs: 1 }), {
      atblokuoti: async () => {},
      pranesimas: "antras šlavimas UŽSTRIGO — nors lentelės nebėra, jis turėjo kristi iškart.",
    });
    assert.ok(rB.ok, `šlavimas neturėjo mesti: ${rB.ok ? "" : rB.klaida.message}`);
    const [nepavyko] = rB.reiksme;
    await pool.query("ALTER TABLE job_result_attempts_slepta RENAME TO job_result_attempts");

    assert.equal(nepavyko.verdiktas, "nepavyko", "nežinoma klaida NEGALI virsti `uzimtas`");
    assert.match(nepavyko.priezastis, /pakartotinė patikra nepavyko/, nepavyko.priezastis);
  }
);

test(
  "#351 R2: užraktas paleistas iki `delete()` — matuojama KVIETIMO VIETOJE, ne funkcijoje",
  { skip: PRALEISTI, timeout: 180000 },
  async (t) => {
    /**
     * ⚠️ KUO ŠIS TESTAS SKIRIASI NUO ANKSTESNIO („patikra yra autocommit").
     *
     * Tas gina FUNKCIJOS kontraktą: `arVisDarSluotina(pool, …)` po savęs užrakto
     * nepalieka. Bet jis kviečia funkciją su `pool`, tad realistinei regresijai —
     * kai užraktą prailgina ne funkcija, o KVIETIMO VIETA, paduodama transakcijos
     * klientą (`sweepResultArtifacts` mutacija M7, `abfc7ad` forma) — jis žalias
     * PAGAL KONSTRUKCIJĄ: mutacijos net nepasiekia.
     *
     * Čia matuojama ten, kur garantija realiai reikalinga: MOMENTU, kai vykdomas
     * `delete()`. Jei tuo metu eilutė vis dar užrakinta, nuotolinis I/O vyksta po
     * užraktu — tiksliai tai, ką PR-4 D4 draudžia.
     *
     * ⚠️ ZONDAS GYVENA SAUGYKLOS DUBLYJE, NE TESTE PO ŠLAVIMO. Po šlavimo tikrinti
     * per vėlu: užraktas iki tol jau paleistas bet kuriuo atveju, ir tvirtinimas
     * nieko nebeskirtų.
     */
    await perkurtiDb();
    const { createPostgresStore } = require("../utils/jobStore/postgresStore");
    const { createFsArtifactStore } = require("../utils/artifactStore/fsStore");
    const os = require("node:os");
    const fsp = require("node:fs/promises");

    const pool = new Pool({ connectionString: DB_URL });
    const saknis = await fsp.mkdtemp(path.join(os.tmpdir(), "stenograma-kablys-"));
    t.after(async () => {
      await pool.end().catch(() => {});
      await fsp.rm(saknis, { recursive: true, force: true });
    });

    const jobId = await sukurtiJoba(pool, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const bandymas = await sukurtiBandyma(pool, { jobId, amziusMs: MAX + 60_000 });

    const fs = createFsArtifactStore({ root: saknis });
    let zondas = null;

    const saugykla = {
      ...fs,
      backend: "fs",
      /**
       * ⚠️ KABLYS `delete()` VIDUJE. Trečia, nuo pool'o nepriklausoma jungtis bando
       * tą patį `UPDATE`, kurį darytų rašytojas. Su autocommit patikra užraktas jau
       * paleistas, tad jis praeina per milisekundes.
       */
      async delete(raktas) {
        const c = new Client({ connectionString: DB_URL });
        await c.connect();
        try {
          const { rows } = await c.query("SELECT pg_backend_pid() AS pid");
          const pradzia = Date.now();
          const r = await ribotas(
            c.query("UPDATE job_result_attempts SET updated_at = now() WHERE attempt_id = $1", [
              bandymas.attemptId,
            ]),
            {
              atblokuoti: atblokuotiPer(rows[0].pid),
              pranesimas:
                "`delete()` METU eilutė TEBEUŽRAKINTA ilgiau nei 5 s — patikros užraktas " +
                "nusitęsė per nuotolinį I/O. Kvietimo vieta paduoda transakcijos klientą?",
            }
          );
          zondas = { ok: r.ok, trukmeMs: Date.now() - pradzia, klaida: r.ok ? null : r.klaida };
        } finally {
          await c.end().catch(() => {});
        }
        return fs.delete(raktas);
      },
    };

    const store = createPostgresStore(pool, {
      artifactStores: { fs: saugykla },
      bandymuRegistras: true,
    });

    await fs.put(bandymas.raktas, Buffer.from("x"));
    const kandidatai = [
      { attempt_id: bandymas.attemptId, storage_type: "fs", storage_key: bandymas.raktas },
    ];

    const [verdiktas] = await store.sweepResultArtifacts(kandidatai, { laukianciuRibaMs: 1 });

    assert.equal(verdiktas.verdiktas, "pasalinta", `kontrolė: objektas pašalintas (${verdiktas.priezastis})`);
    assert.ok(zondas, "zondas PRIVALO būti pasiektas — kitaip testas nieko nematavo");
    assert.ok(zondas.ok, `\`UPDATE\` \`delete()\` metu privalo praeiti: ${zondas.klaida && zondas.klaida.message}`);
    assert.ok(
      zondas.trukmeMs < LAUKIMO_RIBA_MS,
      `eilutė privalo būti LAISVA \`delete()\` metu, truko ${zondas.trukmeMs} ms`
    );
  }
);

/* ═════════════ D4a riba — BAIGTINIS per didelis horizontas ═════════════ */

test(
  "#351 D4a RIBA: baigtinis per didelis horizontas — atrankos sakinys KRENTA, nešalinama nieko",
  { skip: PRALEISTI, timeout: 180000 },
  async (t) => {
    /**
     * ⚠️ FAIL-CLOSED KITU MECHANIZMU, NE SARGU. `Number.isFinite` sargas tokios
     * reikšmės nepraleidžia per klaidą — jis jos SĄMONINGAI negaudo (ribos nespėliojau,
     * žr. `retentionSweeper.js` komentarą). Saugumą čia užtikrina tai, kad PostgreSQL
     * tokio intervalo nepriima, `_valytiRezultatoBandymus()` kvietėjas klaidą gaudo, ir
     * nė vienas objektas nešalinamas.
     *
     * `QUEUE_MAX_ATTEMPTS=60` duoda ~2.9e21 ms — baigtinį, teigiamą ir per didelį.
     */
    await perkurtiDb();
    const pool = new Pool({ connectionString: DB_URL });
    t.after(async () => pool.end().catch(() => {}));

    const jobId = await sukurtiJoba(pool, "99999999-9999-4999-8999-999999999999");
    const bandymas = await sukurtiBandyma(pool, { jobId, amziusMs: MAX + 60_000 });

    const { revivalHorizonsMs } = require("../queues/config");
    const horizontas = revivalHorizonsMs({ QUEUE_MAX_ATTEMPTS: "60" }).horizonMs;
    assert.ok(Number.isFinite(horizontas) && horizontas > 0, "prielaida: baigtinis ir teigiamas");

    await assert.rejects(
      () =>
        attemptRegistry.valytiniBandymai(pool, {
          laukianciuRibaMs: horizontas + MAX,
          atmestuRibaMs: horizontas,
        }),
      "per didelis intervalas privalo kristi DB pusėje, ne praeiti tyliai"
    );

    assert.equal(await busena(pool, bandymas.attemptId), "pending", "nė viena eilutė nepaliesta");
  }
);
