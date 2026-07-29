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
const MAX_BACKOFF_MULTIPLIER = 32; // 10 min bazei -> ne daugiau kaip ~5 val.

/**
 * Eksponentinis backoff: 1x, 2x, 4x, 8x... bazinio intervalo, su riba.
 * Be jo nuolat krentantis storage būtų kalamas kas 10 min be galo, o logai
 * užsipildytų tuo pačiu įspėjimu.
 */
function _backoffMs(attempts, baseMs) {
  const multiplier = Math.min(2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MULTIPLIER);
  return baseMs * multiplier;
}

function _baseIntervalMs() {
  const configured = Number(process.env.DELETION_RETRY_INTERVAL_MINUTES);
  return Number.isFinite(configured) && configured > 0
    ? configured * 60 * 1000
    : DEFAULT_INTERVAL_MS;
}

/**
 * Ar bandymo laikas jau atėjo? `field` - ISO laiko žyma jobo įraše.
 */
function _isDue(job, field, now = Date.now()) {
  const next = job[field] ? Date.parse(job[field]) : NaN;
  return !Number.isFinite(next) || next <= now;
}

function _nextAttemptAt(attempts) {
  return new Date(Date.now() + _backoffMs(attempts, _baseIntervalMs())).toISOString();
}

async function retryPendingDeletions({ limit = 50 } = {}) {
  const { eraseJob } = require("./jobErasure");

  const pending = await jobStore.listPendingDeletions(limit);
  const summary = { attempted: pending.length, succeeded: 0, failed: 0, deferred: 0 };

  for (const job of pending) {
    if (!_isDue(job, "deletion_next_attempt_at")) {
      summary.deferred += 1;
      continue;
    }

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
      .update(job.id, {
        deletion_pending: true,
        deletion_attempts: attempts,
        deletion_next_attempt_at: _nextAttemptAt(attempts),
      })
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
  const summary = { attempted: pending.length, succeeded: 0, failed: 0, deferred: 0 };

  for (const job of pending) {
    if (!_isDue(job, "audio_cleanup_next_attempt_at")) {
      summary.deferred += 1;
      continue;
    }

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
      .update(job.id, {
        audio_cleanup_attempts: attempts,
        audio_cleanup_next_attempt_at: _nextAttemptAt(attempts),
      })
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
  const interval = intervalMs || _baseIntervalMs();

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
  _backoffMs, // testams
};
