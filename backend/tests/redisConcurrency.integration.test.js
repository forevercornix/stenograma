const test = require("node:test");
const assert = require("node:assert/strict");

const { skipWithoutRedis, REDIS_URL } = require("./helpers/redisGuard");

process.env.NODE_ENV = "test";
process.env.LLM_PROVIDER = "mock";
process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.DIARIZATION_PROVIDER = "none";
process.env.API_KEY = "";
process.env.LOG_LEVEL = "error";
process.env.RATE_LIMIT_MAX_REQUESTS = "500";
process.env.RATE_LIMIT_GENERAL_MAX = "500";

/**
 * LYGIAGRETUMAS IR IZOLIACIJA SU TIKRU REDIS (#15).
 *
 * `correlationChain.integration` jau tikrina izoliaciją, bet INLINE režime:
 * ten viskas vyksta viename procese, ir `AsyncLocalStorage` kontekstas
 * natūraliai atskirtas. Su Redis paveikslas kitas - jobai keliauja per bendrą
 * saugyklą, o worker'is kontekstą ATKURIA iš įrašo.
 *
 * Būtent ten koreliacija gali „susimaišyti" nepastebimai: jei worker'is
 * kontekstą nustatytų kartą, o ne kiekvienam jobui, du lygiagretūs jobai
 * pasidalintų vieno iš jų `requestId`. Logai atrodytų tvarkingi ir meluotų.
 */

const HAS_REDIS = !skipWithoutRedis();

const jobStore = require("../utils/jobStore");

/**
 * Ryšys inicijuojamas VIENĄ kartą visam failui.
 *
 * Pirmoji versija darė `init` + `close` kiekviename teste, o `jobStore` yra
 * BENDRAS modulis - antrasis testas gaudavo „Connection is closed". Klaida
 * pamokoma: testų izoliacija neturi reikšti bendro resurso uždarymo, jei jį
 * dalinasi visi.
 */
test("REDIS: ryšys paruošiamas", { skip: skipWithoutRedis() }, async () => {
  await jobStore.init({ redisUrl: REDIS_URL });
});

test("REDIS: koreliacijos laukai išgyvena tikrą saugyklos ratą", { skip: skipWithoutRedis() }, async () => {

  const created = await jobStore.create({ ownerKind: "unowned",
    type: jobStore.JOB_TYPES.PROTOCOL,
    requestId: "req_tikras_redis_1",
    actor: "key_abc123def456",
  });

  // Ne tas pats objektas - realiai skaitom iš Redis.
  const loaded = await jobStore.system.get(created.id);

  assert.equal(loaded.requestId, "req_tikras_redis_1");
  assert.equal(loaded.actor, "key_abc123def456");

  // `null` irgi turi išlikti `null`, o ne virsti eilute "null".
  const plain = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.PROTOCOL });
  const loadedPlain = await jobStore.system.get(plain.id);

  assert.equal(loadedPlain.requestId, null);
  assert.equal(loadedPlain.actor, null);
});

test("REDIS: lygiagretūs jobai nesumaišo koreliacijos", { skip: skipWithoutRedis() }, async () => {

  const COUNT = 10;

  const jobs = await Promise.all(
    Array.from({ length: COUNT }, (_, i) =>
      jobStore.create({ ownerKind: "unowned",
        type: jobStore.JOB_TYPES.PROTOCOL,
        requestId: `req_lygiagretus_${i}`,
        actor: `key_${String(i).padStart(12, "0")}`,
      })
    )
  );

  const loaded = await Promise.all(jobs.map((job) => jobStore.system.get(job.id)));

  for (let i = 0; i < COUNT; i += 1) {
    assert.equal(
      loaded[i].requestId,
      `req_lygiagretus_${i}`,
      `jobas ${i} gavo svetimą requestId - koreliacija MELUOJA`
    );
    assert.equal(loaded[i].actor, `key_${String(i).padStart(12, "0")}`);
  }
});

test("REDIS: kontekstas atkuriamas iš SAUGYKLOS per realų vykdymo kelią", { skip: skipWithoutRedis() }, async () => {
  /**
   * Šis testas eina per TIKRĄ atkūrimo kodą, ne per `runWithContext` tiesiogiai.
   *
   * Pirmoji versija kvietė `runWithContext` pati ir tikrino `getRequestId()` -
   * puikus `AsyncLocalStorage` testas, bet jis būtų likęs žalias net tada, jei
   * `jobRunner` apskritai pamirštų konteksto atkūrimą. Testas tikrino biblioteką,
   * o ne mūsų kodą.
   *
   * Dabar grandinė tikra: Redis → jobStore → jobRunner → runWithContext →
   * processor. Vienintelis dalykas, kurio čia nėra - BullMQ worker procesas
   * (jį dengia `queueRecovery.integration`); atkūrimo logika abiejuose keliuose
   * ta pati.
   */
  const jobRunner = require("../queues/jobRunner");
  const { getRequestId, getContext } = require("../utils/requestContext");

  const observed = [];

  jobRunner.registerProcessor("protocol", async (payload, jobId) => {
    // Dirbtinis delsimas, kad lygiagretūs scope'ai realiai persidengtų laike.
    await new Promise((resolve) => setTimeout(resolve, 15));
    observed.push({ jobId, requestId: getRequestId(), execution: getContext().execution });
    return { ok: true };
  });

  await jobRunner.init({ persistentStoreAvailable: false });

  // Jobai kuriami TIKROJE saugykloje su skirtingais ID.
  const jobs = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      jobStore.create({ ownerKind: "unowned",
        type: jobStore.JOB_TYPES.PROTOCOL,
        requestId: `req_is_saugyklos_${i}`,
        actor: `key_${String(i).padStart(12, "0")}`,
      })
    )
  );

  await Promise.all(jobs.map((job) => jobRunner.enqueueProtocol(job.id, { transcript: "x" })));

  for (let i = 0; i < 100 && observed.length < jobs.length; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.equal(observed.length, jobs.length, "visi jobai turėjo pasiekti processor'ių");

  for (const job of jobs) {
    const seen = observed.find((entry) => entry.jobId === job.id);

    assert.ok(seen, `jobas ${job.id} nepasiekė processor'iaus`);
    assert.equal(
      seen.requestId,
      job.requestId,
      "processor'ius matė SVETIMĄ requestId - kontekstas nutekėjo tarp lygiagrečių jobų"
    );
    assert.equal(seen.execution, "inline");
  }
});

