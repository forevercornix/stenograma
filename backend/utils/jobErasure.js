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

  // LEGACY: prieš `job.type` įvedimą sukurti (ypač Redis'e išlikę) jobai šio
  // lauko neturi. Aklai priskirti "transcription" NEGALIMA - protokolo jobas
  // tada būtų valomas iš ne tos eilės. Todėl nežinomo tipo atveju valom ABI
  // eiles: BullMQ jobo ID sutampa su mūsų UUID, tad `getJob` ne toje eilėje
  // tiesiog grąžina null (no-op), o teisingoji eilė išsivalo.
  const type =
    job.type === jobStore.JOB_TYPES.PROTOCOL
      ? "protocol"
      : job.type === jobStore.JOB_TYPES.TRANSCRIPTION
        ? "transcription"
        : "legacy";

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
    const removers = [];
    if (type !== "protocol") {
      removers.push(require("../queues/transcriptionQueue").removeTranscriptionJob);
    }
    if (type !== "transcription") {
      removers.push(require("../queues/protocolQueue").removeProtocolJob);
    }

    for (const remove of removers) {
      try {
        const data = await remove(jobId);
        if (data !== null) {
          queueData = data;
          outcome.queueJobRemoved = true;
        }
      } catch (e) {
        outcome.errors.push(`queue: ${e.message}`);
        outcome.criticalFailure = true;
      }
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

  // 3) Audito įrašai. KRITINIAI: pseudonimizuoti duomenys pagal BDAR vis tiek
  //    yra asmens duomenys, tad "204 - ištrinta" būtų netiesa, jei audito įrašai
  //    liktų. Nepavykus - jobStore įrašas paliekamas, kad DELETE būtų pakartojamas
  //    (visi žingsniai idempotentiški).
  try {
    outcome.auditEntriesRemoved = await auditLog.removeBySubjectIdentifier(jobId);
  } catch (e) {
    outcome.errors.push(`audit: ${e.message}`);
    outcome.criticalFailure = true;
  }

  // 4) jobStore - TIK jei kritiniai šaltiniai išvalyti. Kitaip paliekam įrašą,
  //    kad operaciją būtų galima pakartoti su tuo pačiu ID.
  if (outcome.criticalFailure) {
    try {
      await jobStore.update(jobId, { deletion_pending: true, storageKey });
    } catch (e) {
      // Klientas ir taip gaus 503, bet garantijos, kad vėliava išsaugota, nėra -
      // tad bent jau nenutylim (anksčiau čia buvo tuščias .catch()).
      outcome.errors.push(`deletion_pending: ${e.message}`);
    }
    return outcome;
  }

  try {
    outcome.jobRemoved = Boolean(await jobStore.remove(jobId));
  } catch (e) {
    outcome.errors.push(`jobStore: ${e.message}`);
    outcome.criticalFailure = true;
  }

  writeDeletionReceipt(outcome);

  return outcome;
}

/**
 * IŠTRYNIMO KVITAS (deletion receipt).
 *
 * Pašalinus audito įrašus nelieka jokio pėdsako, kad ištrynimas apskritai buvo
 * atliktas - o atskaitomybei to reikia. Todėl rašomas atskiras įvykis BE jokios
 * sąsajos su subjektu: `subjectId` yra `null`, job ID nesaugomas jokia forma.
 * Dėl to jo nepašalina ir pakartotinis to paties jobo ištrynimas.
 *
 * APRIBOJIMAS: kvitas guli tame pačiame atmintiniame audito žurnale, tad
 * galioja tos pačios retencijos ir restarto ribos (žr. README).
 */
function writeDeletionReceipt(outcome) {
  if (outcome.criticalFailure) return;

  // Kvitas rašomas TIK jei kažkas realiai pašalinta. Anksčiau sąlyga buvo vien
  // `!criticalFailure`, tad `DELETE /api/.../neegzistuojantis-id` sukurdavo
  // klaidingą DATA_ERASED įrašą - o kadangi kvitai neturi subjectId, jų srautas
  // galėjo per AUDIT_MAX_ENTRIES išstumti tikrus audito įrašus. Tas pats galioja
  // lenktynių atvejui, kai `jobStore.remove()` grąžina false.
  const anythingRemoved =
    outcome.jobRemoved ||
    outcome.queueJobRemoved ||
    outcome.storageRemoved ||
    outcome.auditEntriesRemoved > 0;

  if (!anythingRemoved) return;

  try {
    auditLog.record({
      event: "DATA_ERASED",
      success: true,
      details:
        `type=${outcome.type} queue=${outcome.queueJobRemoved ? "deleted" : "none"} ` +
        `storage=${outcome.storageRemoved ? "deleted" : "none"} ` +
        `jobStore=${outcome.jobRemoved ? "deleted" : "none"} ` +
        `audit=${outcome.auditEntriesRemoved}`,
    });
  } catch {
    // Kvitas neturi versti ištrynimo nesėkme - duomenys jau pašalinti.
  }
}

/**
 * Ištrynimas, kai jobStore įrašo JAU NEBĖRA.
 *
 * Retencijos laikai nesutampa: jobStore TTL numatytai 60 min (JOB_TTL_MINUTES),
 * BullMQ `removeOnFail` - 24 val., auditas - 30 dienų. Tad nepavykęs jobas po
 * valandos dingsta iš jobStore, o jo payload, rezultatas ir audito įrašai dar
 * egzistuoja. Anksčiau DELETE tokiu atveju iš karto grąžindavo 404 ir NIEKO
 * nebeištrindavo - teisė ištrinti tapdavo neįgyvendinama, nors duomenys buvo.
 *
 * Todėl, nesant jobStore įrašo, ieškom tiesiogiai ABIEJOSE eilėse ir audite.
 * Tipas nežinomas (jo šaltinis buvo jobStore), tad valom abi - BullMQ ID sutampa
 * su mūsų UUID, tad ne toje eilėje operacija yra no-op.
 *
 * @returns {object} outcome; `found` - ar kur nors iš viso kas nors rasta
 */
async function eraseOrphanedJobData(jobId) {
  const outcome = await eraseJob({ id: jobId, type: null, storageKey: null });

  outcome.orphan = true;
  outcome.found =
    outcome.queueJobRemoved || outcome.storageRemoved || outcome.auditEntriesRemoved > 0;

  // jobStore įrašo nebuvo - tai ne klaida, o šio kelio prielaida.
  outcome.jobRemoved = false;

  return outcome;
}

module.exports = { eraseJob, eraseOrphanedJobData };
