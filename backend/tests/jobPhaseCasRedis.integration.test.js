const { test } = require("node:test");
const assert = require("node:assert/strict");
const { skipWithoutRedis } = require("./helpers/redisGuard");

/**
 * #154, 3 žingsnis: ATOMINIS PROGRESO ĮRAŠYMAS REDIS'E.
 *
 * `jobPhase.reportProgress()` yra gryna funkcija – ji sprendžia pagal PERDUOTĄ
 * būseną. Fasade tai reiškia `GET → sprendimas → UPDATE`, ir tarp jų kitas
 * rašytojas gali pakeisti fazę:
 *
 *   worker A: GET (phase=transcribing)
 *   worker B: startPhase(diarizing)
 *   worker A: UPDATE progress=4200        ← pasenęs įvykis LAIMĖTŲ
 *
 * Vienetiniai testai to NEĮRODO – jie tikrina sprendimą, ne lenktynes. Ši byla
 * tikrina, kad patikra ir rašymas vyksta viena Redis operacija.
 *
 * ⚠️ Praleidžiama be `REDIS_URL`; CI nustato `REQUIRE_REDIS=1`.
 *
 * ⚠️ JOKIO `flushdb()`. `node --test` failus vykdo LYGIAGREČIAI, tad viso DB
 * išvalymas sunaikintų kitų testų būseną – tai būtų tas pats bendro Redis
 * spąstas, kurį aprašo `helpers/redisGuard.js`, tik agresyvesnis. Kiekvienas
 * testas kuria SAVO job'ą ir po savęs išsivalo.
 */

const K = require("../utils/jobStore/common").OWNER_KIND;
const { PHASE } = require("../utils/jobPhase");

async function paruosti() {
  const { createRedisStore } = require("../utils/jobStore/redisStore");
  const IORedis = require("ioredis");
  const client = new IORedis(process.env.REDIS_URL);
  return { client, store: createRedisStore(client) };
}

/** Išvalo TIK šio testo job'ą – ne visą DB. */
async function isvalyti(client, id) {
  await client.del(`job:${id}`).catch(() => {});
  await client.zrem("jobs:index", id).catch(() => {});
}

test(
  "#154 CAS: fazės pakeitimas TARP skaitymo ir rašymo atmeta pasenusį progresą",
  { skip: skipWithoutRedis() },
  async () => {
    /**
     * ESMINIS testas.
     *
     * Fazė keičiama interceptinant `eval()` – t. y. PO to, kai JS pusė jau
     * priėmė sprendimą, bet PRIEŠ Lua vykdymą. Keičiant fazę anksčiau suveiktų
     * grynoji patikra, ir CAS niekada nebūtų pasiektas: testas praeitų net be
     * atomiškumo. Ta pati pamoka kaip #159 `ownerId` CAS.
     */
    const { client, store } = await paruosti();
    let jobId = null;

    try {
      const job = await store.create({ type: "transcription", ownerKind: K.UNOWNED });
      jobId = job.id;
      await client.hset(`job:${job.id}`, {
        status: "processing",
        phase: PHASE.TRANSCRIBING,
        progress: JSON.stringify({ current: 1000, total: 4420 }),
        progressKnown: "true",
      });

      let perimta = false;
      const racing = Object.create(client);
      racing.eval = async (...args) => {
        if (!perimta) {
          perimta = true;
          // Kitas rašytojas pakeičia fazę – progresas resetinamas.
          await client.hset(`job:${job.id}`, {
            phase: PHASE.DIARIZING,
            progress: "null",
            progressKnown: "false",
          });
        }
        return client.eval(...args);
      };

      const racingStore = require("../utils/jobStore/redisStore").createRedisStore(racing);
      const outcome = await racingStore.reportProgressAtomic(job.id, {
        phase: PHASE.TRANSCRIBING,
        progress: { current: 4200, total: 4420 },
      });

      assert.ok(perimta, "prielaida: fazė pakeista būtent prieš Lua kvietimą");
      assert.equal(outcome, "REJECTED", "pasenęs įvykis turi būti atmestas Lua viduje");

      const galutinis = await client.hgetall(`job:${job.id}`);
      assert.equal(galutinis.phase, PHASE.DIARIZING, "fazė lieka nauja");
      assert.equal(galutinis.progress, "null", "transkripcijos progresas NEĮRAŠYTAS");
      assert.equal(galutinis.progressKnown, "false");
    } finally {
      if (jobId) await isvalyti(client, jobId);
      await client.quit();
    }
  }
);

