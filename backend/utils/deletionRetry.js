const jobStore = require("./jobStore");
const { createLogger } = require("../utils/logger");
const log = createLogger("deletion-retry");

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
/**
 * ⚠️ TIKRINAMAS IR ATSARGINIS TERMINAS.
 *
 * Kai `jobStore.update()` krinta, `next_attempt_at` NEIŠSAUGOMAS — persistintas
 * laukas lieka senas arba jo nėra visai. Žiūrint tik į jį, `_isDue()` grąžintų
 * `true` KIEKVIENO sweep'o metu, ir outage'o metu neveikianti saugykla būtų
 * daužoma be jokios pertraukos.
 *
 * Imamas VĖLESNIS iš dviejų: persistinto ir atmintyje laikomo.
 */
function _isDue(job, field, now = Date.now()) {
  const persistintas = job[field] ? Date.parse(job[field]) : NaN;

  const atsarginis = atsarginiaiBandymai.get(_atsarginisRaktas(job.id, _bandymųLaukas(field)));
  const atmintyje = atsarginis?.nextAttemptAt ? Date.parse(atsarginis.nextAttemptAt) : NaN;

  const terminai = [persistintas, atmintyje].filter(Number.isFinite);
  if (terminai.length === 0) return true;

  return Math.max(...terminai) <= now;
}

/** `deletion_next_attempt_at` → `deletion_attempts` (raktas atsarginėje aibėje). */
function _bandymųLaukas(nextAttemptField) {
  return nextAttemptField.replace(/_next_attempt_at$/, "_attempts");
}

function _nextAttemptAt(attempts) {
  return new Date(Date.now() + _backoffMs(attempts, _baseIntervalMs())).toISOString();
}

/**
 * ATSARGINIS BANDYMŲ SKAITIKLIS (#196).
 *
 * ⚠️ KODĖL JO REIKIA.
 *
 * `attempts` skaičiuojamas iš PERSISTINTO `job.deletion_attempts`. Jei
 * `jobStore.update()` krinta — dažniausiai per tą patį Redis sutrikimą, kuris
 * ir sukėlė ištrynimo nesėkmę — skaitiklis neišsaugomas, ir kitas sweep'as vėl
 * skaito senąją reikšmę.
 *
 * Pasekmė: `MAX_ATTEMPTS_BEFORE_ALERT` NIEKADA nepasiekiamas, o
 * `next_attempt_at` neatnaujinamas, tad `_isDue()` praleidžia iškart —
 * ištrynimas kartojamas tankiai, be backoff, ir operatorius nesužino, kad GDPR
 * ištrynimas nepavyksta.
 *
 * Vienintelis apsauginis mechanizmas negali priklausyti nuo to paties
 * komponento, kuris ką tik krito.
 *
 * Atmintis prarandama per restartą — tai priimtina: po restarto persistintas
 * skaitiklis vėl tampa autoritetu, o eskalacija tik atidedama, ne prarandama.
 */
const atsarginiaiBandymai = new Map();

/** `job.id + laukas` → bandymų skaičius, kai persistuoti nepavyko. */
function _atsarginisRaktas(jobId, laukas) {
  return `${jobId}:${laukas}`;
}

function _bandymųSkaičius(job, laukas) {
  const persistintas = job[laukas] || 0;
  const atmintyje = atsarginiaiBandymai.get(_atsarginisRaktas(job.id, laukas))?.attempts || 0;
  // Didesnis laimi: persistintas gali būti pasenęs, atmintinis - prarastas.
  return Math.max(persistintas, atmintyje) + 1;
}

/**
 * Įrašo būseną ir grąžina, ar pavyko.
 *
 * ⚠️ Klaida NEPRARYJAMA. Anksčiau čia buvo `.catch(() => {})`, tad gedimas,
 * dėl kurio neįvyksta įspėjimas, pats liko nematomas.
 */
async function _išsaugotiBandymą(jobId, laukas, patch, attempts) {
  try {
    await jobStore.update(jobId, patch);
    atsarginiaiBandymai.delete(_atsarginisRaktas(jobId, laukas));
    return true;
  } catch (e) {
    /**
     * ⚠️ IŠSAUGOMAS IR TERMINAS, ne tik skaitiklis.
     *
     * Be `nextAttemptAt` atmintyje `_isDue()` matytų tik seną persistintą
     * reikšmę ir praleistų kiekvieną sweep'ą — backoff neegzistuotų būtent
     * tada, kai jo labiausiai reikia.
     */
    const nextAttemptAt =
      patch[laukas.replace(/_attempts$/, "_next_attempt_at")] || _nextAttemptAt(attempts);

    atsarginiaiBandymai.set(_atsarginisRaktas(jobId, laukas), { attempts, nextAttemptAt });
    log.error(
      `Nepavyko išsaugoti jobo ${jobId} pakartojimo būsenos (${laukas}=${attempts}): ` +
        `${e.code || e.name}. Skaitiklis laikomas ATMINTYJE, kad eskalacija ir ` +
        "backoff veiktų net kritus saugyklai."
    );
    return false;
  }
}

