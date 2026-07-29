const jobStore = require("./jobStore");
const auditLog = require("./auditLog");
const fileStorage = require("./fileStorage");
const jobRunner = require("../queues/jobRunner");

/**
 * GDPR "teisė būti pamirštam" - VIENA vieta, kuri išvalo VISUS pėdsakus.
 *
 * Anksčiau DELETE /api/transcribe-jobs/:id trynė tik jobStore įrašą, o duomenys
 * likdavo dar trijose vietose:
 *
 *   1) BullMQ eilėje. queues/config.js: removeOnComplete { age: 3600 },
 *      removeOnFail { age: 24h } - t. y. job.data (storageKey, meetingId) IR
 *      grąžintas rezultatas (TRANSKRIPCIJA / PROTOKOLAS) lieka Redis'e po
 *      užbaigimo. Ištrynimas be to buvo nepilnas.
 *   2) Bendrame audio storage - jei jobas nutrūko taip, kad įprastas valymas
 *      (jobRunner/_runInline finally, workers/_cleanupStorage) nesuveikė.
 *   3) Audito žurnale - pagal pseudonimizuotą subjectId.
 *
 * Funkcija idempotentiška: pakartotinis kvietimas grąžina nulius, o ne klaidą.
 * Nė vienas žingsnis nenutraukia kitų - dalinis pašalinimas geriau nei jokio,
 * o rezultatas grąžinamas iškviečiančiam (kad būtų galima nulogginti/atsakyti).
 *
 * @param {string} jobId
 * @param {"transcription"|"protocol"} type
 */
async function eraseJob(jobId, type = "transcription") {
  const outcome = {
    jobRemoved: false,
    queueJobRemoved: false,
    storageRemoved: false,
    auditEntriesRemoved: 0,
    errors: [],
  };

  // 1) Eilė - PIRMA, nes iš job.data gauname storageKey (jobStore jo nesaugo).
  let queueData = null;
  if (jobRunner.getMode() === "bullmq") {
    try {
      const remove =
        type === "protocol"
          ? require("../queues/protocolQueue").removeProtocolJob
          : require("../queues/transcriptionQueue").removeTranscriptionJob;

      queueData = await remove(jobId);
      outcome.queueJobRemoved = queueData !== null;
    } catch (e) {
      outcome.errors.push(`queue: ${e.message}`);
    }
  }

  // 2) Audio storage. Įprastu atveju failas jau ištrintas po galutinio statuso -
  //    tada del() tiesiog nieko neranda.
  const storageKey = queueData && queueData.payload && queueData.payload.storageKey;
  if (storageKey) {
    try {
      await fileStorage.del(storageKey);
      outcome.storageRemoved = true;
    } catch (e) {
      outcome.errors.push(`storage: ${e.message}`);
    }
  }

  // 3) Jobo įrašas (metaduomenys + rezultatas).
  try {
    outcome.jobRemoved = Boolean(await jobStore.remove(jobId));
  } catch (e) {
    outcome.errors.push(`jobStore: ${e.message}`);
  }

  // 4) Audito įrašai pagal pseudonimizuotą subjectId.
  try {
    outcome.auditEntriesRemoved = auditLog.removeBySubjectIdentifier(jobId);
  } catch (e) {
    outcome.errors.push(`audit: ${e.message}`);
  }

  return outcome;
}

module.exports = { eraseJob };
