const jobStore = require("../utils/jobStore");
const auditLog = require("../utils/auditLog");
const { eraseOrphanedJobData } = require("../utils/jobErasure");
const lifecycleService = require("./lifecycleService");
const { isSessionAdmin } = require("../utils/jobAccessPolicy");
const { OWNER_KIND } = require("../utils/jobStore/common");
const { createLogger } = require("../utils/logger");

const log = createLogger("service:admin-job");

/**
 * ADMINISTRACINIS JOB TRYNIMAS (#160).
 *
 * KODĖL ATSKIRAS SERVISAS, O NE `jobStore.system` MARŠRUTE.
 *
 * #159 įvedė sargą (`tests/systemNamespaceBoundary.test.js`), draudžiantį
 * privilegijuotą namespace'ą `routes/` sluoksnyje. Admin override yra būtent
 * ta vieta, kur norisi jį apeiti „tik šįkart" – todėl privilegija sutelkiama
 * čia, viename siaurame servise, kuris įrašytas į sargo allowlist su
 * pagrindimu ir pats audituoja kiekvieną panaudojimą.
 *
 * DEFENSE-IN-DEPTH. Servisas PATS pakartotinai tikrina session-admin
 * invariantą, o ne aklai pasitiki maršruto teiginiu „čia admin". Jis turi
 * teisėtą prieigą prie `jobStore.system`, tad yra paskutinė riba prieš
 * privilegijuotą kelią – klaida maršrute neturi jos praverti.
 *
 * KO ŠIS SERVISAS NEDARO. Jis nesprendžia 403 vs 404 ir neinterpretuoja
 * `FORBIDDEN`/`null`. Tai politikos (`utils/jobAccessPolicy.js`) ir transporto
 * sluoksnio darbas. Servisas tik VYKDO jau priimtą sprendimą.
 */

/** Audito įvykiai – atskiri, kad override nebūtų neatskiriamas nuo įprasto trynimo. */
const ADMIN_EVENT = Object.freeze({
  DELETE_OVERRIDE: "ADMIN_DELETE_OVERRIDE",
  ORPHAN_CLEANUP: "ADMIN_ORPHAN_CLEANUP",
  ACCESS_DENIED: "ADMIN_ACCESS_DENIED",
});

class AdminOverrideDenied extends Error {
  constructor(message) {
    super(message);
    this.name = "AdminOverrideDenied";
    this.code = "ADMIN_OVERRIDE_DENIED";
  }
}

/**
 * Pakartotinė invarianto patikra + audito įrašas apie NEPAVYKUSĮ bandymą.
 *
 * Nesėkmingas bandymas audituojamas SĄMONINGAI: be jo incidento analizė
 * matytų tik sėkmingus override'us, o bandymai juos gauti liktų nematomi.
 * Įraše NĖRA jokio job turinio – tik pseudonimas ir aktorius.
 */
function assertSessionAdmin(actor, operation, jobId) {
  if (isSessionAdmin(actor)) return;

  auditLog.record({
    event: ADMIN_EVENT.ACCESS_DENIED,
    jobId,
    actor: actor ? actor.ownerId : null,
    success: false,
    details: `operation=${operation} ownerKind=${actor ? actor.ownerKind : "none"}`,
  });

  log.warn(
    { operation, ownerKind: actor ? actor.ownerKind : null },
    "Atmestas administracinis override – iškviečiantysis nėra session-admin"
  );

  throw new AdminOverrideDenied(
    "Administracinis override leidžiamas tik sesijos tapatybei su administrator role."
  );
}

/**
 * Svetimo arba LEGACY job'o ištrynimas (įrašas store'e YRA).
 *
 * Atskirtas nuo našlaičių valymo sąmoningai: čia nuosavybė žinoma (tik ne
 * iškviečiančiojo), o našlaičio atveju jos apskritai nėra su kuo palyginti.
 *
 * @param {string} jobId
 * @param {{ownerId: string|null, ownerKind: string, role: string}} actor
 */
