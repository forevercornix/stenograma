const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const crypto = require("node:crypto");
const { Pool, Client } = require("pg");

const { skipWithoutPostgres, testDatabaseUrl, adminDatabaseUrl } = require("./helpers/postgresGuard");
const {
  createPostgresStore,
  SELECT_JOB_META,
  SELECT_JOB_WITH_RESULT,
} = require("../utils/jobStore/postgresStore");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * HIDRATACIJOS RIBA — METADUOMENŲ KELIAI NETEMPIA TURINIO (#157, PR-3).
 *
 * ⚠️ §9.1: „SPY ANT `read`" ČIA NIEKO NEĮRODYTŲ.
 *
 * Tvirtinimas „niekas nekviečia skaitymo" būtų tenkinamas ir tada, jei external
 * kelio apskritai nebūtų — o jo šiandien produkcijoje ir nėra. Todėl naudojamas
 * SKAITIKLIS pačioje saugykloje ir tikrinamos ABI pusės: metaduomenų kelias duoda
 * `0`, o hidratuotas — `1`. Antroji pusė yra kontrolė, be kurios patikra virstų
 * visada-„taip".
 *
 * ⚠️ SKAITIKLIS SKAIČIUOJA `read` IR `verify`, NE VIEN `read`. `fs` backend'e
 * `verify()` perskaito visą objektą, tad skaitiklis, matantis tik `read`, leistų
 * metaduomenų keliui tempti artefaktus per kitą metodą ir liktų žalias. `head()`
 * skaičiuojamas ATSKIRAI ir pažeidimu NĖRA — jo metaduomenų keliuose laukiama.
 *
 * ⚠️ ŠIS FAILAS VIETOJE NEVYKDOMAS - reikia tikros PostgreSQL.
 */

const SAKNIS = path.resolve(__dirname, "..");
const DB_URL = testDatabaseUrl("hydration");
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

/** Skaitiklinė saugykla: TIKRO kontrakto tipai, bet apskaitomi kvietimai (#266). */
function skaitiklineSaugykla(turinys) {
  const { Readable } = require("node:stream");
  const buferis = Buffer.from(JSON.stringify(turinys), "utf8");

  return {
    /**
     * ⚠️ `backend` DEKLARUOJAMAS TIKRAS: store'as tikrina, ar eilutės `storage_type`
     * sutampa su saugyklos tipu, tad dublis privalo sakyti tiesą apie tai, kam jis
     * apsimeta. Testinės eilutės rašomos kaip `fs`.
     */
    backend: "fs",
    /** ⚠️ Turinio skaitymai — VIENAS skaitiklis abiem metodams. */
    perskaityta: 0,
    galvos: 0,
    async patikrintiSaugykla() {
      return { backend: "fs" };
    },
    async put() {
      throw new Error("rašymas šiame teste nenaudojamas");
    },
    async readStream() {
      this.perskaityta += 1;
      return Readable.from([buferis]);
    },
    async read() {
      this.perskaityta += 1;
      return turinys;
    },
    async head() {
      this.galvos += 1;
      return { exists: true, bytes: buferis.byteLength };
    },
    async verify() {
      this.perskaityta += 1;
      return { ok: true, exists: true, bytes: buferis.byteLength, checksum: "x", nepriklausomas: true };
    },
    async delete() {
      return true;
    },
    dydis: buferis.byteLength,
  };
}

after(async () => {
  if (PRALEISTI) return;
  await adminPg(`DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`).catch(() => {});
});

test("#157 PR-3: hidratacija yra EKSPLICITINĖ ir RIBOTA", { skip: PRALEISTI, timeout: 180000 }, async (t) => {
  await adminPg(`DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`);
  await adminPg(`CREATE DATABASE "${dbVardas()}"`);
  execFileSync("npx", ["node-pg-migrate", "up"], {
    cwd: SAKNIS,
    env: { ...process.env, DATABASE_URL: DB_URL },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const pool = new Pool({ connectionString: DB_URL });
  t.after(() => pool.end().catch(() => {}));

  const turinys = { text: "external transkripcija", segments: [1, 2, 3] };
  const saugykla = skaitiklineSaugykla(turinys);
  const store = createPostgresStore(pool, { artifactStore: saugykla });

  /** External eilutė įrašoma TIESIOGIAI: produkcinio rašymo kelio dar nėra (PR-4). */
  async function sukurtiExternal({ bytes = saugykla.dydis } = {}) {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, created_at, updated_at)
       VALUES ($1, 'transcription', 'completed', now(), now())`,
      [id]
    );
    await pool.query(
      `INSERT INTO job_results (job_id, storage_type, storage_key, bytes, checksum, created_at)
       VALUES ($1, 'fs', $2, $3, $4, now())`,
      [id, `results/${id}/a.json`, bytes, "a".repeat(64)]
    );
    return id;
  }

  await t.test("`get()` hidratuoja external rezultatą — ir tai kainuoja VIENĄ skaitymą", async () => {
    const id = await sukurtiExternal();
    saugykla.perskaityta = 0;

    const job = await store.get(id);

    assert.deepEqual(job.result, turinys, "loginis rezultatas nepriklauso nuo saugyklos");
    assert.equal(saugykla.perskaityta, 1, "hidratacija privalo perskaityti turinį lygiai kartą");
  });

  await t.test("metaduomenų kelias NESKAITO turinio ir `result` lauko NETURI", async () => {
    /**
     * ⚠️ `result: null` čia būtų MELAS: `null` reiškia „rezultato nėra", o jis yra.
     * Be to `applyPatch()` sprendžia pagal `"result" in job`, tad `null` reikštų
     * nurodymą jį IŠTRINTI, jei toks įrašas kada nors keliautų į `update()`.
     */
    const id = await sukurtiExternal();
    saugykla.perskaityta = 0;

    const job = await store.get(id, { hydrate: false });

    assert.equal(saugykla.perskaityta, 0, "metaduomenų kelias turinio neskaito");
    assert.equal("result" in job, false, "nehidratuotas job'as `result` lauko neturi");
    assert.equal(job.status, "completed", "bet metaduomenys grąžinami pilni");
  });

  await t.test("`listAll({hydrate:false})` neskaito NIEKO, o `listAll()` — skaito", async () => {
    /**
     * Antroji pusė yra KONTROLĖ: be jos patikra būtų tenkinama ir tada, jei external
     * hidratacijos kelio apskritai nebūtų.
     */
    const id = await sukurtiExternal();
    saugykla.perskaityta = 0;

    const metaduomenys = await store.listAll({ hydrate: false });
    assert.equal(saugykla.perskaityta, 0, "sąrašas be hidratacijos turinio neskaito");
    assert.ok(metaduomenys.some((j) => j.id === id));
    assert.ok(metaduomenys.every((j) => !("result" in j)), "nė vienas įrašas neturi `result`");

    const hidratuoti = await store.listAll();
    assert.ok(saugykla.perskaityta > 0, "hidratuotas sąrašas turinį skaito");
    assert.deepEqual(hidratuoti.find((j) => j.id === id).result, turinys);
  });

  await t.test("per didelis PERSISTINTAS dydis krenta NEPAKVIETUS saugyklos", async () => {
    /**
     * ⚠️ RIBA TIKRINAMA PRIEŠ ĮKĖLIMĄ. `bytes` persistinamas kartu su nuoroda, tad
     * per didelis rezultatas atmetamas nė nesikreipus į saugyklą — skaitiklis privalo
     * likti `0`. (Kietas stabdis skaitymo metu tikrinamas `artifactStoreBoundedRead`.)
     */
    const { getLimits, LIMIT_KIND } = require("../utils/resultLimits");
    const riba = getLimits()[LIMIT_KIND.RESULT_BYTES];

    const id = await sukurtiExternal({ bytes: riba + 1 });
    saugykla.perskaityta = 0;

    await assert.rejects(
      () => store.get(id),
      (klaida) => klaida.name === "ResultLimitError",
      "viršyta riba yra dydžio klaida, ne tyliai grąžintas `null`"
    );

    assert.equal(saugykla.perskaityta, 0, "saugykla neturi būti net paliesta");
  });

  await t.test("KONTROLĖ: inline eilutė hidratuojama BE saugyklos", async () => {
    /**
     * Be jos ankstesni tvirtinimai būtų tenkinami ir store'o, kuris hidratuoja
     * VISKĄ per saugyklą — o inline kelias privalo likti nepakitęs.
     */
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, created_at, updated_at)
       VALUES ($1, 'transcription', 'completed', now(), now())`,
      [id]
    );
    await pool.query(
      `INSERT INTO job_results (job_id, storage_type, payload, created_at)
       VALUES ($1, 'inline', $2::jsonb, now())`,
      [id, JSON.stringify({ text: "inline" })]
    );

    saugykla.perskaityta = 0;
    const job = await store.get(id);

    assert.deepEqual(job.result, { text: "inline" });
    assert.equal(saugykla.perskaityta, 0, "inline rezultatas saugyklos neliečia");
  });

  await t.test("job'o `storageKey` NEPRIKLAUSO nuo rezultato eilutės", async () => {
    /**
     * ⚠️ IŠMATUOTA REGRESIJA (CI 33984736988).
     *
     * `jobs` ir `job_results` abi turi `storage_key`. Be alias'ų `pg` eilutės objekte
     * lieka PASKUTINIS to paties vardo stulpelis, tad job'o AUDIO raktas tyliai
     * virsdavo rezultato nuoroda (inline atveju — `NULL`), o `update()` jį perrašydavo:
     * audio valymas nebežinotų, kurie failai naudojami. Krito trys nesusiję postgres
     * testai — bet ne vienas vietinis, nes jie visi reikalauja tikros DB.
     *
     * Tikrinami ABU keliai: hidratuotas ir metaduomenų.
     */
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, storage_key, created_at, updated_at)
       VALUES ($1, 'transcription', 'completed', 'audio/originalus.wav', now(), now())`,
      [id]
    );
    await pool.query(
      `INSERT INTO job_results (job_id, storage_type, storage_key, bytes, checksum, created_at)
       VALUES ($1, 'fs', $2, $3, $4, now())`,
      [id, `results/${id}/a.json`, saugykla.dydis, "a".repeat(64)]
    );

    assert.equal((await store.get(id)).storageKey, "audio/originalus.wav");
    assert.equal((await store.get(id, { hydrate: false })).storageKey, "audio/originalus.wav");

    /** Ir po round-trip'o per `update()` raktas privalo išlikti. */
    await store.update(id, { error_message: "nesusijęs pakeitimas" });
    assert.equal((await store.get(id, { hydrate: false })).storageKey, "audio/originalus.wav");

    const raktai = await store.listReferencedStorageKeys();
    assert.ok(raktai.includes("audio/originalus.wav"), "audio raktas privalo likti matomas valymui");
  });

  /* ═══ NUOSAVYBĖ SPRENDŽIAMA PRIEŠ HIDRATACIJĄ ═══ */

  const SAVININKAS = { ownerKind: "user", ownerId: "11111111-1111-1111-1111-111111111111" };
  const SVETIMAS = { ownerKind: "user", ownerId: "22222222-2222-2222-2222-222222222222" };

  async function sukurtiSavininkoJoba({ raktas = null } = {}) {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, owner_kind, owner_id, created_at, updated_at)
       VALUES ($1, 'transcription', 'completed', $2, $3, now(), now())`,
      [id, SAVININKAS.ownerKind, SAVININKAS.ownerId]
    );
    await pool.query(
      `INSERT INTO job_results (job_id, storage_type, storage_key, bytes, checksum, created_at)
       VALUES ($1, 'fs', $2, $3, $4, now())`,
      [id, raktas || `results/${id}/a.json`, saugykla.dydis, "a".repeat(64)]
    );
    return id;
  }

  await t.test("SVETIMAS scope: `FORBIDDEN` ir saugykla NEPALIEČIAMA", async () => {
    /**
     * ⚠️ AMPLIFIKACIJA: svetimas žmogus, žinantis job ID, priverstų iki
     * `MAX_RESULT_BYTES` saugyklos I/O užklausai, kuri turėjo baigtis `403`.
     * Tikrinama SKAITIKLIU, ne stebėjimu.
     */
    const id = await sukurtiSavininkoJoba();
    saugykla.perskaityta = 0;

    assert.equal(await store.getOwned(id, SVETIMAS), "FORBIDDEN");
    assert.equal(saugykla.perskaityta, 0, "atmestai užklausai saugykla neturi būti net paliesta");
  });

  await t.test("SVETIMAS scope + SUGADINTAS artefaktas: vis tiek `FORBIDDEN`", async () => {
    /**
     * ⚠️ INFORMACIJOS NUTEKĖJIMAS: jei hidratacija vyktų pirma, svetimas gautų
     * `ARTIFACT_CORRUPT` vietoj `FORBIDDEN` — t. y. sužinotų apie SVETIMO job'o
     * būseną. Atsakymas privalo būti tas pats, koks jis būtų su tvarkingu objektu.
     */
    const id = await sukurtiSavininkoJoba({ raktas: "results/nera/objekto.json" });
    const sugadinta = { ...saugykla };
    sugadinta.readStream = async () => {
      throw Object.assign(new Error("nėra"), { code: "ARTIFACT_NOT_FOUND" });
    };

    const suSugadinta = createPostgresStore(pool, { artifactStore: sugadinta });
    assert.equal(await suSugadinta.getOwned(id, SVETIMAS), "FORBIDDEN");
  });

  await t.test("SAVININKAS + sugadintas artefaktas: ištrynimo kelias PASIEKIAMAS", async () => {
    /**
     * ⚠️ BLOGIAUSIA PASEKMĖ BUVO ŠI: `DELETE` privalo veikti BŪTENT tada, kai
     * objektas blogas. Ištrynimas eina per `removeOwned()`, kuris sprendžia SQL
     * pusėje ir turinio neliečia — testas fiksuoja, kad ta savybė išlieka.
     */
    const id = await sukurtiSavininkoJoba();
    const sugadinta = { ...saugykla };
    sugadinta.readStream = async () => {
      throw Object.assign(new Error("sugadinta"), { code: "ARTIFACT_CORRUPT" });
    };
    const suSugadinta = createPostgresStore(pool, { artifactStore: sugadinta });

    /** Skaitymas sugadinto artefakto TIKRAI nepaslepia — jis krenta atvirai. */
    await assert.rejects(
      () => suSugadinta.getOwned(id, SAVININKAS),
      (klaida) => klaida.code === "ARTIFACT_CORRUPT"
    );

    /** Bet nuosavybės sprendimas jau priimtas, ir ištrynimas pasiekiamas. */
    assert.equal(await suSugadinta.removeOwned(id, SAVININKAS), true);
    assert.equal(await store.get(id, { hydrate: false }), null, "eilutės nebeliko");
  });

  await t.test("`getOwned(..., {hydrate:false})`: sprendimas priimamas, saugykla NEPALIEČIAMA", async () => {
    /**
     * ⚠️ TAI ANTRA GRANDINĖS PUSĖ. `jobs.route` testas įrodo, kad `DELETE` maršrutas
     * prašo `hydrate: false`; čia įrodoma, ką ta vėliava REIŠKIA: nulis kreipinių į
     * saugyklą. Nė viena pusė atskirai nepakanka.
     */
    const id = await sukurtiSavininkoJoba();
    saugykla.perskaityta = 0;

    const job = await store.getOwned(id, SAVININKAS, { hydrate: false });

    assert.equal(saugykla.perskaityta, 0, "ištrynimo kelias turinio neskaito");
    assert.equal("result" in job, false, "ir `result` lauko negauna");
    assert.equal(job.status, "completed");

    /** Svetimam scope'ui atsakymas toks pat, koks būtų su hidratacija. */
    assert.equal(await store.getOwned(id, SVETIMAS, { hydrate: false }), "FORBIDDEN");
  });

  await t.test("SUGADINTAS artefaktas: `hydrate:false` kelias VEIKIA, `hydrate:true` — krenta", async () => {
    /**
     * ⚠️ BŪTENT DĖL TO IR ATSKIRIAMA. Ištrynimas privalo veikti tada, kai objektas
     * blogas; skaitymas tokiu atveju krenta atvirai, ir tai teisinga.
     */
    const id = await sukurtiSavininkoJoba();
    const sugadinta = { ...saugykla };
    sugadinta.readStream = async () => {
      throw Object.assign(new Error("sugadinta"), { code: "ARTIFACT_CORRUPT" });
    };
    const suSugadinta = createPostgresStore(pool, { artifactStore: sugadinta });

    const metaduomenys = await suSugadinta.getOwned(id, SAVININKAS, { hydrate: false });
    assert.equal(metaduomenys.id, id, "ištrynimo kelias sugadinto artefakto neliečia");

    await assert.rejects(
      () => suSugadinta.getOwned(id, SAVININKAS),
      (klaida) => klaida.code === "ARTIFACT_CORRUPT"
    );
  });

  await t.test("KONTROLĖ: savininkas su tvarkingu artefaktu gauna rezultatą", async () => {
    /**
     * Be jos ankstesni tvirtinimai būtų tenkinami ir `getOwned()`, kuris VISIEMS
     * grąžina `FORBIDDEN`.
     */
    const id = await sukurtiSavininkoJoba();
    saugykla.perskaityta = 0;

    const job = await store.getOwned(id, SAVININKAS);

    assert.deepEqual(job.result, turinys);
    assert.equal(saugykla.perskaityta, 1, "leistai užklausai turinys skaitomas lygiai kartą");
  });

  await t.test("saugykla parenkama pagal EILUTĘ: registruoti du tipai, naudojamas teisingas", async () => {
    /**
     * ⚠️ AUTORITETAS YRA PERSISTINTAS `storage_type`, NE RUNTIME KONFIGŪRACIJA.
     *
     * Diegimas, kuriame dalis rezultatų jau `s3`, o nauji rašomi į `fs`, yra NORMALI
     * būsena po backend'o pakeitimo. Registruojami abu, ir tikrinama, kad eilutė
     * pasiima SAVO saugyklą — kitaip „vienas globalus backend'as" būtų abstrakcija,
     * kurią PR-6/PR-7 turėtų ardyti.
     */
    const fsTurinys = { text: "fs turinys" };
    const s3Turinys = { text: "s3 turinys" };

    const fsSaugykla = { ...skaitiklineSaugykla(fsTurinys), backend: "fs" };
    const s3Saugykla = { ...skaitiklineSaugykla(s3Turinys), backend: "s3" };

    const suAbiem = createPostgresStore(pool, {
      artifactStores: { fs: fsSaugykla, s3: s3Saugykla },
    });

    const idFs = crypto.randomUUID();
    const idS3 = crypto.randomUUID();

    for (const [id, tipas, dydis] of [
      [idFs, "fs", fsSaugykla.dydis],
      [idS3, "s3", s3Saugykla.dydis],
    ]) {
      await pool.query(
        `INSERT INTO jobs (id, type, status, created_at, updated_at)
         VALUES ($1, 'transcription', 'completed', now(), now())`,
        [id]
      );
      await pool.query(
        `INSERT INTO job_results (job_id, storage_type, storage_key, bytes, checksum, created_at)
         VALUES ($1, $2, $3, $4, $5, now())`,
        [id, tipas, `results/${id}/a.json`, dydis, "a".repeat(64)]
      );
    }

    assert.deepEqual((await suAbiem.get(idFs)).result, fsTurinys);
    assert.deepEqual((await suAbiem.get(idS3)).result, s3Turinys);
    assert.equal(fsSaugykla.perskaityta, 1, "`fs` eilutė skaityta TIK per `fs` saugyklą");
    assert.equal(s3Saugykla.perskaityta, 1, "`s3` eilutė skaityta TIK per `s3` saugyklą");
  });

  await t.test("neregistruotas `storage_type` KRENTA, o ne skaitomas iš to, kas po ranka", async () => {
    /**
     * ⚠️ Pilnas dispatch pagal `storage_type` — PR-4/PR-6 tema. Bet `s3` eilutė,
     * skaitoma per `fs` saugyklą tuo pačiu raktu ir su sutampančiu dydžiu, hidratuotų
     * SVETIMĄ turinį, ir niekas apie tai nesužinotų. Fail-closed kainuoja vieną `if`.
     */
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, created_at, updated_at)
       VALUES ($1, 'transcription', 'completed', now(), now())`,
      [id]
    );
    await pool.query(
      `INSERT INTO job_results (job_id, storage_type, storage_key, bytes, checksum, created_at)
       VALUES ($1, 's3', $2, $3, $4, now())`,
      [id, `results/${id}/a.json`, saugykla.dydis, "a".repeat(64)]
    );

    /** Registruota TIK `fs`, o eilutė yra `s3`. */
    const suFs = createPostgresStore(pool, { artifactStore: { ...saugykla, backend: "fs" } });
    await assert.rejects(() => suFs.get(id), /neregistruota/i);

    /** KONTROLĖ: registravus teisingą tipą, hidratacija veikia. */
    const suS3 = createPostgresStore(pool, { artifactStore: { ...saugykla, backend: "s3" } });
    assert.deepEqual((await suS3.get(id)).result, turinys);
  });

  /* ═══ HIDRATACIJA SUSIETA SU AUTORIZUOTU SNAPSHOT'U ═══ */

  await t.test("savininkas pakeistas TARP skaitymų: kvietėjas negauna NEI seno, NEI naujo", async () => {
    /**
     * ⚠️ DU NEPRIKLAUSOMI SKAITYMAI PALIKO LANGĄ (Codex P1, #291).
     *
     * Atkūrimas ar administracinis kelias gali pakeisti to paties UUID savininką po
     * autorizacijos. Jei antra užklausa apribojimo nebeturi, kvietėjas gauna JAU NAUJO
     * savininko rezultatą; jei ji ima raktą iš snapshot'o, bet niekas nepatikrina
     * eilutės po skaitymo — gauna SENO job'o rezultatą po to, kai UUID jau perimtas.
     * Abu keliai blogi, tad tikrinami abu galai: verdiktas ir TURINIO nebuvimas.
     *
     * Pakeitimas įterpiamas ties draiverio riba: `readStream` yra vienintelis taškas,
     * kuriame `getOwned()` laukia išorinio I/O.
     */
    const id = await sukurtiSavininkoJoba();

    const lenktyniaujanti = { ...saugykla };
    lenktyniaujanti.readStream = async (...args) => {
      /** Kol vyksta skaitymas, eilutę perima KITAS savininkas ir versija pasikeičia. */
      await pool.query(
        "UPDATE jobs SET owner_id = $2, version = version + 1 WHERE id = $1",
        [id, SVETIMAS.ownerId]
      );
      return saugykla.readStream(...args);
    };

    const suLenktynemis = createPostgresStore(pool, { artifactStore: lenktyniaujanti });
    const verdiktas = await suLenktynemis.getOwned(id, SAVININKAS);

    assert.ok(
      verdiktas === "FORBIDDEN" || verdiktas === null,
      `pasikeitusi eilutė privalo duoti FORBIDDEN arba NOT_FOUND, gauta: ${JSON.stringify(verdiktas)}`
    );
    assert.equal(
      verdiktas && verdiktas.result,
      undefined,
      "perskaitytas turinys privalo būti ATMESTAS, ne grąžintas"
    );

    /** KONTROLĖ: naujas savininkas tą pačią eilutę mato normaliai. */
    assert.deepEqual((await store.getOwned(id, SVETIMAS)).result, turinys);
  });

  await t.test("versija pasikeitė be savininko pasikeitimo: rezultatas irgi ATMETAMAS", async () => {
    /**
     * ⚠️ SAVININKAS TAS PATS, BET TURINYS — NEBE TAS, KURĮ MATĖME. Grąžinti pasenusį
     * rezultatą būtų tyli klaida; `NOT_FOUND` verčia kvietėją pakartoti ir gauti
     * dabartinę būseną.
     */
    const id = await sukurtiSavininkoJoba();

    const lenktyniaujanti = { ...saugykla };
    lenktyniaujanti.readStream = async (...args) => {
      await pool.query("UPDATE jobs SET version = version + 1 WHERE id = $1", [id]);
      return saugykla.readStream(...args);
    };

    const suLenktynemis = createPostgresStore(pool, { artifactStore: lenktyniaujanti });
    assert.equal(await suLenktynemis.getOwned(id, SAVININKAS), null);
  });

  await t.test("KONTROLĖ: be lenktynių tas pats kelias grąžina rezultatą", async () => {
    /**
     * Be jos ankstesni tvirtinimai būtų tenkinami ir `getOwned()`, kuris po
     * hidratacijos VISADA atmeta.
     */
    const id = await sukurtiSavininkoJoba();
    assert.deepEqual((await store.getOwned(id, SAVININKAS)).result, turinys);
  });

  await t.test("external skaitymas eina pagal SNAPSHOT'O raktą, ne pagal naują užklausą", async () => {
    /**
     * ⚠️ Jei raktas imamas iš NAUJOS užklausos, perimtas UUID nurodytų jau naujo
     * savininko objektą — ir kvietėjas gautų svetimą turinį net tada, kai verdiktas
     * atrodo teisingas. Todėl fiksuojama, KOKIO rakto buvo paprašyta.
     */
    const id = await sukurtiSavininkoJoba();
    const snapshotRaktas = `results/${id}/a.json`;
    const praSyti = [];

    const stebima = { ...saugykla };
    stebima.readStream = async (raktas) => {
      praSyti.push(raktas);
      /** Pakeičiame nuorodą IŠ KARTO — antra užklausa matytų jau kitą raktą. */
      await pool.query("UPDATE job_results SET storage_key = $2 WHERE job_id = $1", [
        id,
        "results/svetimas/objektas.json",
      ]);
      return saugykla.readStream(raktas);
    };

    const suStebejimu = createPostgresStore(pool, { artifactStore: stebima });
    await suStebejimu.getOwned(id, SAVININKAS).catch(() => {});

    assert.deepEqual(praSyti, [snapshotRaktas], "skaityta pagal snapshot'o raktą");
  });

  await t.test("external eilutė BE sukonfigūruotos saugyklos krenta UŽDARAI", async () => {
    /**
     * ⚠️ Grąžinti `null` čia būtų „`completed` be rezultato" — būsena, po kurios
     * terminalus valymas ištrina šaltinio audio.
     */
    const beSaugyklos = createPostgresStore(pool);
    const id = await sukurtiExternal();

    await assert.rejects(() => beSaugyklos.get(id), /neregistruota/i);
  });

  /* ═══ BENDRI STULPELIŲ VARDAI ═══ */

  await t.test("BENDRI stulpelių vardai NEPATENKA į rezultatą nealiasuoti", async () => {
    /**
     * ⚠️ APSAUGA NEGALI LAIKYTIS ANT RANKA SURAŠYTO SĄRAŠO.
     *
     * `REZULTATO_NUORODA` šiandien išvardija keturis stulpelius su alias'ais, bet
     * pridėjus `r.*` kolizija grįžta. `storage_key` atveju ji jau kainavo raundą
     * (CI 33984736988), o `created_at` atveju būtų BLOGESNĖ: abi reikšmės yra
     * timestamp'ai, tad joks „ar tai data" tvirtinimas nekristų.
     *
     * ⚠️ BENDRŲ VARDŲ SĄRAŠAS IŠVEDAMAS IŠ `information_schema`, ne surašomas — tas
     * pats principas kaip blogų raktų matricoje: pridėjus stulpelį, sargas apie jį
     * sužino pats.
     */
    const { rows: bendri } = await pool.query(`
      SELECT a.column_name
        FROM information_schema.columns a
        JOIN information_schema.columns b
          ON a.column_name = b.column_name
       WHERE a.table_name = 'jobs' AND b.table_name = 'job_results'
    `);

    const bendriVardai = bendri.map((r) => r.column_name);
    assert.ok(bendriVardai.length >= 2, `tikėtasi bent dviejų bendrų vardų, gauta: ${bendriVardai}`);

    for (const [vardas, uzklausa] of [
      ["SELECT_JOB_META", SELECT_JOB_META],
      ["SELECT_JOB_WITH_RESULT", SELECT_JOB_WITH_RESULT],
    ]) {
      const rezultatas = await pool.query(`${uzklausa} LIMIT 0`);
      const laukai = rezultatas.fields.map((f) => f.name);

      /** Dublikatas rezultate reiškia, kad viena reikšmė TYLIAI perrašo kitą. */
      const dublikatai = laukai.filter((l, i) => laukai.indexOf(l) !== i);
      assert.deepEqual(dublikatai, [], `${vardas}: dublikuoti laukai ${dublikatai}`);

      for (const bendras of bendriVardai) {
        assert.equal(
          laukai.filter((l) => l === bendras).length <= 1,
          true,
          `${vardas}: bendras stulpelis "${bendras}" pateko daugiau nei kartą`
        );
      }
    }
  });

  await t.test("`created_at` kolizija: job'o data NEPAIMAMA iš rezultato eilutės", async () => {
    /**
     * ⚠️ PIGUS, BET TIKSLINIS SARGAS. `job_results.created_at` užsėjamas akivaizdžiai
     * kitokia reikšme; jei kada nors užklausa vėl susilietų, `job.createdAt` pasikeistų
     * tyliai — abu laukai yra timestamp'ai, tad tipo patikra nieko neduotų.
     */
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, created_at, updated_at)
       VALUES ($1, 'transcription', 'completed', TIMESTAMPTZ '2020-01-02 03:04:05+00', now())`,
      [id]
    );
    await pool.query(
      `INSERT INTO job_results (job_id, storage_type, payload, created_at)
       VALUES ($1, 'inline', '{"a":1}'::jsonb, TIMESTAMPTZ '2031-11-12 13:14:15+00')`,
      [id]
    );

    for (const nustatymai of [{}, { hydrate: false }]) {
      const job = await store.get(id, nustatymai);
      assert.match(
        job.createdAt,
        /^2020-01-02T03:04:05/,
        `job'o data privalo likti sava (${JSON.stringify(nustatymai)})`
      );
    }
  });
});
