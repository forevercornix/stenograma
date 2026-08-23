const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { skipWithoutRedis } = require("./helpers/redisGuard");
const { sukurtiResursuKruva } = require("./helpers/resourceStack");
const { skipWithoutPostgres, testDatabaseUrl, adminDatabaseUrl } = require("./helpers/postgresGuard");
const { Pool } = require("pg");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const memoryStore = require("../utils/jobStore/memoryStore");
const { createRedisStore } = require("../utils/jobStore/redisStore");
const { createPostgresStore } = require("../utils/jobStore/postgresStore");
const { PHASE } = require("../utils/jobPhase");
const { OWNER_KIND, JOB_TYPES } = require("../utils/jobStore/common");

/**
 * BACKEND'Ų KONTRAKTO EKVIVALENTUMAS.
 *
 * ⚠️ ŠIO TESTO REPO NETURĖJO, IR BACKEND'AI JAU BUVO IŠSISKYRĘ.
 *
 * `reportProgressAtomic()` sugadintam įrašui (`protocol` su svetimo grafo faze)
 * elgėsi PRIEŠINGAI: memory atmesdavo, Redis priimdavo. Fasadas tai maskavo –
 * jis tikrina pirmas ir grąžina anksti – bet backend'o kontraktas yra
 * kontraktas.
 *
 * Testas per adapterius paleidžia TĄ PAČIĄ scenarijų aibę prieš memory,
 * Redis ir PostgreSQL backend'us bei reikalauja vienodo rezultato.
 *
 * Adapterio modelis (`{ name, setup, store, prepareState, cleanup }`) laiko
 * išorinių resursų paruošimą ir uždarymą greta, o scenarijų sąrašas lieka
 * vienas visiems trims backend'ams.
 *
 * `SCENARIJAI` sąrašas gali būti PLEČIAMAS (7.2b prideda `updateOwned`,
 * `removeOwned` ir `getOwned` scenarijus), bet lieka BENDRAS visiems
 * backend'ams – atskirų sąrašų vienam backend'ui būti negali.
 *
 * Failas jau registruotas IR `redis`, IR `postgres` rinkiniuose
 * (`tests/suites.js`), tad PostgreSQL adapteris bus realiai vykdomas CI'e.
 */

/** Laikinos DB nuleidimas per atskirą admin jungtį (tas pats kelias visur). */
async function nuleistiDb(dbName) {
  const a = new Pool({ connectionString: adminDatabaseUrl() });
  try {
    await a.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } finally {
    await a.end();
  }
}

/** Scenarijai, kurių rezultatas turi sutapti VISUOSE backend'uose. */
const SCENARIJAI = [
  {
    id: "svetimo-grafo-faze",
    kodel: "sugadintas įrašas: svetimo grafo fazė",
    /**
     * ⚠️ REIKIA SINTETINĖS SCHEMOS (#180 P3-7).
     * `jobs_status_phase` neleidžia `protocol` job'ui turėti `transcribing`
     * fazės - būsena sąmoningai sugadinta, tad PRODUKCINĖJE schemoje jos
     * sukurti neįmanoma. Vykdoma atskiroje sintetinės schemos DB.
     */
    sintetineSchema: {
      postgres:
        "jobs_status_phase CHECK neleidžia protocol + transcribing derinio; " +
        "scenarijus vykdomas atskiroje sintetinės schemos duomenų bazėje",
    },
    type: JOB_TYPES.PROTOCOL,
    busena: { status: "processing", phase: PHASE.TRANSCRIBING, progressKnown: true },
    progress: { current: 1, total: 10 },
    ivykis: { phase: PHASE.TRANSCRIBING, progress: { current: 5, total: 10 } },
    laukiama: "REJECTED",
  },
  {
    id: "processing-be-fazes",
    kodel: "sugadintas įrašas: processing be fazės",
    /**
     * ⚠️ REIKIA SINTETINĖS SCHEMOS (#180 P3-7).
     * `jobs_status_phase` leidžia `processing` be fazės TIK legacy įrašui
     * (`schema_version IS NULL`), o šis scenarijus reikalauja eros 2.
     */
    sintetineSchema: {
      postgres:
        "jobs_status_phase CHECK leidžia processing be fazės tik kai " +
        "schema_version IS NULL; scenarijus vykdomas sintetinės schemos DB",
    },
    type: JOB_TYPES.TRANSCRIPTION,
    busena: { status: "processing", phase: null, progressKnown: true },
    progress: { current: 1, total: 10 },
    ivykis: { phase: PHASE.TRANSCRIBING, progress: { current: 5, total: 10 } },
    laukiama: "REJECTED",
  },
  {
    id: "pavelaves-ivykis",
    kodel: "pavėlavęs įvykis iš ankstesnės fazės",
    type: JOB_TYPES.TRANSCRIPTION,
    busena: { status: "processing", phase: PHASE.DIARIZING, progressKnown: false },
    progress: null,
    ivykis: { phase: PHASE.TRANSCRIBING, progress: { current: 9, total: 10 } },
    laukiama: "REJECTED",
  },
  {
    id: "current-regresija",
    kodel: "monotoniškumo pažeidimas",
    type: JOB_TYPES.TRANSCRIPTION,
    busena: { status: "processing", phase: PHASE.TRANSCRIBING, progressKnown: true },
    progress: { current: 8, total: 10 },
    ivykis: { phase: PHASE.TRANSCRIBING, progress: { current: 3, total: 10 } },
    laukiama: "REJECTED",
  },
  {
    id: "pasikeites-total",
    kodel: "pasikeitęs total (kita epocha)",
    type: JOB_TYPES.TRANSCRIPTION,
    busena: { status: "processing", phase: PHASE.TRANSCRIBING, progressKnown: true },
    progress: { current: 5, total: 10 },
    ivykis: { phase: PHASE.TRANSCRIBING, progress: { current: 6, total: 20 } },
    laukiama: "REJECTED",
  },
  {
    id: "ne-processing",
    kodel: "ne-processing statusas",
    type: JOB_TYPES.TRANSCRIPTION,
    busena: { status: "queued", phase: null, progressKnown: false },
    progress: null,
    ivykis: { phase: PHASE.TRANSCRIBING, progress: { current: 5, total: 10 } },
    laukiama: "REJECTED",
  },
  {
    id: "ideti-metaduomenys",
    kodel: "progresas su ĮDĖTAIS metaduomenimis",
    /**
     * ⚠️ PostgreSQL ŠIOS PRE-BŪSENOS ATSTOVAUTI NEGALI (#180 P2-5).
     * Deklaracija gyvena PRIE paties scenarijaus, kad ištrynus scenarijų
     * dingtų ir jo išimtis - atskiras globalus sąrašas taptų antru rankiniu
     * tiesos šaltiniu.
     */
    neatstovaujama: {
      postgres:
        "PostgreSQL progresą laiko dviem TIPIZUOTAIS stulpeliais " +
        "(progress_current/progress_total double precision). ĮDĖTIEMS, laisvos " +
        "formos progreso metaduomenims (progress.metadata) stulpelio NĖRA, tad " +
        "jie neišvengiamai dingtų rašant - pre-būsena schemoje neatstovaujama.",
    },
    /**
     * ⚠️ Lua šablono paieška rasdavo pirmą `"total"` BET KUR eilutėje –
     * įskaitant įdėtus objektus. `{metadata:{total:20}, current:5, total:10}`
     * Redis pusėje duodavo 20, memory 10, ir backend'ai išsiskirdavo.
     */
    type: JOB_TYPES.TRANSCRIPTION,
    busena: { status: "processing", phase: PHASE.TRANSCRIBING, progressKnown: true },
    progress: { metadata: { total: 20 }, current: 5, total: 10 },
    ivykis: { phase: PHASE.TRANSCRIBING, progress: { current: 7, total: 10 } },
    laukiama: "OK",
  },
  {
    id: "eksponentine-forma",
    kodel: "eksponentinė skaičiaus forma",
    type: JOB_TYPES.TRANSCRIPTION,
    busena: { status: "processing", phase: PHASE.TRANSCRIBING, progressKnown: true },
    progress: { current: 1e-9, total: 1e-7 },
    ivykis: { phase: PHASE.TRANSCRIBING, progress: { current: 5e-8, total: 1e-7 } },
    laukiama: "OK",
  },
  {
    id: "skaitines-eilutes",
    kodel: "skaitinės EILUTĖS vietoj skaičių",
    /**
     * ⚠️ PostgreSQL ŠIOS PRE-BŪSENOS ATSTOVAUTI NEGALI (#180 P2-5).
     */
    neatstovaujama: {
      postgres:
        "progress_current/progress_total yra double precision, tad skaitinė " +
        "EILUTĖ (\"8\") negali išlikti eilute - PostgreSQL ją įrašytų kaip " +
        "skaičių 8, o progress_known = true dar reikalauja abiejų stulpelių " +
        "ne-NULL. Pre-būsena schemoje neatstovaujama.",
    },
    /**
     * ⚠️ Lua `tonumber()` konvertuoja ir eilutes, tad `{current:"8",total:"10"}`
     * Redis pusėje buvo atmetamas kaip regresija, o memory pusėje priimamas:
     * `Number.isFinite("8")` yra `false`, ir gryna funkcija tokio progreso
     * nelaiko galiojančiu, tad monotoniškumo su juo nelygina.
     *
     * Sprendimas: Lua lygina tik JSON SKAIČIUS (`type(p.total) == 'number'`).
     */
    type: JOB_TYPES.TRANSCRIPTION,
    busena: { status: "processing", phase: PHASE.TRANSCRIBING, progressKnown: true },
    progress: { current: "8", total: "10" },
    ivykis: { phase: PHASE.TRANSCRIBING, progress: { current: 7, total: 10 } },
    laukiama: "OK",
  },
  {
    id: "teisetas-monotoniskas",
    kodel: "TVARKINGAS progresas",
    type: JOB_TYPES.TRANSCRIPTION,
    busena: { status: "processing", phase: PHASE.TRANSCRIBING, progressKnown: true },
    progress: { current: 3, total: 10 },
    ivykis: { phase: PHASE.TRANSCRIBING, progress: { current: 7, total: 10 } },
    laukiama: "OK",
  },
];

