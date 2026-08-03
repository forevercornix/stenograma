const jobStore = require("../utils/jobStore");
const auditLog = require("../utils/auditLog");
const fileStorage = require("../utils/fileStorage");
const backupPolicy = require("../utils/backupPolicy");
const backupManifest = require("../utils/backupManifest");
const { ARTEFACT_TYPES } = require("../utils/artefactInventory");
const { createLogger } = require("../utils/logger");

const log = createLogger("backup");

/**
 * ATSARGINĖS KOPIJOS KŪRIMAS (#20 PR2).
 *
 * NUOSEKLUS MOMENTINIS VAIZDAS BE „FREEZE WORLD".
 *
 * Kopijuojant sistema veikia: jobai keičia būseną, worker'iai rašo rezultatus.
 * Sustabdyti visus rašytojus būtų teisinga teoriškai, bet pilotui per brangu ir
 * pati stabdymo logika taptų nauju gedimų šaltiniu.
 *
 * Vietoj to: `snapshotTime` fiksuojamas pradžioje, ir į kopiją patenka TIK
 * stabilios būsenos objektai. Vykdomi darbai praleidžiami, o manifeste įrašoma,
 * KIEK jų praleista ir KODĖL.
 *
 * Skirtumas svarbus operatoriui: kopija su `excludedInFlightJobs: 3` nėra
 * sugadinta – ji sąmoningai neapima trijų tuo metu vykdytų darbų. Be šio įrašo
 * ta pati kopija atrodytų kaip nepilna dėl nežinomos priežasties.
 */

/** Būsenos, kurios laikomos STABILIOMIS – jų turinys nebesikeis. */
const STABLE_STATUSES = new Set(["completed", "failed"]);

/**
 * VIENAS REŽIMAS: kopija visada pilna ir apima `source_audio`.
 *
 * Dviejų režimų (su audio / be audio) sąmoningai nėra. Pasirinkimas atrodo
 * nekaltas, bet virsta dvigubu testų rinkiniu, papildoma dokumentacija ir
 * klausimu „kurį režimą naudojau?" tada, kai atkūrimas jau reikalingas.
 *
 * Riba aiški: **kopija atkuria sistemą, eksportas išneša rezultatus.** Kam
 * reikia tik protokolų, tam yra `/api/exports`.
 */
async function createBackup({ actor = null, env = process.env } = {}) {
  if (!backupPolicy.isEnabled(env)) {
    throw _backupError("Kopijos išjungtos (`BACKUP_ENABLED`).", "BACKUP_DISABLED");
  }

  const snapshotTime = Date.now();
  const allJobs = await jobStore.listAll();

  const stable = [];
  const inFlight = [];

  for (const job of allJobs) {
    /**
     * Vėliau nei momentinis vaizdas sukurti jobai NEĮTRAUKIAMI.
     *
     * Be šios patikros kopija apimtų dalį darbų, prasidėjusių jau jai
     * vykstant, ir nebeatitiktų jokio konkretaus laiko momento – t. y. nustotų
     * būti momentiniu vaizdu.
     */
    /**
     * NEPARSINAMA data laikoma SENU įrašu ir įtraukiama.
     *
     * `Number.isFinite` patikra reiškia, kad įrašas be galiojančios datos
     * praeina filtrą. Tai sąmoninga suderinamumo nuolaida: senesni įrašai gali
     * neturėti lauko, ir atmetus juos kopija tyliai prarastų duomenis.
     *
     * Rizika priešinga kryptimi maža: įrašas be datos negalėjo atsirasti PO
     * momentinio vaizdo, nes naujus kuria dabartinis kodas, kuris datą rašo.
     */
    const createdAt = Date.parse(job.created_at || job.createdAt || 0);
    if (Number.isFinite(createdAt) && createdAt > snapshotTime) continue;

    if (STABLE_STATUSES.has(job.status)) stable.push(job);
    else inFlight.push(job);
  }

  const audio = await _collectAudio(stable);

  /**
   * ⚠️ AUDITAS Į KOPIJĄ NEPATENKA (žr. `backupPolicy.EXCLUDED_DESPITE_PERSISTENT`).
   *
   * Pirmoji šio serviso versija jį surinkdavo, bet atkūrimas jo neatstatydavo –
   * tarpinė būsena, kurioje kopija turėjo duomenų, kurių niekas niekada
   * nenaudojo. Blogiau: jei būtume juos atkūrę, GDPR ištrinti audito įrašai
   * būtų grįžę, nes žymų apsauga dengia jobus pagal ID, o audito įrašai saugo
   * pseudonimizuotą subjektą.
   */
  const data = {
    jobs: stable,
    audio,
  };

  const serialized = Buffer.from(JSON.stringify(data), "utf8");

  const contents = [
    { type: ARTEFACT_TYPES.JOB_RECORD.id, count: stable.length, bytes: Buffer.byteLength(JSON.stringify(stable)) },
    { type: ARTEFACT_TYPES.SOURCE_AUDIO.id, count: audio.length, bytes: audio.reduce((sum, a) => sum + a.bytes, 0) },
  ];

  const manifest = backupManifest.createManifest({
    contents,
    checksum: backupManifest.computeChecksum(serialized),
    env,
  });

  /**
   * Momentinio vaizdo metaduomenys – manifeste, ne loguose.
   *
   * Logai rotuojasi; manifestas keliauja kartu su kopija. Operatorius, radęs
   * kopiją po pusmečio, turi galėti atsakyti į klausimą „ko joje nėra"
   * neieškodamas archyvuotų logų.
   */
  manifest.snapshotTime = new Date(snapshotTime).toISOString();
  manifest.excludedInFlightJobs = inFlight.length;
  manifest.excludedReason = inFlight.length > 0 ? "in_progress" : null;

  _audit({ event: "BACKUP_CREATED", actor, manifest, success: true });

  log.info("Kopija sukurta", {
    jobs: stable.length,
    excludedInFlight: inFlight.length,
    audioFiles: audio.length,
  });

  return { manifest, data: serialized };
}

/**
 * Surenka audio failus.
 *
 * Trūkstamas failas NĖRA gedimas: audio galėjo būti teisėtai išvalytas po
 * apdorojimo (`audio_cleanup`). Kopija tada tiesiog jo neturi, ir tai
 * atsispindi `count` reikšmėje.
 */
async function _collectAudio(jobs) {
  const collected = [];

  for (const job of jobs) {
    if (!job.storageKey) continue;

    try {
      const buffer = await fileStorage.get(job.storageKey);
      collected.push({
        key: job.storageKey,
        bytes: buffer.length,
        // base64, nes kopija yra vientisas JSON - dvejetainiai duomenys jame
        // kitaip neišgyventų serializacijos.
        content: buffer.toString("base64"),
      });
    } catch {
      // Failo nebėra - teisėta būsena po audio valymo.
    }
  }

  return collected;
}

function _audit({ event, actor, manifest, success, outcome = null }) {
  try {
    auditLog.record({
      event,
      success,
      outcome,
      actor: actor || undefined,
      /**
       * Audite TIK metaduomenys: skaičiai ir versijos. Jokių raktų, kelių ar
       * turinio – ta pati taisyklė kaip #19 ištrynimo įrašuose.
       */
      details:
        `formatVersion=${manifest ? manifest.formatVersion : "?"} ` +
        `appVersion=${manifest ? manifest.applicationVersion : "?"} ` +
        `excludedInFlight=${manifest ? manifest.excludedInFlightJobs : "?"}`,
    });
  } catch {
    // Auditas neturi versti kopijavimo nesėkme.
  }
}

function _backupError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = { createBackup, STABLE_STATUSES, _audit };