test(
  "#154 CAS: monotoniškumas tikrinamas Lua viduje, ne tik JS",
  { skip: skipWithoutRedis() },
  async () => {
    const { client, store } = await paruosti();
    let jobId = null;

    try {
      const job = await store.create({ type: "transcription", ownerKind: K.UNOWNED });
      jobId = job.id;
      await client.hset(`job:${job.id}`, {
        status: "processing",
        phase: PHASE.TRANSCRIBING,
        progress: JSON.stringify({ current: 2000, total: 4420 }),
        progressKnown: "true",
      });

      // Progresas padidinamas TARP JS sprendimo ir Lua – senesnis įvykis vėluoja.
      let perimta = false;
      const racing = Object.create(client);
      racing.eval = async (...args) => {
        if (!perimta) {
          perimta = true;
          await client.hset(`job:${job.id}`, {
            progress: JSON.stringify({ current: 3000, total: 4420 }),
          });
        }
        return client.eval(...args);
      };

      const racingStore = require("../utils/jobStore/redisStore").createRedisStore(racing);
      const outcome = await racingStore.reportProgressAtomic(job.id, {
        phase: PHASE.TRANSCRIBING,
        progress: { current: 2500, total: 4420 },
      });

      assert.equal(outcome, "REJECTED", "2500 < 3000 – regresija atmetama Lua viduje");

      const galutinis = JSON.parse((await client.hgetall(`job:${job.id}`)).progress);
      assert.equal(galutinis.current, 3000, "naujesnė reikšmė išlieka");
    } finally {
      if (jobId) await isvalyti(client, jobId);
      await client.quit();
    }
  }
);

test(
  "#154 CAS: pasikeitęs total atmetamas Lua viduje",
  { skip: skipWithoutRedis() },
  async () => {
    const { client, store } = await paruosti();
    let jobId = null;

    try {
      const job = await store.create({ type: "transcription", ownerKind: K.UNOWNED });
      jobId = job.id;
      await client.hset(`job:${job.id}`, {
        status: "processing",
        phase: PHASE.TRANSCRIBING,
        progress: JSON.stringify({ current: 50, total: 100 }),
        progressKnown: "true",
      });

      const outcome = await store.reportProgressAtomic(job.id, {
        phase: PHASE.TRANSCRIBING,
        progress: { current: 60, total: 200 },
      });

      assert.equal(outcome, "REJECTED", "kitas total – kita epocha, ne pažanga");
    } finally {
      if (jobId) await isvalyti(client, jobId);
      await client.quit();
    }
  }
);

test(
  "#154 CAS: normalus progresas PRAEINA (regresija)",
  { skip: skipWithoutRedis() },
  async () => {
    const { client, store } = await paruosti();
    let jobId = null;

    try {
      const job = await store.create({ type: "transcription", ownerKind: K.UNOWNED });
      jobId = job.id;
      await client.hset(`job:${job.id}`, {
        status: "processing",
        phase: PHASE.TRANSCRIBING,
        progress: JSON.stringify({ current: 1000, total: 4420 }),
        progressKnown: "true",
      });

      const outcome = await store.reportProgressAtomic(job.id, {
        phase: PHASE.TRANSCRIBING,
        progress: { current: 2000, total: 4420 },
      });

      assert.ok(outcome && outcome !== "REJECTED", "apsauga neturi būti aklas blokas");
      assert.equal(outcome.progress.current, 2000);
      assert.equal(outcome.progressKnown, true, "tipas išlieka boolean");
    } finally {
      if (jobId) await isvalyti(client, jobId);
      await client.quit();
    }
  }
);

test(
  "#154 CAS: nesantis job'as grąžina null",
  { skip: skipWithoutRedis() },
  async () => {
    // Cleanup nereikalingas: testas sąmoningai naudoja neegzistuojantį job'ą.
    const { client, store } = await paruosti();
    try {
      const outcome = await store.reportProgressAtomic("nera-tokio", {
        phase: PHASE.TRANSCRIBING,
        progress: { current: 1, total: 2 },
      });
      assert.equal(outcome, null);
    } finally {
      await client.quit();
    }
  }
);

