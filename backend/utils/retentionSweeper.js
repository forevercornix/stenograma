const path = require("path");
const fs = require("fs").promises;

const jobStore = require("./jobStore");
const auditLog = require("./auditLog");
const { rasytiAudita } = require("./auditWrite");
const fileStorage = require("./fileStorage");
const { getPrivacyPolicy } = require("./privacyPolicy");
const { createLogger } = require("../utils/logger");
const log = createLogger("retention");

/**
 * AUTOMATINIS RETENCIJOS ŠALINIMAS (GDPR issue #2).
 *
 * Iki šiol veikė tik `jobStore.sweepExpired()` (jobo metaduomenys + rezultatas)
 * ir audito `purgeExpired()` rašymo/skaitymo metu. Trūko trijų dalykų:
 *
 *   1) NUSKENDĘ (orphan) audio failai. Failas trinamas po galutinio jobo statuso,
 *      bet jei procesas nukrito tarp `putFile()` ir jobo užbaigimo, storage
 *      kataloge lieka failas, kurio nebeturi nė vienas jobas. Niekas jo nešalino.
 *   2) Audito retencija be srauto. `purgeExpired()` kviečiamas tik rašant ar
 *      skaitant - nustojus naudoti sistemą pasenę įrašai likdavo.
 *   3) Įrašo, KAD šalinimas įvyko. GDPR reikalauja parodyti, jog retencijos
 *      politika realiai veikia, o ne tik aprašyta README.
 *
 * Šalinimo įvykiai rašomi kaip `RETENTION_PURGE` su kiekiais - be jokių
 * identifikatorių, failų vardų ar turinio (`subjectId` = null).
 */

const AUDIO_PREFIX = "uploads";

/**
 * Nuskendę audio failai: senesni nei `audioRetentionHours` IR nepaminėti nė
 * viename gyvame jobe. Amžiaus riba būtina - kitaip ištrintume ką tik įkeltą
 * failą, kurio jobas dar tik kuriamas.
 */
async function purgeOrphanedAudio({ now = Date.now(), retentionHours } = {}) {
  const config = getPrivacyPolicy();
  const maxAgeMs = (retentionHours || config.audioRetentionHours) * 60 * 60 * 1000;

  const dir = path.join(path.resolve(fileStorage.STORAGE_DIR), AUDIO_PREFIX);

  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (e) {
    if (e && e.code === "ENOENT") return { removed: 0, skipped: 0 };
    throw e;
  }

  // Raktai, kuriuos DAR naudoja bet kuris gyvas jobas - NEPRIKLAUSOMAI nuo statuso
  // ar vėliavų.
  //
  // KLAIDA, kurią tai taiso: anksčiau čia buvo renkami tik `deletion_pending` ir
  // `audio_cleanup_pending` jobai. Todėl paprastas `queued`/`processing` jobas su
  // senesniu nei AUDIO_RETENTION_HOURS audio (4 val. įrašas, užstrigusi eilė, GPU
  // trūkumas, maža retencijos reikšmė) būdavo palaikomas orphan ir jo failas
  // IŠTRINAMAS dar apdorojant - jobas krisdavo be jokio ryšio su priežastimi.
  const referencedList = await jobStore.system.listReferencedStorageKeys();

  if (referencedList === null) {
    // Saugykla neleidžia išvardyti jobų - tada NIEKO netrinam. Geriau likęs
    // failas nei ištrintas naudojamas.
    log.warn(
      "Retencija: saugykla nepalaiko listReferencedStorageKeys() - " +
        "nuskendusių audio failų šalinimas praleidžiamas (fail-safe)."
    );
    return { removed: 0, skipped: 0, skippedReason: "unsupported-store" };
  }

  const referenced = new Set(referencedList);

  let removed = 0;
  let skipped = 0;

  for (const entry of entries) {
    const key = `${AUDIO_PREFIX}/${entry}`;

    if (referenced.has(key)) {
      skipped += 1;
      continue;
    }

    let stat;
    try {
      stat = await fs.stat(path.join(dir, entry));
    } catch {
      continue;
    }

    if (!stat.isFile() || now - stat.mtimeMs < maxAgeMs) {
      skipped += 1;
      continue;
    }

    try {
      if (await fileStorage.del(key)) removed += 1;
    } catch (e) {
      // Nekritinė: bus pakartota kitą ciklą. Bet nenutylim.
      log.error(`Retencija: nepavyko ištrinti ${key}: ${e.message}`);
      skipped += 1;
    }
  }

  return { removed, skipped };
}

/**
 * Vienas pilnas retencijos ciklas. Grąžina suvestinę (naudinga testams ir logams).
 */
