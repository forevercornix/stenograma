/**
 * BullMQ eilių bendras Redis prisijungimas ir eilių vardai.
 *
 * ARCHITEKTŪRA: HTTP backend'as tik ĮDEDA jobus į eiles (queue.add) ir grąžina 202.
 * Darbą pasiima ATSKIRI worker procesai (workers/), kurie gali būti paleisti kaip
 * atskiri konteineriai/procesai. Tai reiškia:
 *   - HTTP backend restartas NEnutraukia vykdomo darbo (jį daro worker);
 *   - worker restartas -> BullMQ automatiškai grąžina nebaigtą jobą į eilę;
 *   - keli worker'iai nepaima to paties jobo (BullMQ atominis job reservation);
 *   - retry + backoff + dead-letter (failed) built-in į BullMQ.
 *
 * BullMQ reikalauja Redis. Be REDIS_URL sistema naudoja INLINE runner'į
 * (jobRunner.js) - dabartinį in-proceso elgesį (fallback, tinka dev/desktop).
 */
const QUEUE_NAMES = {
  TRANSCRIPTION: "stenograma:transcription",
  PROTOCOL: "stenograma:protocol",
};

// BullMQ job'ų nustatymai - retry, backoff, valymas.
const DEFAULT_JOB_OPTIONS = {
  attempts: parseInt(process.env.QUEUE_MAX_ATTEMPTS || "3", 10),
  backoff: {
    type: "exponential",
    delay: parseInt(process.env.QUEUE_BACKOFF_MS || "5000", 10),
  },
  // Baigti jobai išvalomi (būsena vis tiek atskirai saugoma jobStore).
  removeOnComplete: { age: parseInt(process.env.QUEUE_TTL_SECONDS || "3600", 10) },
  removeOnFail: { age: 24 * 3600 }, // failed laikomi ilgiau diagnostikai
};

// Worker'io nustatymai - STALLED job recovery (priėmimo kriterijus "worker
// restartavus nebaigtas jobas atnaujinamas"). Jei worker'is krenta vykdymo metu
// neatnaujinęs job lock'o per stalledInterval, BullMQ laiko jobą "stalled" ir
// grąžina jį į eilę (iki maxStalledCount kartų), tada kitas worker'is jį pakartoja.
// Nustatom EKSPLICITIŠKAI (ne pasikliaujam default), kad elgesys būtų aiškus.
const WORKER_OPTIONS = {
  concurrency: parseInt(process.env.WORKER_CONCURRENCY || "2", 10),
  stalledInterval: parseInt(process.env.QUEUE_STALLED_INTERVAL_MS || "30000", 10),
  maxStalledCount: parseInt(process.env.QUEUE_MAX_STALLED || "2", 10),
  // Lock'as turi būti ilgesnis nei ilgiausia transkripcija, kad ilgas (bet gyvas)
  // jobas nebūtų klaidingai laikomas stalled. Numatyta 10 min.
  lockDuration: parseInt(process.env.QUEUE_LOCK_DURATION_MS || "600000", 10),
};

/**
 * Sukuria BullMQ suderinamą ioredis prisijungimą. BullMQ reikalauja
 * maxRetriesPerRequest: null (kad blokuojantys komandos veiktų).
 */
function createQueueConnection() {
  const Redis = require("ioredis");
  const url = process.env.REDIS_URL;
  return new Redis(url, {
    maxRetriesPerRequest: null, // BullMQ reikalavimas
    enableReadyCheck: false,
  });
}

module.exports = { QUEUE_NAMES, DEFAULT_JOB_OPTIONS, WORKER_OPTIONS, createQueueConnection };
