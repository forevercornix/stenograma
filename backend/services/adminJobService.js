const jobStore = require("../utils/jobStore");
const { rasytiAudita } = require("../utils/auditWrite");
const { eraseOrphanedJobData } = require("../utils/jobErasure");
const lifecycleService = require("./lifecycleService");
const tombstones = require("../utils/deletionTombstones");
const {
  ERASURE_REASON,
  ACTOR_KIND,
  TOMBSTONE_STATUS,
} = require("../utils/deletionTombstones/states");
const { isSessionAdmin } = require("../utils/jobAccessPolicy");
const { OWNER_KIND } = require("../utils/jobStore/common");
const { createLogger } = require("../utils/logger");

const log = createLogger("service:admin-job");

/**
 * Barjero nulemtos baigtys, kurios NĖRA nei sėkmė, nei valymo gedimas (#183).
 *
 * Vardai sutampa su `lifecycleService.DELETION_STATUS` reikšmėmis SĄMONINGAI:
 * abu keliai atsako tą patį klausimą ir maršrutas juos atvaizduoja vienodai.
 */
const BARRIER_OUTCOME = {
  ALREADY_DELETED: "already_deleted",
  IN_PROGRESS: "in_progress",
  TOMBSTONE_UNRESOLVED: "tombstone_unresolved",
};

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
/**
 * ⚠️ ASYNC NUO 7.4a (#210). `ADMIN_ACCESS_DENIED` yra BLOKUOJANTIS: atmetimas
 * negali būti grąžintas anksčiau, nei patvirtintas audito įrašas.
 */
