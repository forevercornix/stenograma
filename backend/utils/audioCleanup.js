const fileStorage = require("./fileStorage");
const jobStore = require("./jobStore");

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
    console.error(
      `[stenograma] Nepavyko ištrinti audio iš storage (job ${jobId}): ${e.message}. ` +
        "storageKey PALIEKAMAS jobStore įraše, kad ištrynimą būtų galima pakartoti."
    );
    return false;
  }

  try {
    if (jobId) await jobStore.update(jobId, { storageKey: null });
  } catch (e) {
    // Failas jau ištrintas - tai saugi pusė. Likęs raktas tik reikš, kad GDPR
    // ištrynimas bandys trinti nesantį objektą (idempotentiška operacija).
    console.error(
      `[stenograma] Audio ištrintas, bet nepavyko atnaujinti jobo ${jobId} storageKey: ${e.message}`
    );
  }

  return true;
}

module.exports = { releaseAudio };