/**
 * #180 6 PUNKTO REIKALAUJAMI PROGRESO INVARIANTAI - PRIVALOMA AIBĖ.
 *
 * ⚠️ KODĖL ŠIS SĄRAŠAS EGZISTUOJA ATSKIRAI (#180 P2-4).
 *
 * Anksčiau vienintelis „pilnumo" įrodymas buvo
 * `assert.equal(results.length, SCENARIJAI.length)`. Tai TAUTOLOGIJA:
 * `paleisti()` prideda po vieną rezultatą KIEKVIENAM `SCENARIJAI` elementui be
 * jokios sąlygos, tad lygybė galioja pagal konstrukciją. Ištrynus privalomą
 * scenarijų, MAŽĖJA ABI pusės - ir tikrinimas lieka žalias. Tikrinimas
 * įrodinėjo pats save.
 *
 * Todėl reikalavimai laikomi ATSKIRAI nuo realizacijos. Šis sąrašas NĖRA
 * išvestas iš `SCENARIJAI` - jis perrašytas iš issue #180 6 punkto
 * („Progreso invariantai"), kurio repo kopija yra `SUBISSUES-155.md`.
 * Kiekvienas įrašas atitinka VIENĄ to punkto reikalavimą:
 *
 *   svetimo-grafo-faze     - „svetimo job grafo fazė → reject"
 *   processing-be-fazes    - „`processing` be teisėtos fazės → reject"
 *   pavelaves-ivykis       - „pavėlavęs ankstesnės fazės event → reject"
 *   current-regresija      - „`current` regresija → reject"
 *   pasikeites-total       - „pasikeitęs `total` toje pačioje epochoje → reject"
 *   ne-processing          - „ne-`processing` job → reject"
 *   ideti-metaduomenys     - „nested metadata neturi būti interpretuojami..."
 *   eksponentine-forma     - „eksponentinė skaičiaus forma išlaikoma"
 *   skaitines-eilutes      - „skaitinės eilutės nėra tyliai perinterpretuojamos"
 *   teisetas-monotoniskas  - „teisėtas monotoniškas progresas → accepted"
 *
 * ⚠️ SĄRAŠAS NĖRA VIRŠUTINĖ RIBA. #180 7 punktas sąmoningai NEFIKSUOJA
 * scenarijų SKAIČIAUS, tad `SCENARIJAI` gali turėti daugiau elementų; čia
 * tikrinamas tik PRIVALOMAS minimumas. Dėl to `SCENARIJAI ⊆ PRIVALOMI`
 * NETIKRINAMA - tikrinama tik `PRIVALOMI ⊆ įvykdyti`.
 */
const PRIVALOMI_SCENARIJAI = Object.freeze([
  "svetimo-grafo-faze",
  "processing-be-fazes",
  "pavelaves-ivykis",
  "current-regresija",
  "pasikeites-total",
  "ne-processing",
  "ideti-metaduomenys",
  "eksponentine-forma",
  "skaitines-eilutes",
  "teisetas-monotoniskas",
]);

/** Paleidžia visus scenarijus prieš vieną backend'ą. */
/**
 * SUTARTINEI BŪSENAI REIKŠMINGA PROJEKCIJA (#180 P2-5).
 *
 * ⚠️ NE SERIALIZUOTAS TEKSTAS. Lyginamos STRUKTŪRINĖS reikšmės, tad
 * `{current:"8"}` ir `{current:8}` NESUTAMPA - būtent tokį tylų tipo pakeitimą
 * P2-5 ir pagavo. `progressKnown` normalizuojamas į boolean (Redis jį laiko
 * eilute), o `phase`/`progress` nesančios reikšmės - į `null` (Redis hash'e
 * nėra `null`). Tai VIENINTELĖS leistinos konversijos: jos priklauso
 * saugojimo reprezentacijai, o ne tikrinamai semantikai.
 *
 * ⚠️ PROJEKCIJA NEGALI SLĖPTI P2-5 PAKEITIMŲ. Ji NEIŠMETA nežinomų progreso
 * raktų (`metadata` lieka) ir NEKONVERTUOJA eilučių į skaičius.
 */