test(
  "#154 CAS: FASADAS naudoja atominį kelią, ne JS read-then-write",
  { skip: skipWithoutRedis() },
  async (t) => {
    /**
     * Ankstesni testai kviečia `reportProgressAtomic()` TIESIOGIAI, tad jie
     * įrodo Lua, bet ne tai, kad fasadas ja naudojasi. Grąžinus fasadą į
     * `store.update()` visi jie liktų žali, o TOCTOU langas atsivertų.
     *
     * ⚠️ LANGAS ATIDAROMAS PER `get()` PERĖMIMĄ. Bandymas „paleisti abu
     * lygiagrečiai ir tikėtis lenktynių" nepakanka: `await` seka reiškia, kad
     * fasadas spėja baigti prieš fazės pakeitimą, ir testas praeina net be
     * atomiškumo. Deterministiškumo reikia, ne tikimybės.
     */
    const jobStore = require("../utils/jobStore");
    const IORedis = require("ioredis");
    const client = new IORedis(process.env.REDIS_URL);

    t.after(async () => {
      await client.quit().catch(() => {});
      await jobStore._resetForTests();
    });

    await jobStore.init();

    const job = await jobStore.create({ type: "transcription", ownerKind: K.UNOWNED });
    await jobStore.system.startPhase(job.id, PHASE.VALIDATING);
    await jobStore.system.startPhase(job.id, PHASE.TRANSCRIBING, {
      progress: { current: 1000, total: 4420 },
    });

    /**
     * Perimam backend'o `get()`: kai fasadas jį iškviečia progreso kelyje,
     * PO grąžinimo pakeičiam fazę. Fasadas jau turi seną būseną – tiksliai
     * TOCTOU situacija.
     */
    const store = jobStore._storeForTests ? jobStore._storeForTests() : null;
    assert.ok(store, "testui reikia prieigos prie backend'o");

    const originalGet = store.get.bind(store);
    let perimta = false;
    store.get = async (id) => {
      const rezultatas = await originalGet(id);
      if (!perimta && rezultatas && rezultatas.phase === PHASE.TRANSCRIBING) {
        perimta = true;
        await client.hset(`job:${id}`, {
          phase: PHASE.DIARIZING,
          progress: "null",
          progressKnown: "false",
        });
      }
      return rezultatas;
    };

    try {
      await jobStore.system.reportProgress(job.id, {
        phase: PHASE.TRANSCRIBING,
        progress: { current: 4200, total: 4420 },
      });
    } finally {
      store.get = originalGet;
    }

    assert.ok(perimta, "prielaida: fazė pakeista po fasado get()");

    const galutinis = await client.hgetall(`job:${job.id}`);
    assert.equal(galutinis.phase, PHASE.DIARIZING, "fazė lieka nauja");
    assert.equal(
      galutinis.progress,
      "null",
      "pasenęs transkripcijos progresas NETURI patekti į diarizacijos fazę"
    );
  }
);

test(
  "#154 CAS: lygiagretus NESUSIJUSIO lauko pakeitimas IŠLIEKA",
  { skip: skipWithoutRedis() },
  async () => {
    /**
     * KITA CONCURRENCY KLASĖ nei ankstesni testai.
     *
     * Anksčiau tikrinome, ką CAS turi ATMESTI. Čia — ką jis turi PALIKTI
     * RAMYBĖJE, kai progreso įvykis teisėtai praeina.
     *
     * ⚠️ Pirmoji implementacija rašė VISĄ serializuotą job'ą, sudarytą iš
     * `get()` metu nuskaityto snapshot'o. Tai reikštų:
     *
     *   A: GET (ownerId=X)
     *   B: atominis ownerId CAS → ownerId=Y
     *   A: HSET visas snapshot'as → ownerId GRĮŽTA į X
     *
     * T. y. progreso įvykis anuliuotų #159 `ownerId` CAS rezultatą. Todėl
     * rašomi tik `progress`, `progressKnown` ir `updatedAt`.
     */
    const { client, store } = await paruosti();
    let jobId = null;

    try {
      const job = await store.create({ type: "transcription", ownerKind: K.UNOWNED });
      jobId = job.id;
      await client.hset(`job:${job.id}`, {
        status: "processing",
        phase: PHASE.TRANSCRIBING,
        progress: JSON.stringify({ current: 1000, total: 4420 }),
        progressKnown: "true",
      });

      /**
       * Nesusijęs laukas keičiamas TARP JS sprendimo ir Lua – tiksliai tas
       * langas, kuriame platus HSET jį atsuktų atgal.
       */
      let perimta = false;
      const racing = Object.create(client);
      racing.eval = async (...args) => {
        if (!perimta) {
          perimta = true;
          await client.hset(`job:${job.id}`, { actor: "kitas-worker", attempt_count: "3" });
        }
        return client.eval(...args);
      };

      const racingStore = require("../utils/jobStore/redisStore").createRedisStore(racing);
      const outcome = await racingStore.reportProgressAtomic(job.id, {
        phase: PHASE.TRANSCRIBING,
        progress: { current: 2000, total: 4420 },
      });

      assert.ok(perimta, "prielaida: laukas pakeistas prieš Lua");
      assert.ok(outcome && outcome !== "REJECTED", "progresas turėjo praeiti");

      const galutinis = await client.hgetall(`job:${job.id}`);

      assert.equal(JSON.parse(galutinis.progress).current, 2000, "progresas įrašytas");
      assert.equal(galutinis.actor, "kitas-worker", "SVETIMAS pakeitimas NEATSUKTAS");
      assert.equal(galutinis.attempt_count, "3", "ir antras laukas išliko");
    } finally {
      if (jobId) await isvalyti(client, jobId);
      await client.quit();
    }
  }
);
