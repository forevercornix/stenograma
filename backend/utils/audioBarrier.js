const jobStore = require("./jobStore");
const { createLogger } = require("./logger");

const log = createLogger("audio-barrier");

/**
 * ŠALTINIO AUDIO ŠALINIMO BARJERAS — VIENAS AUTORITETAS ABIEM VYKDYMO KELIAMS
 * (#184, 7.5b; Codex peržiūros A grupė).
 *
 * ⚠️ KODĖL ATSKIRAS MODULIS, O NE FUNKCIJA `workers/index.js` VIDUJE.
 *
 * Pirmoji 7.5b redakcija barjerą įdėjo į `workers/_cleanupStorage()`, ir tai
 * uždarė WORKER kelią. Bet `inline` kelias (`queues/jobRunner.js`) turi SAVO
 * valymo funkciją (`_atlaisvintiSaltini`) ir savo `finally` bloką — jis liko
 * visiškai be barjero. Perkelti predikato į `workers/index.js` nepavyktų:
 * `workers` jau importuoja `jobRunner`, tad atvirkštinė nuoroda sukurtų ciklą.
 *
 * ⚠️ KODĖL NE `releaseAudio()` VIDUJE.
 *
 * Tai atrodo kaip dar siauresnis taškas, bet ten barjeras būtų NETEISINGAS:
 * `utils/deletionRetry.js:288` kviečia `releaseAudio()` GDPR ištrynimo kelyje,
 * kur audio privalo dingti nepriklausomai nuo job'o būsenos. Barjeras ten
 * blokuotų būtent tą veiksmą, kurio įstatymas reikalauja.
 *
 * Todėl siauriausias TEISINGAS taškas yra gyvavimo ciklo valymas — abu jo
 * kvietėjai eina per šį modulį.
 */

/** Ką retry turi daryti radęs autoritetingą būseną. */
const RETRY_VEIKSMAS = Object.freeze({
  /** Įrašo nėra arba jis dar ne terminalus — įprastas vykdymas. */
  VYKDYTI: "VYKDYTI",
  /** `completed` + galiojantis rezultatas — grąžinamas jis, darbas nekartojamas. */
  IDEMPOTENTISKA_SEKME: "IDEMPOTENTISKA_SEKME",
  /** `completed` BE rezultato — ne sėkmė; audio LIEKA. */
  REMONTUOTINA: "REMONTUOTINA",
});

/**
 * RETRY ĮĖJIMO SPRENDIMAS — GRYNA FUNKCIJA.
 *
 * ⚠️ GRYNA, KAD MUTACIJA BŪTŲ TIKRINAMA BE TIKRO BullMQ. Kol sprendimas gyveno
 * processor'iaus viduje, jo mutacija reikalavo tikros eilės — vietinėje
 * aplinkoje NIEKADA. Nepatikrinamas lieka tik laidų sujungimas.
 *
 * @param {object|null} job autoritetinga persistentinė būsena
 */
function sprendimasPriesRestart(job) {
  if (!job || job.status !== jobStore.STATUS.COMPLETED) return RETRY_VEIKSMAS.VYKDYTI;

  /**
   * ⚠️ `null` IR `undefined` — TA PATI BŪSENA. `undefined` reikštų, kad laukas
   * nehidratuotas, `null` — kad rezultato nėra; abiem atvejais perskaityti nėra
   * ko, ir audio yra vienintelė medžiaga remontui.
   */
  if (job.result === undefined || job.result === null) return RETRY_VEIKSMAS.REMONTUOTINA;

  return RETRY_VEIKSMAS.IDEMPOTENTISKA_SEKME;
}

/**
 * AUDIO ŠALINIMO PREDIKATAS.
 *
 * ⚠️ IŠVEDAMAS IŠ `sprendimasPriesRestart()`, NE RAŠOMAS ANTRĄ KARTĄ. Abu
 * klausimai remiasi ta pačia riba, o dviejų realizacijų išsiskyrimo kaina čia
 * yra negrįžtamai prarasti duomenys.
 *
 * ⚠️ SĄLYGA SIAURA. Blokuojama TIK `completed` be rezultato. Įprastas `failed`,
 * `cancelled` ir nerastas įrašas (TTL, ištrynimas) elgesio nekeičia — priešingu
 * atveju audio failai kauptųsi neribotai, nes retencija jų neliečia, kol raktą
 * nurodo gyvas job'o įrašas.
 */
function arGalimaSalintiAudio(job) {
  return sprendimasPriesRestart(job) !== RETRY_VEIKSMAS.REMONTUOTINA;
}

/**
 * Gyvavimo ciklo audio valymas su barjeru. VIENINTELIS kelias, kuriuo `inline`
 * ir `worker` vykdymai šalina šaltinio audio po galutinio statuso.
 *
 * ⚠️ AUTORITETINGA BŪSENA, NE KVIETĖJO SPĖJIMAS. Kvietėjas gali turėti pasenusį
 * snapshot'ą arba jo neturėti visai (`_handleFailure` mato tik klaidą), tad
 * sprendimas priimamas iš saugyklos.
 *
 * @returns {Promise<boolean>} `true`, jei valymas buvo LEISTAS (nebūtinai pavykęs)
 */
async function salintiAudioSuBarjeru(jobId, payload, kontekstas = {}) {
  if (!payload || !payload.storageKey) return false;

  /**
   * ⚠️ PAIEŠKOS GEDIMAS NEGALI TYLIAI NUTRAUKTI VALYMO GRANDINĖS (Codex D2).
   *
   * Barjeras įvedė naują gedimo tašką PRIEŠ `releaseAudio()`. O būtent
   * `releaseAudio()` nepavykus uždeda `audio_cleanup_pending` vėliavą, ir
   * `retryPendingAudioCleanups()` ieško TIK jos. Vadinasi trumpalaikis saugyklos
   * trikdis čia paliktų audio be jokio vėlesnio kvietėjo — nei ištrintą, nei
   * pažymėtą pakartojimui.
   *
   * Elgesys fail-closed IR fail-visible: netrinam (nes negalim įrodyti, kad
   * galima), bet pažymim, kad valymas dar skolingas. Žymėjimas irgi
   * best-effort — jei ir jis krenta, lieka `error` eilutė, o ne tyla.
   */
  let autoritetingas;
  try {
    autoritetingas = await jobStore.system.get(jobId);
  } catch (klaida) {
    log.error("Barjero paieška krito - audio NEŠALINAMAS, žymimas pakartojimui", {
      stage: "cleanup_lookup_failed",
      jobId,
      klaida: klaida && klaida.message,
      ...kontekstas,
    });
    await jobStore.system
      .update(jobId, { audio_cleanup_pending: true })
      .catch((zymejimoKlaida) =>
        log.error("Nepavyko pažymėti audio valymo pakartojimo", {
          stage: "cleanup_flag_failed",
          jobId,
          klaida: zymejimoKlaida && zymejimoKlaida.message,
        })
      );
    return false;
  }

  if (!arGalimaSalintiAudio(autoritetingas)) {
    log.error("Audio NEŠALINAMAS: `completed` be rezultato yra remontuotina būsena", {
      stage: "cleanup_blocked",
      jobId,
      ...kontekstas,
    });
    return false;
  }

  const { releaseAudio } = require("./audioCleanup");
  await releaseAudio(jobId, payload.storageKey);
  return true;
}

module.exports = {
  RETRY_VEIKSMAS,
  sprendimasPriesRestart,
  arGalimaSalintiAudio,
  salintiAudioSuBarjeru,
};
