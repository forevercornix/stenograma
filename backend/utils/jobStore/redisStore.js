const { STATUS, JOB_TYPES, TTL_MS, newJob, applyPatch, isFinished, hasPendingCleanup } = require("./common");

/**
 * Redis job store backend'as (persistentus, atsparus restartams, palaiko kelis
 * procesus/replikas).
 *
 * ATNAUJINTA: šis modulis teikia PERSISTENT job BŪSENOS saugyklą (create/get/update
 * sąsaja) - ją naudoja TIEK inline/mock veiksena, TIEK tikra BullMQ eilė (žr.
 * `queues/`, `workers/`). Tai NĖRA "kitas žingsnis prieš BullMQ" - BullMQ JAU
 * implementuota atskirai (`queues/jobRunner.js` automatiškai renkasi BullMQ
 * režimą su `REDIS_URL`); šis failas yra job BŪSENOS sluoksnis, kurį BullMQ
 * worker'iai atnaujina (`workers/index.js`), ne pati eilės logika.
 *
 * "Dead-letter queue" terminijos pastaba: BullMQ pusėje po visų `attempts`
 * išnaudojimo jobas lieka pažymėtas `failed` (ir čia, jobStore, atitinkamai
 * `STATUS.FAILED`) - tai NĖRA atskira izoliuota dead-letter eilė, tik `failed`
 * būsenos retencija (žr. `queues/config.js` `removeOnFail.age`).
 *
 * Raktų schema:
 *   job:{id}        -> Redis hash su job laukais (JSON reikšmės sudėtingoms)
 *   jobs:index      -> Redis sorted set (score = updatedAt ms) sweepExpired'ui
 *
 * TTL: kiekvienam baigtam (completed/failed/cancelled) job'ui nustatomas Redis
 * EXPIRE = JOB_TTL_MINUTES, tad Redis pats išvalo pasenusius - sweepExpired lieka
 * suderinamumui, bet Redis atveju daugiausiai no-op (Redis EXPIRE atlieka darbą).
 *
 * TESTAVIMO PASTABA: `tests/jobStoreRedis.test.js` testuoja ŠIO failo logiką su
 * FakeRedis (in-memory imitacija, ne tikras ioredis/Redis serveris) - tikrina
 * serializaciją/raktų schemą, NE tikrą Redis tinklo elgesį. Realus Redis
 * naudojamas tik `tests/queueRecovery.integration.test.js` (per BullMQ, ne
 * tiesiogiai per šį modulį) - atskiro šio konkretaus modulio integracinio testo
 * su tikru Redis šiuo metu nėra (žr. backend/README.md "Testai" pastabą).
 *
 * STATUS: parašyta pagal ioredis API, bet REALIAI NETESTUOTA su tikru Redis
 * serveriu šioje aplinkoje (nėra Redis daemon). Sąsajos logika testuota su
 * in-memory fake Redis (žr. tests/jobStoreRedis.test.js). Prieš produkciją
 * patikrinkite su tikru Redis.
 */

const JOB_PREFIX = "job:";
const INDEX_KEY = "jobs:index";
const TTL_SECONDS = Math.ceil(TTL_MS / 1000);

// Laukai, kuriuos saugom kaip JSON (objektai/masyvai); kiti - kaip paprastą tekstą.
const JSON_FIELDS = new Set(["result", "progress"]);

/**
 * Redis hash'e VISKAS yra eilutė. Todėl laukus, kurių tipas turi reikšmę, būtina
 * atstatyti - kitaip `false` grįžta kaip `"false"`, o TAI YRA TRUTHY.
 *
 * Ką tai laužė (rasta savo testu, Redis režime):
 *   - `audio_cleanup_pending: "false"` -> listByFlag() grąžindavo VISUS jobus, o
 *     retryPendingAudioCleanups() tada trindavo dar apdorojamų jobų audio;
 *   - hasPendingCleanup() visada true -> update() kviesdavo PERSIST vietoj EXPIRE,
 *     tad baigti jobai Redis'e NIEKADA neiškvėpdavo (retencija tyliai neveikė);
 *   - `audio_cleanup_attempts: "0"` -> `("0" || 0) + 1` === "01" (eilučių
 *     konkatenacija), tad bandymų skaitliukas ir alerto riba neveikė.
 *
 * `attempt_count` jau buvo apdorojamas atskirai - tai buvo užuomina, kad ši spąsta
 * žinoma; naujus laukus reikėjo pridėti čia iš karto.
 */
const BOOLEAN_FIELDS = new Set(["audio_cleanup_pending", "deletion_pending"]);

const NUMBER_FIELDS = new Set([
  "attempt_count",
  "audio_cleanup_attempts",
  "deletion_attempts",
]);

function serialize(job) {
  const flat = {};
  for (const [k, v] of Object.entries(job)) {
    if (v === null || v === undefined) {
      flat[k] = "";
    } else if (JSON_FIELDS.has(k) || typeof v === "object") {
      flat[k] = JSON.stringify(v);
    } else {
      flat[k] = String(v);
    }
  }
  return flat;
}

function deserialize(flat) {
  if (!flat || Object.keys(flat).length === 0) return null;
  const job = {};
  for (const [k, v] of Object.entries(flat)) {
    if (v === "") {
      job[k] = null;
    } else if (JSON_FIELDS.has(k)) {
      try {
        job[k] = JSON.parse(v);
      } catch {
        job[k] = null;
      }
    } else if (BOOLEAN_FIELDS.has(k)) {
      job[k] = String(v).toLowerCase() === "true";
    } else if (NUMBER_FIELDS.has(k)) {
      job[k] = parseInt(v, 10) || 0;
    } else {
      job[k] = v;
    }
  }
  return job;
}

