const path = require("path");
const fs = require("fs").promises;

const jobStore = require("./jobStore");
const auditLog = require("./auditLog");
const tombstones = require("./deletionTombstones");
const {
  ERASURE_REASON,
  ACTOR_KIND,
  TOMBSTONE_STATUS,
} = require("./deletionTombstones/states");
const { rasytiAudita } = require("./auditWrite");
const fileStorage = require("./fileStorage");
const { getPrivacyPolicy } = require("./privacyPolicy");
const { createLogger } = require("../utils/logger");

/** Vieno ciklo riba - žr. `_valytiPasenusiusJobus`. */
const JOBU_BATCH = 500;
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
 * PASENUSIŲ JOB'Ų VALYMAS SU IŠTRYNIMO ŽYMA (#183).
 *
 * ⚠️ ANKSČIAU ŠIS KELIAS BARJERO NEPALIKDAVO.
 *
 * `jobStore.sweepExpired()` bendru `DELETE` pašalindavo pasenusius job'us, ir
 * `ERASURE_REASON.RETENTION_POLICY` neturėjo NĖ VIENO produkcinio kvietėjo -
 * reikšmė buvo apibrėžta, bet niekur nenaudojama. Pasibaigusio termino jobas
 * dingdavo be žymos, o `restoreRecord()` po to tą ID iš senesnės kopijos
 * priimdavo: ištrynimas atsistatydavo.
 *
 * ⚠️ Tai buvo ir `docs/deletion-guarantees.md` teiginio „barjerą palieka VISI
 * ištrynimo keliai" paneigimas - dokumentacija buvo stipresnė už kodą.
 *
 * Tvarka ta pati kaip visur: žyma PIRMA, šalinimas antras.
 *
 * ⚠️ PRETENZIJA, NE VIEN ŽYMA. Jei jobą tuo metu jau trina kita replika ar
 * vartotojo `DELETE`, pretenzijos negaunam ir job'o NELIEČIAM - antraip
 * retencija dubliuotų destruktyvų darbą ir lenktyniautų dėl to paties įrašo.
 *
 * ⚠️ APRIBOTAS BATCH. Retencija gali rasti tūkstančius pasenusių job'ų;
 * neapribotas ciklas laikytų pool'ą ir audito rašymą užimtą neapibrėžtą laiką.
 * Likusieji išvalomi kitame cikle - ta pati tvarka kaip audito retencijoje.
 */
async function _valytiPasenusiusJobus(now) {
  const kandidatai = await jobStore.listExpired(now, JOBU_BATCH);

  let pasalinta = 0;
  let praleista = 0;

  for (const jobId of kandidatai) {
    const { vykdytojas } = await tombstones.claimForDeletion(jobId, {
      reason: ERASURE_REASON.RETENTION_POLICY,
      actorKind: ACTOR_KIND.SYSTEM,
    });

    /** Jobą jau tvarko kitas vykdytojas - retencija nesikiša. */
    if (!vykdytojas) {
      praleista += 1;
      continue;
    }

    try {
      const nuimta = await jobStore.system.remove(jobId);
      if (nuimta) pasalinta += 1;

      await tombstones.complete(jobId, TOMBSTONE_STATUS.DELETED);
    } catch (e) {
      /**
       * Šalinimas nepavyko po pretenzijos - žyma privalo tai atspindėti, kitaip
       * ji liktų `deletion_pending` be vykdytojo ir kiekvienas vėlesnis kelias
       * gautų „jau vykdoma" amžinai.
       */
      await tombstones
        .complete(jobId, TOMBSTONE_STATUS.FAILED, { failureKind: "retryable" })
        .catch(() => {});

      throw e;
    }
  }

  /**
   * ⚠️ BACKEND'O VIDINĖ PRIEŽIŪRA - TIK KAI KANDIDATŲ NEBUVO IŠVIS.
   *
   * `sweepExpired()` Redis režime genėja `jobs:index` (priežiūra), o
   * `postgres`/`memory` režimuose TRINA bendru `DELETE`, nežiūrėdamas į žymas.
   *
   * ⚠️ PIRMOJI ŠIO SARGO VERSIJA BUVO PER SILPNA, IR TESTAS TAI PAGAVO.
   * Ji leido priežiūrą, kai batch'as nepilnas - bet tada bendras `DELETE`
   * pašalindavo BŪTENT tuos job'us, kuriuos ciklas sąmoningai praleido dėl
   * svetimos pretenzijos. Retencija atimdavo darbą iš kito vykdytojo ir dar be
   * žymos.
   *
   * Kai kandidatų nebuvo, `postgres`/`memory` režimuose `sweepExpired()`
   * neranda ko trinti, o Redis atlieka savo indekso priežiūrą.
   */
  if (kandidatai.length === 0) {
    await jobStore.sweepExpired(now);
  }

  return { pasalinta, praleista };
}

