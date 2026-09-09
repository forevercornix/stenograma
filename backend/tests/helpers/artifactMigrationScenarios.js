const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { Pool, Client } = require("pg");

const { testDatabaseUrl, adminDatabaseUrl } = require("./postgresGuard");
const { migruoti, sausasPaleidimas, PRIEZASTIS } = require("../../utils/artifactMigration");
const attemptRegistry = require("../../utils/attemptRegistry");

/**
 * MIGRACIJOS SCENARIJŲ RINKINYS — VIENAS, VISIEMS BACKEND'AMS (#157, PR-6).
 *
 * ⚠️ KODĖL RINKINYS IŠKELTAS, O NE NUKOPIJUOTAS `s3` PUSEI.
 *
 * Repo tą klaidą jau padarė tris kartus: rinkinys, rašytas prieš `fs`, tyliai
 * perima jo savybes (kelio forma, sinchroniškumas, rakto gamyba), ir tai
 * pasimato TIK prieš antrą backend'ą. `paleistiKontrakta` (PR-2) yra tas pats
 * sprendimas ta pačia priežastimi; čia jis pakartojamas migracijos sekai.
 *
 * ⚠️ KĄ RINKINYS ĮRODO, IR KAM TO REIKIA ANTRAM BACKEND'UI.
 *
 * Ne „migracija veikia", o kad TA PATI SEKA — `registras → put() → verify() →
 * atominis switch` — galioja ir prieš TINKLINĘ saugyklą. `ArtifactStore`
 * kontraktas dengia SEMANTIKĄ; jis nedengia trijų dalykų, kuriais `s3` skiriasi
 * nuo `fs`: `verify()` per tinklą, `put()` latencija partijoje ir klaidų
 * taksonomija.
 *
 * ⚠️ NĖ VIENAS TVIRTINIMAS NEREMIASI SAUGYKLOS RŪŠIMI.
 *
 * Dvi vietos, kurios anksčiau rėmėsi, dabar ateina iš fixture:
 *
 *   `sugadinti(raktas)`   — perrašo objektą TUO PAČIU ilgiu, APLENKDAMAS mūsų
 *                           saugyklą; grąžina ilgį prieš sugadinimą;
 *   `objektuKiekis()`     — kiek objektų saugykloje.
 *
 * Be jų P1 scenarijus būtų įkodavęs „objektas yra failas kelyje", o `s3` atveju
 * tai netiesa.
 */