function sutartineBusena(saltinis) {
  return {
    status: saltinis.status ?? null,
    phase: saltinis.phase ?? null,
    progressKnown: saltinis.progressKnown === true,
    progress: saltinis.progress ?? null,
  };
}

async function paleisti(store, paruostiBusena, backendas) {
  const rezultatai = [];
  /**
   * ⚠️ ĮVYKDYTŲ SCENARIJŲ REGISTRAS (#180 9b.B, P2-4).
   *
   * `id` įrašomas TIK PO to, kai `reportProgressAtomic()` realiai grąžino
   * reikšmę. Todėl aibė matuoja ĮVYKDYMĄ, ne `SCENARIJAI` ilgį.
   */
  const ivykdyti = new Set();
  /**
   * ⚠️ EKSPLICITIŠKAI ATSISAKYTI SCENARIJAI (#180 P2-5, Option A).
   *
   * Trečia - ir VIENINTELĖ leistina - alternatyva „įvykdyta"/„trūksta".
   * Atsisakoma TIK tada, kai pats scenarijus deklaruoja šį backend'ą
   * neatstovaujamu. Tylus būsenos pakeitimas nėra ketvirta būsena.
   */
  const atsisakyta = new Map();

  for (const s of SCENARIJAI) {
    /**
     * Du eksplicitinių išimčių šaltiniai, abu SCENARIJAUS lokalūs:
     *   `neatstovaujama`   - backend'as pre-būsenos atstovauti NEGALI (P2-5);
     *   `sintetineSchema`  - pre-būsena neįmanoma PRODUKCINĖJE schemoje ir
     *                        vykdoma atskiroje sintetinės schemos DB (P3-7).
     */
    const priezastis = (s.neatstovaujama && s.neatstovaujama[backendas]) ||
      (s.sintetineSchema && s.sintetineSchema[backendas]);
    if (priezastis) {
      atsisakyta.set(s.id, priezastis);
      continue;
    }

    const job = await store.create({ type: s.type, ownerKind: OWNER_KIND.UNOWNED });
    await paruostiBusena(job.id, { ...s.busena, progress: s.progress });

    /**
     * ⚠️ REPREZENTACIJOS EKVIVALENTUMO SARGAS (#180 P2-5).
     *
     * Kiekvienam VYKDOMAM scenarijui tikrinama, kad backend'o paruošimas
     * NEPAKEITĖ sutartinės pre-būsenos. Būtent šio tikrinimo trūko: PostgreSQL
     * adapteris `skaitines-eilutes` paversdavo į `progressKnown=false,
     * progress=null`, o `ideti-metaduomenys` - į progresą be `metadata`, ir
     * scenarijus vis tiek pranešdavo apie įvykdymą tuo pačiu `id`.
     */
    const laukiamaBusena = sutartineBusena({ ...s.busena, progress: s.progress });
    const parengtaBusena = sutartineBusena((await store.get(job.id)) || {});
    assert.deepEqual(parengtaBusena, laukiamaBusena,
      `${backendas}/${s.id}: paruošta pre-būsena SKIRIASI nuo bendro scenarijaus - ` +
        "backend'as arba privalo ją atstovauti tiksliai, arba deklaruoti " +
        "`neatstovaujama`, o ne tyliai pakeisti");

    const r = await store.reportProgressAtomic(job.id, s.ivykis);
    ivykdyti.add(s.id);
    rezultatai.push({
      kodel: s.kodel,
      scenarijus: s.id,
      gauta: r === "REJECTED" ? "REJECTED" : r == null ? "NULL" : "OK",
      laukiama: s.laukiama,
      id: job.id,
    });
  }

  return { rezultatai, ivykdyti, atsisakyta };
}

