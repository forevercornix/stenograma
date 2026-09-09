const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");
const { Pool, Client } = require("pg");

const { skipWithoutPostgres, testDatabaseUrl, adminDatabaseUrl } = require("./helpers/postgresGuard");
const { createFsArtifactStore } = require("../utils/artifactStore/fsStore");
const { migruoti, sausasPaleidimas, PRIEZASTIS } = require("../utils/artifactMigration");
const attemptRegistry = require("../utils/attemptRegistry");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * `inline` → external MIGRACIJA (#157, PR-6).
 *
 * ⚠️ KĄ ŠIS FAILAS ĮRODO, IR KO NEĮRODINĖJA.
 *
 * Įrodo: tvarką (registras → `put()` → `head()` → atominis perjungimas),
 * idempotenciją, keturias atskiriamas nesėkmes ir — svarbiausia — kad NĖRA
 * commit'intos būsenos, pažeidžiančios DVI POras, kurių negina jokia `CHECK`
 * sąlyga.
 *
 * ⚠️ §9.1 PERORIENTUOTAS PO MATAVIMO. Planas reikalavo stebėtojo, tikrinančio
 * `job_results` eilutes prieš `job_results_storage_shape`. Tas stebėtojas
 * NEGALĖTŲ KRISTI: išmatuota (`jobResultsShapeDomain.integration`, CI
 * 34323230438), kad visi 60 dalinių perėjimo sakinių atmetami `23514`, tad
 * pažeidžiančios eilutės padaryti neįmanoma. Testas, kuris negali kristi, nėra
 * įrodymas.
 *
 * Todėl stebimos POROS TARP SISTEMŲ, kur `CHECK` negalioja pagal apibrėžimą:
 *
 *   objektas ↔ nuoroda   — external eilutė rodo į raktą, kurio saugykloje nėra;
 *   progresas ↔ nuoroda  — `artifact_migration_progress` sako `done`, o eilutė
 *                          tebėra `inline` (arba atvirkščiai).
 *
 * ⚠️ IR ABI TIKRINAMOS MUTACIJA. Stebėtojas, kuris nieko nerado, neatskiriamas
 * nuo stebėtojo, kuris neveikia — tad greta tikros migracijos paleidžiama SUGADINTA
 * (progresas atskiroje, ankstesnėje transakcijoje), ir stebėtojas privalo kristi.
 *
 * ⚠️ ŠIS FAILAS VIETOJE NEVYKDOMAS — reikia tikros PostgreSQL.
 */

const SAKNIS = path.resolve(__dirname, "..");
const DB_URL = testDatabaseUrl("artifactmigration");
const PRALEISTI = skipWithoutPostgres();

let pool = null;
let saknis = null;

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

async function perkurti() {
  /**
   * ⚠️ SENAS POOL'AS UŽDAROMAS PRIEŠ `DROP`, NE PO JO.
   *
   * `WITH (FORCE)` nutraukia VISAS prisijungusias sesijas. Jei ankstesnio testo
   * pool'as dar atviras, jo laisvos jungtys gauna „terminating connection due to
   * administrator command" jau PO to, kai anas testas baigėsi — `node --test` tai
   * mato kaip „asynchronous activity after the test ended" ir paverčia
   * `uncaughtException`. Failas krinta, nors nė viena asercija nesuklydo.
   *
   * Būtent taip ir nutiko pirmame CI raunde (34352704975): visi 14 subtestų
   * `ok`, o failas `exit 1`. Tvarka čia yra testo gyvavimo ciklo dalis, ne
   * kosmetika.
   */
  if (pool) await pool.end().catch(() => {});
  pool = null;

  await adminPg(`DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`);
  await adminPg(`CREATE DATABASE "${dbVardas()}"`);
  execFileSync("npx", ["node-pg-migrate", "up"], {
    cwd: SAKNIS,
    env: { ...process.env, DATABASE_URL: DB_URL },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  pool = new Pool({ connectionString: DB_URL });

  /**
   * ⚠️ ANKSTESNĖ ŠAKNIS PAŠALINAMA ČIA, NE TIK `after()`.
   *
   * `after()` išvalo tik PASKUTINĘ, tad keturi `perkurti()` kvietimai paliktų
   * tris katalogus CI runner'io `/tmp`. Testas, kuris po savęs netvarko, yra
   * `verify-clean.mjs` klausimas, o ne skonio reikalas.
   */
  if (saknis) await fsp.rm(saknis, { recursive: true, force: true }).catch(() => {});

  saknis = await fsp.mkdtemp(path.join(os.tmpdir(), "stenograma-migracija-"));
  return createFsArtifactStore({ root: saknis });
}

after(async () => {
  if (PRALEISTI) return;
  if (pool) await pool.end().catch(() => {});
  if (saknis) await fsp.rm(saknis, { recursive: true, force: true }).catch(() => {});
  await adminPg(`DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`).catch(() => {});
});

/** Inline job'as su `job_results` eilute. `payloadSql` leidžia įrašyti JSON `null`. */
async function naujasInline(payload, { payloadSql = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO jobs (id, type, status, created_at, updated_at)
     VALUES (gen_random_uuid(), 'transcription', 'completed', now(), now()) RETURNING id`
  );
  const jobId = rows[0].id;

  if (payloadSql) {
    await pool.query(
      `INSERT INTO job_results (job_id, storage_type, payload, created_at)
       VALUES ($1, 'inline', ${payloadSql}, now())`,
      [jobId]
    );
  } else {
    await pool.query(
      `INSERT INTO job_results (job_id, storage_type, payload, created_at)
       VALUES ($1, 'inline', $2::jsonb, now())`,
      [jobId, JSON.stringify(payload)]
    );
  }

  return jobId;
}

async function eilute(jobId) {
  const { rows } = await pool.query("SELECT * FROM job_results WHERE job_id = $1", [jobId]);
  return rows[0];
}

async function progresas(jobId) {
  const { rows } = await pool.query(
    "SELECT * FROM artifact_migration_progress WHERE job_id = $1",
    [String(jobId)]
  );
  return rows[0] || null;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. SAUSAS PALEIDIMAS NIEKO NEKEIČIA
 * ═══════════════════════════════════════════════════════════════════════════ */

test("#157 PR-6: sausas paleidimas nerašo NIEKUR", { skip: PRALEISTI, timeout: 300000 }, async (t) => {
  await perkurti();

  const geras = await naujasInline({ text: "labas" });
  const blogas = await naujasInline(null, { payloadSql: "'null'::jsonb" });

  const suvestine = await sausasPaleidimas(pool, {});

  await t.test("suvestinė atskiria perkeltinus nuo neatvaizduojamų", () => {
    assert.equal(suvestine.kandidatai, 2);
    assert.equal(suvestine.perkeltini, 1);
    assert.deepEqual(suvestine.neatvaizduojami, [String(blogas)]);
  });

  await t.test("DB nepaliesta — nė vienos eilutės, nė vieno progreso įrašo", async () => {
    assert.equal((await eilute(geras)).storage_type, "inline");
    assert.equal(await progresas(geras), null);
    assert.equal(await progresas(blogas), null);

    const { rows } = await pool.query("SELECT count(*)::int AS k FROM job_result_attempts");
    assert.equal(rows[0].k, 0, "sausas paleidimas neregistruoja bandymų");
  });

  await t.test("saugykla nepaliesta", async () => {
    /**
     * ⚠️ TIKRINAMA FAILŲ SISTEMA, NE `put()` KVIETIMŲ SKAITIKLIS. Skaitiklis
     * įrodytų, kad mūsų kodas nekvietė; katalogas įrodo, kad objektų NĖRA —
     * įskaitant tuos, kuriuos galėtų palikti kas nors kitas tuo pačiu keliu.
     */
    const irasai = await fsp.readdir(saknis).catch(() => []);
    assert.deepEqual(irasai, [], "sausas paleidimas negali palikti objektų");
  });

  /** ⚠️ KONTROLĖ: be jos „nieko nepakeitė" tenkintų ir paleidimas, kuris nieko nerado. */
  await t.test("KONTROLĖ: kandidatų tikrai buvo", () => {
    assert.ok(suvestine.kandidatai > 0, "matavimas be kandidatų nieko nesako");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. TIKRAS PERKĖLIMAS, TVARKA IR IDEMPOTENCIJA
 * ═══════════════════════════════════════════════════════════════════════════ */

test("#157 PR-6: perkėlimas, registras ir pakartotinis paleidimas", { skip: PRALEISTI, timeout: 300000 }, async (t) => {
  const saugykla = await perkurti();

  const jobId = await naujasInline({ text: "protokolas" });
  const suvestine = await migruoti(pool, saugykla, {});

  await t.test("eilutė tapo external su PILNU trejetu", async () => {
    const r = await eilute(jobId);
    assert.equal(r.storage_type, "fs");
    assert.ok(r.storage_key, "raktas privalomas");
    assert.equal(r.payload, null, "`payload` pašalintas TIK po perkėlimo");
    assert.ok(Number(r.bytes) > 0);
    assert.match(r.checksum, /^[0-9a-f]{64}$/);
  });

  await t.test("objektas saugykloje ATITINKA nuorodą", async () => {
    const r = await eilute(jobId);
    const galva = await saugykla.head(r.storage_key);
    assert.ok(galva, "objekto nėra — nuoroda rodo į tuštumą");
    assert.equal(Number(galva.bytes), Number(r.bytes));
  });

  await t.test("bandymas registre yra `committed`", async () => {
    const bandymai = await attemptRegistry.joboBandymai(pool, String(jobId));
    assert.equal(bandymai.length, 1, "vienas perkėlimas — vienas bandymas");
    assert.equal(bandymai[0].busena, attemptRegistry.BUSENA.ISIPAREIGOTA);
  });

  await t.test("progresas `done` ir rodo TĄ PATĮ raktą", async () => {
    const p = await progresas(jobId);
    const r = await eilute(jobId);
    assert.equal(p.busena, "done");
    assert.equal(p.storage_key, r.storage_key, "progresas ir nuoroda privalo sutapti");
    assert.equal(p.priezastis, null);
    assert.equal(p.run_id, suvestine.runId);
  });

  await t.test("PAKARTOTINIS paleidimas nieko nebedaro", async () => {
    const antras = await migruoti(pool, saugykla, {});
    assert.equal(antras.kandidatai, 0, "perkelta eilutė nebėra `inline`, tad nebeatrenkama");
    assert.equal(antras.perkelta, 0);

    const bandymai = await attemptRegistry.joboBandymai(pool, String(jobId));
    assert.equal(bandymai.length, 1, "pakartojimas negali sukurti antro objekto");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. KETURIOS NESĖKMĖS — TIKRINAMOS ATSKIRAI
 * ═══════════════════════════════════════════════════════════════════════════ */

test("#157 PR-6: kiekviena nesėkmės klasė atskiriama ir nepraranda kopijos", { skip: PRALEISTI, timeout: 300000 }, async (t) => {
  const saugykla = await perkurti();

  /**
   * ⚠️ KETURIOS KLASĖS TIKRINAMOS ATSKIRAI, NE VIENU „nepavyko".
   *
   * Bendras testas praeitų padengęs vieną iš keturių, o ataskaitoje atrodytų kaip
   * keturios — ta pati klaida, kurią PR-1 padarė su `CHECK` dalimis.
   */

  await t.test("neatvaizduojamas `payload` → `payload_neatvaizduojamas`, be objekto", async () => {
    /**
     * ⚠️ JSON `null` YRA PASIEKIAMAS ATVEJIS, NE SUGALVOTAS. SQL `IS NOT NULL`
     * jam TEISINGAS, tad `job_results_storage_shape` tokią eilutę priima, o riba
     * atmeta (`ARTIFACT_VALUE_UNSUPPORTED`). NUL ar neporinis surogatas čia
     * netiktų — jų `jsonb` apskritai nepriima (išmatuota
     * `jobResultsJsonbDomain.integration`), tad tokios eilutės DB egzistuoti negali.
     */
    const jobId = await naujasInline(null, { payloadSql: "'null'::jsonb" });
    const s = await migruoti(pool, saugykla, {});

    assert.equal(s.nepavyko[PRIEZASTIS.PAYLOAD_NEATVAIZDUOJAMAS], 1);
    assert.equal((await progresas(jobId)).priezastis, PRIEZASTIS.PAYLOAD_NEATVAIZDUOJAMAS);

    const bandymai = await attemptRegistry.joboBandymai(pool, String(jobId));
    assert.deepEqual(bandymai, [], "riba tikrinama PRIEŠ registrą — bandymo neturi būti");
    assert.equal((await eilute(jobId)).storage_type, "inline", "kopija lieka vietoje");
  });

  await t.test("`put()` krito → `saugyklos_klaida`, bandymas `abandoned`", async () => {
    const jobId = await naujasInline({ text: "krentantis" });
    const sugedusi = { ...saugykla, put: async () => { throw new Error("saugykla nepasiekiama"); } };

    const s = await migruoti(pool, sugedusi, {});

    assert.equal(s.nepavyko[PRIEZASTIS.SAUGYKLOS_KLAIDA], 1);
    assert.equal((await progresas(jobId)).priezastis, PRIEZASTIS.SAUGYKLOS_KLAIDA);
    assert.equal((await eilute(jobId)).storage_type, "inline", "kopija lieka vietoje");

    const bandymai = await attemptRegistry.joboBandymai(pool, String(jobId));
    assert.equal(bandymai.length, 1, "registro eilutė LIEKA — ji yra įrodymas");
    assert.equal(
      bandymai[0].busena,
      attemptRegistry.BUSENA.ATMESTA,
      "`pending` likusi eilutė siųstų šlavėją ten, kur nieko nėra"
    );
  });

  await t.test("`head()` nepatvirtino → `vientisumas_nepatvirtintas`, objektas pašalintas", async () => {
    const jobId = await naujasInline({ text: "nepatvirtintas" });
    const melagis = { ...saugykla, head: async () => ({ bytes: 999999 }) };

    const s = await migruoti(pool, melagis, {});

    assert.equal(s.nepavyko[PRIEZASTIS.VIENTISUMAS_NEPATVIRTINTAS], 1);
    assert.equal((await eilute(jobId)).storage_type, "inline", "SĄLYGA 7: `payload` nepaliestas");

    const bandymai = await attemptRegistry.joboBandymai(pool, String(jobId));
    assert.equal(bandymai[0].busena, attemptRegistry.BUSENA.ATMESTA);

    const galva = await saugykla.head(bandymai[0].storage_key);
    assert.equal(galva, null, "nepatvirtintas objektas privalo būti pašalintas");
  });

  await t.test("eilutė pasikeitė po `head()` → `eilute_pasikeite`, svetima nuoroda nepaliesta", async () => {
    const jobId = await naujasInline({ text: "lenktynes" });

    /**
     * ⚠️ LENKTYNĖS SINCHRONIZUOJAMOS, NE TIKIMASI. `put()` kabliukas įvykdo tai,
     * ką realiai padarytų lygiagretus užbaigimo kelias: perjungia eilutę PIRMAS.
     * Be sinchronizacijos testas priklausytų nuo planuoklio ir dažniausiai
     * praeitų nieko neišbandęs.
     */
    const svetimas = { ...saugykla };
    svetimas.put = async (raktas, paruosta) => {
      const kvitas = await saugykla.put(raktas, paruosta);
      await pool.query(
        `UPDATE job_results
            SET storage_type = 'fs', storage_key = 'results/svetimas/kitas.json',
                bytes = 7, checksum = repeat('b', 64), payload = NULL
          WHERE job_id = $1`,
        [jobId]
      );
      return kvitas;
    };

    const s = await migruoti(pool, svetimas, {});

    assert.equal(s.nepavyko[PRIEZASTIS.EILUTE_PASIKEITE], 1);

    const r = await eilute(jobId);
    assert.equal(r.storage_key, "results/svetimas/kitas.json", "svetima nuoroda NEPERRAŠYTA");

    const bandymai = await attemptRegistry.joboBandymai(pool, String(jobId));
    const musu = bandymai.find((b) => b.storage_key !== "results/svetimas/kitas.json");
    assert.equal(musu.busena, attemptRegistry.BUSENA.ATMESTA);
    assert.equal(await saugykla.head(musu.storage_key), null, "pralaimėjęs objektas pašalintas");
  });

  await t.test("SUGADINTAS TO PATIES ILGIO objektas → `payload` NEIŠTRINAMAS", async () => {
    /**
     * ⚠️ P1: ČIA VIENINTELIS PR-6 KELIAS, KURIAME DUOMENYS NAIKINAMI.
     *
     * `head()` grąžina tik egzistavimą ir baitus — `fs` ir `s3` tai daro
     * SĄMONINGAI (metadata-only kaina). Sugadintas TO PAČIO ILGIO objektas tokią
     * patikrą praeina, ir kitas `UPDATE` sunaikina vienintelę galiojančią inline
     * kopiją, o `job_results` išsaugo ORIGINALO `checksum`. Nuo tada `verify()`
     * visada sakys „nesutampa" — bet jau po to, kai atkurti nebėra iš ko.
     *
     * ⚠️ TA PATI KLASĖ, KURIĄ PR-4 UŽDARĖ PRE-CHECK'E: verdiktas skelbiamas
     * remiantis įrodymu, kuris nustato tik DYDĮ. Ten pasekmė buvo sugadintas
     * rezultatas klientui; čia — sunaikinta vienintelė kopija.
     *
     * Objektas gadinamas TIESIAI failų sistemoje, ne per padirbtą verdiktą:
     * padirbtas `verify()` įrodytų tik tai, kad mūsų kodas skaito lauką, o ne
     * kad `head()` šio sugadinimo nepagauna.
     */
    const jobId = await naujasInline({ text: "sugadinamas" });

    const gadintojas = { ...saugykla };
    gadintojas.put = async (raktas, paruosta) => {
      const kvitas = await saugykla.put(raktas, paruosta);

      const kelias = path.join(saknis, raktas);
      const baitai = await fsp.readFile(kelias);

      /** Keičiama VIENA raidė reikšmės viduje — ilgis nekinta, JSON lieka galiojantis. */
      const i = baitai.findIndex((b, idx) => idx > 10 && b >= 0x61 && b <= 0x7a);
      assert.ok(i > 0, "testo prielaida: kanoninėje eilutėje yra mažoji raidė");
      baitai[i] = baitai[i] === 0x7a ? 0x79 : baitai[i] + 1;

      await fsp.writeFile(kelias, baitai);
      return kvitas;
    };

    const s = await migruoti(pool, gadintojas, {});

    await t.test("KONTROLĖ: `head()` šio sugadinimo NEPAGAUNA", async () => {
      /**
       * Be šitos kontrolės testas praeitų ir tada, jei sugadinimas pakeistų
       * ILGĮ — tada jį pagautų ir senoji patikra, ir įrodymas būtų apie kitą
       * klasę, nei teigiama.
       */
      const bandymai = await attemptRegistry.joboBandymai(pool, String(jobId));
      const musu = bandymai[bandymai.length - 1];
      const kelias = path.join(saknis, musu.storage_key);
      const yra = await fsp.stat(kelias).then(() => true).catch(() => false);

      if (yra) {
        const galva = await saugykla.head(musu.storage_key);
        const verdiktas = await saugykla.verify(musu.storage_key, {
          bytes: galva.bytes,
          checksum: null,
        });
        assert.equal(Number(galva.bytes), Number(verdiktas.bytes), "ilgis nepakito — `head()` aklas");
      }
    });

    assert.equal(
      s.nepavyko[PRIEZASTIS.VIENTISUMAS_NEPATVIRTINTAS],
      1,
      "sugadintas objektas privalo duoti `vientisumas_nepatvirtintas`"
    );

    const r = await eilute(jobId);
    assert.equal(r.storage_type, "inline", "eilutė privalo likti inline");
    assert.ok(r.payload, "VIENINTELĖ galiojanti kopija privalo likti — tai negrįžtama");
  });

  await t.test("`verify()` be nepriklausomo patvirtinimo NEPRALEIDŽIAMAS", async () => {
    /**
     * ⚠️ `nepriklausomas: false` REIŠKIA „reikšmė palyginta SU SAVIMI".
     *
     * Taip elgiasi `inlineStore` (`inlineStore.js:210`). Saugykla, kuri
     * vientisumą „patvirtina" savo pačios metaduomenimis, migracijai nieko
     * neįrodo — o `payload` naikinimas remiasi būtent tuo įrodymu.
     */
    const jobId = await naujasInline({ text: "priklausomas" });

    const priklausomas = { ...saugykla };
    priklausomas.verify = async (raktas, laukiama) => {
      const v = await saugykla.verify(raktas, laukiama);
      return { ...v, nepriklausomas: false };
    };

    const s = await migruoti(pool, priklausomas, {});

    assert.equal(s.nepavyko[PRIEZASTIS.VIENTISUMAS_NEPATVIRTINTAS], 1);
    assert.equal((await eilute(jobId)).storage_type, "inline");
    assert.ok((await eilute(jobId)).payload, "kopija lieka");
  });

  await t.test("`failed` eilutės pakartotinai NEBANDOMOS be `retryFailed`", async () => {
    const pries = await migruoti(pool, saugykla, {});
    assert.equal(pries.kandidatai, 0, "visos keturios pažymėtos `failed` ir praleidžiamos");

    const su = await sausasPaleidimas(pool, { retryFailed: true });
    assert.ok(su.kandidatai > 0, "`retryFailed` privalo jas grąžinti — sprendimas yra operatoriaus");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. §9.1 — STEBĖTOJAS PAGAL PORAS
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Stebėtojas ANTROJE jungtyje. Grąžina `stop()`, kuris atiduoda pažeidimus.
 *
 * ⚠️ TIKRINAMOS TIK POROS TARP SISTEMŲ. `job_results` vidaus netikrina sąmoningai:
 * tą invariantą DB taiko kiekvienam sakiniui, ir stebėtojas ten kristi negalėtų.
 */
function paleistiStebetoja(saugykla) {
  const pazeidimai = [];
  let dirba = true;

  const ciklas = (async () => {
    const klientas = new Client({ connectionString: DB_URL });
    await klientas.connect();

    try {
      while (dirba) {
        const { rows } = await klientas.query(
          `SELECT r.job_id, r.storage_type, r.storage_key, r.bytes,
                  p.busena AS progresas, p.storage_key AS progreso_raktas
             FROM job_results r
             LEFT JOIN artifact_migration_progress p ON p.job_id = r.job_id::text`
        );

        for (const e of rows) {
          /* PORA 1: objektas ↔ nuoroda. */
          if (e.storage_type !== "inline") {
            const galva = await saugykla.head(e.storage_key).catch(() => null);
            if (!galva) {
              pazeidimai.push(`objekto nėra: ${e.job_id} → ${e.storage_key}`);
            } else if (Number(galva.bytes) !== Number(e.bytes)) {
              pazeidimai.push(`dydis nesutampa: ${e.job_id} (${galva.bytes} vs ${e.bytes})`);
            }
          }

          /* PORA 2: progresas ↔ nuoroda. */
          if (e.progresas === "done") {
            if (e.storage_type === "inline") {
              pazeidimai.push(`progresas \`done\`, o eilutė tebėra inline: ${e.job_id}`);
            } else if (e.progreso_raktas !== e.storage_key) {
              pazeidimai.push(`progreso raktas skiriasi nuo nuorodos: ${e.job_id}`);
            }
          }
        }

        await new Promise((r) => setTimeout(r, 2));
      }
    } finally {
      await klientas.end().catch(() => {});
    }
  })();

  return async function stop() {
    dirba = false;
    await ciklas;
    return pazeidimai;
  };
}

