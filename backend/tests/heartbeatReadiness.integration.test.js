const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
process.env.LLM_PROVIDER = process.env.LLM_PROVIDER || "mock";

/**
 * HEARTBEAT -> /api/ready integracinis testas su TIKRU Redis.
 *
 * ⚠️ PRALEIDŽIAMAS be REDIS_URL - paleiskite su:
 *   REDIS_URL=redis://localhost:6379 npm run test:redis
 *
 * Anksčiau ŠIS konkretus grandinės tikrinimas TRŪKO: `tests/workerHeartbeat.test.js`
 * testuoja `startHeartbeat`/`isWorkerAlive`/`getWorkerStatus` su MOCK Redis;
 * `tests/queueRecovery.integration.test.js` naudoja TIKRĄ Redis, bet tikrina BullMQ
 * job recovery, NE heartbeat/readiness. Nė vienas testas nepatvirtino, kad:
 *   1) worker'is rašo `stenograma:worker:<tipas>:lastSeen` per TIKRĄ Redis;
 *   2) `GET /api/ready` (server.js) TĄ PATĮ raktą TIKRAI perskaito per TIKRĄ Redis
 *      (ne mock) ir teisingai atspindi jo buvimą/nebuvimą atsakyme;
 *   3) raktui išnykus (TTL pasibaigus ar worker'iui sustojus), readiness pereina
 *      į 503 su tiksliu `workers` skaidymu, kuris tipas konkrečiai "miręs".
 *
 * TTL nelaukiam realiai (HEARTBEAT_TTL_SEC=30s būtų per lėtas testui) - vietoj to
 * TIESIOGIAI ištriname Redis raktą, kas FUNKCIŠKAI atitinka TTL pasibaigimą iš
 * server.js /api/ready perspektyvos (jis tik tikrina `EXISTS`, nesiskiria kodėl
 * rakto nėra - TTL ar rankinis DEL).
 */

/**
 * Praleidimo sąlyga - BENDRA (žr. tests/helpers/redisGuard.js).
 *
 * Su `REQUIRE_REDIS=1` (nustatoma CI) tylus praleidimas tampa klaida: kitaip
 * dingęs `REDIS_URL` paliktų job'ą žalią, nors nieko nepatikrino.
 */
const { skipWithoutRedis } = require("./helpers/redisGuard");

