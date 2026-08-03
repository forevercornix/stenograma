const { loadUsers } = require("./credentials");
const { resolveApiKeyRole } = require("../middleware/authorize");
const { hasPermission, PERMISSIONS } = require("./permissions");
const { createLogger } = require("./logger");
const auditLog = require("./auditLog");

const log = createLogger("job-authz");

/**
 * JOBO AUTORIZACIJA VYKDYMO METU (#18 PR3).
 *
 * KLAUSIMAS, kurį reikėjo atsakyti: ar asinchroninio jobo teisės UŽŠALDOMOS
 * kūrimo metu, ar PERSKAIČIUOJAMOS vykdymo metu?
 *
 * PASIRINKTA: perskaičiuojamos.
 *
 * Priežastis praktinė. Jobai gali laukti eilėje minutes ar valandas (ilgas
 * įrašas, užimtas worker'is, restartas). Per tą laiką vartotojas gali būti
 * pašalintas iš `AUTH_USERS` arba jo rolė sumažinta – būtent tada, kai to
 * labiausiai reikia (kompromituota paskyra, išėjęs darbuotojas). Užšaldytos
 * teisės reikštų, kad revokacija neveikia atgaline data, ir atleistas
 * darbuotojas vis dar gautų protokolą iš eilėje laukiančio jobo.
 *
 * KAINA, kurią priimam sąmoningai: rolės sumažinimas nutraukia JAU EILĖJE
 * esančius darbus. Tai teisingesnė pusė – geriau nutraukti teisėtą darbą, nei
 * įvykdyti neteisėtą.
 *
 * KO NEDAROMA: sesijos atsijungimas (logout) NENUTRAUKIA jobo. Sesija yra
 * prisijungimo, ne teisės, mechanizmas – vartotojas teisėtai pradėjo darbą ir
 * uždaręs naršyklę jo neatšaukė. Nutraukiama tik tada, kai dingsta PATI
 * TAPATYBĖ ar teisė.
 */

/** Rezultato priežastys – atskiros, kad auditas ir logai rodytų TIKSLIAI kas nutiko. */
const DENY_REASON = {
  /** Vartotojo nebėra `AUTH_USERS` – paskyra pašalinta arba pervadinta. */
  ACTOR_UNKNOWN: "actor_unknown",
  /** Vartotojas yra, bet jo dabartinė rolė nebeturi reikiamo leidimo. */
  PERMISSION_REVOKED: "permission_revoked",
  /** Jobas be aktoriaus metaduomenų – sukurtas iki #18 arba be tapatybės. */
  NO_ACTOR: "no_actor",
};

/**
 * Perskaičiuoja aktoriaus rolę DABAR, o ne pasitiki jobo įrašu.
 *
 * @returns {string|null} dabartinė rolė arba `null`, jei aktoriaus nebėra.
 */
function resolveCurrentRole(job, env = process.env) {
  /**
   * API rakto keliui rolė ateina iš konfigūracijos, ne iš vartotojų sąrašo.
   *
   * Naudojam TĄ PAČIĄ `resolveApiKeyRole()` funkciją kaip HTTP sluoksnis
   * (#18 PR2), o ne savo kopiją. Pirmoji versija čia darė tik
   * `.trim().toLowerCase()` ir grąžindavo bet kokią reikšmę - tad neteisinga
   * `API_KEY_ROLE=manager` būtų grąžinusi `"manager"`, o `hasPermission()`
   * tada tyliai atmestų viską (deny-by-default), atrodydama kaip revokacija,
   * ne kaip konfigūracijos klaida.
   *
   * Praktiškai startup validacija tokios reikšmės neįleidžia, bet dvi
   * nepriklausomos apsaugos pigiau nei viena - ir, svarbiau, dvi kopijos tos
   * pačios logikos ilgainiui išsiskiria.
   */
  if (job.actorSource === "api-key") {
    return resolveApiKeyRole(env);
  }

  if (job.actorSource === "session" && job.actor) {
    const users = loadUsers(env);
    const user = users.get(job.actor);
    return user ? user.role : null;
  }

  return null;
}

/**
 * Ar jobą DAR galima vykdyti?
 *
 * @returns {{allowed: boolean, reason?: string, role?: string}}
 */
function authorizeJobExecution(job, permission = PERMISSIONS.JOB_CREATE, env = process.env) {
  /**
   * JOBAI BE `actorSource` PRALEIDŽIAMI.
   *
   * ⚠️ LEMIAMAS LAUKAS YRA `actorSource`, NE `actor`.
   *
   * Pirmoji versija tikrino `!job.actor && !job.actorSource` – t. y.
   * reikalavo, kad trūktų ABIEJŲ. Bet `actor` egzistuoja nuo #17
   * (koreliacijai), o `actorSource` – tik nuo #18. Todėl KIEKVIENAS #17 laikų
   * jobas turėjo `actor` be `actorSource`, ir `resolveCurrentRole()` jam
   * grąžindavo `null` → visi tokie darbai buvo atmetami kaip `actor_unknown`.
   *
   * Rasta CI'e su tikru Redis: 0 iš 6 jobų pasiekė procesorių. Mano paties
   * testai to nepagavo, nes tikrino tik `{ actor: null, actorSource: null }` –
   * derinį, kurio realiai beveik nebūna.
   *
   * Be `actorSource` rolės nustatyti NEĮMANOMA, tad blokavimas reikštų, kad
   * atnaujinus sistemą visi eilėje laukiantys darbai tyliai miršta. Jų teisę
   * jau patikrino HTTP sluoksnis kūrimo metu.
   */
  if (!job || !job.actorSource) {
    return { allowed: true, reason: DENY_REASON.NO_ACTOR };
  }

  const currentRole = resolveCurrentRole(job, env);

  if (!currentRole) {
    return { allowed: false, reason: DENY_REASON.ACTOR_UNKNOWN };
  }

  if (!hasPermission(currentRole, permission)) {
    return { allowed: false, reason: DENY_REASON.PERMISSION_REVOKED, role: currentRole };
  }

  return { allowed: true, role: currentRole };
}

/**
 * Autorizuoja ir, jei neleidžiama, ĮRAŠO audito įvykį.
 *
 * Audito įrašas čia būtinas: jobo nutraukimas dėl revokacijos atrodo lygiai
 * taip pat kaip techninis gedimas, jei niekur nefiksuojama priežastis.
 */
function authorizeJobOrAudit(job, jobId, permission = PERMISSIONS.JOB_CREATE, env = process.env) {
  const decision = authorizeJobExecution(job, permission, env);

  if (!decision.allowed) {
    auditLog.record({
      event: "JOB_EXECUTION_DENIED",
      success: false,
      outcome: decision.reason,
      // Aktoriaus ID rašomas, nes jis JAU yra jobo įraše ir audite (#17) -
      // naujos informacijos tai neatskleidžia. Kredencialų čia nėra jokių.
      details: `jobId=${jobId} permission=${permission} reason=${decision.reason}`,
    });

    log.warn("Jobo vykdymas atmestas", { jobId, permission, reason: decision.reason });
  }

  return decision;
}

module.exports = { authorizeJobExecution, authorizeJobOrAudit, resolveCurrentRole, DENY_REASON };
