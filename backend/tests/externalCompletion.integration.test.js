const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const { Pool, Client } = require("pg");

const { skipWithoutPostgres, testDatabaseUrl, adminDatabaseUrl } = require("./helpers/postgresGuard");
const { createPostgresStore } = require("../utils/jobStore/postgresStore");
const { createFsArtifactStore } = require("../utils/artifactStore/fsStore");
const { arParuosta } = require("../utils/artifactStore/validation");
const attemptRegistry = require("../utils/attemptRegistry");
const { STATUS, OWNER_KIND } = require("../utils/jobStore/common");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * EXTERNAL COMPLETION — RAŠYMO KELIAS SU BANDYMŲ REGISTRU (#157, PR-4).
 *
 * ⚠️ ČIA PIRMĄ KARTĄ SUSITINKA VISOS TRYS DALYS: `ArtifactStore` rašymas, registras ir
 * completion CAS. Kiekviena atskirai jau padengta; klausimas, į kurį atsako šis failas,
 * yra jų TVARKA — kas įvyksta prieš ką ir kas lieka, kai grandinė nutrūksta.
 *
 * ⚠️ ŠIS FAILAS VIETOJE NEVYKDOMAS - reikia tikros PostgreSQL.
 */

const SAKNIS = path.resolve(__dirname, "..");
const DB_URL = testDatabaseUrl("externalcompletion");
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

after(async () => {
  if (PRALEISTI) return;
  await adminPg(`DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`).catch(() => {});
});

test("#157 PR-4: external completion, registras ir pakartojimas", { skip: PRALEISTI, timeout: 180000 }, async (t) => {
  await adminPg(`DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`);
  await adminPg(`CREATE DATABASE "${dbVardas()}"`);
  execFileSync("npx", ["node-pg-migrate", "up"], {
    cwd: SAKNIS,
    env: { ...process.env, DATABASE_URL: DB_URL },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const pool = new Pool({ connectionString: DB_URL });
  const saknis = await fsp.mkdtemp(path.join(os.tmpdir(), "stenograma-external-"));
  t.after(async () => {
    await pool.end().catch(() => {});
    await fsp.rm(saknis, { recursive: true, force: true });
  });

  /** Skaitiklis: `put` yra tas kvietimas, kurio pre-check privalo išvengti. */
  const fs = createFsArtifactStore({ root: saknis });
  const saugykla = {
    ...fs,
    backend: "fs",
    rasymai: 0,
    trynimai: [],
    neparuostos: 0,
    async put(raktas, reiksme) {
      this.rasymai += 1;

      /**
       * ⚠️ KONTRAKTAS, NE STILIUS: completion kelias privalo perduoti PARUOŠTĄ
       * reprezentaciją (#294, Codex „Reuse the prepared result").
       *
       * `paruostiReiksme()` idempotentiškumas yra ŠVELNINIMAS — jis pašalina PASEKMĘ
       * (kvitas ir baitai išsiskiria), bet ne KELIĄ: kvietėjas vis dar gali paskaičiuoti
       * kvitą ties riba, o į `put()` paduoti žalią reikšmę, ir niekas nekris. Čia tas
       * kelias tampa MATOMAS: skaitiklis kaupia atvejus, o tvirtinimas gyvena testuose,
       * kad gedimas rodytų į konkretų scenarijų, ne į bendrą „kažkas kažkada".
       */
      if (!arParuosta(reiksme)) this.neparuostos += 1;

      return fs.put(raktas, reiksme);
    },
    async delete(raktas) {
      this.trynimai.push(raktas);
      return fs.delete(raktas);
    },
  };

  const store = createPostgresStore(pool, { rasymoSaugykla: saugykla });

  async function naujasJobas() {
    const job = await store.create({ ownerKind: OWNER_KIND.UNOWNED, type: "transcription" });
    await store.update(job.id, { status: STATUS.PROCESSING, phase: "transcribing" });
    return job.id;
  }

  async function eilute(jobId) {
    const { rows } = await pool.query("SELECT * FROM job_results WHERE job_id = $1", [jobId]);
    return rows[0] || null;
  }

  await t.test("completion parašo NUORODĄ, ne turinį, ir uždaro registro eilutę", async () => {
    const id = await naujasJobas();
    const rezultatas = { text: "external transkripcija", segments: [1, 2] };

    saugykla.rasymai = 0;
    const job = await store.finishAtomic(id, STATUS.COMPLETED, { result: rezultatas });

    assert.equal(job.status, STATUS.COMPLETED);
    assert.deepEqual(job.result, rezultatas, "hidratacija grąžina TĄ PATĮ loginį rezultatą");
    assert.equal(saugykla.rasymai, 1, "vienas bandymas — vienas objektas");

    const r = await eilute(id);
    assert.equal(r.storage_type, "fs");
    assert.equal(r.payload, null, "external eilutėje turinio NĖRA");
    assert.match(r.storage_key, new RegExp(`^results/${id}/`), "raktas neša job'o prefiksą");
    assert.match(r.checksum, /^[0-9a-f]{64}$/);

    const bandymai = await attemptRegistry.joboBandymai(pool, id);
    assert.equal(bandymai.length, 1);
    assert.equal(bandymai[0].busena, attemptRegistry.BUSENA.ISIPAREIGOTA, "registras uždarytas");
    assert.equal(bandymai[0].storage_key, r.storage_key, "registras ir nuoroda rodo TĄ PATĮ objektą");
  });

  await t.test("registro eilutė egzistuoja JAU TADA, kai prasideda `put()`", async () => {
    /**
     * ⚠️ TVARKA TIKRINAMA PER PRODUKCINĮ KELIĄ, NE PER MODULIO SIGNATŪRĄ (Codex, #294).
     *
     * `attemptRegistry` vienetinis testas niekada nekviečia `finishAtomic()`: perkėlus
     * `registruoti()` ŽEMIAU `put()`, jis liktų žalias — o būtent ta tvarka yra viso
     * registro esmė. „Geriau eilutė be objekto, nei objektas be eilutės" yra teiginys
     * apie SEKĄ, tad ir tikrinti reikia seką.
     *
     * Dublis klausia DB rašymo metu: ar mano bandymo eilutė jau yra?
     */
    const id = await naujasJobas();
    let eiluteRasymoMetu = null;

    const stebimaSaugykla = {
      ...saugykla,
      async put(raktas, reiksme) {
        const { rows } = await pool.query(
          "SELECT busena FROM job_result_attempts WHERE storage_key = $1",
          [raktas]
        );
        eiluteRasymoMetu = rows[0] ? rows[0].busena : null;
        return saugykla.put(raktas, reiksme);
      },
    };

    const suStebejimu = createPostgresStore(pool, { rasymoSaugykla: stebimaSaugykla });
    await suStebejimu.finishAtomic(id, STATUS.COMPLETED, { result: { text: "tvarka" } });

    assert.equal(
      eiluteRasymoMetu,
      attemptRegistry.BUSENA.LAUKIA,
      "registro eilutė privalo egzistuoti (`pending`) DAR PRIEŠ rašymą į saugyklą"
    );
  });

  await t.test("pakartojimas su TUO PAČIU rezultatu: `put()` NEKVIEČIAMAS, version nedidėja", async () => {
    /**
     * ⚠️ SU ATTEMPT-UNIQUE RAKTU PRE-CHECK YRA VIENINTELIS DALYKAS, NELEIDŽIANTIS
     * ŠIUKŠLĖS. „Tas pats raktas, tad perrašymas nekenkia" nebeegzistuoja: be
     * pre-check kiekvienas pakartojimas sukurtų NAUJĄ objektą.
     */
    const id = await naujasJobas();
    const rezultatas = { text: "idempotencija" };

    const pirmas = await store.finishAtomic(id, STATUS.COMPLETED, { result: rezultatas });
    const pirmaEilute = await eilute(id);

    saugykla.rasymai = 0;
    const antras = await store.finishAtomic(id, STATUS.COMPLETED, { result: rezultatas });

    assert.equal(saugykla.rasymai, 0, "pakartojimas į saugyklą NERAŠO");
    assert.equal(antras.version, pirmas.version, "version nedidėja");
    assert.deepEqual(antras.result, rezultatas, "bet rezultatas grąžinamas kaip visada");

    const antraEilute = await eilute(id);
    assert.equal(antraEilute.storage_key, pirmaEilute.storage_key, "nuoroda neperrašoma");

    const bandymai = await attemptRegistry.joboBandymai(pool, id);
    assert.equal(bandymai.length, 1, "naujas bandymas net neregistruojamas");
  });

  await t.test("pakartojimas su KITU rezultatu: `RESULT_CONFLICT`, o pralaimėjęs objektas IŠVALOMAS", async () => {
    const id = await naujasJobas();
    await store.finishAtomic(id, STATUS.COMPLETED, { result: { text: "pirmas" } });
    const pirmaEilute = await eilute(id);

    saugykla.trynimai = [];
    const verdiktas = await store.finishAtomic(id, STATUS.COMPLETED, { result: { text: "antras" } });

    assert.equal(verdiktas, "RESULT_CONFLICT");

    const bandymai = await attemptRegistry.joboBandymai(pool, id);
    assert.equal(bandymai.length, 2, "antras bandymas registruotas PRIEŠ `put()`");

    const atmestas = bandymai.find((b) => b.busena === attemptRegistry.BUSENA.ATMESTA);
    assert.ok(atmestas, "pralaimėjęs pažymimas `abandoned`, ne ištrinamas iš registro");
    assert.deepEqual(saugykla.trynimai, [atmestas.storage_key], "valymas liečia TIK savo bandymą");

    /** ⚠️ LAIMĖTOJO OBJEKTAS NEPALIESTAS — su skirtingais raktais to net neįmanoma. */
    assert.ok(await saugykla.head(pirmaEilute.storage_key), "laimėtojo objektas vietoje");
    assert.equal(await saugykla.head(atmestas.storage_key), null, "pralaimėjusio — nebėra");
    assert.equal((await eilute(id)).storage_key, pirmaEilute.storage_key, "nuoroda nepakitusi");
  });

  await t.test("checksum sutampa, bet objekto NĖRA: tai REMONTAS, ne pakartojimas", async () => {
    /**
     * ⚠️ NO-OP NEGALI BŪTI SKELBIAMAS NEPATIKRINUS, AR OBJEKTAS DAR YRA (Codex, #289).
     * Sutapęs checksum sako tik tiek, kad METADUOMENYS sutampa; grąžinus sėkmę virš
     * pakibusios nuorodos, job'as liktų `completed` be naudojamo rezultato.
     */
    const id = await naujasJobas();
    const rezultatas = { text: "remontas" };
    await store.finishAtomic(id, STATUS.COMPLETED, { result: rezultatas });

    const sena = await eilute(id);
    /** Objektas dingsta iš saugyklos — DB apie tai nieko nežino. */
    await fs.delete(sena.storage_key);

    saugykla.rasymai = 0;
    const job = await store.finishAtomic(id, STATUS.COMPLETED, { result: rezultatas });

    assert.equal(saugykla.rasymai, 1, "remontas RAŠO naują objektą");
    assert.deepEqual(job.result, rezultatas);

    const nauja = await eilute(id);
    assert.notEqual(nauja.storage_key, sena.storage_key, "nuoroda perjungta į naują bandymą");
    assert.ok(await saugykla.head(nauja.storage_key));
  });

  await t.test("kvitas ir įrašytas turinys sutampa net su NESTABILIA reikšme", async () => {
    /**
     * ⚠️ TAS PATS PER PRODUKCINĮ KELIĄ, NE PER `put()` (Codex, #294).
     *
     * Bendras kontraktas tikrina `put()`; čia tikrinama visa `finishAtomic()` grandinė:
     * kvitas skaičiuojamas VIENĄ kartą, ir būtent ta reprezentacija patenka į saugyklą.
     * Reikšmė svyruoja po ribos skaitymų — jei kelias ją kanonizuotų antrą kartą,
     * `checksum` kolonoje ir objekte gultų SKIRTINGI duomenys.
     */
    const id = await naujasJobas();

    let kvietimai = 0;
    const nestabili = {
      get text() {
        kvietimai += 1;
        return kvietimai <= 3 ? "pirma" : "antra";
      },
    };

    const job = await store.finishAtomic(id, STATUS.COMPLETED, { result: nestabili });

    assert.deepEqual(job.result, { text: "pirma" }, "grąžinamas tas turinys, kurį matė riba");

    const r = await eilute(id);
    const objektas = await saugykla.read(r.storage_key);
    const crypto2 = require("node:crypto");
    const { kanoninisRezultatas } = require("../utils/jobStore/common");

    assert.equal(
      crypto2.createHash("sha256").update(kanoninisRezultatas(objektas), "utf8").digest("hex"),
      r.checksum,
      "`checksum` kolona privalo aprašyti TAI, kas guli saugykloje"
    );
    assert.equal(Number(r.bytes), Buffer.byteLength(kanoninisRezultatas(objektas), "utf8"));
  });

  await t.test("DU lygiagretūs REMONTAI to paties dingusio objekto: lieka VIENAS įsipareigotas", async () => {
    /**
     * ⚠️ SCENARIJUS, KURIO TREČIOJI MUTACIJA NEPAGAVO (Codex, #294).
     *
     * Mutacijų lentelė „patvirtino", kad registro būsenos sargas veikia — bet dengė
     * VIENĄ kelią, ne invariantą. Šis atvejis laužia tą patį invariantą kita kryptimi:
     * abu vykdytojai pre-check metu mato TĄ PATĮ dingusį objektą ir abu nusprendžia
     * remontuoti. Jei sprendimas priimtas PRIEŠ užraktą ir vykdomas po jo, antrasis
     * perrašo pirmojo nuorodą — laimėtojo objektas lieka nereferencuotas, o job'as
     * gauna DU įsipareigotus registro įrašus.
     *
     * Dabar pre-check fiksuoja tik STEBĖJIMĄ („šitas raktas buvo tuščias"), o remontą
     * patvirtina transakcija: jei eilutė po užraktu rodo jau į kitą raktą, mes esame
     * pralaimėjęs bandymas.
     */
    const id = await naujasJobas();
    const rezultatas = { text: "remonto lenktynės" };

    await store.finishAtomic(id, STATUS.COMPLETED, { result: rezultatas });
    const sena = await eilute(id);

    /** Objektas dingsta — abu vykdytojai pamatys tą patį tuščią raktą. */
    await fs.delete(sena.storage_key);

    const [a, b] = await Promise.all([
      store.finishAtomic(id, STATUS.COMPLETED, { result: rezultatas }),
      store.finishAtomic(id, STATUS.COMPLETED, { result: rezultatas }),
    ]);

    for (const atsakymas of [a, b]) {
      assert.equal(typeof atsakymas, "object", `netikėtas verdiktas: ${JSON.stringify(atsakymas)}`);
      assert.deepEqual(atsakymas.result, rezultatas);
    }

    const nauja = await eilute(id);
    const bandymai = await attemptRegistry.joboBandymai(pool, id);
    const isipareigoti = bandymai.filter((x) => x.busena === attemptRegistry.BUSENA.ISIPAREIGOTA);

    assert.equal(
      isipareigoti.length,
      1,
      `po dviejų remontų privalo likti VIENAS įsipareigotas: ` +
        JSON.stringify(bandymai.map((x) => [x.storage_key, x.busena]))
    );
    assert.equal(isipareigoti[0].storage_key, nauja.storage_key, "nuoroda rodo į jį");
    assert.ok(await saugykla.head(nauja.storage_key), "remontuotas objektas vietoje");

    /** Ir nė vienas nereferencuotas objektas neliko saugykloje. */
    for (const bandymas of bandymai.filter((x) => x.storage_key !== nauja.storage_key)) {
      assert.equal(
        bandymas.busena,
        attemptRegistry.BUSENA.ATMESTA,
        `nereferencuotas bandymas privalo būti \`abandoned\`: ${bandymas.storage_key}`
      );
      assert.equal(
        await saugykla.head(bandymas.storage_key),
        null,
        `nereferencuotas objektas liko: ${bandymas.storage_key} (${bandymas.busena})`
      );
    }
  });

  await t.test("po REMONTO senasis bandymas nustoja būti `committed`", async () => {
    /**
     * ⚠️ INVARIANTAS: JOB'AS TURI DAUGIAUSIA VIENĄ ĮSIPAREIGOTĄ BANDYMĄ (išmatuota
     * CI 34083939521).
     *
     * Pirmoji redakcija po remonto palikdavo DU `committed` įrašus: senąjį (kurio
     * objekto nebėra) ir naująjį. Registras tada teigtų, kad naudojami DU objektai, o
     * šlavėjas (PR-5) senojo niekada neliestų — jis atrodytų reikalingas. Tai tas pats
     * „registras rašo, bet meluoja" atvejis, tik kita kryptimi.
     */
    const id = await naujasJobas();
    const rezultatas = { text: "remonto istorija" };

    await store.finishAtomic(id, STATUS.COMPLETED, { result: rezultatas });
    const sena = await eilute(id);
    await fs.delete(sena.storage_key);

    await store.finishAtomic(id, STATUS.COMPLETED, { result: rezultatas });

    const bandymai = await attemptRegistry.joboBandymai(pool, id);
    const isipareigoti = bandymai.filter((x) => x.busena === attemptRegistry.BUSENA.ISIPAREIGOTA);

    assert.equal(bandymai.length, 2, "abu bandymai lieka registre — jis yra istorija, ne būsena");
    assert.equal(isipareigoti.length, 1, "bet įsipareigotas gali būti tik VIENAS");
    assert.equal(
      bandymai.find((x) => x.storage_key === sena.storage_key).busena,
      attemptRegistry.BUSENA.ATMESTA,
      "senasis privalo tapti `abandoned`, kad šlavėjas jį matytų"
    );
  });

  await t.test("pre-check klausia PERSISTINTO backend'o, ne aktyvaus", async () => {
    /**
     * ⚠️ #245 INVARIANTAS: persistinti metaduomenys autoritetingi, runtime konfigūracija
     * — ne. PR-3 jį užrašė hidratacijos pusėje; pre-check jį pažeidė trečioje vietoje.
     *
     * DB po migracijos ilgai bus MIŠRI: `s3` eilutės objektas, tikrinamas per `fs`
     * saugyklą, atrodytų dingęs — ir tai sukeltų remontą, kurio niekas neprašė, plius
     * naują objektą kitame backend'e.
     */
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, created_at, updated_at)
       VALUES ($1, 'transcription', 'completed', now(), now())`,
      [id]
    );

    const turinys = { text: "s3 eilutė" };
    const { paruostiReiksme } = require("../utils/artifactStore/validation");
    const paruosta = paruostiReiksme(turinys);

    await pool.query(
      `INSERT INTO job_results (job_id, storage_type, storage_key, bytes, checksum, created_at)
       VALUES ($1, 's3', $2, $3, $4, now())`,
      [id, `results/${id}/svetimas.json`, paruosta.bytes, paruosta.checksum]
    );

    /** Rašymo saugykla yra `fs`, o eilutė — `s3`: klausti `fs` būtų klaida. */
    await assert.rejects(
      () => store.finishAtomic(id, STATUS.COMPLETED, { result: turinys }),
      /neregistruota|kito backend/i,
      "pre-check negali tikrinti `s3` eilutės per `fs` saugyklą"
    );
  });

  /* ═══ LYGYBĖS PARITETAS: TAS PATS SĄRAŠAS ABIEM KELIAMS ═══ */

  await t.test("external verdiktai SUTAMPA su inline verdiktais toms pačioms poroms", async () => {
    /**
     * ⚠️ TAI PRIELAIDA, ANT KURIOS STOVI VISAS EXTERNAL IDEMPOTENTIŠKUMAS.
     *
     * `inline` lygina kanonines eilutes, external — persistintą `checksum`. Tai ta pati
     * išvestis dviem pavidalais, bet „ta pati" yra TEIGINYS, kol jo niekas nepatikrino.
     * Jei kada nors išsiskirs, external kelias skelbtų „tas pats rezultatas" ten, kur
     * inline skelbia konfliktą — arba atvirkščiai, ir teisėtas retry gautų
     * `RESULT_CONFLICT`.
     *
     * Sąrašas bendras (`helpers/rezultatuPoros.js`), tad abu keliai gauna TIKSLIAI tą
     * pačią įvestį — įrašius jį į vieną testą, antrasis anksčiau ar vėliau gautų savo
     * variantą, ir paritetas taptų nepatikrinamas.
     */
    const { POROS } = require("./helpers/rezultatuPoros");
    const inlineStore = createPostgresStore(pool);

    for (const pora of POROS) {
      /* ── external kelias ── */
      const idExternal = await naujasJobas();
      await store.finishAtomic(idExternal, STATUS.COMPLETED, { result: pora.pirmas });
      const pirmaVersija = (await store.get(idExternal, { hydrate: false })).version;

      const externalVerdiktas = await store.finishAtomic(idExternal, STATUS.COMPLETED, {
        result: pora.antras,
      });

      /* ── inline kelias, TA PATI pora ── */
      const idInline = await naujasJobas();
      await inlineStore.finishAtomic(idInline, STATUS.COMPLETED, { result: pora.pirmas });
      const inlineVerdiktas = await inlineStore.finishAtomic(idInline, STATUS.COMPLETED, {
        result: pora.antras,
      });

      const externalTapatus = typeof externalVerdiktas === "object";
      const inlineTapatus = typeof inlineVerdiktas === "object";

      assert.equal(
        externalTapatus,
        inlineTapatus,
        `${pora.vardas}: verdiktai IŠSISKYRĖ (external: ${JSON.stringify(externalVerdiktas)}, ` +
          `inline: ${JSON.stringify(inlineVerdiktas)})`
      );
      assert.equal(externalTapatus, pora.tapatus, `${pora.vardas}: verdiktas ne toks, kokio laukta`);

      if (pora.tapatus) {
        assert.equal(
          (await store.get(idExternal, { hydrate: false })).version,
          pirmaVersija,
          `${pora.vardas}: no-op version NEDIDINA`
        );
      }
    }
  });

  /* ═══ LYGIAGRETUMAS: DVI LENKTYNĖS, NE VIENA ═══ */

  await t.test("DU lygiagretūs `finish()` su TUO PAČIU rezultatu: lieka VIENAS objektas", async () => {
    /**
     * ⚠️ ĮDOMESNĖ LENKTYNĖ NEI SKIRTINGI REZULTATAI.
     *
     * Skirtingi rezultatai duoda `RESULT_CONFLICT` — akivaizdus atvejis. Tas pats
     * loginis rezultatas yra ten, kur susikerta pre-check, „pakartojimas vs remontas"
     * ir cleanup: abu vykdytojai mato TĄ PATĮ checksum, abu jau parašė savo objektą, ir
     * klausimas tampa — kas nutinka pralaimėjusiojo objektui.
     *
     * ⚠️ ŠI LENKTYNĖ RADO TREČIĄ BŪSENĄ. Pirmoji redakcija skyrė tik „pakartojimą" ir
     * „remontą", tad pralaimėjęs vykdytojas su tuo pačiu checksum PERJUNGDAVO nuorodą į
     * savo objektą — laimėtojo objektas liktų nereferencuotas, o job'as turėtų DU
     * įsipareigotus registro įrašus.
     */
    const id = await naujasJobas();
    const rezultatas = { text: "lygiagretus", segments: [1, 2, 3] };

    saugykla.rasymai = 0;
    saugykla.trynimai = [];

    /**
     * ⚠️ `Promise.all()` NEGARANTUOJA LENKTYNIŲ (Codex, #294).
     *
     * Be sinchronizacijos abu bandymai gali įvykti NUOSEKLIAI — pirmas spėja
     * įsipareigoti anksčiau, nei antras pasiekia pre-check — ir testas praeitų su
     * visomis asercijomis, nieko neišbandęs. Barjeras ties saugyklos riba sulaiko abu,
     * kol JIEDU paruošė savo objektus; tik tada leidžiama eiti į transakciją.
     */
    const barjeras = { laukiantys: 0, atrakinti: null };
    barjeras.zadejimas = new Promise((r) => {
      barjeras.atrakinti = r;
    });

    const suBarjeru = createPostgresStore(pool, {
      rasymoSaugykla: {
        ...saugykla,
        async put(raktas, reiksme) {
          const kvitas = await saugykla.put(raktas, reiksme);

          barjeras.laukiantys += 1;
          barjeras.atrakinti();

          return kvitas;
        },
      },
    });

    const [a, b] = await Promise.all([
      suBarjeru.finishAtomic(id, STATUS.COMPLETED, { result: rezultatas }),
      suBarjeru.finishAtomic(id, STATUS.COMPLETED, { result: rezultatas }),
    ]);

    assert.equal(barjeras.laukiantys, 2, "abu bandymai privalėjo pasiekti barjerą");

    /** Abu grąžina sėkmę: tas pats loginis rezultatas yra idempotentiškas. */
    for (const atsakymas of [a, b]) {
      assert.equal(typeof atsakymas, "object", `netikėtas verdiktas: ${JSON.stringify(atsakymas)}`);
      assert.deepEqual(atsakymas.result, rezultatas);
    }

    const r = await eilute(id);
    const bandymai = await attemptRegistry.joboBandymai(pool, id);
    const isipareigoti = bandymai.filter((x) => x.busena === attemptRegistry.BUSENA.ISIPAREIGOTA);

    /** 1. Laimėtojo objektas išlieka. */
    assert.ok(await saugykla.head(r.storage_key), "referencuotas objektas privalo egzistuoti");

    /**
     * 2. Pralaimėjusio cleanup laimėtojo NEPALIEČIA.
     *
     * ⚠️ SU ATTEMPT-UNIQUE RAKTU TAI SAUGU PAGAL KONSTRUKCIJĄ — ir būtent todėl verta
     * tvirtinimo: jei raktas kada nors taps TURINIO adresu, abu bandymai taikysis į tą
     * patį objektą, ir šis testas kris. Tai tas pats variantas, kuris jau buvo atmestas
     * (plano „ATMESTAS VARIANTAS: turinio adresas").
     */
    assert.ok(
      !saugykla.trynimai.includes(r.storage_key),
      `cleanup palietė laimėtojo objektą: ${saugykla.trynimai.join(", ")}`
    );

    /** 3. Job'ui lieka LYGIAI VIENAS įsipareigotas registro įrašas. */
    assert.equal(
      isipareigoti.length,
      1,
      `laukta vieno įsipareigoto bandymo, gauta ${isipareigoti.length}: ` +
        JSON.stringify(bandymai.map((x) => [x.attempt_id, x.busena]))
    );
    assert.equal(isipareigoti[0].storage_key, r.storage_key, "nuoroda rodo į įsipareigotą bandymą");

    /** Ir pralaimėjusiojo objekto nebėra — nei saugykloje, nei kaip `pending` eilutės. */
    for (const bandymas of bandymai.filter((x) => x !== isipareigoti[0])) {
      assert.equal(bandymas.busena, attemptRegistry.BUSENA.ATMESTA, "pralaimėjęs pažymimas");
      assert.equal(await saugykla.head(bandymas.storage_key), null, "ir jo objekto nebėra");
    }
  });

  await t.test("DU lygiagretūs `finish()` su SKIRTINGAIS rezultatais: vienas laimi, kitas gauna konfliktą", async () => {
    const id = await naujasJobas();

    const verdiktai = await Promise.all([
      store.finishAtomic(id, STATUS.COMPLETED, { result: { text: "A" } }),
      store.finishAtomic(id, STATUS.COMPLETED, { result: { text: "B" } }),
    ]);

    const laimeti = verdiktai.filter((v) => v && typeof v === "object");
    const konfliktai = verdiktai.filter((v) => v === "RESULT_CONFLICT");

    assert.equal(laimeti.length, 1, "lygiai vienas vykdytojas laimi");
    assert.equal(konfliktai.length, 1, "kitas gauna konfliktą, ne tylų perrašymą");

    const r = await eilute(id);
    assert.deepEqual((await store.get(id)).result, laimeti[0].result, "eilutė rodo laimėtojo rezultatą");

    const bandymai = await attemptRegistry.joboBandymai(pool, id);
    const isipareigoti = bandymai.filter((x) => x.busena === attemptRegistry.BUSENA.ISIPAREIGOTA);

    assert.equal(isipareigoti.length, 1);
    assert.equal(isipareigoti[0].storage_key, r.storage_key);
    assert.ok(await saugykla.head(r.storage_key), "laimėtojo objektas vietoje");

    for (const bandymas of bandymai.filter((x) => x !== isipareigoti[0])) {
      assert.equal(await saugykla.head(bandymas.storage_key), null, "pralaimėjusio objekto nebėra");
    }
  });

  /* ═══ I/O NEVYKSTA PO EILUTĖS UŽRAKTU ═══ */

  await t.test("`put()` vyksta NE po `jobs` eilutės užraktu — elgesio įrodymas", async (t2) => {
    /**
     * ⚠️ ŠITO NEGALIMA ĮRODYTI GREP'U (§9.2).
     *
     * „Patikrinom, kad `put()` kviečiamas prieš `inTransaction()`" yra teksto, ne
     * elgesio tvirtinimas: pakanka vieno refaktoringo, ir kvietimas persikelia į vidų,
     * o testas lieka žalias. Todėl saugyklos dublis rašymo metu bando ANTRA JUNGTIMI
     * paimti tos pačios `jobs` eilutės užraktą su `FOR UPDATE NOWAIT`.
     *
     * Jei `put()` vyktų po užraktu, PostgreSQL grąžintų `55P03` (lock_not_available), ir
     * testas kristų. Tai elgesio įrodymas su tikra DB, ne prielaida apie kodo tvarką.
     */
    const id = await naujasJobas();

    const antraJungtis = new Client({ connectionString: DB_URL });
    await antraJungtis.connect();
    t2.after(() => antraJungtis.end().catch(() => {}));

    let uzraktoKlaida = null;
    let uzraktasGautas = false;

    const stebimaSaugykla = {
      ...saugykla,
      async put(raktas, reiksme) {
        try {
          await antraJungtis.query("BEGIN");
          await antraJungtis.query("SELECT id FROM jobs WHERE id = $1 FOR UPDATE NOWAIT", [id]);
          uzraktasGautas = true;
        } catch (klaida) {
          uzraktoKlaida = klaida;
        } finally {
          await antraJungtis.query("ROLLBACK").catch(() => {});
        }

        return saugykla.put(raktas, reiksme);
      },
    };

    const suStebejimu = createPostgresStore(pool, { rasymoSaugykla: stebimaSaugykla });
    const job = await suStebejimu.finishAtomic(id, STATUS.COMPLETED, { result: { text: "užraktas" } });

    assert.deepEqual(job.result, { text: "užraktas" }, "rašymas privalo pavykti");
    assert.equal(
      uzraktoKlaida,
      null,
      `rašymo metu eilutė buvo UŽRAKINTA (${uzraktoKlaida && uzraktoKlaida.code}) — I/O vyksta po užraktu`
    );
    assert.equal(uzraktasGautas, true, "užraktas privalo būti laisvas `put()` metu");
  });

  await t.test("KONTROLĖ: tas pats zondas KRENTA, kai eilutė TIKRAI užrakinta", async (t2) => {
    /**
     * Be jos ankstesnis testas nieko neįrodytų: jis būtų žalias ir tada, jei
     * `FOR UPDATE NOWAIT` niekada nemestų (pvz. dėl klaidingos užklausos ar jungties).
     * Čia užraktas paimamas SĄMONINGAI, ir zondas privalo gauti `55P03`.
     */
    const id = await naujasJobas();

    const laikantis = new Client({ connectionString: DB_URL });
    const zondas = new Client({ connectionString: DB_URL });
    await laikantis.connect();
    await zondas.connect();
    t2.after(async () => {
      await laikantis.query("ROLLBACK").catch(() => {});
      await laikantis.end().catch(() => {});
      await zondas.end().catch(() => {});
    });

    await laikantis.query("BEGIN");
    await laikantis.query("SELECT id FROM jobs WHERE id = $1 FOR UPDATE", [id]);

    let kodas = null;
    try {
      await zondas.query("BEGIN");
      await zondas.query("SELECT id FROM jobs WHERE id = $1 FOR UPDATE NOWAIT", [id]);
    } catch (klaida) {
      kodas = klaida.code;
    } finally {
      await zondas.query("ROLLBACK").catch(() => {});
    }

    assert.equal(kodas, "55P03", "zondas privalo mokėti pastebėti užraktą");
  });

  await t.test("KONTROLĖ: be `rasymoSaugykla` rezultatas ir toliau rašomas INLINE", async () => {
    /**
     * Be jos ankstesni tvirtinimai būtų tenkinami ir store'o, kuris VISKĄ rašo
     * external — o #157 riba sako, kad `inline` lieka teisėtas režimas.
     */
    const inlineStore = createPostgresStore(pool);
    const id = await naujasJobas();

    const job = await inlineStore.finishAtomic(id, STATUS.COMPLETED, { result: { text: "inline" } });

    assert.deepEqual(job.result, { text: "inline" });
    const r = await eilute(id);
    assert.equal(r.storage_type, "inline");
    assert.equal(r.storage_key, null);
    assert.deepEqual(r.payload, { text: "inline" });
    assert.deepEqual(await attemptRegistry.joboBandymai(pool, id), [], "inline registro neliečia");
  });

  await t.test("„daugiausia VIENAS įsipareigotas\" yra DB invariantas, ne modulio susitarimas", async () => {
    /**
     * ⚠️ REGISTRO API ČIA SĄMONINGAI APLENKIAMAS.
     *
     * `isipareigoti()` taisyklę laiko, ir tai jau tikrinama aukščiau („du lygiagretūs
     * remontai"). Bet toks testas įrodo tik tiek, kad TAS kelias jos nelaužo. Šlavėjas
     * (PR-5) rems prielaida, kad įsipareigotas bandymas yra vienas, nesvarbu, kas ir
     * kaip eilutę parašė — tad tikrinama, ar antra `committed` eilutė apskritai
     * IŠREIŠKIAMA. Migracijos `1756400000000` dalinis unikalus indeksas sako, kad ne.
     */
    const id = await naujasJobas();
    const a = attemptRegistry.naujasBandymas();
    const b = attemptRegistry.naujasBandymas();

    for (const attemptId of [a, b]) {
      await attemptRegistry.registruoti(pool, {
        attemptId,
        jobId: id,
        storageType: "fs",
        storageKey: attemptRegistry.bandymoRaktas(id, attemptId),
      });
    }

    await pool.query("UPDATE job_result_attempts SET busena = $2 WHERE attempt_id = $1", [
      a,
      attemptRegistry.BUSENA.ISIPAREIGOTA,
    ]);

    let kodas = null;
    try {
      await pool.query("UPDATE job_result_attempts SET busena = $2 WHERE attempt_id = $1", [
        b,
        attemptRegistry.BUSENA.ISIPAREIGOTA,
      ]);
    } catch (klaida) {
      kodas = klaida.code;
    }

    assert.equal(kodas, "23505", "antra `committed` eilutė privalo būti NEĮMANOMA");

    /** Ta pati eilutė KITAM job'ui — leidžiama; indeksas dalinis ir pagal `job_id`. */
    const kitas = await naujasJobas();
    const c = attemptRegistry.naujasBandymas();
    await attemptRegistry.registruoti(pool, {
      attemptId: c,
      jobId: kitas,
      storageType: "fs",
      storageKey: attemptRegistry.bandymoRaktas(kitas, c),
    });
    await pool.query("UPDATE job_result_attempts SET busena = $2 WHERE attempt_id = $1", [
      c,
      attemptRegistry.BUSENA.ISIPAREIGOTA,
    ]);

    /** O `isipareigoti()` po viso to VIS TIEK pereina — nuvertinimas eina pirmas. */
    await attemptRegistry.isipareigoti(pool, { jobId: id, attemptId: b });
    const bandymai = await attemptRegistry.joboBandymai(pool, id);
    assert.deepEqual(
      bandymai.filter((x) => x.busena === attemptRegistry.BUSENA.ISIPAREIGOTA).map((x) => x.attempt_id),
      [b],
      "perėjimas dviem sakiniais indekso NELAUŽO"
    );
  });

  await t.test("registro `23505` NEPASIEKIAMAS produkciniu keliu: promote vyksta PO `jobs` užraktu", async (t2) => {
    /**
     * ⚠️ NAUJAS INDEKSAS ĮVEDA NAUJĄ GEDIMO REŽIMĄ, IR JIS PRIVALO BŪTI ARBA
     * APDOROTAS, ARBA ĮRODYTAS NEPASIEKIAMU (Codex, #294).
     *
     * `UNIQUE (job_id) WHERE busena = 'committed'` reiškia, kad `23505` dabar gali kilti
     * ir iš registro. Repo jį apdoroja vienoje vietoje (`postgresStore.js:1035`) ir tik
     * `jobs_idempotency` suvaržymui; registro pažeidimas sklistų kaip žalia DB klaida, o
     * worker'is laikytų ją ATKARTOJAMA ir perleistų visą transkripciją. Tai D radinys
     * kitu pavidalu.
     *
     * Scenarijus, dėl kurio kilo klausimas: du lygiagretūs remontai, kai antrasis paima
     * užraktą PRIEŠ pirmojo commit'ą — tada jis dar matytų seną raktą, remonto sąlyga jį
     * praleistų, ir promote duotų `23505`.
     *
     * ⚠️ TO NUTIKTI NEGALI, IR PRIEŽASTIS TIKRINAMA ELGESIU, NE ARGUMENTU: promote vyksta
     * TOJE PAČIOJE transakcijoje, kuri jau laiko `jobs` eilutės `FOR UPDATE` užraktą, tad
     * antrasis vykdytojas į tą šaką patenka tik PO pirmojo commit'o — o tada mato jau
     * perjungtą raktą ir promote nekviečia.
     *
     * Zondas antra jungtimi klausia to paties, ko klausia ankstesnis testas, tik
     * PRIEŠINGA kryptimi: `put()` metu užraktas privalo būti LAISVAS, promote metu —
     * UŽIMTAS. Kontrolė ta pati zondo eilutėje: kito job'o eilutė lieka pasiekiama, tad
     * `55P03` yra teiginys apie ŠITĄ eilutę, ne apie zondą.
     */
    const id = await naujasJobas();
    const kitas = await naujasJobas();

    const antraJungtis = new Client({ connectionString: DB_URL });
    await antraJungtis.connect();
    t2.after(() => antraJungtis.end().catch(() => {}));

    async function zondas(jobId) {
      try {
        await antraJungtis.query("BEGIN");
        await antraJungtis.query("SELECT id FROM jobs WHERE id = $1 FOR UPDATE NOWAIT", [jobId]);
        return null;
      } catch (klaida) {
        return klaida.code;
      } finally {
        await antraJungtis.query("ROLLBACK").catch(() => {});
      }
    }

    const originalus = attemptRegistry.isipareigoti;
    let uzraktasPromoteMetu = "NEPAKVIESTA";
    let kontrolePromoteMetu = "NEPAKVIESTA";

    attemptRegistry.isipareigoti = async (vykdytojas, argumentai) => {
      uzraktasPromoteMetu = await zondas(id);
      kontrolePromoteMetu = await zondas(kitas);
      return originalus(vykdytojas, argumentai);
    };

    try {
      await store.finishAtomic(id, STATUS.COMPLETED, { result: { text: "promote po užraktu" } });
    } finally {
      attemptRegistry.isipareigoti = originalus;
    }

    assert.equal(
      uzraktasPromoteMetu,
      "55P03",
      "promote metu `jobs` eilutė privalo būti UŽRAKINTA — kitaip du promote gali sutapti"
    );
    assert.equal(kontrolePromoteMetu, null, "kontrolė: zondas kito job'o eilutę paima laisvai");

    /**
     * Ir antra pusė to paties teiginio: du lygiagretūs remontai iš tikrųjų NEIŠMETA
     * `23505`. Aukščiau esantis remontų testas tai tikrina netiesiogiai (verdiktas
     * privalo būti objektas); čia klaidos kodas gaudomas atvirai, kad gedimas rodytų į
     * indeksą, o ne į „netikėtą verdiktą".
     */
    const remontuojamas = await naujasJobas();
    const rezultatas = { text: "23505 zondas" };
    await store.finishAtomic(remontuojamas, STATUS.COMPLETED, { result: rezultatas });
    const sena = await eilute(remontuojamas);
    await fs.delete(sena.storage_key);

    const atsakymai = await Promise.allSettled([
      store.finishAtomic(remontuojamas, STATUS.COMPLETED, { result: rezultatas }),
      store.finishAtomic(remontuojamas, STATUS.COMPLETED, { result: rezultatas }),
    ]);

    const registroPazeidimai = atsakymai
      .filter((x) => x.status === "rejected")
      .map((x) => `${x.reason && x.reason.code}/${x.reason && x.reason.constraint}`);

    assert.deepEqual(registroPazeidimai, [], `lygiagretus remontas išmetė DB klaidą: ${registroPazeidimai}`);
  });

  await t.test("VISI šio failo rašymai ėjo per PARUOŠTĄ reprezentaciją", () => {
    /**
     * ⚠️ TVIRTINIMAS PABAIGOJE, NE KIEKVIENAME TESTE.
     *
     * Klausimas yra apie KELIĄ, ne apie vieną scenarijų: ar completion, remontas ir
     * lenktynių šakos VISOS paduoda `put()` tą pačią formą. Sudėjus tvirtinimą į
     * kiekvieną testą, naujas testas, pridėtas vėliau, jį tyliai praleistų.
     *
     * Ką tai NEPADENGIA: `paruostiReiksme()` idempotentiškumas leidžia `put()` priimti
     * ir žalią reikšmę, tad ateities kvietėjas, apeinantis `paruostiExternalRasyma()`,
     * čia nesimatys. Ta liekamoji rizika užrašyta ataskaitos §9.
     */
    assert.ok(saugykla.rasymai > 0, "kontrolė: rašymų apskritai buvo");
    assert.equal(saugykla.neparuostos, 0, "į `put()` niekada nepateko žalia reikšmė");
  });
});