test("#157 PR-6: stebėtojas nemato pažeistų POrų, ir tai patikrinta mutacija", { skip: PRALEISTI, timeout: 300000 }, async (t) => {
  const saugykla = await perkurti();

  await t.test("TIKRA migracija: nė vieno pažeidimo", async () => {
    for (let i = 0; i < 12; i += 1) await naujasInline({ text: `eilute-${i}` });

    const stop = paleistiStebetoja(saugykla);
    const s = await migruoti(pool, saugykla, {});
    const pazeidimai = await stop();

    assert.equal(s.perkelta, 12, "kontrolė: stebėtojas stebėjo TIKRĄ darbą, ne tuštumą");
    assert.deepEqual(pazeidimai, [], "commit'inta pažeista pora — migracija turi langą");
  });

  await t.test("MUTACIJA: progresas ATSKIROJE ankstesnėje transakcijoje → stebėtojas KRENTA", async () => {
    /**
     * ⚠️ BE ŠITO ANKSTESNIS TVIRTINIMAS NIEKO NEĮRODO.
     *
     * Stebėtojas, kuris nieko nerado, neatskiriamas nuo stebėtojo, kuris neveikia.
     * Čia sugadinama BŪTENT ta savybė, kurią tikra migracija turi: progresas
     * rašomas SAVO transakcijoje PRIEŠ perjungimą, tad atsiranda commit'inta
     * būsena „progresas `done`, eilutė `inline`" — pora, kurios negina joks `CHECK`.
     *
     * Mutacija rašoma ČIA, teste, o ne kaip produkcinio kodo režimas: „sugadinto
     * režimo" vėliavėlė gyventų kode amžinai ir kada nors būtų įjungta.
     */
    const jobId = await naujasInline({ text: "mutacija" });

    const stop = paleistiStebetoja(saugykla);

    await pool.query(
      `INSERT INTO artifact_migration_progress
             (job_id, busena, storage_type, storage_key, run_id, created_at, updated_at)
       VALUES ($1, 'done', 'fs', 'results/mutacija/x.json', gen_random_uuid(), now(), now())`,
      [String(jobId)]
    );

    /** Stebėtojui duodamas laikas pamatyti commit'intą tarpinę būseną. */
    await new Promise((r) => setTimeout(r, 60));

    const pazeidimai = await stop();

    assert.ok(
      pazeidimai.some((p) => p.includes("tebėra inline")),
      `stebėtojas privalėjo pagauti porą; matė: ${JSON.stringify(pazeidimai)}`
    );

    await pool.query("DELETE FROM artifact_migration_progress WHERE job_id = $1", [String(jobId)]);
  });

  await t.test("MUTACIJA: nuoroda be objekto → stebėtojas KRENTA", async () => {
    /** Antra pora, ir ji tikrinama ATSKIRAI — bendras stebėtojas dengtų vieną iš dviejų. */
    const jobId = await naujasInline({ text: "be-objekto" });
    await pool.query(
      `UPDATE job_results
          SET storage_type = 'fs', storage_key = 'results/nera/objekto.json',
              bytes = 10, checksum = repeat('c', 64), payload = NULL
        WHERE job_id = $1`,
      [jobId]
    );

    const stop = paleistiStebetoja(saugykla);
    await new Promise((r) => setTimeout(r, 60));
    const pazeidimai = await stop();

    assert.ok(
      pazeidimai.some((p) => p.includes("objekto nėra")),
      `stebėtojas privalėjo pagauti nuorodą į tuštumą; matė: ${JSON.stringify(pazeidimai)}`
    );
  });
});
