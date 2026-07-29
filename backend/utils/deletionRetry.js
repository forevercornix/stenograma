const jobStore = require("./jobStore");

/**
 * Nebaigtų ištrynimų pakartojimas.
 *
 * `eraseJob()` nepavykus kritiniam žingsniui palieka jobą su `deletion_pending`,
 * o klientas gauna 503. Bet jei klientas užklausos nebepakartoja, duomenys
 * liktų neribotai - ištrynimo prašymas faktiškai dingtų. Todėl periodinis
 * procesas pats bando iš naujo.
 *
 * APRIBOJIMAS (sąžiningai): tai paprastas periodinis pakartojimas, ne
 * garantuota dead-letter sistema. Vėliava gyvena `jobStore`, tad in-memory
 * režime po restarto ji dingsta kartu su jobu; Redis režime - išlieka. Tikram
 * SLA reikėtų atskiros ištrynimo užduočių eilės (Milestone 2).
 */

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS_BEFORE_ALERT = 3;

async function retryPendingDeletions({ limit = 50 } = {}) {
  const { eraseJob } = require("./jobErasure");

  const pending = await jobStore.listPendingDeletions(limit);
  const summary = { attempted: pending.length, succeeded: 0, failed: 0 };

  for (const job of pending) {
    const attempts = (job.deletion_attempts || 0) + 1;
    const outcome = await eraseJob(job);

    if (!outcome.criticalFailure) {
      summary.succeeded += 1;
      console.log(
        `[stenograma] Nebaigtas jobo ${job.id} ištrynimas pakartotas sėkmingai (bandymas ${attempts}).`
      );
      continue;
    }

    summary.failed += 1;

    await jobStore
      .update(job.id, { deletion_pending: true, deletion_attempts: attempts })
      .catch(() => {});

    const message =
      `[stenograma] Jobo ${job.id} ištrynimas vis dar nepavyksta ` +
      `(bandymas ${attempts}): ${outcome.errors.join("; ")}`;

    if (attempts >= MAX_ATTEMPTS_BEFORE_ALERT) {
      // Aiškiai atskiriam nuo įprastos klaidos - tai jau reikalauja žmogaus.
      console.error(
        `${message}. ⚠️  REIKIA RANKINIO ĮSIKIŠIMO: jautrūs duomenys tebėra saugomi.`
      );
    } else {
      console.warn(message);
    }
  }

  return summary;
}

/**
 * TECHNINIS audio valymo pakartojimas - ATSKIRAS nuo viso jobo ištrynimo.
 *
 * Kai `releaseAudio()` nepavyksta po sėkmingos transkripcijos, jobas pažymimas
 * `audio_cleanup_pending`. Čia trinamas TIK audio failas; jobo rezultatas
 * (transkripcija) lieka prieinamas - vartotojas jo dar gali neatsiėmęs.
 * Naudoti tą pačią `deletion_pending` semantiką būtų klaida: ji ištrintų
 * visą jobą, nors vartotojas to neprašė.
 */
async function retryPendingAudioCleanups({ limit = 50 } = {}) {
  const { releaseAudio } = require("./audioCleanup");

  const pending = await jobStore.listPendingAudioCleanups(limit);
  const summary = { attempted: pending.length, succeeded: 0, failed: 0 };

  for (const job of pending) {
    const attempts = (job.audio_cleanup_attempts || 0) + 1;

    if (!job.storageKey) {
      // Nėra ką trinti - vėliava pasenusi (pvz. raktas jau išvalytas kitu keliu).
      await jobStore
        .update(job.id, { audio_cleanup_pending: false })
        .catch(() => {});
      continue;
    }

    const removed = await releaseAudio(job.id, job.storageKey);

    if (removed) {
      summary.succeeded += 1;
      console.log(
        `[stenograma] Likęs jobo ${job.id} audio pašalintas pakartotinai (bandymas ${attempts}).`
      );
      continue;
    }

    summary.failed += 1;

    // releaseAudio jau iš naujo nustatė vėliavą; čia tik didinam skaitiklį.
    await jobStore
      .update(job.id, { audio_cleanup_attempts: attempts })
      .catch(() => {});

    const message =
      `[stenograma] Jobo ${job.id} audio vis dar nepavyksta ištrinti (bandymas ${attempts}).`;

    if (attempts >= MAX_ATTEMPTS_BEFORE_ALERT) {
      console.error(
        `${message} ⚠️  REIKIA RANKINIO ĮSIKIŠIMO: audio failas tebėra storage.`
      );
    } else {
      console.warn(message);
    }
  }

  return summary;
}

/**
 * Paleidžia periodinį pakartojimą. Grąžina timer'į (jau `unref()`-intą, kad
 * neblokuotų proceso pabaigos).
 */
function startDeletionRetry({ intervalMs } = {}) {
  const interval = Number(process.env.DELETION_RETRY_INTERVAL_MINUTES)
    ? Number(process.env.DELETION_RETRY_INTERVAL_MINUTES) * 60 * 1000
    : intervalMs || DEFAULT_INTERVAL_MS;

  const timer = setInterval(() => {
    retryPendingDeletions().catch((e) =>
      console.error(`[stenograma] Ištrynimų pakartojimas nepavyko: ${e.message}`)
    );
    retryPendingAudioCleanups().catch((e) =>
      console.error(`[stenograma] Audio valymo pakartojimas nepavyko: ${e.message}`)
    );
  }, interval);

  timer.unref();
  return timer;
}

module.exports = {
  retryPendingDeletions,
  retryPendingAudioCleanups,
  startDeletionRetry,
  MAX_ATTEMPTS_BEFORE_ALERT,
};