const ADAPTERIAI = [
  {
    name: "memory",
    skip: false,
    async setup() {
      return { store: memoryStore, prepareState: (id, state) => memoryStore.update(id, state),
        cleanup: async () => {} };
    },
  },
  {
    name: "redis",
    skip: skipWithoutRedis(),
    async setup() {
      const IORedis = require("ioredis");
      const client = new IORedis(process.env.REDIS_URL);
      const ids = [];
      return {
        store: createRedisStore(client),
        prepareState: async (id, state) => {
          ids.push(id);
          await client.hset(`job:${id}`, { status: state.status,
            phase: state.phase == null ? "" : state.phase,
            progress: state.progress == null ? "null" : JSON.stringify(state.progress),
            progressKnown: String(Boolean(state.progressKnown)) });
        },
        cleanup: async () => {
          for (const id of ids) { await client.del(`job:${id}`); await client.zrem("jobs:index", id); }
          await client.quit();
        },
      };
    },
  },
  {
    name: "postgres",
    skip: skipWithoutPostgres(),
    async setup() {
      /**
       * ⚠️ RESURSAI REGISTRUOJAMI IŠ KARTO PO SUKŪRIMO (#180 P2-A).
       *
       * Jei `setup()` kristų prieš grąžindamas `ctx`, kvietėjo `finally` niekada
       * neįvyktų ir jau sukurti resursai nutekėtų. Krūva tai išsprendžia toje
       * pačioje vietoje, kur resursas sukuriamas.
       */
      const resursai = sukurtiResursuKruva();
      try {
      const url = testDatabaseUrl("backend_contract");
      const dbName = new URL(url).pathname.slice(1);
      const admin = new Pool({ connectionString: adminDatabaseUrl() });
      resursai.registruoti("admin pool", () => admin.end());
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.query(`CREATE DATABASE "${dbName}"`);
      resursai.registruoti("laikina DB", () => nuleistiDb(dbName));
      await admin.end();
      execFileSync("npx", ["node-pg-migrate", "up"], {
        cwd: path.resolve(__dirname, ".."), env: { ...process.env, DATABASE_URL: url },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const pool = new Pool({ connectionString: url });
      resursai.registruoti("darbinis pool", () => pool.end());
      /**
       * ⚠️ PRODUKCINĖ SCHEMA NELIEČIAMA (#180 P3-7).
       *
       * Anksčiau čia buvo `ALTER TABLE jobs DROP CONSTRAINT jobs_status_phase`,
       * kad tilptų du sąmoningai sugadintų būsenų scenarijai. Tai reiškė, kad
       * VISAS PostgreSQL kontrakto paleidimas vyko su nusilpninta schema, nors
       * įrodymai skambėjo kaip produkcinės schemos paritetas.
       *
       * Dabar tie du scenarijai deklaruoja `sintetineSchema.postgres` ir
       * vykdomi ATSKIROJE DB; čia constraint'as LIEKA, ir tai patikrinama.
       */
      const { rows: [{ yra }] } = await pool.query(
        `SELECT count(*)::int AS yra FROM pg_constraint WHERE conname = 'jobs_status_phase'`
      );
      assert.equal(yra, 1,
        "PostgreSQL kontrakto DB privalo turėti PRODUKCINĮ jobs_status_phase CHECK");
      const store = createPostgresStore(pool);
      return {
        store,
        prepareState: async (id, state) => {
          /**
           * ⚠️ JOKIO SAUGOJIMO MODELIO DUBLIKATO (#180 P2-C / Option C).
           *
           * Ankstesnė versija čia rankomis aprašinėjo, ką PostgreSQL geba
           * atstovauti (`Object.keys(progress).length === 2`, `typeof … ===
           * "number"`), t. y. laikė ANTRĄ, rankiniu būdu prižiūrimą schemos
           * aprašą testų sluoksnyje.
           *
           * Dabar atstovaujamumą lemia TIK eksplicitinė scenarijaus deklaracija
           * (`neatstovaujama` / `sintetineSchema`), o paruošimas rašo tai, ką
           * gavo. Jei nedeklaruotą pre-būseną saugykla iškraipytų, tai pagauna
           * REPREZENTACIJOS EKVIVALENTUMO SARGAS `paleisti()` viduje: jis
           * palygina perskaitytą būseną su bendru scenarijumi ir krinta.
           * Elgesys yra autoritetas, ne rankinis schemos modelis.
           */
          const known = state.progressKnown === true;
          await pool.query(`UPDATE jobs SET status=$2, phase=$3, progress_known=$4,
            progress_current=$5, progress_total=$6 WHERE id=$1`, [id, state.status,
            state.phase, known, known && state.progress ? state.progress.current : null,
            known && state.progress ? state.progress.total : null]);
        },
        /** Sėkmės kelias naudoja TĄ PAČIĄ krūvą - viena valymo realizacija. */
        cleanup: async () => resursai.isvalyti(),
      };
      } catch (klaida) {
        await resursai.isvalyti(klaida);
        throw klaida;
      }
    },
  },
];

for (const adapter of ADAPTERIAI) {
  test(`KONTRAKTAS: ${adapter.name} vykdo bendrą backend scenarijų rinkinį`,
    { skip: adapter.skip }, async () => {
      const ctx = await adapter.setup();
      try {
        const { rezultatai: results, ivykdyti, atsisakyta } =
          await paleisti(ctx.store, ctx.prepareState, adapter.name);

        /**
         * ⚠️ JOKIŲ NEAUTORIZUOTŲ ATSISAKYMŲ (#180 P2-5, 7 reikalavimas).
         *
         * Atsisakymas galioja TIK jei pats scenarijus deklaruoja šį backend'ą
         * neatstovaujamu ir nurodo NETUŠČIĄ priežastį. Vykdymo logika savo
         * nuožiūra scenarijaus praleisti negali - kitaip „eksplicitinis
         * atsisakymas" taptų nauju tyliu praleidimo keliu.
         */
        for (const [id, priezastis] of atsisakyta) {
          const scenarijus = SCENARIJAI.find((x) => x.id === id);
          assert.ok(scenarijus, `${adapter.name}: atsisakyta nežinomo scenarijaus "${id}"`);
          const deklaruota =
            (scenarijus.neatstovaujama && scenarijus.neatstovaujama[adapter.name]) ||
            (scenarijus.sintetineSchema && scenarijus.sintetineSchema[adapter.name]);
          assert.equal(typeof deklaruota, "string",
            `${adapter.name}/${id}: atsisakyta BE deklaracijos - tai MISSING, ne išimtis`);
          assert.notEqual(deklaruota.trim(), "",
            `${adapter.name}/${id}: neatstovaujamumo priežastis negali būti tuščia`);
          assert.equal(priezastis, deklaruota,
            `${adapter.name}/${id}: atsisakymo priežastis privalo ateiti iš deklaracijos`);
        }

        /**
         * ⚠️ PILNUMAS: PRIVALOMI ⊆ (įvykdyti ∪ eksplicitiškai atsisakyti).
         *
         * Trečias variantas - MISSING - krinta įvardijant scenarijų. Ištrynus
         * scenarijų iš `SCENARIJAI`, jo `id` nepateks NEI į `ivykdyti`, NEI į
         * `atsisakyta`, tad P2-4 apsauga lieka galioti ir su išimtimis.
         */
        const truksta = PRIVALOMI_SCENARIJAI.filter(
          (id) => !ivykdyti.has(id) && !atsisakyta.has(id)
        );
        assert.deepEqual(truksta, [],
          `${adapter.name}: PRIVALOMI #180 scenarijai nei įvykdyti, nei deklaruoti ` +
            `neatstovaujamais: ${truksta.join(", ")}`);

        /** Būsenos nesikerta: scenarijus negali būti ir įvykdytas, ir atsisakytas. */
        const persidengia = [...ivykdyti].filter((id) => atsisakyta.has(id));
        assert.deepEqual(persidengia, [],
          `${adapter.name}: scenarijus vienu metu įvykdytas IR atsisakytas: ${persidengia.join(", ")}`);

        /**
         * Dinaminė apskaita (#180 9b.B): kiekvienas `SCENARIJAI` elementas
         * privalo turėti TIKSLIAI vieną būseną. Skaičius NEFIKSUOJAMAS
         * (7 punktas) - jis išvedamas iš pačių apibrėžimų.
         */
        assert.equal(ivykdyti.size + atsisakyta.size, SCENARIJAI.length,
          `${adapter.name}: apskaita nesueina - įvykdyta ${ivykdyti.size}, ` +
            `atsisakyta ${atsisakyta.size}, iš viso ${SCENARIJAI.length}`);
        assert.notEqual(ivykdyti.size, 0,
          `${adapter.name}: nulis įvykdytų scenarijų yra NESĖKMĖ, ne tyli praleistis`);

        console.log(
          `[#180 apskaita] ${adapter.name}: įvykdyta ${ivykdyti.size}, ` +
            `eksplicitiškai neatstovaujama ${atsisakyta.size}, trūksta ${truksta.length}` +
            (atsisakyta.size ? ` (${[...atsisakyta.keys()].join(", ")})` : "")
        );

        for (const { kodel, gauta, laukiama } of results) {
          assert.equal(gauta, laukiama, `${adapter.name}: ${kodel}`);
        }

        const scope = { ownerKind: OWNER_KIND.UNOWNED, ownerId: null };
        const apiScope = { ownerKind: OWNER_KIND.API_PRINCIPAL, ownerId: null };
        const tenantId = "33333333-3333-3333-3333-333333333333";
        const owned = await ctx.store.create({
          ownerKind: OWNER_KIND.UNOWNED,
          tenantId,
          idempotencyKey: `contract-${adapter.name}`,
        });
        assert.equal((await ctx.store.getOwned(owned.id, scope)).id, owned.id);
        assert.equal(await ctx.store.getOwned(owned.id, apiScope), "FORBIDDEN");
        assert.equal(await ctx.store.getOwned(crypto.randomUUID(), scope), null);
        const updated = await ctx.store.updateOwned(owned.id, {
          id: crypto.randomUUID(),
          requestId: "contract",
          ownerId: crypto.randomUUID(),
          ownerKind: OWNER_KIND.API_PRINCIPAL,
          tenantId: crypto.randomUUID(),
          idempotencyKey: "replaced",
          createdAt: "2000-01-01T00:00:00.000Z",
          created_at: "2000-01-01T00:00:00.000Z",
          schemaVersion: 999,
        }, scope);
        assert.equal(updated.requestId, "contract");
        assert.equal(updated.id, owned.id);
        assert.equal(updated.ownerId, null);
        assert.equal(updated.ownerKind, OWNER_KIND.UNOWNED);
        assert.equal(updated.tenantId, tenantId);
        assert.equal(updated.idempotencyKey, `contract-${adapter.name}`);
        assert.equal(updated.createdAt, owned.createdAt);
        assert.equal(updated.created_at, owned.created_at);
        assert.equal(updated.schemaVersion, 2);

        await ctx.store.update(owned.id, {
          status: "processing", phase: PHASE.TRANSCRIBING,
        });
        const expectedResult = { transcript: `result-${adapter.name}` };
        await ctx.store.update(owned.id, {
          status: "completed", phase: null, progress: null,
          progressKnown: false, result: expectedResult,
        });
        const completed = await ctx.store.getOwned(owned.id, scope);
        assert.equal(completed.status, "completed");
        assert.deepEqual(completed.result, expectedResult,
          `${adapter.name}: getOwned() privalo hidratuoti užbaigto job'o rezultatą`);
        assert.equal(await ctx.store.updateOwned(owned.id, {}, apiScope), "FORBIDDEN");
        assert.equal(await ctx.store.removeOwned(owned.id, apiScope), "FORBIDDEN");
        assert.equal(await ctx.store.removeOwned(owned.id, scope), true);
        assert.equal(await ctx.store.removeOwned(owned.id, scope), false);
      } finally { await ctx.cleanup(); }
    });
}

/**
 * #180 P2-4: PRIVALOMŲ SCENARIJŲ INVENTORIUS.
 *
 * ⚠️ ŠIS TESTAS VEIKIA BE JOKIO BACKEND'O. Adapterių testai be
 * `REDIS_URL`/`DATABASE_URL` praleidžiami, tad jei pilnumas būtų tikrinamas TIK
 * juose, ištrintas scenarijus iškristų tik tame CI žingsnyje, kuriame tas
 * backend'as realiai pakyla. Šis tikrinimas nuo išorinių servisų nepriklauso,
 * tad ĮVYKDOMAS (ne praleidžiamas) abiejuose rinkiniuose, kuriuose failas
 * registruotas - `test:redis` IR `test:postgres`.
 *
 * ⚠️ TIKSLUMO DĖLEI: failas NĖRA numatytojo `npm test` rinkinyje (žr.
 * `tests/suites.js` - `redis` ir `postgres`), tad lokaliai be nė vieno URL jis
 * nepaleidžiamas. #180 8 punktas reikalauja būtent šios registracijos, todėl
 * jos čia nekeičiame.
 *
 * ⚠️ KĄ TAI ĮRODO IR KO NE. Tai yra REIKALAVIMŲ PADENGIMO tikrinimas: kad
 * kiekvienam #180 6 punkto invariantui egzistuoja scenarijus. Tai NĖRA įrodymas,
 * kad PostgreSQL elgiasi teisingai - elgesį įrodo tik realus adapterio
 * paleidimas su `DATABASE_URL` (žr. `ivykdyti` registrą `paleisti()` viduje).
 */
test("KONTRAKTAS: kiekvienas PRIVALOMAS #180 scenarijus turi realizaciją", () => {
  const idAibe = SCENARIJAI.map((s) => s.id);

  for (const [i, id] of idAibe.entries()) {
    assert.equal(typeof id, "string",
      `SCENARIJAI[${i}]: kiekvienas scenarijus privalo turėti stabilų "id"`);
    assert.notEqual(id, "", `SCENARIJAI[${i}]: "id" negali būti tuščias`);
  }

  /**
   * Dublikatai paslėptų trūkstamą scenarijų: du vienodi `id` užpildytų
   * `ivykdyti` aibę taip, kad trūkstamas invariantas atrodytų padengtas.
   */
  assert.equal(new Set(idAibe).size, idAibe.length,
    `SCENARIJAI "id" privalo būti unikalūs, gauta: ${idAibe.join(", ")}`);

  /**
   * ⚠️ ESMINIS P2-4 TIKRINIMAS. Reikalavimų sąrašas ir realizacija yra DU
   * NEPRIKLAUSOMI artefaktai, tad ištrintas ar pervadintas scenarijus čia
   * įvardijamas poimeniui. Senasis `results.length === SCENARIJAI.length`
   * tokiu atveju likdavo žalias, nes mažėjo abi lygybės pusės.
   */
  const truksta = PRIVALOMI_SCENARIJAI.filter((id) => !idAibe.includes(id));
  assert.deepEqual(truksta, [],
    `#180 6 punkto invariantai be realizacijos: ${truksta.join(", ")}`);
});

/**
 * #180 P3-7: SINTETINĖS SCHEMOS SCENARIJAI - ATSKIRAI IR EKSPLICITIŠKAI.
 *
 * ⚠️ KODĖL ATSKIRA DUOMENŲ BAZĖ.
 *
 * Du scenarijai reikalauja būsenų, kurių `jobs_status_phase` CHECK produkcijoje
 * neleidžia (`protocol` su `transcribing` faze; `processing` be fazės eros 2
 * įraše). Anksčiau dėl jų constraint'as būdavo pašalinamas iš BENDROS kontrakto
 * DB, tad VISAS PostgreSQL kontrakto paleidimas vykdavo su nusilpninta schema.
 *
 * Dabar įprastas PostgreSQL adapteris dirba su NEPAKEISTA produkcine schema, o
 * šie du scenarijai vykdomi čia - savo DB, kurioje constraint'as pašalinamas
 * eksplicitiškai ir tik po to, kai patikrinama, kad jis apskritai buvo.
 *
 * ⚠️ KĄ ŠIS TESTAS ĮRODO IR KO NE. Jis įrodo store SPRENDIMĄ dviem sugadintoms
 * būsenoms. Jis NĖRA produkcinės schemos vykdymo įrodymas ir negali būti
 * skaičiuojamas kaip toks.
 */
test(
  "KONTRAKTAS: PostgreSQL sintetinės schemos scenarijai (P3-7)",
  { skip: skipWithoutPostgres() },
  async () => {
    const sintetiniai = SCENARIJAI.filter(
      (x) => x.sintetineSchema && x.sintetineSchema.postgres
    );
    assert.notEqual(sintetiniai.length, 0,
      "sintetinės schemos rinkinys negali būti tuščias - kitaip du #180 invariantai dingtų");

    /** Ta pati resursų nuosavybės disciplina kaip įprastame adapteryje (P2-A). */
    const resursai = sukurtiResursuKruva();
    try {
    const url = testDatabaseUrl("backend_contract_sintetine");
    const dbName = new URL(url).pathname.slice(1);
    const admin = new Pool({ connectionString: adminDatabaseUrl() });
    resursai.registruoti("admin pool", () => admin.end());
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
    resursai.registruoti("laikina DB", () => nuleistiDb(dbName));
    await admin.end();
    execFileSync("npx", ["node-pg-migrate", "up"], {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, DATABASE_URL: url },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const pool = new Pool({ connectionString: url });
    resursai.registruoti("darbinis pool", () => pool.end());
    const store = createPostgresStore(pool);
    try {
      /** Constraint'as PRIVALO egzistuoti prieš pašalinant - kitaip migracija pasikeitė. */
      const pries = await pool.query(
        `SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'jobs_status_phase'`);
      assert.equal(pries.rows[0].n, 1,
        "prielaida: produkcinė migracija sukuria jobs_status_phase");

      await pool.query("ALTER TABLE jobs DROP CONSTRAINT jobs_status_phase");

      const po = await pool.query(
        `SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'jobs_status_phase'`);
      assert.equal(po.rows[0].n, 0, "sintetinė DB privalo būti be jobs_status_phase");

      for (const sc of sintetiniai) {
        const job = await store.create({ type: sc.type, ownerKind: OWNER_KIND.UNOWNED });
        await pool.query(
          `UPDATE jobs SET status = $2, phase = $3, progress_known = $4,
             progress_current = $5, progress_total = $6 WHERE id = $1`,
          [job.id, sc.busena.status, sc.busena.phase, sc.busena.progressKnown === true,
            sc.progress ? sc.progress.current : null,
            sc.progress ? sc.progress.total : null]
        );

        /** Ta pati semantinė projekcija kaip produkcinės schemos kelyje. */
        assert.deepEqual(
          sutartineBusena((await store.get(job.id)) || {}),
          sutartineBusena({ ...sc.busena, progress: sc.progress }),
          `${sc.id}: sintetinė paruošta būsena privalo atitikti bendrą scenarijų`
        );

        const r = await store.reportProgressAtomic(job.id, sc.ivykis);
        const gauta = r === "REJECTED" ? "REJECTED" : r == null ? "NULL" : "OK";
        assert.equal(gauta, sc.laukiama, `${sc.id} (sintetinė schema)`);
      }

      console.log(
        `[#180 apskaita] postgres-sintetine: įvykdyta ${sintetiniai.length} ` +
          `(${sintetiniai.map((x) => x.id).join(", ")})`
      );
    } finally {
      await resursai.isvalyti();
    }
    } catch (klaida) {
      await resursai.isvalyti(klaida);
      throw klaida;
    }
  }
);

/**
 * #180 P2-A: resursų nuosavybė, kai `setup()` krenta nebaigęs.
 *
 * ⚠️ VEIKIA BE PostgreSQL. Tikrinamas JS nuosavybės mechanizmas su netikrais
 * resursais - būtent jis lemia, ar nutekės admin pool'as, laikina DB ir
 * darbinis pool'as. Tikras serveris tam nereikalingas ir jo laukimas paliktų
 * mechanizmą neišbandytą.
 */
test("KONTRAKTAS: nebaigtas setup() sutvarko jau sukurtus resursus (P2-A)", async () => {
  const etapai = ["admin pool", "laikina DB", "darbinis pool"];

  for (let luzta = 0; luzta < etapai.length; luzta++) {
    const uzdaryta = [];
    const resursai = sukurtiResursuKruva();
    const pirmine = new Error(`setup nutrūko po etapo: ${etapai[luzta]}`);

    let gauta = null;
    try {
      for (let i = 0; i < etapai.length; i++) {
        resursai.registruoti(etapai[i], async () => uzdaryta.push(etapai[i]));
        if (i === luzta) throw pirmine;
      }
    } catch (e) {
      await resursai.isvalyti(e);
      gauta = e;
    }

    /** 1) Sutvarkyta VISKAS, kas jau buvo sukurta - ir tik tai. */
    assert.deepEqual(uzdaryta, etapai.slice(0, luzta + 1).reverse(),
      `${etapai[luzta]}: privalo būti išvalyti visi jau sukurti resursai atvirkštine tvarka`);

    /** 2) Pirminė klaida NEUŽDENGTA. */
    assert.equal(gauta, pirmine, `${etapai[luzta]}: pirminė setup klaida privalo išlikti`);
    assert.equal(gauta.valymoKlaidos, undefined, "sėkmingas valymas nepalieka pėdsakų");

    /** 3) Pakartotinis valymas nieko nedaro DAR KARTĄ. */
    await resursai.isvalyti();
    assert.deepEqual(uzdaryta, etapai.slice(0, luzta + 1).reverse(),
      `${etapai[luzta]}: valymas negali įvykti du kartus`);
    assert.equal(resursai.kiek(), 0, "krūva po valymo privalo būti tuščia");
  }
});

test("KONTRAKTAS: valymo klaida neuždengia pirminės setup klaidos (P2-A)", async () => {
  const resursai = sukurtiResursuKruva();
  resursai.registruoti("geras resursas", async () => {});
  resursai.registruoti("blogas resursas", async () => { throw new Error("close failed"); });

  const pirmine = new Error("tikroji setup priežastis");
  await resursai.isvalyti(pirmine);

  assert.equal(pirmine.message, "tikroji setup priežastis",
    "pirminė klaida privalo likti nepakitusi");
  assert.deepEqual(pirmine.valymoKlaidos, ["blogas resursas: close failed"],
    "valymo nesėkmė privalo likti MATOMA, bet atskirai nuo pirminės priežasties");
});

/**
 * #180 P3-7: sintetinės schemos išimtys yra eksplicitinės ir ribotos.
 */
test("KONTRAKTAS: sintetinės schemos scenarijai deklaruoti ir apriboti (P3-7)", () => {
  const sintetiniai = SCENARIJAI.filter((x) => x.sintetineSchema && x.sintetineSchema.postgres);

  assert.deepEqual(sintetiniai.map((x) => x.id).sort(),
    ["processing-be-fazes", "svetimo-grafo-faze"],
    "sintetinės schemos gali reikalauti TIK du #180 scenarijai");

  for (const sc of sintetiniai) {
    assert.ok(PRIVALOMI_SCENARIJAI.includes(sc.id),
      `${sc.id}: privalo LIKTI privalomas - P3-7 sprendžiamas izoliacija, ne panaikinimu`);
    assert.notEqual(sc.sintetineSchema.postgres.trim(), "",
      `${sc.id}: sintetinės schemos priežastis negali būti tuščia`);
    assert.match(sc.sintetineSchema.postgres, /jobs_status_phase/,
      `${sc.id}: priežastis privalo įvardyti KONKRETŲ constraint'ą`);
    /** Memory ir Redis šias būsenas atstovauja be jokios schemos - jie VYKDO. */
    assert.equal(sc.sintetineSchema.memory, undefined, `${sc.id}: memory privalo VYKDYTI`);
    assert.equal(sc.sintetineSchema.redis, undefined, `${sc.id}: Redis privalo VYKDYTI`);
    /** Sintetinė schema NĖRA neatstovaujamumas - kategorijos nesumaišomos. */
    assert.equal(sc.neatstovaujama, undefined,
      `${sc.id}: sintetinės schemos scenarijus nėra „neatstovaujamas"`);
  }
});

/**
 * #180 P2-5 (Option A): NEATSTOVAUJAMUMO DEKLARACIJOS.
 *
 * ⚠️ VEIKIA BE JOKIO BACKEND'O, tad išimčių higiena tikrinama abiejuose
 * rinkiniuose, kuriuose failas registruotas (`test:redis`, `test:postgres`).
 *
 * ⚠️ KĄ TAI ĮRODO IR KO NE. Tikrinama, kad kiekviena išimtis yra EKSPLICITINĖ,
 * priskirta realiam adapteriui ir pagrįsta. Tai NĖRA įrodymas, kad PostgreSQL
 * elgiasi teisingai - tai įrodymas, kad jis nebemeluoja apie padengimą.
 */
test("KONTRAKTAS: neatstovaujamumo deklaracijos yra eksplicitinės ir pagrįstos", () => {
  const vardai = new Set(ADAPTERIAI.map((a) => a.name));

  /** Abu deklaracijų šaltiniai tikrinami vienodai (P2-5 ir P3-7). */
  for (const s of SCENARIJAI) {
    /**
     * ⚠️ TIKSLIAI VIENA BAIGTINĖ BŪSENA (#180 7a punktas). Scenarijus negali
     * tam pačiam backend'ui vienu metu būti ir „neatstovaujamas", ir
     * „reikalaujantis sintetinės schemos" - tada apskaita nebeturėtų
     * vienareikšmės būsenos.
     */
    for (const backendas of Object.keys(s.neatstovaujama || {})) {
      assert.equal((s.sintetineSchema || {})[backendas], undefined,
        `${s.id}/${backendas}: dvi deklaracijos tam pačiam backend'ui - baigtinė būsena neapibrėžta`);
    }

    if (s.sintetineSchema !== undefined) {
      for (const [backendas, priezastis] of Object.entries(s.sintetineSchema)) {
        assert.ok(vardai.has(backendas),
          `${s.id}: nežinomas backend'as "${backendas}" sintetineSchema deklaracijoje`);
        assert.equal(typeof priezastis, "string", `${s.id}/${backendas}: priežastis privalo būti eilutė`);
        assert.notEqual(priezastis.trim(), "", `${s.id}/${backendas}: priežastis negali būti tuščia`);
      }
      assert.notEqual(Object.keys(s.sintetineSchema).length, vardai.size,
        `${s.id}: sintetinės schemos reikalauti VISIEMS backend'ams negalima`);
    }

    if (s.neatstovaujama === undefined) continue;

    assert.equal(typeof s.neatstovaujama, "object",
      `${s.id}: "neatstovaujama" privalo būti objektas {backendas: priežastis}`);
    assert.notEqual(s.neatstovaujama, null, `${s.id}: "neatstovaujama" negali būti null`);

    const atsisako = Object.keys(s.neatstovaujama);
    for (const backendas of atsisako) {
      assert.ok(vardai.has(backendas),
        `${s.id}: nežinomas backend'as "${backendas}" - deklaracija taikoma niekam`);
      const priezastis = s.neatstovaujama[backendas];
      assert.equal(typeof priezastis, "string",
        `${s.id}/${backendas}: priežastis privalo būti eilutė`);
      assert.notEqual(priezastis.trim(), "",
        `${s.id}/${backendas}: priežastis negali būti tuščia - išimtis be paaiškinimo ` +
          "yra tylus praleidimas kita forma");
    }

    /**
     * ⚠️ NĖ VIENAS PRIVALOMAS SCENARIJUS NEGALI BŪTI ATSISAKYTAS VISUR.
     * Kitaip #180 invariantas dingtų iš rinkinio nepalikdamas pėdsako.
     */
    assert.notEqual(atsisako.length, vardai.size,
      `${s.id}: atsisakyta VISŲ backend'ų - bent vienas privalo scenarijų VYKDYTI`);
  }
});

/**
 * #180 P2-5: dvi konkrečios pre-būsenos, dėl kurių ši išimtis atsirado.
 */
test("KONTRAKTAS: P2-5 scenarijai lieka PRIVALOMI, o PostgreSQL juos atsisako eksplicitiškai", () => {
  for (const id of ["skaitines-eilutes", "ideti-metaduomenys"]) {
    assert.ok(PRIVALOMI_SCENARIJAI.includes(id),
      `${id}: privalo LIKTI privalomas - P2-5 sprendžiamas išimtimi, ne reikalavimo panaikinimu`);

    const s = SCENARIJAI.find((x) => x.id === id);
    assert.ok(s, `${id}: scenarijus privalo egzistuoti (nepervadintas, neištrintas)`);

    const d = s.neatstovaujama || {};
    assert.equal(typeof d.postgres, "string",
      `${id}: PostgreSQL neatstovaujamumas privalo būti DEKLARUOTAS`);
    assert.notEqual(d.postgres.trim(), "", `${id}: PostgreSQL priežastis negali būti tuščia`);

    /** Memory ir Redis šias pre-būsenas atstovauja, tad VYKDO. */
    assert.equal(d.memory, undefined, `${id}: memory privalo VYKDYTI šį scenarijų`);
    assert.equal(d.redis, undefined, `${id}: Redis privalo VYKDYTI šį scenarijų`);
  }

  /** Priežastys privalo įvardyti TIKRĄ schemos ribą, ne būti bendra fraze. */
  const eilutes = SCENARIJAI.find((x) => x.id === "skaitines-eilutes").neatstovaujama.postgres;
  assert.match(eilutes, /double precision/i,
    "skaitines-eilutes: priežastis privalo įvardyti tipizuotus stulpelius");
  const meta = SCENARIJAI.find((x) => x.id === "ideti-metaduomenys").neatstovaujama.postgres;
  assert.match(meta, /metadata/i,
    "ideti-metaduomenys: priežastis privalo įvardyti įdėtus progreso metaduomenis");

  /**
   * ⚠️ KONTROLINIS SCENARIJUS. PostgreSQL neturi tapti „viską atsisakančiu"
   * adapteriu: eksponentinę formą `double precision` atstovauja tiksliai, tad
   * ji privalo likti VYKDOMA visuose trijuose.
   */
  const kontrolinis = SCENARIJAI.find((x) => x.id === "eksponentine-forma");
  assert.ok(kontrolinis, "kontrolinis scenarijus privalo egzistuoti");
  assert.equal(kontrolinis.neatstovaujama, undefined,
    "eksponentine-forma privalo būti vykdoma VISUOSE backend'uose");

  /** Dauguma scenarijų PostgreSQL'e vykdomi - išimtis lieka išimtimi. */
  const pgAtsisako = SCENARIJAI.filter((x) => x.neatstovaujama && x.neatstovaujama.postgres);
  assert.deepEqual(pgAtsisako.map((x) => x.id).sort(),
    ["ideti-metaduomenys", "skaitines-eilutes"],
    "PostgreSQL gali atsisakyti TIK dviejų P2-5 scenarijų");
});

/**
 * #180 8 ir 9b.B punktai: praleidimas negali būti TYLUS.
 *
 * ⚠️ Tai FAIL-CLOSED sargas, ne elgesio įrodymas. Jis tikrina tik tai, kad su
 * nustatytu URL adapteris NEPRALEIDŽIAMAS - ar scenarijai realiai praėjo,
 * sprendžia pats adapterio testas.
 */
test("KONTRAKTAS: su nustatytu URL adapteris NEGALI praleisti savo scenarijų", () => {
  const reikalavimai = [
    { name: "redis", url: process.env.REDIS_URL },
    { name: "postgres", url: process.env.DATABASE_URL },
  ];

  for (const { name, url } of reikalavimai) {
    const adapteris = ADAPTERIAI.find((a) => a.name === name);
    assert.ok(adapteris, `adapteris "${name}" privalo egzistuoti rinkinyje`);

    if (!url) continue; // be URL praleidimas yra teisėtas (žr. guard'us)

    assert.equal(adapteris.skip, false,
      `${name}: URL nustatytas, tad adapterio praleidimas yra NESĖKMĖ, ne tyli praleistis`);
  }
});

test("KONTRAKTAS: visi trys backend'ai deklaruoja TĄ PAČIĄ 15 metodų aibę", () => {
  /**
   * Trūkstamas metodas viename backend'e reikštų, kad fasadas tyliai grįžta į
   * atsarginį kelią – be jokio signalo. Būtent taip `reportProgressAtomic()`
   * ilgai nebuvo memory backend'e.
   */
  const redis = createRedisStore({ on: () => {}, defineCommand: () => {} });
  const postgres = createPostgresStore({});

  const metodai = (store) => Object.keys(store)
    .filter((key) => typeof store[key] === "function")
    .sort();
  const expected = metodai(memoryStore);

  assert.equal(expected.length, 15, "jobStore kontraktas privalo turėti tiksliai 15 metodų");
  assert.deepEqual(metodai(redis), expected,
    "Redis metodų aibė privalo tiksliai sutapti su memory");
  assert.deepEqual(metodai(postgres), expected,
    "PostgreSQL metodų aibė privalo tiksliai sutapti su memory");
});

test(
  "KONTRAKTAS: Redis CAS tikrina ir TIPO nekintamumą",
  { skip: skipWithoutRedis() },
  async (t) => {
    /**
     * ⚠️ Tipas tikrinamas JS pusėje, bet įrašas gali pasikeisti tarp `get()` ir
     * `eval()` — `restoreRecord()` perrašo visą hash'ą. Lua CAS lygino tik
     * statusą, fazę ir progresą, tad įrašas, pakeistas į `protocol +
     * transcribing`, progresą vis tiek gaudavo.
     *
     * Memory backend'as tokio lango neturi (skaito ir rašo be `await` tarp jų),
     * tad tai buvo dar viena backend'ų divergencija.
     */
    const IORedis = require("ioredis");
    const client = new IORedis(process.env.REDIS_URL);
    const store = createRedisStore(client);
    let jobId = null;

    t.after(async () => {
      if (jobId) {
        await client.del(`job:${jobId}`).catch(() => {});
        await client.zrem("jobs:index", jobId).catch(() => {});
      }
      await client.quit().catch(() => {});
    });

    const job = await store.create({
      type: JOB_TYPES.TRANSCRIPTION,
      ownerKind: OWNER_KIND.UNOWNED,
    });
    jobId = job.id;

    await client.hset(`job:${job.id}`, {
      status: "processing",
      phase: PHASE.TRANSCRIBING,
      progress: JSON.stringify({ current: 1, total: 10 }),
      progressKnown: "true",
    });

    /** Tipas keičiamas PO JS sprendimo, prieš Lua. */
    let perimta = false;
    const racing = Object.create(client);
    racing.eval = async (...args) => {
      if (!perimta) {
        perimta = true;
        await client.hset(`job:${job.id}`, { type: JOB_TYPES.PROTOCOL });
      }
      return client.eval(...args);
    };

    const racingStore = createRedisStore(racing);
    const outcome = await racingStore.reportProgressAtomic(job.id, {
      phase: PHASE.TRANSCRIBING,
      progress: { current: 5, total: 10 },
    });

    assert.ok(perimta, "prielaida: tipas pakeistas prieš Lua");
    assert.equal(outcome, "REJECTED", "pasikeitęs tipas turi atmesti įvykį");
  }
);

test("KONTRAKTAS: dokumentacija neteigia, kad memory backend'ui CAS nereikalingas", () => {
  /**
   * ⚠️ ŠIS TEIGINYS ATSIRADO DU KARTUS.
   *
   * Pirmą kartą — `docs/job-lifecycle.md`, antrą — `docs/security-test-matrix.md`,
   * abiejose vietose greta įrašo, sakančio priešingai. Palikus abu, būsimas
   * backend'o autorius gautų viena kitą paneigiančius nurodymus, o
   * `memoryStore.reportProgressAtomic()` atrodytų kaip nereikalingas kodas.
   *
   * Tikrinama abiem kryptim: teiginio nėra IR metodas realiai egzistuoja.
   */
  const fs = require("node:fs");
  const path = require("node:path");
  const šaknis = path.resolve(__dirname, "..", "..");

  assert.equal(
    typeof memoryStore.reportProgressAtomic,
    "function",
    "prielaida: memory backend'as turi atominį kelią"
  );

  const šablonas = /memory\s+backend'?[ue]\s+CAS\s+nereikalingas/i;

  for (const failas of ["docs/security-test-matrix.md", "docs/job-lifecycle.md"]) {
    const kelias = path.join(šaknis, failas);
    if (!fs.existsSync(kelias)) continue; // `job-lifecycle.md` ateina su PR B

    assert.equal(
      šablonas.test(fs.readFileSync(kelias, "utf8")),
      false,
      `${failas}: teiginys prieštarauja reportProgressAtomic() egzistavimui`
    );
  }
});
