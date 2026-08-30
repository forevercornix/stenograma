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
  TRANSCRIPTION: "stenograma-transcription",
  PROTOCOL: "stenograma-protocol",
};

// BullMQ job'ų nustatymai - retry, backoff, valymas.
//
// ⚠️ FABRIKAS, NE VIEN KONSTANTA (#155, 7.5a). `revivalHorizonsMs()` privalo
// mokėti skaičiuoti horizontus PAGAL PADUOTĄ `env`, kitaip testas negalėtų
// įrodyti, kad riba pasikeičia pakeitus konfigūraciją, ir liktų tik rankinis
// skaičių palyginimas. Eksportuojamos reikšmės nesikeičia.
function jobOptionsFor(env = process.env) {
  return {
    attempts: parseInt(env.QUEUE_MAX_ATTEMPTS || "3", 10),
    backoff: {
      type: "exponential",
      delay: parseInt(env.QUEUE_BACKOFF_MS || "5000", 10),
    },
    // Baigti jobai išvalomi (būsena vis tiek atskirai saugoma jobStore).
    removeOnComplete: { age: parseInt(env.QUEUE_TTL_SECONDS || "3600", 10) },
    removeOnFail: { age: 24 * 3600 }, // failed laikomi ilgiau diagnostikai
  };
}

const DEFAULT_JOB_OPTIONS = jobOptionsFor(process.env);

// Worker'io nustatymai - STALLED job recovery (priėmimo kriterijus "worker
// restartavus nebaigtas jobas atnaujinamas"). Jei worker'is krenta vykdymo metu
// neatnaujinęs job lock'o per stalledInterval, BullMQ laiko jobą "stalled" ir
// grąžina jį į eilę (iki maxStalledCount kartų), tada kitas worker'is jį pakartoja.
// Nustatom EKSPLICITIŠKAI (ne pasikliaujam default), kad elgesys būtų aiškus.
function workerOptionsFor(env = process.env) {
  return {
    concurrency: parseInt(env.WORKER_CONCURRENCY || "2", 10),
    stalledInterval: parseInt(env.QUEUE_STALLED_INTERVAL_MS || "30000", 10),
    maxStalledCount: parseInt(env.QUEUE_MAX_STALLED || "2", 10),
    // Lock'as turi būti ilgesnis nei ilgiausia transkripcija, kad ilgas (bet gyvas)
    // jobas nebūtų klaidingai laikomas stalled. Numatyta 10 min.
    lockDuration: parseInt(env.QUEUE_LOCK_DURATION_MS || "600000", 10),
  };
}

const WORKER_OPTIONS = workerOptionsFor(process.env);

/**
 * ⚠️ MAKSIMALI LEISTINA `delay` REIKŠMĖ (#155, 7.5a / #183).
 *
 * Ištrynimo žymos retencija skaičiuojama iš prikėlimo horizontų: žymos negalima
 * pašalinti anksčiau, nei nebegali pasirodyti vėluojantis darbas. Neribotas
 * per-job `delay` tą garantiją paverstų tuščia - job'as, įdėtas su
 * `delay: 30 dienų`, atkeliautų jau po to, kai žyma teisėtai pašalinta, ir
 * ištrintam ID vėl būtų sukurti artefaktai.
 *
 * Riba VYKDOMA `enqueue()` metu, ne dokumentuojama: dokumentuota riba nesustabdo
 * nė vieno producer'io. Šiandien `delay` neperduoda nė vienas kelias, tad riba
 * nieko nekainuoja - todėl ji įvedama dabar, o ne tada, kai kainuos.
 */
const MAX_JOB_DELAY_MS = 60 * 60 * 1000; // 1 val.

/** Sekundės → milisekundės. Egzistuoja, kad konversija turėtų vardą. */
const SEKUNDES_MS = 1000;

/**
 * ⚠️ ŠIUKŠLĖ META, O NE VIRSTA NULIU (#155, 7.5a).
 *
 * `parseInt("abc")` duoda `NaN`. Palaikius jį nuliu, `QUEUE_TTL_SECONDS=abc`
 * TYLIAI sutrumpintų prikėlimo horizontą, o kartu ir ištrynimo žymos retenciją:
 * žyma būtų pašalinta anksčiau, nei job'as nebegali būti prikeltas, ir niekas
 * to nepamatytų. Metimas paverčia tai `retentionMs()` fail-safe atveju - žymos
 * NEŠALINAMOS, kol konfigūracija nepataisyta.
 */
function teigiamas(reiksme, numatytas = 0) {
  if (reiksme === undefined || reiksme === null) return numatytas;

  const n = Number(reiksme);

  if (!Number.isFinite(n) || n < 0) {
    throw new TypeError(
      `Neapskaičiuojamas eilės horizonto dydis: ${reiksme}. Konfigūracija privalo būti ` +
        "taisoma; tylus nulis sutrumpintų ištrynimo žymų retenciją (#155, 7.5a)."
    );
  }

  return n;
}

/**
 * VISI EILĖS PRIKĖLIMO HORIZONTAI VIENOJE VIETOJE (#155, 7.5a / #183).
 *
 * ⚠️ VIENETAI NORMALIZUOJAMI PRIEŠ `Math.max`. BullMQ `removeOnComplete.age` ir
 * `removeOnFail.age` yra SEKUNDĖS, o `stalledInterval` ir `lockDuration` -
 * MILISEKUNDĖS. `Math.max()` ant neapdorotų reikšmių parinktų klaidingą
 * horizontą: 86400 (sekundžių) atrodytų mažiau nei 600000 (ms), ir riba
 * nukristų nuo paros iki dešimties minučių - tyliai, nes abu yra skaičiai.
 *
 * ⚠️ ŠIS HELPERIS YRA AUTORITETAS. Testai lygina SU JUO, o ne su rankiniu
 * horizontų sąrašu: kitaip naujas mechanizmas, pridėtas konfigūracijoje,
 * pakeistų tikrovę, o testas liktų žalias su senuoju maksimumu. Naujas
 * prikėlimo kelias privalo atsirasti ČIA.
 */