async function adminDeleteJob(jobId, actor) {
  assertSessionAdmin(actor, "delete", jobId);

  const job = await jobStore.system.get(jobId);
  if (!job) {
    /**
     * Job'as dingo tarp politikos sprendimo ir šio kvietimo.
     *
     * FAIL-CLOSED: NEpereinam tyliai į našlaičių valymą. Tai atskiras
     * sprendimas, kurį turi priimti politika iš naujo – kitaip lenktynės
     * paverstų `DELETE` operaciją kita operacija be jokio pėdsako.
     */
    return { deleted: false, reason: "vanished" };
  }

  /**
   * SĖKMĖ IŠVEDAMA IŠ REZULTATO, NE IŠ TO, KAD PROMISE UŽSIBAIGĖ.
   *
   * `eraseJob()` gali grąžinti `criticalFailure` (saugyklos, eilės ar jobStore
   * trynimas nepavyko) ir vis tiek sėkmingai resolve'intis. Anksčiau čia buvo
   * `success: true` besąlygiškai – auditas rodytų sėkmingą override, nors
   * duomenys liko, o maršrutas pagal `deleted: true` grąžintų 204.
   *
   * Naudojamas `lifecycleService`, o NE tiesioginis `eraseJob()`: jis jau turi
   * sėkmės kriterijų (`DELETED` / `PARTIAL` / `FAILED` / `ALREADY_DELETED` +
   * `complete`), tvarko tombstone'us ir ištrynimo kvitus. Antras lygiagretus
   * kriterijus neišvengiamai išsiskirtų su esamu savininko keliu.
   */
  const result = await lifecycleService.deleteJobArtefacts(job, jobId, {
    actor: actor.ownerId,
  });

  auditLog.record({
    event: ADMIN_EVENT.DELETE_OVERRIDE,
    jobId,
    actor: actor.ownerId,
    success: result.complete,
    details:
      `override=admin ownerKind=${job.ownerKind || "legacy"} ` +
      `status=${result.status}`,
  });

  return {
    deleted: result.complete,
    reason: result.complete ? null : "erasure_incomplete",
    result,
  };
}

/**
 * Našlaičio valymas (store įraše NĖRA).
 *
 * Admin-only, nes nuosavybės patikrinti neįmanoma iš principo: likę pėdsakai
 * (BullMQ eilė, auditas) savininko nesaugo. Eilinis vartotojas, žinantis job
 * ID, galėtų ištrinti svetimus pėdsakus.
 */
async function adminCleanupOrphan(jobId, actor) {
  assertSessionAdmin(actor, "orphan_cleanup", jobId);

  const outcome = await eraseOrphanedJobData(jobId, { scope: "system" });

  /**
   * Ta pati taisyklė kaip `adminDeleteJob`: sėkmė iš rezultato, ne iš to, kad
   * kvietimas nemetė klaidos. Nepilnas našlaičio valymas reiškia, kad BullMQ
   * ar audito pėdsakai liko – kvietėjas to negali interpretuoti kaip sėkmės.
   */
  const success = !outcome.criticalFailure;

  auditLog.record({
    event: ADMIN_EVENT.ORPHAN_CLEANUP,
    jobId,
    actor: actor.ownerId,
    success,
    details: "override=admin ownershipVerified=false",
  });

  return {
    cleaned: success,
    reason: success ? null : "erasure_incomplete",
    outcome,
  };
}

/**
 * Našlaičio valymas VIENO VARTOTOJO režime (desktop / no-auth).
 *
 * Atskiras įėjimas, o ne `adminCleanupOrphan` su atlaisvinta patikra: kiekvienas
 * privilegijuotas kelias turi savo EKSPLICITINĮ invariantą. Bendras metodas su
 * dviem sąlygomis greitai taptų vieta, kur viena iš jų tyliai iškrenta.
 */
async function desktopCleanupOrphan(jobId, actor) {
  if (!actor || actor.ownerKind !== OWNER_KIND.UNOWNED) {
    auditLog.record({
      event: ADMIN_EVENT.ACCESS_DENIED,
      jobId,
      actor: actor ? actor.ownerId : null,
      success: false,
      details: `operation=desktop_orphan_cleanup ownerKind=${actor ? actor.ownerKind : "none"}`,
    });
    throw new AdminOverrideDenied(
      "Desktop našlaičių valymas leidžiamas tik režime be autentifikacijos."
    );
  }

  const outcome = await eraseOrphanedJobData(jobId, { scope: "system" });
  const success = !outcome.criticalFailure;

  /**
   * ATSKIRO AUDITO ĮRAŠO ČIA NĖRA – SĄMONINGAI.
   *
   * `ADMIN_*` įvykiai fiksuoja PRIVILEGIJOS PANAUDOJIMĄ: kas ir kieno duomenis
   * pasiekė peržengdamas nuosavybę. Desktop režime privilegija nepanaudota –
   * ten vienas vartotojas ir nėra nuosavybės, kurią būtų galima peržengti.
   *
   * Patį ištrynimą jau dokumentuoja `DATA_ERASED` kvitas (`writeDeletionReceipt`).
   * Antras įrašas jį tik dubliuotų ir iškreiptų override statistiką – pagal
   * `ADMIN_*` įvykių skaičių nebebūtų galima pasakyti, kiek kartų realiai
   * naudotasi privilegija.
   */
  return { cleaned: success, reason: success ? null : "erasure_incomplete", outcome };
}

module.exports = {
  adminDeleteJob,
  adminCleanupOrphan,
  desktopCleanupOrphan,
  AdminOverrideDenied,
  ADMIN_EVENT,
};
