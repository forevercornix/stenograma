const jobStore = require("./jobStore");
const auditLog = require("./auditLog");
const fileStorage = require("./fileStorage");
const jobRunner = require("../queues/jobRunner");

/**
 * GDPR "teisė būti pamirštam" - VIENA vieta, kuri išvalo VISUS pėdsakus.
 *
 * Duomenys gyvena keturiose vietose:
 *
 *   1) BullMQ eilėje. queues/config.js: removeOnComplete { age: 3600 },
 *      removeOnFail { age: 24h } - t. y. job.data (storageKey, meetingId) IR
 *      grąžintas rezultatas (TRANSKRIPCIJA / PROTOKOLAS) lieka Redis'e po
 *      užbaigimo.
 *   2) Bendrame audio storage.
 *   3) jobStore įraše (metaduomenys + rezultatas).
 *   4) Audito žurnale (pagal pseudonimizuotą subjectId).
 *
 * TVARKA YRA ESMINĖ. jobStore įrašas šalinamas PASKUTINIS ir TIK tada, kai
 * išoriniai (kritiniai) šaltiniai jau išvalyti. Priešingu atveju nepavykus
 * BullMQ ar storage valymui prarastume vienintelį raktą, per kurį operaciją
 * galima pakartoti: klientas gautų 204, pakartotinis DELETE - 404, o jautrus
 * failas liktų našlaite.
 *
 * Tipas imamas IŠ PATIES JOBO (job.type), ne iš URL. Abu async endpoint'ai
 * naudoja tą patį jobStore, tad pasitikint URL'u protokolo jobo ID, pateiktas
 * transkripcijos endpoint'ui, būtų ieškomas ne toje eilėje.
 *
 * @param {object} job - jobStore įrašas (ne tik id)
 * @returns {object} outcome su `criticalFailure` vėliava
 */
async function eraseJob(job) {
  const jobId = job.id;
  const type = job.type === jobStore.JOB_TYPES.PROTOCOL ? "protocol" : "transcription";

  const outcome = {
    jobId,
    type,
    jobRemoved: false,
    queueJobRemoved: false,
    storageRemoved: false,
    auditEntriesRemoved: 0,
    errors: [],
    criticalFailure: false,
  };

  // 1) Eilė - PIRMA, nes iš job.data gauname storageKey (BullMQ režime).
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
      outcome.criticalFailure = true;
    }
  }

  // 2) Audio storage. Raktas imamas iš BullMQ payload'o ARBA iš paties jobo -
  //    inline režime eilės nėra, tad jobStore.storageKey yra vienintelis šaltinis.
  //    Įprastu atveju jis jau `null` (išvalytas po galutinio statuso).
  const storageKey =
    (queueData && queueData.payload && queueData.payload.storageKey) || job.storageKey || null;

  if (storageKey) {
    try {
      await fileStorage.del(storageKey);
      outcome.storageRemoved = true;
    } catch (e) {
      outcome.errors.push(`storage: ${e.message}`);
      outcome.criticalFailure = true;
    }
  }

  // 3) Audito įrašai. Ne kritiniai ištrynimo tęstinumui (jie nesaugo turinio,
  //    tik pseudonimizuotus metaduomenis), bet klaidą raportuojam.
  try {
    outcome.auditEntriesRemoved = await auditLog.removeBySubjectIdentifier(jobId);
  } catch (e) {
    outcome.errors.push(`audit: ${e.message}`);
  }

  // 4) jobStore - TIK jei kritiniai šaltiniai išvalyti. Kitaip paliekam įrašą,
  //    kad operaciją būtų galima pakartoti su tuo pačiu ID.
  if (outcome.criticalFailure) {
    await jobStore
      .update(jobId, { deletion_pending: true, storageKey })
      .catch(() => {});
    return outcome;
  }

  try {
    outcome.jobRemoved = Boolean(await jobStore.remove(jobId));
  } catch (e) {
    outcome.errors.push(`jobStore: ${e.message}`);
    outcome.criticalFailure = true;
  }

  return outcome;
}

module.exports = { eraseJob };
