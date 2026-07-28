const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

/**
 * REGRESIJOS testas: transcriptionWorker.js/protocolWorker.js (atskiri Docker
 * compose entrypoint'ai) TURI paleisti heartbeat SU TEISINGU worker tipu,
 * kitaip /api/ready visada grąžina 503 BullMQ režime, nors darbas realiai
 * vyksta (žr. utils/workerHeartbeat.js, docker-compose.gpu.yml/server.yml
 * "transcription-worker"/"protocol-worker" servisus).
 *
 * Mock'iname ioredis (kaip tests/jobRunnerBullmq.test.js), kad patikrintume
 * REALŲ connection.set() kvietimą su teisingu raktu - be tikro Redis.
 */

function mockRedisModule(setCalls, quitCalls) {
  return class MockRedis {
    async set(key, value, mode, ttl) {
      setCalls.push({ key, value, mode, ttl });
      return "OK";
    }
    async quit() {
      if (quitCalls) quitCalls.push(Date.now());
    }
  };
}

function setupTest(t, setCalls, quitCalls) {
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === "ioredis") return mockRedisModule(setCalls, quitCalls);
    return origLoad.apply(this, arguments);
  };

  const prevRedisUrl = process.env.REDIS_URL;
  process.env.REDIS_URL = "redis://mock:6379";

  // jobStore mock'as - simuliuojam sėkmingą Redis backend'ą (kad
  // initializeWorkerOrFail praeitų), kaip tests/workerGuard.test.js.
  const jobStorePath = require.resolve("../utils/jobStore");
  const realJobStore = require("../utils/jobStore");
  require.cache[jobStorePath].exports = {
    ...realJobStore,
    init: async () => {},
    getBackend: () => "redis",
  };

  delete require.cache[require.resolve("../workers/index")];
  delete require.cache[require.resolve("../queues/config")];

  t.after(() => {
    Module._load = origLoad;
    delete require.cache[jobStorePath];
    delete require.cache[require.resolve("../workers/index")];
    delete require.cache[require.resolve("../queues/config")];
    if (prevRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = prevRedisUrl;
  });
}

test("runWorkerProcess paleidžia heartbeat SU teisingu workerType (transcription)", async (t) => {
  const setCalls = [];
  setupTest(t, setCalls);

  const { runWorkerProcess } = require("../workers/index");

  // Stub worker (imituoja BullMQ Worker) - realaus BullMQ Worker čia nekuriam,
  // testuojam TIK runWorkerProcess apvalkalą (init + heartbeat + shutdown wiring).
  const stubWorker = { close: async () => {} };
  const runtime = await runWorkerProcess("Test worker", () => stubWorker, "transcription");

  // t.after IŠVALO heartbeat intervalą IR SIGTERM/SIGINT listener'ius
  // (shutdown({exit:false}) - NEKVIEČIA process.exit, kad netrukdytų testų
  // procesui), kitaip liktų atviras setInterval + listener'iai per visą testų
  // failo vykdymo laiką.
  t.after(() => runtime.shutdown({ exit: false }));

  assert.equal(runtime.worker, stubWorker, "runWorkerProcess turi grąžinti startWorker() rezultatą kaip .worker");
  assert.equal(typeof runtime.shutdown, "function", "runWorkerProcess turi grąžinti .shutdown funkciją (testuojamumui)");

  // Heartbeat rašomas asinchroniškai (beat() kviečiamas iškart, bet nelaukiamas) -
  // palaukiam microtask, kad set() spėtų įvykti.
  await new Promise((r) => setImmediate(r));

  assert.ok(setCalls.length >= 1, "heartbeat turėjo parašyti bent vieną raktą");
  const keys = setCalls.map((c) => c.key);
  assert.ok(
    keys.includes("stenograma:worker:transcription:lastSeen"),
    `heartbeat turėjo rašyti "transcription" tipo raktą, bet rašė: ${keys.join(", ")}`
  );
  assert.ok(
    !keys.includes("stenograma:worker:protocol:lastSeen"),
    "transcription worker'is NETURI rašyti protocol tipo rakto"
  );
  assert.ok(
    !keys.includes("stenograma:worker:lastSeen"),
    "atskiras worker procesas NETURI rašyti legacy bendro rakto (tas skirtas TIK kombinuotam workers/index.js)"
  );
});