test(
  "heartbeat -> /api/ready: worker'io rašytas raktas TIKRAI matomas per Redis, o jam išnykus - readiness krenta į 503",
  { skip: skipWithoutRedis() },
  async (t) => {
    const jobStore = require("../utils/jobStore");
    const jobRunner = require("../queues/jobRunner");
    const { createQueueConnection } = require("../queues/config");
    const { startHeartbeat, heartbeatKey } = require("../utils/workerHeartbeat");

    // Kintamieji deklaruojami PRIEŠ vienintelį konsoliduotą t.after() bloką, kad
    // jis pasiektų VISUS resursus (workerConn, stopHeartbeat) neatsižvelgiant į
    // tai, kada tiksliai jie priskiriami toliau teste.
    let workerConn;
    let stopHeartbeat;

    // VIENAS aiškus cleanup blokas TEISINGA TVARKA (užregistruotas IŠKART, kad
    // suveiktų NET jei kuri nors žemiau esanti asercija/kvietimas kristų prieš
    // pasiekiant testo pabaigą):
    //   1) sustabdom heartbeat rašymą (interval);
    //   2) ištrinam ABU (transcription IR protocol) heartbeat raktus - testas
    //      turi palikti Redis TOKIOS PAT būsenos, kokią rado (ne tik protocol,
    //      kaip buvo anksčiau - transcription raktas būtų likęs iki 30s TTL);
    //   3) uždarom worker'io imituotą Redis ryšį (workerConn);
    //   4) uždarom jobRunner (BullMQ eilių jungtis, jei kada nors buvo sukurtos);
    //   5) jobStore._resetForTests() UŽDARO jobStore.init() sukurtą ioredis
    //      klientą - BE ŠITO jis liktų atviras (jobStore modulio lygmens
    //      singleton'as), testų procesas galėtų neužsibaigti/pakibti CI.
    t.after(async () => {
      stopHeartbeat?.();
      if (workerConn) {
        await workerConn.del(heartbeatKey("transcription"), heartbeatKey("protocol")).catch(() => {});
        await workerConn.quit().catch(() => {});
      }
      await jobRunner.close().catch(() => {});
      await jobStore._resetForTests();
    });

    await jobStore.init();
    await jobRunner.init({ persistentStoreAvailable: true });
    assert.equal(jobRunner.getMode(), "bullmq", "testui reikia realaus BullMQ režimo (REDIS_URL turi būti pasiekiamas)");

    // Server.js bendras readiness flag'as (jobStore/jobRunner init) - apeinam
    // per testams skirtą helperį, kad liktų tik jobRunner.getMode()==="bullmq"
    // šaka (Redis + worker heartbeat), kurią čia ir tikrinam.
    const app = require("../server");
    app._setReadyForTests(true);
    t.after(() => app._setReadyForTests(true));

    // Atskiras Redis ryšys - imituoja worker procesą, kuris rašo heartbeat (kaip
    // workers/index.js runWorkerProcess() realiai daro).
    workerConn = createQueueConnection();

    // 1. PRIEŠ paleidžiant heartbeat - raktų NĖRA, /api/ready TURI grąžinti 503.
    await workerConn.del(heartbeatKey("transcription"));
    await workerConn.del(heartbeatKey("protocol"));

    const beforeRes = await request(app).get("/api/ready");
    assert.equal(beforeRes.status, 503, "be jokio worker heartbeat, /api/ready turi grąžinti 503");
    assert.equal(beforeRes.body.components.workerAlive, false);
    assert.equal(beforeRes.body.components.workers.transcription, false);
    assert.equal(beforeRes.body.components.workers.protocol, false);

    // 2. Paleidžiam TIKRĄ heartbeat (per TIKRĄ Redis) ABIEM tipams.
    stopHeartbeat = startHeartbeat(workerConn, ["transcription", "protocol"]);

    // Palaukiam, kol pirmas beat() realiai įvyks per Redis (asinchroninis, žr.
    // utils/workerHeartbeat.js - kviečiamas iškart, bet nelaukiamas viduje).
    let afterStartRes;
    for (let i = 0; i < 20; i++) {
      afterStartRes = await request(app).get("/api/ready");
      if (afterStartRes.status === 200) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(afterStartRes.status, 200, "abiem worker tipams rašant heartbeat per TIKRĄ Redis, /api/ready turi grąžinti 200");
    assert.equal(afterStartRes.body.components.workerAlive, true);
    assert.deepEqual(afterStartRes.body.components.workers, { transcription: true, protocol: true });

    // 3. Sustabdom TIK protocol heartbeat rašymą IR iškart ištriname jo raktą
    // (imituoja TTL pasibaigimą be realaus 30s laukimo - server.js pusėje
    // funkciškai NEATSKIRIAMA nuo tikro TTL expiry, nes tikrinama TIK EXISTS).
    // PASTABA: čia sustabdomas VISAS heartbeat (abiem tipams, nes startHeartbeat
    // šiam testui paleistas su abiem raktais viename intervale), bet ištrinamas
    // TIK protocol raktas - transcription raktas testo METU sąmoningai paliekamas
    // (kad įrodytume, jog jis LIEKA "gyvas" nepaisant bendro stop() kvietimo,
    // kol jo TTL nepasibaigęs). Galutinis t.after() cleanup vėliau ištrina ABU.
    stopHeartbeat();
    await workerConn.del(heartbeatKey("protocol"));

    const afterDeathRes = await request(app).get("/api/ready");
    assert.equal(afterDeathRes.status, 503, "protocol worker'iui \"mirus\" (raktas dingęs), /api/ready turi grąžinti 503");
    assert.equal(afterDeathRes.body.components.workerAlive, false, "workerAlive turi būti false, jei BENT VIENAS tipas miręs");
    assert.equal(afterDeathRes.body.components.workers.transcription, true, "transcription worker'is VIS DAR gyvas - jo raktas nepaliestas");
    assert.equal(afterDeathRes.body.components.workers.protocol, false, "protocol worker'is turi rodytis kaip miręs");
  }
);
