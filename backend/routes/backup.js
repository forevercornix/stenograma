const express = require("express");
const multer = require("multer");

const authenticate = require("../middleware/authenticate");
const { requirePermission } = require("../middleware/authorize");
const { PERMISSIONS } = require("../utils/permissions");
const rateLimiter = require("../middleware/rateLimiter");
const backupService = require("../services/backupService");
const restoreService = require("../services/restoreService");
const backupPolicy = require("../utils/backupPolicy");
const maintenanceLock = require("../utils/maintenanceLock");
const jobStore = require("../utils/jobStore");
const { createLogger } = require("../utils/logger");

const log = createLogger("backup-routes");
const router = express.Router();

/**
 * ADMINISTRACINIAI KOPIJŲ ENDPOINT'AI (#20 PR4).
 *
 * ⚠️ VISKAS ČIA YRA ADMINISTRATORIAUS LYGIO. Kopija yra visų duomenų nuotrauka
 * vienoje vietoje – galingiausias eksportas, koks įmanomas. Atkūrimas dar
 * destruktyvesnis: jis PERRAŠO esamą būseną, tad griežtesnis net už
 * `job:delete`.
 *
 * Iki šio PR `backup:create` ir `backup:restore` buvo tik lentelėje. Čia jie
 * pirmą kartą tampa VYKDOMA garantija.
 */

/** Įkeliamos kopijos dydžio riba. */
function maxUploadMb(env = process.env) {
  const raw = Number(env.MAX_BACKUP_UPLOAD_MB);
  return Number.isInteger(raw) && raw > 0 ? raw : 512;
}

/**
 * Manifestui – ATSKIRA, gerokai mažesnė riba.
 *
 * Jis yra metaduomenys: tipai, skaičiai, kontrolinės sumos. Kelių šimtų
 * kilobaitų riba pakankama net dideliam inventoriui, o didesnis failas reiškia
 * arba klaidą, arba bandymą išnaudoti atmintį.
 */
function maxManifestKb(env = process.env) {
  const raw = Number(env.MAX_BACKUP_MANIFEST_KB);
  return Number.isInteger(raw) && raw > 0 ? raw : 256;
}

/**
 * Įkėlimas Į ATMINTĮ, ne į diską.
 *
 * Kopija atkūrimo metu vis tiek turi būti visa atmintyje (patikros vyksta prieš
 * pritaikymą), tad laikinas failas diske pridėtų valymo ir retencijos klausimų
 * nieko nelaimint. Riba saugo nuo išnaudojimo.
 */
function createBackupUpload() {
  return multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: maxUploadMb() * 1024 * 1024,
      files: 2,
      // Papildomų laukų neleidžiam - žr. `assertExactlyTwoParts`.
      fields: 0,
    },
  });
}

/**
 * Priima TIKSLIAI du laukus: `manifest` ir `data`.
 *
 * Perteklinius, pasikartojančius ar trūkstamus laukus atmetam eksplicitiškai:
 * neaiški įvestis atkūrimo kelyje reikštų spėjimą, kurį failą laikyti kopija.
 */
function uploadBackupParts(req, res, next) {
  const handler = createBackupUpload().fields([
    { name: "manifest", maxCount: 1 },
    { name: "data", maxCount: 1 },
  ]);

  handler(req, res, (err) => {
    if (err) {
      /**
       * 413, ne 400, per dideliam failui.
       *
       * Skirtumas operatoriui esminis: 400 reikštų „netinkama kopija", ir jis
       * ieškotų problemos faile, o ne konfigūracijoje.
       */
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          error: `Kopija viršija leistiną dydį (${maxUploadMb()} MB).`,
          code: "BACKUP_TOO_LARGE",
        });
      }

      if (err.code === "LIMIT_UNEXPECTED_FILE" || err.code === "LIMIT_FILE_COUNT") {
        return res.status(400).json({
          error: "Priimami tik du laukai: `manifest` ir `data`.",
          code: "BACKUP_UNEXPECTED_PART",
        });
      }

      return res.status(400).json({ error: "Netinkamas kopijos įkėlimas." });
    }

    next();
  });
}

function assertExactlyTwoParts(req, res, next) {
  const manifest = req.files && req.files.manifest && req.files.manifest[0];
  const data = req.files && req.files.data && req.files.data[0];

  if (!manifest || !data) {
    return res.status(400).json({
      error: "Privalomi abu laukai: `manifest` ir `data`.",
      code: "BACKUP_PARTS_MISSING",
    });
  }

  if (manifest.size > maxManifestKb() * 1024) {
    return res.status(413).json({
      error: `Manifestas viršija leistiną dydį (${maxManifestKb()} KB).`,
      code: "BACKUP_MANIFEST_TOO_LARGE",
    });
  }

  req.backupParts = { manifest, data };
  next();
}

/** Ar kopijų funkcija apskritai įjungta? */
function requireBackupEnabled(req, res, next) {
  if (!backupPolicy.isEnabled()) {
    /**
     * 503, ne 404: endpointas egzistuoja, bet sąmoningai išjungtas. 404
     * verstų operatorių ieškoti neteisingo kelio.
     */
    return res.status(503).json({
      error: "Kopijos išjungtos (`BACKUP_ENABLED`).",
      code: "BACKUP_DISABLED",
    });
  }

  next();
}