function revivalHorizonsMs(env = process.env) {
  const jobOptions = jobOptionsFor(env);
  const workerOptions = workerOptionsFor(env);

  /**
   * Eksponentinis backoff: `delay`, `2×delay`, ... per `attempts - 1`
   * pakartojimus. Paskutinis bandymas naujo laukimo nebeprideda.
   */
  const bandymai = Math.max(1, teigiamas(jobOptions.attempts, 1));
  const baze = teigiamas(jobOptions.backoff && jobOptions.backoff.delay, 0);
  let retry = 0;
  for (let i = 0; i < bandymai - 1; i += 1) retry += baze * 2 ** i;

  const horizontai = {
    /** Užbaigti job'ai lieka Redis'e - juos dar galima rankiniu būdu perpaleisti. */
    removeOnComplete:
      teigiamas(jobOptions.removeOnComplete && jobOptions.removeOnComplete.age) * SEKUNDES_MS,
    /** Nepavykę laikomi ilgiau diagnostikai; paprastai tai ir yra ribojantis dydis. */
    removeOnFail: teigiamas(jobOptions.removeOnFail && jobOptions.removeOnFail.age) * SEKUNDES_MS,
    /**
     * Stalled recovery: kiek ilgiausiai gali praeiti nuo lock'o praradimo iki
     * paskutinio pakartotinio priskyrimo.
     */
    stalled:
      teigiamas(workerOptions.stalledInterval) *
        Math.max(1, teigiamas(workerOptions.maxStalledCount, 1)) +
      teigiamas(workerOptions.lockDuration),
    retry,
    delayMax: MAX_JOB_DELAY_MS,
  };

  /**
   * ⚠️ DALIS MECHANIZMŲ SUMUOJASI, NE KONKURUOJA (#183 Codex, P1).
   *
   * `Math.max(...)` iš visų dedamųjų yra per mažas, nes VIENO job'o gyvenimo
   * linija juos sudeda: darbas laukia `delay`, tada eina per retry grandinę
   * (kiekvienas bandymas su savo backoff), tada dar guli terminalioje būsenoje
   * `removeOnFail`/`removeOnComplete` langą. Sukonfigūravus ilgą retry grandinę
   * ir trumpą terminalų langą, `max` grąžintų vieną dedamąją, o job'as
   * realiai gyventų jų sumą - žyma būtų išvalyta, kol BullMQ dar gali job'ą
   * prikelti, ir artefaktai materializuotųsi PO ištrynimo.
   *
   * Todėl sumuojama tai, kas eina nuosekliai, ir tik terminalus laikymas imamas
   * `max` (job'as baigiasi arba `completed`, arba `failed` - ne abiem).
   *
   * ⚠️ `stalled` PRISKIRIAMAS NUOSEKLIAJAI DALIAI SĄMONINGAI. Užstrigusio
   * job'o perėmimas vyksta grandinės viduje ir ją pailgina. Įvertinimas iš
   * viršaus čia yra saugioji pusė: per didelis horizontas žymą palaiko ILGIAU,
   * o per mažas leidžia jai dingti per anksti - būtent tai 7.5a ir draudžia.
   */
  const nuoseklus = horizontai.delayMax + horizontai.retry + horizontai.stalled;
  const terminalus = Math.max(horizontai.removeOnComplete, horizontai.removeOnFail);

  /**
   * ⚠️ LAUKAS `max` PAŠALINTAS SĄMONINGAI. Jo vardas po šio pakeitimo meluotų
   * (AGENTS.md §12.1), o tylus reikšmės pakeitimas paliktų kvietėjus, manančius
   * gaunant maksimumą. Pervadinus kiekvienas kvietėjas kertasi kompiliavimo
   * metu, ne tyliai.
   */
  return { ...horizontai, nuoseklus, terminalus, horizonMs: nuoseklus + terminalus };
}

/**
 * ⚠️ VIENINTELIS REGISTRUOTAS ĮDĖJIMO KELIAS (#155, 7.5a / #183).
 *
 * Producer'iai eina per šitą funkciją, kad `delay` riba būtų VYKDOMA, o ne
 * paliekama kiekvieno kvietėjo geranoriškumui. Tripwire testas tikrina, kad
 * `queue.add(` už šios vietos ribų neatsirastų.
 */
async function enqueue(queue, name, data, opts = {}) {
  const { delay } = opts;

  if (delay !== undefined && delay !== null) {
    const reiksme = Number(delay);

    if (!Number.isFinite(reiksme) || reiksme < 0) {
      throw new TypeError(`Neteisinga \`delay\` reikšmė: ${delay}.`);
    }

    if (reiksme > MAX_JOB_DELAY_MS) {
      throw new RangeError(
        `\`delay\` ${reiksme} ms viršija leistiną ${MAX_JOB_DELAY_MS} ms. ` +
          "Ilgesnis atidėjimas apeitų ištrynimo žymų retenciją: darbas atkeliautų " +
          "po to, kai žyma teisėtai pašalinta (#155, 7.5a)."
      );
    }
  }

  return queue.add(name, data, opts);
}

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

module.exports = {
  QUEUE_NAMES,
  DEFAULT_JOB_OPTIONS,
  WORKER_OPTIONS,
  createQueueConnection,
  jobOptionsFor,
  workerOptionsFor,
  revivalHorizonsMs,
  enqueue,
  MAX_JOB_DELAY_MS,
};