function createRedisStore(redisClient) {
  async function create(fields = {}) {
    const job = newJob(fields);
    await redisClient.hset(JOB_PREFIX + job.id, serialize(job));
    await redisClient.zadd(INDEX_KEY, Date.now(), job.id);
    return job;
  }

  async function get(id) {
    const flat = await redisClient.hgetall(JOB_PREFIX + id);
    return deserialize(flat);
  }

  async function update(id, patch) {
    const existing = await get(id);
    if (!existing) return null;
    const next = applyPatch(existing, patch);
    await redisClient.hset(JOB_PREFIX + id, serialize(next));
    await redisClient.zadd(INDEX_KEY, Date.now(), id);
    // Baigtiems job'ams - Redis EXPIRE, kad pats išvalytų po TTL. IŠIMTIS:
    // nebaigtas valymas (audio_cleanup_pending / deletion_pending) - tada
    // PERSIST, nes šis įrašas yra vienintelis šaltinis, iš kurio žinomas
    // storageKey. Redis pats jo išmesti neturi.
    if (hasPendingCleanup(next)) {
      if (typeof redisClient.persist === "function") {
        await redisClient.persist(JOB_PREFIX + id);
      }
    } else if (isFinished(next.status)) {
      await redisClient.expire(JOB_PREFIX + id, TTL_SECONDS);
    }
    return next;
  }

  async function remove(id) {
    const existed = await redisClient.exists(JOB_PREFIX + id);

    await redisClient.del(JOB_PREFIX + id);
    await redisClient.zrem(INDEX_KEY, id);

    return Boolean(existed);
  }

  async function sweepExpired(now = Date.now()) {
    // Redis EXPIRE jau tvarko baigtų job'ų išvalymą. Čia papildomai išvalom
    // INDEX sorted set nuo raktų, kurių hash jau expiravo (kad indeksas neaugtų).
    const cutoff = now - TTL_MS;
    const oldIds = await redisClient.zrangebyscore(INDEX_KEY, 0, cutoff);
    let removed = 0;
    for (const id of oldIds) {
      const exists = await redisClient.exists(JOB_PREFIX + id);
      if (!exists) {
        await redisClient.zrem(INDEX_KEY, id);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Jobai su nustatyta boolean vėliava (`deletion_pending`,
   * `audio_cleanup_pending`). Redis'e nėra sekundinio indekso pagal šiuos
   * laukus, tad einam per jobs:index (jame - tik gyvi jobai) ir tikrinam lauką.
   * Riba (`limit`) apsaugo nuo didelio skenavimo.
   */
  /**
   * VISŲ gyvų jobų storage raktai (žr. memoryStore analogą dėl priežasties).
   * jobs:index gali turėti "vaiduoklių", kurių hash'ai jau iškvėpė per Redis TTL -
   * jie tiesiog praleidžiami (deserialize grąžina null), o jų failai tada teisėtai
   * tampa orphan.
   */
  async function listReferencedStorageKeys() {
    const jobs = await _scanJobs();
    const keys = new Set();

    for (const job of jobs) {
      if (job.storageKey) keys.add(job.storageKey);
    }

    return [...keys];
  }

  async function listByFlag(field, limit = 100) {
    const jobs = await _scanJobs();
    const pending = [];

    for (const job of jobs) {
      if (pending.length >= limit) break;
      if (job[field]) pending.push(job);
    }

    return pending;
  }

  /**
   * Visi REALIAI egzistuojantys jobai iš jobs:index.
   *
   * Vienas round-trip per PIPELINE, o ne N atskirų HGETALL - prie tūkstančių jobų
   * N kvietimų reikštų N tinklo apsikeitimų. Tas pats šablonas kaip size().
   *
   * jobs:index gali turėti "vaiduoklių", kurių hash'ai jau iškvėpė per Redis TTL
   * (indekso įrašą vėliau pašalina sweepExpired) - deserialize jiems grąžina null
   * ir jie praleidžiami.
   */
  async function _scanJobs() {
    const ids = await redisClient.zrange(INDEX_KEY, 0, -1);
    if (!ids.length) return [];

    const pipeline = redisClient.pipeline();
    for (const id of ids) pipeline.hgetall(JOB_PREFIX + id);
    const results = await pipeline.exec();

    const jobs = [];
    for (const [, flat] of results) {
      const job = deserialize(flat);
      if (job) jobs.push(job);
    }

    return jobs;
  }

  async function size() {
    // TIKSLUMAS: jobs:index (zcard) gali įtraukti jobus, kurių hash'ai JAU IŠNYKO per
    // Redis TTL (EXPIRE), bet indekso įrašas dar nepašalintas (tai daro sweepExpired
    // periodiškai). Kad size() nerodytų "vaiduoklių", suskaičiuojam tik REALIAI
    // egzistuojančius. Naudojam pipeline (vienas round-trip), ne N atskirų exists.
    const ids = await redisClient.zrange(INDEX_KEY, 0, -1);
    if (!ids.length) return 0;
    const pipeline = redisClient.pipeline();
    for (const id of ids) pipeline.exists(JOB_PREFIX + id);
    const results = await pipeline.exec();
    // results: [[err, 0|1], ...] - skaičiuojam tuos, kur exists === 1.
    return results.reduce((count, [, exists]) => count + (exists ? 1 : 0), 0);
  }

  async function close() {
    if (typeof redisClient.quit === "function") {
      await redisClient.quit();
    }
  }

  return { create, get, update, remove, sweepExpired, size, listByFlag, listReferencedStorageKeys, close, STATUS, JOB_TYPES, TTL_MS, backend: "redis" };
}

module.exports = { createRedisStore, serialize, deserialize, BOOLEAN_FIELDS, NUMBER_FIELDS };