/**
 * Vienas pilnas retencijos ciklas. Grąžina suvestinę (naudinga testams ir logams).
 */
async function runRetentionSweep({ now = Date.now() } = {}) {
  const summary = {
    jobs: 0,
    /** Kiek pasenusių job'ų paliko kitam vykdytojui (#183). */
    jobsSkipped: 0,
    audio: 0,
    auditEntries: 0,
    tombstones: 0,
    errors: [],
  };

  try {
    const r = await _valytiPasenusiusJobus(now);
    summary.jobs = r.pasalinta;
    summary.jobsSkipped = r.praleista;
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
    /**
     * ⚠️ JAU PAŠALINTOS EILUTĖS PATENKA Į SUVESTINĘ (#233 Codex, P2).
     *
     * Retencija persistentiniame režime vyksta batch'ais, ir kiekvienas jų
     * commit'inasi atskirai. Kritus vėlesniam batch'ui, priskyrimas aukščiau
     * neįvyksta - be šito `auditEntries` liktų nulis, ciklas atrodytų tuščias,
     * ir `RETENTION_PURGE` įrašas nebūtų parašytas. Eilutės būtų negrįžtamai
     * ištrintos be pėdsako audito žurnale.
     */
    summary.auditEntries = Number.isInteger(e.pasalinta) ? e.pasalinta : 0;
    summary.errors.push(`audit: ${e.message}`);
  }

  try {
    /**
     * ⚠️ ŽYMŲ VALYMAS ČIA, NE SAVO TIMER'YJE (#155, 7.5a / #183).
     *
     * Iki 7.5a `deletionTombstones` turėjo savo `setInterval`. Du valymo ciklai
     * ant to paties duomenų gyvavimo ciklo reikštų dvi konfigūracijas, du
     * laikrodžius, o `RETENTION_PURGE` įrašas rodytų tik vieno jų darbą - ta
     * pati taisyklė, kurią 7.4d pritaikė auditui.
     *
     * ⚠️ ŠALINAMOS TIK `deleted` ŽYMOS. `pending` ir `failed` nesensta: jos
     * reiškia, kad jautrūs duomenys dar gali egzistuoti.
     */
    const zymos = await tombstones.purgeExpired(now);
    summary.tombstones = zymos.removed;

    if (zymos.skipped) {
      /**
       * FAIL-SAFE nėra klaida - tai sąmoningas atsisakymas spėlioti. Bet jis
       * privalo būti matomas: tyliai praleistas valymas atrodytų kaip valymas.
       */
      log.warn("Retencija: žymų terminas neapskaičiuojamas - žymos NEŠALINAMOS.");
    }
  } catch (e) {
    /** ⚠️ Jau pašalinti barjerai patenka į suvestinę - žr. `purgeExpired` (#183). */
    summary.tombstones = Number.isInteger(e.pasalinta) ? e.pasalinta : 0;
    summary.errors.push(`tombstones: ${e.message}`);
  }

  const removedAnything =
    summary.jobs > 0 || summary.audio > 0 || summary.auditEntries > 0 || summary.tombstones > 0;

  /**
   * ⚠️ KLAIDA IRGI YRA ĮVYKIS (#233 Codex, P2).
   *
   * Iki šito ciklas, kuris nieko nepašalino IR krito, baigdavosi visiškoje
   * tyloje: nei `RETENTION_PURGE` įrašo, nei klaidos - `startRetentionSweeper`
   * logina tik tada, kai visas pažadas atmetamas, o klaidos čia sugaunamos.
   * Nesėkmingas automatinis asmens duomenų šalinimas privalo palikti pėdsaką.
   */
  const verta = removedAnything || summary.errors.length > 0;

  // Įrašom TIK kai kažkas realiai pašalinta arba kai buvo klaidų - kitaip kas
  // valandą rašytume tuščią įvykį ir per AUDIT_MAX_ENTRIES išstumtume naudingus.
  if (verta) {
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
      details:
        `jobs=${summary.jobs} audio=${summary.audio} audit=${summary.auditEntries} ` +
        `tombstones=${summary.tombstones}`,
    });
    log.info(
      `Retencija: pašalinta jobų=${summary.jobs}, audio failų=${summary.audio}, ` +
        `audito įrašų=${summary.auditEntries}, ištrynimo žymų=${summary.tombstones}.`
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