function paleistiMigracijosScenarijus(vardas, { dbSuffix, praleisti, paruostiSaugykla }) {
  const ŠAKNIS = path.resolve(__dirname, "..", "..");
  const DB_URL = testDatabaseUrl(dbSuffix);
  const PRALEISTI = praleisti;

  let pool = null;
  let fixture = null;

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

  /** Fixture galimybės — kviečiamos scenarijų, aprašytos backend'o. */
  const sugadinti = (raktas) => fixture.sugadinti(raktas);
  const objektuKiekis = () => fixture.objektuKiekis();

  /**
   * ⚠️ BACKEND'O VARDAS IMAMAS IŠ SAUGYKLOS, NE RAŠOMAS SCENARIJUJE.
   *
   * Pirma iškelto rinkinio redakcija tvirtino `storage_type === "fs"` — t. y.
   * rinkinys, rašytas prieš `fs`, buvo TYLIAI perėmęs jo savybę. Prieš `s3` tai
   * davė šešis kritimus (CI 34370538544), ir tai NĖRA radinys apie `s3`: tai
   * radinys apie rinkinį, kuris teigė daugiau, nei tikrino.
   *
   * Būtent dėl šios klasės antras backend'as ir buvo reikalingas — argumentas
   * „kontraktas jau dengia" jos nepagavo, nes kontraktas apie `job_results`
   * eilutės turinį nieko nesako.
   *
   * `saugykla.backend` yra pačios saugyklos deklaracija, tad scenarijus
   * nebeturi kaip išsiskirti su tuo, ką ji realiai persistina.
   */
  const backendas = () => fixture.saugykla.backend;


  async function perkurti() {
    /**
     * ⚠️ SENAS POOL'AS UŽDAROMAS PRIEŠ `DROP`, NE PO JO.
     *
     * `WITH (FORCE)` nutraukia VISAS sesijas. Likęs atviras pool'as gauna
     * „terminating connection due to administrator command" jau PO testo
     * pabaigos, ir `node --test` tai paverčia `uncaughtException`: visos
     * asercijos `ok`, failas `exit 1` (CI 34352704975 ir 34363036930).
     * Klasė registruota #310.
     */
    if (pool) await pool.end().catch(() => {});
    pool = null;

    await adminPg(`DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`);
    await adminPg(`CREATE DATABASE "${dbVardas()}"`);
    execFileSync("npx", ["node-pg-migrate", "up"], {
      cwd: ŠAKNIS,
      env: { ...process.env, DATABASE_URL: DB_URL },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    pool = new Pool({ connectionString: DB_URL });

    /** ⚠️ Ankstesnis fixture išvalomas ČIA, ne tik `after()` — kitaip lieka šiukšlės. */
    if (fixture) await fixture.isvalyti().catch(() => {});
    fixture = await paruostiSaugykla();

    return fixture.saugykla;
  }

  after(async () => {
    if (PRALEISTI) return;
    if (pool) await pool.end().catch(() => {});
    if (fixture) await fixture.isvalyti().catch(() => {});
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

  test(`#157 PR-6: sausas paleidimas nerašo NIEKUR [${vardas}]`, { skip: PRALEISTI, timeout: 300000 }, async (t) => {
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
      assert.equal(await objektuKiekis(), 0, "sausas paleidimas negali palikti objektų");
    });

    /** ⚠️ KONTROLĖ: be jos „nieko nepakeitė" tenkintų ir paleidimas, kuris nieko nerado. */
    await t.test("KONTROLĖ: kandidatų tikrai buvo", () => {
      assert.ok(suvestine.kandidatai > 0, "matavimas be kandidatų nieko nesako");
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════════
   * 2. TIKRAS PERKĖLIMAS, TVARKA IR IDEMPOTENCIJA
   * ═══════════════════════════════════════════════════════════════════════════ */

  test(`#157 PR-6: perkėlimas, registras ir pakartotinis paleidimas [${vardas}]`, { skip: PRALEISTI, timeout: 300000 }, async (t) => {
    const saugykla = await perkurti();

    const jobId = await naujasInline({ text: "protokolas" });
    const suvestine = await migruoti(pool, saugykla, {});

    await t.test("eilutė tapo external su PILNU trejetu", async () => {
      const r = await eilute(jobId);
      assert.equal(r.storage_type, backendas());
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

  test(`#157 PR-6: kiekviena nesėkmės klasė atskiriama ir nepraranda kopijos [${vardas}]`, { skip: PRALEISTI, timeout: 300000 }, async (t) => {
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

    await t.test("`verify()` nepatvirtino → `vientisumas_nepatvirtintas`, objektas pašalintas", async () => {
      /**
       * ⚠️ MELUOJA `verify()`, NE `head()`. Po P1 taisymo `head()` šiame kelyje
       * nebedalyvauja, tad senas `head` melagis nieko nebeišbandytų — testas būtų
       * žalias apie sargą, kurio nebekviečia.
       */
      const jobId = await naujasInline({ text: "nepatvirtintas" });
      const melagis = {
        ...saugykla,
        verify: async () => ({ ok: false, exists: true, bytes: 1, checksum: "a".repeat(64), nepriklausomas: true }),
      };

      const s = await migruoti(pool, melagis, {});

      assert.equal(s.nepavyko[PRIEZASTIS.VIENTISUMAS_NEPATVIRTINTAS], 1);
      assert.equal((await eilute(jobId)).storage_type, "inline", "SĄLYGA 7: `payload` nepaliestas");

      const bandymai = await attemptRegistry.joboBandymai(pool, String(jobId));
      assert.equal(bandymai[0].busena, attemptRegistry.BUSENA.ATMESTA);

      const galva = await saugykla.head(bandymai[0].storage_key);
      assert.equal(galva, null, "nepatvirtintas objektas privalo būti pašalintas");
    });

    await t.test("eilutė pasikeitė po `verify()` → `eilute_pasikeite`, svetima nuoroda nepaliesta", async () => {
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
              SET storage_type = $2, storage_key = 'results/svetimas/kitas.json',
                  bytes = 7, checksum = repeat('b', 64), payload = NULL
            WHERE job_id = $1`,
          [jobId, backendas()]
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

        const priesIlgis = await sugadinti(raktas);

        /**
         * ⚠️ KONTROLĖ TEN, KUR TEIGIAMA — TIES PAČIU SUGADINIMU.
         *
         * Be jos testas praeitų ir tada, jei sugadinimas pakeistų ILGĮ: tada jį
         * pagautų ir senoji `head()` patikra, ir įrodymas būtų apie kitą klasę.
         *
         * ⚠️ IR BŪTENT ČIA, O NE PO MIGRACIJOS. Po sėkmingo taisymo objektas
         * pašalinamas valymo, tad vėlesnė kontrolė taptų TUŠČIA — praeitų nieko
         * nepatikrinusi. Kontrolė, kuri po taisymo nustoja veikti, negina nieko.
         *
         * ⚠️ IR NE ĮDĖTINIS `t.test()`. Pirma redakcija kvietė `t.test()` iš
         * subtesto vidaus su TĖVO kontekstu; `node --test` tai baigia klaida
         * „Promise resolution is still pending", kuri sugadina VISĄ failą, ir
         * raundas nieko neįrodo (CI 34359378997).
         */
        const galva = await saugykla.head(raktas);
        assert.equal(Number(galva.bytes), priesIlgis, "sugadinimas pakeitė ILGĮ — kita klasė");
        assert.equal(
          Number(galva.bytes),
          Number(kvitas.bytes),
          "`head()` rodo tą patį dydį kaip kvitas — vadinasi ji šito sugadinimo NEPAGAUNA"
        );

        return kvitas;
      };

      const s = await migruoti(pool, gadintojas, {});

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

    await t.test("PRALAIMĖJĘS NEPERRAŠO laimėtojo `done` įrašo", async () => {
      /**
       * ⚠️ P2: PRALAIMĖJĘS CAS NAIKINO SVETIMĄ AUDITO ĮRAŠĄ.
       *
       * `irasytiNesekme()` upsert buvo besąlyginis: `busena = 'failed'`,
       * `storage_type`/`storage_key` į `NULL`. Jei kitas procesas tuo metu jau
       * įsipareigojo `done`, o `job_results` jau external, pralaimėjęs sunaikindavo
       * LAIMĖTOJO įrašą ir nuorodą į realiai egzistuojantį objektą — o jo `run_id`
       * pakeisdavo savuoju. Audito lentelė tada meluotų apie du dalykus vienu metu:
       * kad perkėlimas nepavyko, ir kad jį darė ne tas paleidimas.
       *
       * Lenktynės SINCHRONIZUOJAMOS ties draiverio riba, ne tikimasi: `put()`
       * kabliukas įvykdo VISĄ svetimo proceso perkėlimą (eilutė + progresas), tad
       * mūsų procesas garantuotai ateina antras.
       */
      const jobId = await naujasInline({ text: "lenktynes-progresas" });
      const svetimasRun = "11111111-2222-4333-8444-555555555555";

      const svetimas = { ...saugykla };
      svetimas.put = async (raktas, paruosta) => {
        const kvitas = await saugykla.put(raktas, paruosta);

        await pool.query(
          `UPDATE job_results
              SET storage_type = $2, storage_key = 'results/laimetojas/a.json',
                  bytes = 9, checksum = repeat('d', 64), payload = NULL
            WHERE job_id = $1`,
          [jobId, backendas()]
        );
        await pool.query(
          `INSERT INTO artifact_migration_progress
                 (job_id, busena, storage_type, storage_key, run_id, created_at, updated_at)
           VALUES ($1, 'done', $3, 'results/laimetojas/a.json', $2, now(), now())`,
          [String(jobId), svetimasRun, backendas()]
        );

        return kvitas;
      };

      const s = await migruoti(pool, svetimas, {});

      assert.equal(s.nepavyko[PRIEZASTIS.EILUTE_PASIKEITE], 1, "kontrolė: mūsų procesas TIKRAI pralaimėjo");

      const p = await progresas(jobId);
      assert.equal(p.busena, "done", "laimėtojo įrašas privalo išlikti");
      assert.equal(p.storage_key, "results/laimetojas/a.json", "nuoroda į realų objektą nesunaikinta");
      assert.equal(p.priezastis, null, "`failed` priežastis negali atsirasti ant `done` įrašo");
      assert.equal(p.run_id, svetimasRun, "laimėtojo `run_id` neperrašytas");
    });

    await t.test("PARTIJA, viršijanti vienos eilutės dydį, apdorojama DALIMIS", async () => {
      /**
       * ⚠️ KĄ ŠIS TESTAS ĮRODO, IR KO NEĮRODINĖJA.
       *
       * Įrodo, kad kelios stambios eilutės pereina VISOS ir nė viena neužstringa —
       * t. y. kad apdorojimas eina per eilutę. NEĮRODO atsparumo ties 20 GiB: toks
       * rinkinys CI'uje neįmanomas, o mažesnis nieko nesakytų. Baitinę ribą pagal
       * konstrukciją įrodo `artifactMigrationContract` („atranka netraukia
       * `payload`"), ir tai vienintelis būdas ją įrodyti tikrai.
       */
      const tekstas = "a".repeat(64 * 1024);
      const kiek = 6;
      for (let i = 0; i < kiek; i += 1) await naujasInline({ text: `${i}-${tekstas}` });

      const s = await migruoti(pool, saugykla, {});

      assert.equal(s.perkelta, kiek, "visos stambios eilutės privalo pereiti");
      assert.deepEqual(s.nepavyko, {}, "dydis pats savaime nėra nesėkmė");
      assert.equal(s.praleista, 0);
    });

    await t.test("Eilutė, perjungta TARP atrankos ir traukimo, PRALEIDŽIAMA (ne `failed`)", async () => {
      /**
       * ⚠️ TAI LANGAS, KURĮ ATVĖRĖ `payload` TRAUKIMAS PER EILUTĘ.
       *
       * Atranka grąžina tik `job_id`, tad tarp jos ir traukimo eilutę gali
       * perjungti įprastas užbaigimo kelias. Tokia eilutė NĖRA nesėkmė — niekas
       * nesugedo, darbą atliko kas nors kitas, ir `failed` įrašas apie ją meluotų
       * bei dar užkirstų kelią būsimiems paleidimams be `retryFailed`.
       *
       * Langas uždaromas ta pačia sąlyga (`storage_type = 'inline'`), kuri yra
       * atrankoje; čia tikrinamas ELGESYS, o sąlygos buvimą gina kontraktinis testas.
       *
       * Sinchronizuojama ties draiverio riba: pirmos eilutės `put()` perjungia
       * ANTRĄ, tad kai ciklas prie jos prieina, ji jau nebe `inline`.
       */
      const pirmas = await naujasInline({ text: "pirmas" });
      const antras = await naujasInline({ text: "antras" });

      const kabliukas = { ...saugykla };
      let perjungta = false;
      kabliukas.put = async (raktas, paruosta) => {
        const kvitas = await saugykla.put(raktas, paruosta);
        if (!perjungta) {
          perjungta = true;
          await pool.query(
            `UPDATE job_results
                SET storage_type = $2, storage_key = 'results/kitas/proc.json',
                    bytes = 5, checksum = repeat('e', 64), payload = NULL
              WHERE job_id = $1`,
            [antras, backendas()]
          );
        }
        return kvitas;
      };

      const s = await migruoti(pool, kabliukas, {});

      assert.equal(s.perkelta, 1, "pirmas perkeltas");
      assert.equal(s.praleista, 1, "antras PRALEISTAS, ne pažymėtas nesėkme");
      assert.deepEqual(s.nepavyko, {}, "praleidimas negali virsti `failed`");
      assert.equal(await progresas(antras), null, "praleistas job'as neturi progreso įrašo");
      assert.equal((await eilute(pirmas)).storage_type, backendas());
    });

    await t.test("`failed` eilutės pakartotinai NEBANDOMOS be `retryFailed`", async () => {
      const pries = await migruoti(pool, saugykla, {});
      assert.equal(pries.kandidatai, 0, "visos keturios pažymėtos `failed` ir praleidžiamos");

      const su = await sausasPaleidimas(pool, { retryFailed: true });
      assert.ok(su.kandidatai > 0, "`retryFailed` privalo jas grąžinti — sprendimas yra operatoriaus");
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════════
   * 3b. BATCH'Ų GRANDINĖ — `LIMIT` TIKRAI ATKERTA
   * ═══════════════════════════════════════════════════════════════════════════ */

  test(`#157 PR-6: \`--limit\` grandinė baigia darbą per kelis paleidimus [${vardas}]`, { skip: PRALEISTI, timeout: 300000 }, async (t) => {
    const saugykla = await perkurti();

    /**
     * ⚠️ RINKINYS PARINKTAS TAIP, KAD `LIMIT` ATKIRSTŲ TRIS KARTUS.
     *
     * Septynios eilutės su `limit: 3` duoda 3 + 3 + 1 + 0. Lyginis skaičius
     * paslėptų klaidą paskutiniame, nepilname batch'e — būtent ten, kur ciklo
     * pabaigos sąlyga dažniausiai ir klysta.
     *
     * ⚠️ IDEMPOTENCIJA TIKRINAMA PAKARTOJIMU, NE PRIELAIDA. Ankstesnis testas
     * („PAKARTOTINIS paleidimas nieko nebedaro") tikrino vieną eilutę ir vieną
     * pakartojimą; čia grandinė vykdoma iki pabaigos, ir kiekvienas žingsnis
     * tikrinamas atskirai.
     */
    const IS_VISO = 7;
    const RIBA = 3;
    const laukiama = [3, 3, 1, 0];

    const jobai = [];
    for (let i = 0; i < IS_VISO; i += 1) jobai.push(await naujasInline({ text: `batch-${i}` }));

    const gauta = [];
    for (let raundas = 0; raundas < laukiama.length; raundas += 1) {
      const s = await migruoti(pool, saugykla, { limit: RIBA });
      gauta.push(s.perkelta);
      assert.deepEqual(s.nepavyko, {}, `raundas ${raundas}: nesėkmių būti neturi`);
      assert.equal(s.praleista, 0, `raundas ${raundas}: praleidimų būti neturi`);
    }

    await t.test("kiekvienas raundas perkelia tiek, kiek `LIMIT` leidžia", () => {
      assert.deepEqual(gauta, laukiama, "grandinė nesutampa — `LIMIT` arba atranka klysta");
    });

    await t.test("KONTROLĖ: `LIMIT` tikrai atkirto, o ne visi tilpo iš karto", () => {
      /**
       * Be jos testas praeitų ir tada, jei `limit` būtų ignoruojamas ir viskas
       * pereitų per vieną raundą — o tada grandinė nieko neįrodytų.
       */
      assert.ok(gauta[0] === RIBA && gauta.length > 2, "pirmas raundas privalo būti APRIBOTAS");
      assert.ok(gauta[gauta.length - 2] < RIBA, "priešpaskutinis raundas privalo būti NEPILNAS");
    });

    await t.test("visos eilutės perkeltos, be dublikatų", async () => {
      for (const jobId of jobai) {
        const r = await eilute(jobId);
        assert.equal(r.storage_type, backendas(), `${jobId} liko inline`);
        assert.equal(r.payload, null);

        const p = await progresas(jobId);
        assert.equal(p.busena, "done");
        assert.equal(p.storage_key, r.storage_key);

        const bandymai = await attemptRegistry.joboBandymai(pool, String(jobId));
        assert.equal(bandymai.length, 1, "pakartotinis paleidimas negali sukurti antro objekto");
        assert.equal(bandymai[0].busena, attemptRegistry.BUSENA.ISIPAREIGOTA);
      }
    });

    await t.test("PENKTAS raundas nieko nebekeičia", async () => {
      const s = await migruoti(pool, saugykla, { limit: RIBA });
      assert.equal(s.kandidatai, 0, "atranka privalo būti tuščia");
      assert.equal(s.perkelta, 0);
    });

    await t.test("`dry-run` mato tą pačią ribą", async () => {
      /** Sausas paleidimas be kandidatų — kontrolė, kad `limit` jam irgi galioja. */
      for (let i = 0; i < 4; i += 1) await naujasInline({ text: `sausas-${i}` });

      const s = await sausasPaleidimas(pool, { limit: 2 });
      assert.equal(s.kandidatai, 2, "`limit` galioja ir sausame paleidime");
      assert.equal(s.perkeltini, 2);
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

  test(`#157 PR-6: stebėtojas nemato pažeistų POrų, ir tai patikrinta mutacija [${vardas}]`, { skip: PRALEISTI, timeout: 300000 }, async (t) => {
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
         VALUES ($1, 'done', $2, 'results/mutacija/x.json', gen_random_uuid(), now(), now())`,
        [String(jobId), backendas()]
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
            SET storage_type = $2, storage_key = 'results/nera/objekto.json',
                bytes = 10, checksum = repeat('c', 64), payload = NULL
          WHERE job_id = $1`,
        [jobId, backendas()]
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

}

module.exports = { paleistiMigracijosScenarijus };