async function runRetentionSweep({ now = Date.now() } = {}) {
  const summary = { jobs: 0, audio: 0, auditEntries: 0, errors: [] };

  try {
    summary.jobs = await jobStore.sweepExpired(now);
  } catch (e) {
    summary.errors.push(`jobs: ${e.message}`);
  }

  try {
    const audio = await purgeOrphanedAudio({ now });
    summary.audio = audio.removed;
  } catch (e) {
    summary.errors.push(`audio: ${e.message}`);
  }

  try {
    /**
     * ⚠️ `await` PRIVALOMAS (#155, 7.4d / #213).
     *
     * Nuo 7.4d `purgeExpired()` yra asinchroninė - persistentiniame režime ji
     * vykdo ribotus DB batch'us. Be `await` čia atsidurtų `Promise`: logas
     * rodytų `[object Promise]` vietoj skaičiaus, `RETENTION_PURGE` įrašas
     * meluotų, o klaida taptų neapdorotu rejection - tyliu būtent tame kelyje,
     * kuris turi įrodyti, kad asmens duomenys pašalinti.
     */
    summary.auditEntries = await auditLog.purgeExpired(now);
  } catch (e) {
    summary.errors.push(`audit: ${e.message}`);
  }

  const removedAnything = summary.jobs > 0 || summary.audio > 0 || summary.auditEntries > 0;

  // Įrašom TIK kai kažkas realiai pašalinta - kitaip kas valandą rašytume tuščią
  // įvykį ir per AUDIT_MAX_ENTRIES išstumtume naudingus įrašus.
  if (removedAnything) {
    /**
     * ⚠️ AUDITO KLAIDA PROPAGUOJAMA (#155, 7.4a / #210).
     *
     * `RETENTION_PURGE` yra BLOKUOJANTIS: automatinis asmens duomenų šalinimas
     * be patvirtinto įrašo yra tas pats trūkumas kaip ir rankinis. Ciklas
     * nutrūksta, o `startRetentionSweeper` klaidą sulogina - kitas ciklas
     * kartos.
     */
    await rasytiAudita({
      event: "RETENTION_PURGE",
      success: summary.errors.length === 0,
      error: summary.errors.length ? summary.errors.join("; ") : null,
      details: `jobs=${summary.jobs} audio=${summary.audio} audit=${summary.auditEntries}`,
    });
    log.info(
      `Retencija: pašalinta jobų=${summary.jobs}, audio failų=${summary.audio}, ` +
        `audito įrašų=${summary.auditEntries}.`
    );
  }

  return summary;
}

/**
 * Paleidžia periodinį retencijos šalinimą. Timer'is `unref()`-intas.
 *
 * ⚠️ CIKLAI NEPERSIDENGIA (#155, 7.4d / #213).
 *
 * Nuo 7.4d sweep'as trina ir persistentines audito eilutes ribotais DB
 * batch'ais, tad didelėje lentelėje jis gali trukti ilgiau nei intervalas. Be
 * apsaugos kitas `setInterval` tick'as paleistų antrą ciklą to paties proceso
 * viduje: du sweep'ai konkuruotų dėl tų pačių eilučių, o `RETENTION_PURGE`
 * įrašai persidengtų.
 *
 * ⚠️ APSAUGA GYVENA SCHEDULER'YJE, NE `runRetentionSweep()` VIDUJE. Tiesioginis
 * kvietimas (testai, rankinis paleidimas) privalo likti sinchroniškai
 * nuspėjamas: praleistas ciklas ten reikštų tyliai neįvykusį valymą.
 *
 * Tai proceso lokali spyna. Multi-instance korektiškumo ji NEGARANTUOJA ir
 * neturi - tam yra `FOR UPDATE SKIP LOCKED` batch'ų atrankoje.
 */
function startRetentionSweeper({ intervalMs, runImmediately = true } = {}) {
  const config = getPrivacyPolicy();
  const interval = intervalMs || config.retentionSweepMinutes * 60 * 1000;

  let vykstantis = null;

  const paleisti = (kontekstas) => {
    if (vykstantis) {
      log.warn(`${kontekstas}: praleistas - ankstesnis retencijos ciklas dar vyksta.`);
      return;
    }

    vykstantis = runRetentionSweep()
      .catch((e) => log.error(`${kontekstas} nepavyko: ${e.message}`))
      .finally(() => {
        vykstantis = null;
      });
  };

  // PRADINIS ciklas iškart po starto. Be jo po restarto pasenę duomenys liktų dar
  // visą intervalą (numatytai valandą) - automatinei retencijai tai per ilgai.
  // `unref`-intas timeout, kad neblokuotų proceso pabaigos ir netrikdytų testų.
  if (runImmediately) {
    setTimeout(() => paleisti("Pradinis retencijos ciklas"), 5000).unref();
  }

  const timer = setInterval(() => paleisti("Retencijos ciklas"), interval);

  timer.unref();
  return timer;
}

module.exports = { runRetentionSweep, purgeOrphanedAudio, startRetentionSweeper };