/** Testams: atsarginių skaitiklių išvalymas. */
function _resetForTests() {
  atsarginiaiBandymai.clear();
}

async function retryPendingDeletions({ limit = 50 } = {}) {
  const { eraseJob } = require("./jobErasure");
  const tombstones = require("./deletionTombstones");

  const pending = await jobStore.system.listPendingDeletions(limit);

  // `scanned` - kiek pažymėtų jobų rasta; `attempted` - kiek REALIAI bandyta.
  // Anksčiau attempted buvo pending.length, tad esant 10 pažymėtų ir 8 dar ne
  // laiku gaudavosi {attempted: 10, deferred: 8} - metrika klaidinga.
  const summary = {
    scanned: pending.length,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    deferred: 0,
    /** Palikta operatoriui: žyma `deletion_failed` (#183). */
    unresolved: 0,
  };

  for (const job of pending) {
    if (!_isDue(job, "deletion_next_attempt_at")) {
      summary.deferred += 1;
      continue;
    }

    /**
     * ⚠️ NEPAVYKĘS IŠTRYNIMAS SU `deletion_failed` ŽYMA PALIEKAMAS OPERATORIUI.
     *
     * Iki 7.5a čia buvo ANTRA kartojimo sistema: šis sweeper'is automatiškai
     * kartodavo tai, ką žymų mašina laiko operatoriaus sprendimu. Dvi sistemos
     * nesugyvena - jei sweeper'is pakartoja sėkmingai, jobas dingsta, o žyma
     * lieka `deletion_failed` AMŽINAI, ir be jokio `LIFECYCLE_DELETION` įrašo.
     * Nuo tada, kai barjeras lemia HTTP atsakymą, tai reiškia 503 vartotojui,
     * kurio duomenų seniai nebėra.
     *
     * ⚠️ ALTERNATYVA BUVO ATMESTA SĄMONINGAI. Sweeper'is galėjo tapti
     * autorizuotu kartotoju (`ERASURE_MARK_RETRIED` su `actorKind=system`), bet
     * tada `deletion_failed` vėl išsispręstų savaime - tik kitoje vietoje ir be
     * aiškaus aktoriaus. Būsena, kuri išsisprendžia savaime, nebėra barjeras.
     *
     * ⚠️ PRALEIDŽIAMA GARSIAI. Tylus `continue` paverstų užstrigusį ištrynimą
     * nematomu: sweeper'io metrikos rodytų „nieko nelaukia", nors jautrūs
     * duomenys tebėra saugomi.
     */
    const zyma = await tombstones.barrierState(job.id);

    if (zyma && zyma.status === tombstones.TOMBSTONE_STATUS.FAILED) {
      summary.unresolved += 1;

      log.warn(
        `Jobo ${job.id} ištrynimas PALIKTAS OPERATORIUI: žyma yra ` +
          `\`deletion_failed\` (bandymai ${zyma.attempts}, paskutinė klaida ` +
          `${zyma.lastFailureKind || "nežinoma"}). Automatinis kartojimas ` +
          "nebevykdomas - naują bandymą autorizuoja operatorius: " +
          `\`erasure-marks retry ${job.id}\`. ` +
          "⚠️  JAUTRŪS DUOMENYS GALI TEBEBŪTI SAUGOMI."
      );

      continue;
    }

    summary.attempted += 1;

    const attempts = _bandymųSkaičius(job, "deletion_attempts");
    const outcome = await eraseJob(job);

    if (!outcome.criticalFailure) {
      summary.succeeded += 1;
      log.info(
        `Nebaigtas jobo ${job.id} ištrynimas pakartotas sėkmingai (bandymas ${attempts}).`
      );
      continue;
    }

    summary.failed += 1;

    await _išsaugotiBandymą(
      job.id,
      "deletion_attempts",
      {
        deletion_pending: true,
        deletion_attempts: attempts,
        deletion_next_attempt_at: _nextAttemptAt(attempts),
      },
      attempts
    );

    const message =
      `Jobo ${job.id} ištrynimas vis dar nepavyksta ` +
      `(bandymas ${attempts}): ${outcome.errors.join("; ")}`;

    if (attempts >= MAX_ATTEMPTS_BEFORE_ALERT) {
      // Aiškiai atskiriam nuo įprastos klaidos - tai jau reikalauja žmogaus.
      log.error(
        `${message}. ⚠️  REIKIA RANKINIO ĮSIKIŠIMO: jautrūs duomenys tebėra saugomi.`
      );
    } else {
      log.warn(message);
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
  /**
   * ⚠️ TECHNINIS PAKARTOJIMAS EINA PER BARJERĄ (Codex E1).
   *
   * Anksčiau čia buvo TIESIOGINIS `releaseAudio()`, ir tai apeidavo barjerą.
   * Pasekmė buvo tiksliai atvirkštinė nei norėta: barjerui nepavykus perskaityti
   * būsenos, jis pažymi `audio_cleanup_pending` (kad valymas nedingtų), o šis
   * sweep'as tą vėliavą apdorodavo BE patikros — ir negrįžtamai ištrindavo
   * būtent tą audio, kurį barjeras saugojo.
   *
   * ⚠️ GDPR IŠTRYNIMAS EINA VISIŠKAI KITU KELIU, IR BARJERO TEN NĖRA.
   *
   * `retryPendingDeletions()` kviečia `jobErasure.eraseJob()`, o tas šalina
   * failą TIESIOGIAI per `fileStorage.del()` (`utils/jobErasure.js`) —
   * `releaseAudio()` ten nedalyvauja apskritai. Barjeras tos šakos nepasiekia ir
   * neturi pasiekti: ten audio privalo dingti nepriklausomai nuo job'o būsenos.
   *
   * Skiriasi ne mechanizmas, o teisė: techninis valymas yra patogumas,
   * ištrynimas — pareiga.
   */
  const { salintiAudioSuBarjeru } = require("./audioBarrier");

  const pending = await jobStore.system.listPendingAudioCleanups(limit);
  const summary = { scanned: pending.length, attempted: 0, succeeded: 0, failed: 0, deferred: 0 };

  for (const job of pending) {
    if (!_isDue(job, "audio_cleanup_next_attempt_at")) {
      summary.deferred += 1;
      continue;
    }

    const attempts = _bandymųSkaičius(job, "audio_cleanup_attempts");

    if (!job.storageKey) {
      // Nėra ką trinti - vėliava pasenusi (pvz. raktas jau išvalytas kitu keliu).
      // Į `attempted` neįskaičiuojam: jokio trynimo nebuvo.
      /** Vėliava pasenusi; nepavykus - kitas sweep'as bandys dar kartą. */
      await _išsaugotiBandymą(
        job.id,
        "audio_cleanup_attempts",
        { audio_cleanup_pending: false },
        attempts
      );
      continue;
    }

    summary.attempted += 1;

    const removed = await salintiAudioSuBarjeru(
      job.id,
      { storageKey: job.storageKey },
      { execution: "retry" }
    );

    if (removed) {
      summary.succeeded += 1;
      log.info(
        `Likęs jobo ${job.id} audio pašalintas pakartotinai (bandymas ${attempts}).`
      );
      continue;
    }

    summary.failed += 1;

    // releaseAudio jau iš naujo nustatė vėliavą; čia tik didinam skaitiklį.
    await _išsaugotiBandymą(
      job.id,
      "audio_cleanup_attempts",
      {
        audio_cleanup_attempts: attempts,
        audio_cleanup_next_attempt_at: _nextAttemptAt(attempts),
      },
      attempts
    );

    const message =
      `Jobo ${job.id} audio vis dar nepavyksta ištrinti (bandymas ${attempts}).`;

    if (attempts >= MAX_ATTEMPTS_BEFORE_ALERT) {
      log.error(
        `${message} ⚠️  REIKIA RANKINIO ĮSIKIŠIMO: audio failas tebėra storage.`
      );
    } else {
      log.warn(message);
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
      log.error(`Ištrynimų pakartojimas nepavyko: ${e.message}`)
    );
    retryPendingAudioCleanups().catch((e) =>
      log.error(`Audio valymo pakartojimas nepavyko: ${e.message}`)
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
  _resetForTests, // #196: atsarginių skaitiklių išvalymas tarp testų
};
