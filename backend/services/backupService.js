const tombstones = require("../utils/deletionTombstones");
const jobStore = require("../utils/jobStore");
const { rasytiAudita } = require("../utils/auditWrite");
const fileStorage = require("../utils/fileStorage");
const backupPolicy = require("../utils/backupPolicy");
const backupManifest = require("../utils/backupManifest");
const { ARTEFACT_TYPES } = require("../utils/artefactInventory");
const { createLogger } = require("../utils/logger");
const backupEncryption = require("../utils/backupEncryption");
const secretsInventory = require("../utils/secretsInventory");

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
  const allJobs = await jobStore.system.listAll();

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

  const plaintext = Buffer.from(JSON.stringify(data), "utf8");

  const encrypted = backupEncryption.isEnabled(env);

  /**
   * PASLAPČIŲ PATIKRA KŪRIMO METU (#20 PR3 v3).
   *
   * Anksčiau ji vykdavo TIK atkuriant – t. y. kopija su nutekėjusia paslaptimi
   * būdavo sukuriama, laikoma visą retencijos laikotarpį, ir problema
   * paaiškėdavo nelaimės metu, kai atkūrimas jau reikalingas.
   *
   * Atkūrimo momentas yra blogiausia vieta pirmą kartą sužinoti, kad kopija
   * neatitinka politikos.
   */
  const leaked = secretsInventory.findLeakedSecrets(plaintext.toString("utf8"), env);
  if (leaked.length > 0) {
    await _audit({ event: "BACKUP_REJECTED", actor, manifest: null, success: false, outcome: "secrets_present" });

    // Pranešime - TIK vardai, niekada reikšmės.
    throw _backupError(`Kopijoje aptikta paslapčių: ${leaked.join(", ")}. Kopija nesukurta.`, "BACKUP_SECRETS_PRESENT");
  }

  const contents = [
    { type: ARTEFACT_TYPES.JOB_RECORD.id, count: stable.length, bytes: Buffer.byteLength(JSON.stringify(stable)) },
    { type: ARTEFACT_TYPES.SOURCE_AUDIO.id, count: audio.length, bytes: audio.reduce((sum, a) => sum + a.bytes, 0) },
  ];

  /**
   * MANIFESTAS SUDAROMAS PRIEŠ ŠIFRAVIMĄ.
   *
   * Jo saugumo laukai naudojami kaip AAD, tad turi būti žinomi šifruojant.
   * Kontrolinė suma – vienintelis laukas, kuris priklauso nuo šifruoto turinio,
   * todėl ji pridedama po to (ir į AAD nepatenka: ji apskaičiuojama nuo to
   * paties ciphertext, kurį autentifikuoja GCM žyma).
   */
  const manifest = backupManifest.createManifest({
    contents,
    checksum: "pending",
    env,
  });

  /**
   * ⚠️ IŠLEISTOS KOPIJOS GALIOJIMAS FIKSUOJAMAS PERSISTENTIŠKAI (#183 Codex, P1).
   *
   * Ištrynimo žymos terminas remiasi tuo, kiek laiko job'as dar gali būti
   * atkurtas. Skaičiuojant tik iš DABARTINĖS `BACKUP_RETENTION_DAYS`, šios
   * kopijos galiojimą būtų galima „sutrumpinti" tiesiog pakeitus nustatymą - o
   * pati kopija jau išleista ir galioja pagal savo manifestą.
   *
   * ⚠️ NEBLOKUOJANTIS: kopija jau sukurta, ir jos negalima atšaukti dėl
   * apskaitos įrašo. Klaida garsiai logojama - tylus praleidimas reikštų, kad
   * barjeras gali sutrumpėti be jokio signalo.
   */
  const galiojaIki = Date.parse(manifest.expiresAt);

  if (Number.isFinite(galiojaIki)) {
    await tombstones.recordBackupHorizon(galiojaIki).catch((klaida) =>
      log.error(
        "Kopijos galiojimo NEPAVYKO užfiksuoti - ištrynimo žymos gali būti " +
          `pašalintos anksčiau, nei nustoja galioti ši kopija: ${klaida.message}`
      )
    );
  }

  manifest.encrypted = encrypted;
  manifest.encryptionAlgorithm = encrypted ? `${backupEncryption.ALGORITHM}-${backupEncryption.FORMAT}` : null;
  manifest.snapshotTime = new Date(snapshotTime).toISOString();
  manifest.excludedInFlightJobs = inFlight.length;
  manifest.excludedReason = inFlight.length > 0 ? "in_progress" : null;

  const serialized = encrypted
    ? Buffer.from(JSON.stringify(backupEncryption.encrypt(plaintext, { env, manifest })), "utf8")
    : plaintext;

  /**
   * Kontrolinė suma – nuo TO, KAS REALIAI SAUGOMA (šifruoto turinio).
   *
   * Taip sugadinimas aptinkamas IŠ KARTO, o ne po nepavykusio dešifravimo, kai
   * priežastis jau dviprasmiška (sugadinta ar netinkamas raktas?).
   */
  manifest.checksum = backupManifest.computeChecksum(serialized);

  await _audit({ event: "BACKUP_CREATED", actor, manifest, success: true });

  log.info("Kopija sukurta", {
    jobs: stable.length,
    excludedInFlight: inFlight.length,
    audioFiles: audio.length,
    encrypted,
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

/**
 * ⚠️ ASYNC NUO 7.4a (#210). Anksčiau čia buvo `try { auditLog.record(...) }
 * catch {}` - po `record()` async pakeitimo tas `catch` nebebūtų pagavęs
 * atmesto Promise, ir kvietimas taptų fire-and-forget. `BACKUP_*` yra
 * NEBLOKUOJANTYS, tad gedimo politiką (logas + skaitiklis) pritaiko
 * `rasytiAudita()`, o ne tylus `catch`.
 */
async function _audit({ event, actor, manifest, success, outcome = null }) {
  await rasytiAudita({
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
}

function _backupError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Aktyvių (nebaigtų) darbų skaičius – GLOBALIAI, per visus savininkus.
 *
 * Perkelta čia iš `routes/backup.js` (#159): tai priežiūros operacija, kuriai
 * reikia sisteminio matymo, o `jobStore.system` maršrutų sluoksnyje uždraustas.
 * Palikus ją maršrute, tektų daryti sargo išimtį – o viena išimtis greitai
 * tampa dviem.
 */
async function countActiveJobs() {
  /**
   * ⚠️ BE HIDRATACIJOS (#157, PR-3). Skaičiuojamos BŪSENOS, o rezultatų turinys čia
   * niekada nebuvo žiūrimas — su 20 MiB riba kiekvienas priežiūros patikrinimas be
   * reikalo pertempdavo visų job'ų `payload`. `createBackup()` lieka hidratuotas:
   * jam rezultatai BŪTINI.
   */
  const jobs = await jobStore.system.listAll({ hydrate: false });
  return jobs.filter((job) => !["completed", "failed"].includes(job.status)).length;
}

module.exports = { createBackup, STABLE_STATUSES, countActiveJobs, _audit };
