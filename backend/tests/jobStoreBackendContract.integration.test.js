const { test } = require("node:test");
const assert = require("node:assert/strict");
const { skipWithoutRedis } = require("./helpers/redisGuard");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const memoryStore = require("../utils/jobStore/memoryStore");
const { createRedisStore } = require("../utils/jobStore/redisStore");
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
 * Šis testas paleidžia TĄ PAČIĄ scenarijų aibę prieš abu backend'us ir
 * reikalauja vienodo rezultato.
 *
 * ⚠️ #155 PRIDĖS TREČIĄ REALIZACIJĄ (`postgresStore`).
 *
 * Backend'ai čia NĖRA parametrizuoti – memory ir Redis turi po atskirą testą,
 * nes jų paruošimas skiriasi (memory rašo objektą, Redis – Redis hash'ą).
 * Pridedant `postgresStore` reikia:
 *
 *   1. naujo `paruostiBusena` adapterio (SQL INSERT/UPDATE);
 *   2. trečio testo, lyginančio jį su memory rezultatais, kaip daro Redis;
 *   3. `SCENARIJAI` sąrašo NEKEISTI – jis bendras.
 *
 * Šito praleidimas nebūtų automatiškai pastebimas, todėl ADR 7.2b tai įvardija
 * kaip eksplicitinį DoD punktą.
 */

/** Scenarijai, kurių rezultatas turi sutapti VISUOSE backend'uose. */
const SCENARIJAI = [
  {
    kodel: "sugadintas įrašas: svetimo grafo fazė",
    type: JOB_TYPES.PROTOCOL,
    busena: { status: "processing", phase: PHASE.TRANSCRIBING, progressKnown: true },
    progress: { current: 1, total: 10 },
    ivykis: { phase: PHASE.TRANSCRIBING, progress: { current: 5, total: 10 } },
    laukiama: "REJECTED",
  },
  {
    kodel: "sugadintas įrašas: processing be fazės",
    type: JOB_TYPES.TRANSCRIPTION,
    busena: { status: "processing", phase: null, progressKnown: true },
    progress: { current: 1, total: 10 },
    ivykis: { phase: PHASE.TRANSCRIBING, progress: { current: 5, total: 10 } },
    laukiama: "REJECTED",
  },
  {
    kodel: "pavėlavęs įvykis iš ankstesnės fazės",
    type: JOB_TYPES.TRANSCRIPTION,
    busena: { status: "processing", phase: PHASE.DIARIZING, progressKnown: false },
    progress: null,
    ivykis: { phase: PHASE.TRANSCRIBING, progress: { current: 9, total: 10 } },
    laukiama: "REJECTED",
  },
  {
    kodel: "monotoniškumo pažeidimas",
    type: JOB_TYPES.TRANSCRIPTION,
    busena: { status: "processing", phase: PHASE.TRANSCRIBING, progressKnown: true },
    progress: { current: 8, total: 10 },
    ivykis: { phase: PHASE.TRANSCRIBING, progress: { current: 3, total: 10 } },
    laukiama: "REJECTED",
  },
  {
    kodel: "pasikeitęs total (kita epocha)",
    type: JOB_TYPES.TRANSCRIPTION,
    busena: { status: "processing", phase: PHASE.TRANSCRIBING, progressKnown: true },
    progress: { current: 5, total: 10 },
    ivykis: { phase: PHASE.TRANSCRIBING, progress: { current: 6, total: 20 } },
    laukiama: "REJECTED",
  },
  {
    kodel: "ne-processing statusas",
    type: JOB_TYPES.TRANSCRIPTION,
    busena: { status: "queued", phase: null, progressKnown: false },
    progress: null,
    ivykis: { phase: PHASE.TRANSCRIBING, progress: { current: 5, total: 10 } },
    laukiama: "REJECTED",
  },
  {
    kodel: "progresas su ĮDĖTAIS metaduomenimis",
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
    kodel: "eksponentinė skaičiaus forma",
    type: JOB_TYPES.TRANSCRIPTION,
    busena: { status: "processing", phase: PHASE.TRANSCRIBING, progressKnown: true },
    progress: { current: 1e-9, total: 1e-7 },
    ivykis: { phase: PHASE.TRANSCRIBING, progress: { current: 5e-8, total: 1e-7 } },
    laukiama: "OK",
  },
  {
    kodel: "skaitinės EILUTĖS vietoj skaičių",
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
    kodel: "TVARKINGAS progresas",
    type: JOB_TYPES.TRANSCRIPTION,
    busena: { status: "processing", phase: PHASE.TRANSCRIBING, progressKnown: true },
    progress: { current: 3, total: 10 },
    ivykis: { phase: PHASE.TRANSCRIBING, progress: { current: 7, total: 10 } },
    laukiama: "OK",
  },
];

/** Paleidžia visus scenarijus prieš vieną backend'ą. */
async function paleisti(store, paruostiBusena) {
  const rezultatai = [];

  for (const s of SCENARIJAI) {
    const job = await store.create({ type: s.type, ownerKind: OWNER_KIND.UNOWNED });
    await paruostiBusena(job.id, { ...s.busena, progress: s.progress });

    const r = await store.reportProgressAtomic(job.id, s.ivykis);
    rezultatai.push({
      kodel: s.kodel,
      gauta: r === "REJECTED" ? "REJECTED" : r == null ? "NULL" : "OK",
      laukiama: s.laukiama,
      id: job.id,
    });
  }

  return rezultatai;
}

test("KONTRAKTAS: memory backend'as atitinka scenarijų lūkesčius", async () => {
  const r = await paleisti(memoryStore, async (id, busena) => {
    await memoryStore.update(id, busena);
  });

  for (const { kodel, gauta, laukiama } of r) {
    assert.equal(gauta, laukiama, `memory: ${kodel}`);
  }
});

test(
  "KONTRAKTAS: Redis backend'as duoda TĄ PATĮ rezultatą kaip memory",
  { skip: skipWithoutRedis() },
  async (t) => {
    /**
     * ⚠️ Lyginami ne tik lūkesčiai, bet ir backend'ai TARPUSAVYJE.
     *
     * Jei abu būtų klaidingi vienodai, pirmasis testas kristų. Jei išsiskirtų –
     * kris šis. Kartu jie uždaro abu variantus.
     */
    const IORedis = require("ioredis");
    const client = new IORedis(process.env.REDIS_URL);
    const store = createRedisStore(client);
    const sukurti = [];

    t.after(async () => {
      for (const id of sukurti) {
        await client.del(`job:${id}`).catch(() => {});
        await client.zrem("jobs:index", id).catch(() => {});
      }
      await client.quit().catch(() => {});
    });

    const redisR = await paleisti(store, async (id, busena) => {
      sukurti.push(id);
      await client.hset(`job:${id}`, {
        status: busena.status,
        phase: busena.phase == null ? "" : busena.phase,
        progress: busena.progress == null ? "null" : JSON.stringify(busena.progress),
        progressKnown: String(Boolean(busena.progressKnown)),
      });
    });

    const memoryR = await paleisti(memoryStore, async (id, busena) => {
      await memoryStore.update(id, busena);
    });

    for (let i = 0; i < SCENARIJAI.length; i += 1) {
      assert.equal(
        redisR[i].gauta,
        memoryR[i].gauta,
        `BACKEND'AI IŠSISKYRĖ ties "${SCENARIJAI[i].kodel}": ` +
          `redis=${redisR[i].gauta}, memory=${memoryR[i].gauta}`
      );
      assert.equal(redisR[i].gauta, SCENARIJAI[i].laukiama, `redis: ${SCENARIJAI[i].kodel}`);
    }
  }
);

test("KONTRAKTAS: abu backend'ai deklaruoja TĄ PAČIĄ metodų aibę", () => {
  /**
   * Trūkstamas metodas viename backend'e reikštų, kad fasadas tyliai grįžta į
   * atsarginį kelią – be jokio signalo. Būtent taip `reportProgressAtomic()`
   * ilgai nebuvo memory backend'e.
   */
  const redis = createRedisStore({ on: () => {}, defineCommand: () => {} });

  const memoryMetodai = Object.keys(memoryStore).filter((k) => typeof memoryStore[k] === "function");
  const redisMetodai = Object.keys(redis).filter((k) => typeof redis[k] === "function");

  const trukstaRedis = memoryMetodai.filter((m) => !redisMetodai.includes(m));
  const trukstaMemory = redisMetodai.filter((m) => !memoryMetodai.includes(m));

  assert.deepEqual(trukstaRedis, [], `Redis backend'e trūksta: ${trukstaRedis.join(", ")}`);
  assert.deepEqual(trukstaMemory, [], `memory backend'e trūksta: ${trukstaMemory.join(", ")}`);
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
