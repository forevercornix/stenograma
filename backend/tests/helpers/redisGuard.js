/**
 * REDIS TESTŲ SĄLYGA (#15).
 *
 * Iki šiol kiekvienas integracinis testas pats tikrino `process.env.REDIS_URL`
 * ir tyliai praleisdavo save. Vietinei aplinkai tai teisinga - reikalauti Redis
 * kiekvienam `npm test` būtų nepatogu be jokios naudos.
 *
 * Bet CI'ui tas pats elgesys yra spraga: jei `REDIS_URL` kada nors dingtų (env
 * pervadinimas, servisas nepakilo, workflow refaktoringas), testai praleistų
 * save, o job'as liktų ŽALIAS. Rezultatas - „Redis testai vykdomi" būtų tiesa
 * tik konfigūracijoje, ne tikrovėje.
 *
 * `REQUIRE_REDIS=1` paverčia praleidimą KLAIDA. CI jį nustato kartu su
 * `REDIS_URL`, tad prarasti galima tik abu vienu metu - o tai jau matomas
 * pakeitimas, ne atsitiktinumas.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ⚠️ RAŠANT NAUJĄ REDIS TESTĄ: EILĖS IR ENV YRA BENDRI (#153 pamoka)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Visi šio rinkinio testai dalijasi VIENU Redis. Tai reiškia du spąstus:
 *
 * 1. BENDROS EILĖS. Worker'is, paleistas ant `QUEUE_NAMES.PROTOCOL`, pasiima
 *    BET KURĮ toje eilėje esantį job'ą – ir kitų testų. #153 metu testas su
 *    sumažinta `MAX_RESULT_BYTES` riba pasiėmė `stalled recovery` testo job'ą
 *    ir numarino jį su `RESULT_TOO_LARGE`. Krito SVETIMAS testas, o priežastis
 *    buvo visai kitame faile.
 *
 *    → Naudokite UNIKALŲ eilės pavadinimą:
 *        const queueName = `test-<sritis>-${process.pid}-${Date.now()}`;
 *      ir dėkite job'ą tiesiai per savo `Queue`, ne per `jobRunner.enqueue*`.
 *
 * 2. GLOBALŪS `process.env` POKYČIAI. Ribos, vėliavos ir režimai, nustatyti
 *    per `process.env`, veikia visą procesą. Jei testas keičia elgesį,
 *    geriau parinkti ĮVESTĮ, kuri viršija numatytąją reikšmę, nei mažinti
 *    ribą globaliai.
 *
 * ⚠️ ABU spąstai NEMATOMI paleidžiant testą PO VIENĄ. #153 lokaliai praėjo,
 * o CI krito – nes CI paleidžia visą rinkinį. Prieš push'ą paleiskite:
 *
 *     REDIS_URL=... npm run test:redis
 *
 * ne atskirą failą.
 */

const REDIS_URL = process.env.REDIS_URL;
const REQUIRED = process.env.REQUIRE_REDIS === "1";

if (REQUIRED && !REDIS_URL) {
  throw new Error(
    "REQUIRE_REDIS=1 nustatytas, bet REDIS_URL nėra. Integraciniai testai būtų " +
      "praleisti tyliai, o CI liktų žalias jų nepaleidęs. Nustatykite REDIS_URL " +
      "arba nuimkite REQUIRE_REDIS."
  );
}

/**
 * @returns {false | string} `false` - vykdyti; eilutė - praleidimo priežastis.
 */
function skipWithoutRedis() {
  return REDIS_URL ? false : "reikia REDIS_URL su tikru Redis (CI: REQUIRE_REDIS=1)";
}

module.exports = { REDIS_URL, REQUIRED, skipWithoutRedis, hasRedis: !!REDIS_URL };