test("REDIS: ištrintas jobas dingsta iš saugyklos, ne tik iš atminties", { skip: skipWithoutRedis() }, async () => {

  const job = await jobStore.create({ ownerKind: "unowned",
    type: jobStore.JOB_TYPES.PROTOCOL,
    requestId: "req_trynimo_testas",
  });

  assert.ok(await jobStore.system.get(job.id), "jobas turi egzistuoti prieš trynimą");

  await jobStore.system.remove(job.id);

  // GDPR ištrynimas, kuris veikia tik atmintyje, palieka duomenis Redis'e -
  // o būtent ten jie išgyvena restartą.
  assert.equal(await jobStore.system.get(job.id), null, "jobas turi dingti iš TIKROS saugyklos");
});

test("REDIS: jobas ir jo ištrynimas IŠGYVENA restartą", { skip: skipWithoutRedis() }, async () => {
  /**
   * Pagrindinis GDPR argumentas nėra „ištrinta toje pačioje sesijoje", o
   * „ištrinta ir po restarto nebeatsiranda".
   *
   * Ankstesnė versija darė create → remove → get vienoje sesijoje. Tai
   * praeidavo net tada, jei trynimas veiktų tik atmintyje - o būtent Redis'e
   * duomenys išgyvena procesą, ir būtent ten jie liktų.
   *
   * Čia ryšys sąmoningai uždaromas ir atkuriamas: kiekvienas `init` skaito iš
   * TIKROS saugyklos, ne iš proceso būsenos.
   */
  const job = await jobStore.create({ ownerKind: "unowned",
    type: jobStore.JOB_TYPES.PROTOCOL,
    requestId: "req_restarto_testas",
  });

  /**
   * „Restartas" per `_resetForTests()`, ne per `close()`.
   *
   * Vien `close()` nepakanka: jis uždaro klientą, bet NEATSTATO `initPromise`,
   * tad paskesnis `init()` nieko nedaro ir modulis lieka su uždarytu ryšiu.
   * Tai realus API aštrus kampas - `close()` po savęs palieka nebenaudojamą
   * modulį - bet testams `_resetForTests()` egzistuoja būtent tam.
   */
  await jobStore._resetForTests();
  await jobStore.init({ redisUrl: REDIS_URL });

  const afterRestart = await jobStore.system.get(job.id);
  assert.ok(afterRestart, "jobas turi išgyventi restartą");
  assert.equal(afterRestart.requestId, "req_restarto_testas", "koreliacija irgi turi išlikti");

  // 2. Ištrynimas.
  await jobStore.system.remove(job.id);

  // 3. Antras „restartas" - ištrynimas irgi turi būti persistentus.
  await jobStore._resetForTests();
  await jobStore.init({ redisUrl: REDIS_URL });

  assert.equal(
    await jobStore.system.get(job.id),
    null,
    "ištrintas jobas NEGALI atsirasti po restarto - kitaip trynimas veikė tik atmintyje"
  );
});

test("BE REDIS: rinkinys praleidžiamas, bet apie tai pasakoma", { skip: HAS_REDIS ? "veikia su Redis" : false }, () => {
  /**
   * Šis testas vykdomas TIK be Redis - jis fiksuoja, kad praleidimas yra
   * sąmoningas ir matomas, o ne tyli spraga.
   *
   * Su `REQUIRE_REDIS=1` (CI) net čia nepatektume: `redisGuard` mestų klaidą
   * dar prieš testų paleidimą.
   */
  const { hasRedis, REQUIRED } = require("./helpers/redisGuard");

  assert.equal(hasRedis, false);
  assert.equal(REQUIRED, false, "REQUIRE_REDIS=1 be REDIS_URL turėjo nutraukti dar anksčiau");
});

test("REDIS: ryšys uždaromas - procesas turi baigtis", { skip: skipWithoutRedis() }, async () => {
  /**
   * BE ŠITO FAILAS PAKIBTŲ.
   *
   * `node --test` laukia, kol baigsis visi aktyvūs handle'ai. Atviras Redis
   * ryšys yra vienas iš jų, tad procesas niekada neišeitų - CI job'as kabotų
   * iki savo `timeout-minutes`, o priežastis atrodytų kaip lėtas testas, ne
   * kaip neuždarytas resursas.
   *
   * Rasta paleidžiant: testai praeidavo, bet suvestinė niekada nepasirodydavo.
   */
  await jobStore.close();
});
