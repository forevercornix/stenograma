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
    async put(raktas, reiksme) {
      this.rasymai += 1;
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

    const [a, b] = await Promise.all([
      store.finishAtomic(id, STATUS.COMPLETED, { result: rezultatas }),
      store.finishAtomic(id, STATUS.COMPLETED, { result: rezultatas }),
    ]);

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
});