test("runWorkerProcess paleidžia heartbeat SU teisingu workerType (protocol)", async (t) => {
  const setCalls = [];
  setupTest(t, setCalls);

  const { runWorkerProcess } = require("../workers/index");
  const stubWorker = { close: async () => {} };
  const runtime = await runWorkerProcess("Test worker", () => stubWorker, "protocol");
  t.after(() => runtime.shutdown({ exit: false }));

  await new Promise((r) => setImmediate(r));

  const keys = setCalls.map((c) => c.key);
  assert.ok(keys.includes("stenograma:worker:protocol:lastSeen"));
  assert.ok(!keys.includes("stenograma:worker:transcription:lastSeen"));
});

test("shutdown() yra idempotentiškas - antras iškvietimas nekartoja worker.close()/heartbeat quit()", async (t) => {
  const setCalls = [];
  const quitCalls = [];
  setupTest(t, setCalls, quitCalls);

  const { runWorkerProcess } = require("../workers/index");

  let closeCallCount = 0;
  const stubWorker = {
    close: async () => {
      closeCallCount += 1;
      await new Promise((r) => setTimeout(r, 10)); // imituoja realų async close()
    },
  };
  const runtime = await runWorkerProcess("Test worker", () => stubWorker, "transcription");

  // Kviečiam shutdown() DU KARTUS BEVEIK VIENU METU (imituoja SIGTERM+SIGINT
  // beveik vienu metu arba tą patį signalą pakartotą) - antras kvietimas turi
  // TIK palaukti pirmojo, o NE paleisti worker.close()/heartbeatConn.quit() dar kartą.
  //
  // PASTABA dėl testo tikslumo: NETIKRINAME `shutdown()` grąžinamų promise'ų
  // reikšmių ar identiteto - abu būtų vienodi bet kuriuo atveju (net jei
  // idempotentiškumas NEVEIKTŲ), nes: (1) `shutdown` pati resolve'ina į
  // `undefined` (jokio explicit return value), tad `assert.equal(r1, r2)` po
  // await visada praeitų (undefined === undefined) - tuščia (vacuous) tiesa;
  // (2) net PRIEŠ await, pačių Promise OBJEKTŲ identitetas (`p1 === p2`)
  // BŪTŲ `false`, nes `shutdown` yra `async function` - kiekvienas jos
  // iškvietimas grąžina NAUJĄ Promise apvalkalą aplink vidinę `shuttingDown`
  // reikšmę, net jei vidus teisingai kartotinai naudoja TĄ PATĮ cache'uotą
  // promise (patikrinta empiriškai - žr. PR diskusiją). Todėl vienintelis
  // patikimas idempotentiškumo įrodymas yra ŠALUTINIS POVEIKIS - kiek kartų
  // REALIAI įvyko worker.close()/heartbeatConn.quit().
  await Promise.all([
    runtime.shutdown({ exit: false }),
    runtime.shutdown({ exit: false }),
  ]);

  assert.equal(closeCallCount, 1, "worker.close() turi būti iškviestas TIK VIENĄ kartą, net jei shutdown() kviečiamas kelis kartus");
  assert.equal(quitCalls.length, 1, "heartbeatConn.quit() turi būti iškviestas TIK VIENĄ kartą, net jei shutdown() kviečiamas kelis kartus");

  // Trečias kvietimas (po užbaigimo) irgi neturi kartoti darbo.
  await runtime.shutdown({ exit: false });
  assert.equal(closeCallCount, 1, "shutdown() po užbaigimo irgi neturi pakartotinai kviesti worker.close()");
  assert.equal(quitCalls.length, 1, "shutdown() po užbaigimo irgi neturi pakartotinai kviesti heartbeatConn.quit()");
});