async function assertSessionAdmin(actor, operation, jobId) {
  if (isSessionAdmin(actor)) return;

  await rasytiAudita({
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
  await assertSessionAdmin(actor, "delete", jobId);

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

  await rasytiAudita({
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
 * NAŠLAIČIO VALYMAS SU IŠTRYNIMO ŽYMA - ŽYMA PIRMA, VALYMAS ANTRAS (#183).
 *
 * ⚠️ TVARKA YRA VISA ESMĖ, IR JI FAIL-CLOSED.
 *
 * Iki šio taisymo abu našlaičių keliai kvietė `eraseOrphanedJobData()` tiesiai,
 * be jokios žymos. Ištrynimas pavykdavo, barjero neatsirasdavo, ir atkūrimas iš
 * senesnės kopijos tą `jobId` vėl priimdavo - lygiai ta spraga, kurią 7.5a
 * uždaro savininko kelyje. Vienas produkcinis ištrynimo kelias be garantijos
 * padarytų `docs/deletion-guarantees.md` apribojimo šalinimą neteisingu.
 *
 * ⚠️ ŽYMOS ĮRAŠYMO KLAIDA NEGAUDOMA - VALYMAS NEVYKSTA.
 *
 * `mark()` klaida reiškia, kad barjero nėra: arba DB nepasiekiama, arba žymų
 * saugykla neinicijuota. Tęsti reikštų negrįžtamai ištrinti duomenis be
 * įrodymo, kad jie ištrinti. Atidėtas valymas atstatomas - našlaitis be `jobs`
 * eilutės valandą nieko nepablogina; valymas be žymos yra negrįžtamas.
 *
 * Tai ta pati tvarka kaip `lifecycleService.deleteJobArtefacts` (#19: žyma PRIEŠ
 * artefaktų šalinimą), pasiekiama per tą patį fasadą - antro lygiagretaus
 * mechanizmo čia neatsiranda.
 *
 * @param {string} jobId
 * @param {"user"|"operator"} actorKind kas veikė; KODĖL - visada `orphan_cleanup`
 */
async function valytiNaslaitiSuZyma(jobId, actorKind) {
  const zyma = await tombstones.mark(jobId, {
    reason: ERASURE_REASON.ORPHAN_CLEANUP,
    actorKind,
  });

  /**
   * ⚠️ PRETENZIJA PRIEŠ DESTRUKTYVŲ I/O (#183, 7.5a DoD).
   *
   * `claimed === false` reiškia, kad žymą įrašė KAŽKAS KITAS. Be šio skirtumo
   * abi replikos matytų tą patį `deletion_pending` įrašą ir abi pradėtų tą patį
   * eilės, saugyklos ir audito trynimą - o viena iš jų dar ir grąžintų 404 ten,
   * kur kita grąžino 204.
   *
   * Nė vienas destruktyvus veiksmas čia NEPRADEDAMAS: DoD to reikalauja
   * eksplicitiškai („jokio papildomo I/O nepradedama").
   */
  if (zyma && zyma.claimed === false) {
    if (zyma.status === TOMBSTONE_STATUS.DELETED) {
      return { outcome: null, success: true, barjeras: BARRIER_OUTCOME.ALREADY_DELETED };
    }

    /**
     * `deletion_failed` NEKARTOJAMAS AUTOMATIŠKAI - žr. `lifecycleService`.
     * Automatinis `failed → pending` apeitų `ERASURE_MARK_RETRIED`, ir būsena
     * nustotų reikšti „operatorius turi įsikišti".
     */
    if (zyma.status === TOMBSTONE_STATUS.FAILED) {
      return { outcome: null, success: false, barjeras: BARRIER_OUTCOME.TOMBSTONE_UNRESOLVED };
    }

    /** Ta pati taisyklė kaip savininko kelyje - viena vieta, ne antra kopija. */
    if (tombstones.heldByAnotherExecutor(zyma)) {
      return { outcome: null, success: false, barjeras: BARRIER_OUTCOME.IN_PROGRESS };
    }
  }

  const outcome = await eraseOrphanedJobData(jobId, { scope: "system" });

  /**
   * Ta pati taisyklė kaip `adminDeleteJob`: sėkmė iš rezultato, ne iš to, kad
   * kvietimas nemetė klaidos. Nepilnas našlaičio valymas reiškia, kad BullMQ
   * ar audito pėdsakai liko - kvietėjas to negali interpretuoti kaip sėkmės.
   */
  const success = !outcome.criticalFailure;

  /**
   * ⚠️ `classifyFailure` IŠ `lifecycleService`, o ne vietinė literalė:
   * nesėkmės kategorija turi vieną autoritetą. Į žymą patenka TIK kategorija -
   * `outcome.errors` tekstuose būna failų kelių ir saugyklos raktų.
   */
  const uzbaigta = await tombstones.complete(
    jobId,
    success ? TOMBSTONE_STATUS.DELETED : TOMBSTONE_STATUS.FAILED,
    success
      ? {}
      : { failureKind: lifecycleService.classifyFailure(outcome.errors[0]) }
  );

  /**
   * ⚠️ SĖKMĖ IŠ GRĄŽINTOS ŽYMOS, NE IŠ TO, KAD KVIETIMAS NEMETĖ (#183).
   *
   * Ta pati taisyklė, kurią servisas jau taiko `eraseOrphanedJobData` rezultatui,
   * pritaikyta ir `complete()`: neleidžiamas perėjimas negrąžina klaidos, jis
   * grąžina esamą būseną. Duomenys ištrinti, barjeras neužtikrintas - trečias
   * atsakymas, nes abu paprastesni meluotų.
   */
  if (success && (!uzbaigta || uzbaigta.status !== TOMBSTONE_STATUS.DELETED)) {
    log.error("Našlaitis išvalytas, bet žymos užbaigti nepavyko", {
      jobId,
      zymosBusena: uzbaigta ? uzbaigta.status : "nėra",
    });

    return { outcome, success: false, barjeras: BARRIER_OUTCOME.TOMBSTONE_UNRESOLVED };
  }

  return { outcome, success, barjeras: null };
}

/**
 * Našlaičio valymas (store įraše NĖRA).
 *
 * Admin-only, nes nuosavybės patikrinti neįmanoma iš principo: likę pėdsakai
 * (BullMQ eilė, auditas) savininko nesaugo. Eilinis vartotojas, žinantis job
 * ID, galėtų ištrinti svetimus pėdsakus.
 */
async function adminCleanupOrphan(jobId, actor) {
  await assertSessionAdmin(actor, "orphan_cleanup", jobId);

  /** `actor_kind=operator`: privilegija panaudota, nuosavybė peržengta. */
  const { outcome, success, barjeras } = await valytiNaslaitiSuZyma(jobId, ACTOR_KIND.OPERATOR);

  /**
   * ⚠️ AUDITAS RAŠOMAS IR TADA, KAI DARBO NEBUVO.
   *
   * `ADMIN_*` fiksuoja PRIVILEGIJOS PANAUDOJIMĄ, o ne ištrynimo darbą: admin
   * peržengė nuosavybę tuo momentu, kai kvietė šį kelią. Praleidus įrašą dėl to,
   * kad barjeras darbą sustabdė, override statistika taptų nepilna.
   */
  await rasytiAudita({
    event: ADMIN_EVENT.ORPHAN_CLEANUP,
    jobId,
    actor: actor.ownerId,
    success,
    details: `override=admin ownershipVerified=false barrier=${barjeras || "none"}`,
  });

  return {
    cleaned: success,
    reason: barjeras || (success ? null : "erasure_incomplete"),
    barjeras,
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
    await rasytiAudita({
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

  /**
   * `actor_kind=user`, NE `operator`.
   *
   * Ta pati logika kaip žemiau esančiame audito paaiškinime: desktop režime
   * privilegijos nėra ir nuosavybės peržengti neįmanoma - veikia pats duomenų
   * subjektas. `operator` žymoje, kuri pergyvena jobą, nurodytų aktorių, kurio
   * nebuvo.
   */
  const { outcome, success, barjeras } = await valytiNaslaitiSuZyma(jobId, ACTOR_KIND.USER);

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
  return {
    cleaned: success,
    reason: barjeras || (success ? null : "erasure_incomplete"),
    barjeras,
    outcome,
  };
}

module.exports = {
  BARRIER_OUTCOME,
  adminDeleteJob,
  adminCleanupOrphan,
  desktopCleanupOrphan,
  AdminOverrideDenied,
  ADMIN_EVENT,
};
