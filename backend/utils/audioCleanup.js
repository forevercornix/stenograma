const fileStorage = require("./fileStorage");
const jobStore = require("./jobStore");
const { createLogger } = require("../utils/logger");
const log = createLogger("audio-cleanup");

/**
 * Audio ištrynimas po GALUTINIO jobo statuso - bendras inline runner'iui
 * (queues/jobRunner.js) ir BullMQ worker'iams (workers/index.js).
 *
 * KRITIŠKA TVARKA (rasta code review): `storageKey` jobStore įraše nulinamas
 * TIK po sėkmingo `fileStorage.del()`. Anksčiau abu žingsniai buvo su atskirais
 * `.catch(() => {})`, tad nepavykus trynimui failas likdavo storage, o raktas
 * vis tiek dingdavo iš jobStore - vėlesnis GDPR DELETE jo nebesurasdavo ir
 * audio taptų našlaite. Tai tiesiogiai paneigdavo garantiją, kad raktas
 * laikomas tol, kol failas tikrai ištrintas.
 *
 * Klaida NEMETAMA (valymas neturi versti jobo į FAILED, kai darbas jau atliktas),
 * bet ji ir nenutylima: rašoma į serverio logą, o raktas lieka vietoje, kad
 * ištrynimą būtų galima pakartoti.
 *
 * @returns {boolean} ar audio realiai pašalintas
 */
async function releaseAudio(jobId, storageKey) {
  if (!storageKey) return false;

  try {
    await fileStorage.del(storageKey);
  } catch (e) {
    log.error(
      `Nepavyko ištrinti audio iš storage (job ${jobId}): ${e.message}. ` +
        "storageKey PALIEKAMAS jobStore įraše, jobas pažymimas pakartojimui."
    );

    // BŪTINA: vien rakto palikimo neužtenka. Be vėliavos nebaigto valymo niekas
    // nepamato - deletionRetry ieško tik pažymėtų jobų, klientas DELETE gali
    // niekada nekviesti, o po JOB_TTL_MINUTES jobStore įrašas išnyktų kartu su
    // vieninteliu žinomu storageKey (BullMQ jobas iki tol gali būti pašalintas).
    // Tada audio failas liktų diske be jokios nuorodos į jį.
    //
    // Vėliava SĄMONINGAI atskira nuo `deletion_pending`: pastaroji reiškia
    // vartotojo prašytą VISO jobo ištrynimą, o čia transkripcijos rezultatas
    // turi likti prieinamas - trinamas tik nebereikalingas audio.
    if (jobId) {
      try {
        await jobStore.update(jobId, {
          audio_cleanup_pending: true,
          audio_cleanup_reason: "audio_cleanup_failed",
          storageKey,
        });
      } catch (updateError) {
        log.error(
          `Nepavyko pažymėti jobo ${jobId} pakartotiniam audio valymui: ${updateError.message}`
        );
      }
    }

    return false;
  }

  try {
    if (jobId) {
      await jobStore.update(jobId, {
        storageKey: null,
        audio_cleanup_pending: false,
      });
    }
  } catch (e) {
    // Failas jau ištrintas - tai saugi pusė. Likęs raktas tik reikš, kad GDPR
    // ištrynimas bandys trinti nesantį objektą (idempotentiška operacija).
    log.error(
      `Audio ištrintas, bet nepavyko atnaujinti jobo ${jobId} storageKey: ${e.message}`
    );
  }

  return true;
}

module.exports = { releaseAudio };