/**
 * POST /api/admin/backups – sukuria kopiją ir GRĄŽINA ją atsakyme.
 *
 * Serveris kopijų NESAUGO. Tai sąmoningas sprendimas: serverio saugykla
 * atvertų retencijos, valymo, prieigos ir disko užsipildymo klausimus, kurie
 * yra atskira posistemė, ne endpointo dalis.
 *
 * Formatas – `multipart/mixed` su `manifest.json` ir `backup.data`. ZIP būtų
 * patogesnis operatoriui, bet reikalautų naujos priklausomybės ir tiekimo
 * grandinės peržiūros (žr. #20 sprendimų žurnalą, Decision 14).
 */
router.post(
  "/admin/backups",
  rateLimiter,
  authenticate,
  requirePermission(PERMISSIONS.BACKUP_CREATE),
  requireBackupEnabled,
  async (req, res) => {
    try {
      const { manifest, data } = await backupService.createBackup({
        actor: req.authz ? req.authz.actor : null,
      });

      const boundary = `stenograma-backup-${Date.now().toString(36)}`;
      const manifestJson = JSON.stringify(manifest);

      res.setHeader("Content-Type", `multipart/mixed; boundary=${boundary}`);
      res.setHeader("Content-Disposition", 'attachment; filename="stenograma-backup"');

      const parts = [
        `--${boundary}\r\n`,
        'Content-Type: application/json\r\nContent-Disposition: attachment; filename="manifest.json"\r\n\r\n',
        manifestJson,
        `\r\n--${boundary}\r\n`,
        'Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="backup.data"\r\n\r\n',
      ];

      res.write(parts.join(""));
      res.write(data);
      res.end(`\r\n--${boundary}--\r\n`);
    } catch (error) {
      /**
       * Paslapčių aptikimas kopijoje NĖRA serverio klaida – tai politikos
       * pažeidimas, kurį operatorius turi pamatyti kaip tokį.
       */
      if (error.code === "BACKUP_SECRETS_PRESENT") {
        return res.status(409).json({ error: error.message, code: error.code });
      }

      log.error("Kopijos kūrimas nepavyko", { code: error.code });
      return res.status(500).json({ error: "Kopijos sukurti nepavyko." });
    }
  }
);

/**
 * POST /api/admin/backups/restore – atkuria iš įkeltos kopijos.
 */
router.post(
  "/admin/backups/restore",
  rateLimiter,
  authenticate,
  requirePermission(PERMISSIONS.BACKUP_RESTORE),
  requireBackupEnabled,
  uploadBackupParts,
  assertExactlyTwoParts,
  async (req, res) => {
    let manifest;
    try {
      manifest = JSON.parse(req.backupParts.manifest.buffer.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "Manifestas nėra galiojantis JSON.", code: "BACKUP_MANIFEST_INVALID" });
    }

    /**
     * AKTYVŪS DARBAI – 409.
     *
     * ⚠️ Ši patikra viena NEUŽTENKA: tarp jos ir pritaikymo worker'is gali
     * paimti naują darbą (TOCTOU). Todėl pats atkūrimas vykdomas su priežiūros
     * užraktu, kuris naujų darbų nebepriima.
     */
    const active = await countActiveJobs();
    if (active > 0) {
      return res.status(409).json({
        // TIK skaičius, jokio darbų turinio.
        error: `Atkurti negalima: vykdomi ${active} darbai. Palaukite, kol jie baigsis.`,
        code: "ACTIVE_JOBS_PRESENT",
      });
    }

    const outcome = await maintenanceLock.withLock("backup_restore", async () => {
      /**
       * PAKARTOTINĖ patikra JAU SU UŽRAKTU.
       *
       * Pirmoji patikra buvo teisinga tuo momentu, kai ją atlikom. Ši –
       * galutinė: nuo šiol naujų darbų atsirasti nebegali.
       */
      const stillActive = await countActiveJobs();
      if (stillActive > 0) return { conflict: stillActive };

      return restoreService.restoreBackup({
        manifest,
        data: req.backupParts.data.buffer,
        actor: req.authz ? req.authz.actor : null,
      });
    });

    if (!outcome.locked) {
      return res.status(409).json({ error: "Vyksta kita priežiūros operacija.", code: "MAINTENANCE_IN_PROGRESS" });
    }

    if (outcome.value.conflict) {
      return res.status(409).json({
        error: `Atkurti negalima: vykdomi ${outcome.value.conflict} darbai.`,
        code: "ACTIVE_JOBS_PRESENT",
      });
    }

    const result = outcome.value;

    if (!result.ok) {
      /**
       * Grąžinam ŽINGSNĮ ir priežastį, bet ne kelius ar raktus – `restoreService`
       * jų į rezultatą neįdeda (#20 PR2/PR3).
       */
      return res.status(400).json({
        error: "Atkurti nepavyko.",
        code: "RESTORE_FAILED",
        failedStep: result.failedStep,
        reason: result.reason,
      });
    }

    return res.json({
      ok: true,
      completedSteps: result.completedSteps,
      restored: result.restored,
    });
  }
);

/** Aktyvių (nebaigtų) darbų skaičius. */
async function countActiveJobs() {
  const jobs = await jobStore.listAll();
  return jobs.filter((job) => !["completed", "failed"].includes(job.status)).length;
}

module.exports = router;
