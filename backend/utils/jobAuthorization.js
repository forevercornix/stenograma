const { loadUsers, loadUsersById } = require("./credentials");
const { resolveApiKeyRole } = require("../middleware/authorize");
const { hasPermission, PERMISSIONS } = require("./permissions");
const { createLogger } = require("./logger");
const { rasytiAudita } = require("./auditWrite");

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
 * ĮRAŠO EROS INVARIANTAS (#158).
 *
 * Vienas šaltinis abiem įėjimams (`authorizeJobExecution` ir
 * `resolveCurrentRole`). Dubliuota patikra dviejose vietose ilgainiui
 * išsiskirtų, o skirtumas būtų būtent toks, kokį ši funkcija ir saugo:
 * nežinoma era, tyliai apsimetusi žinoma.
 *
 * `== null` SĄMONINGAI: „eros nėra" yra teisėta pre-v2 būsena, o Redis lauko
 * nebuvimą grąžina kaip `null` (tuščias string'as deserializacijoje), ne
 * `undefined`. Griežta `undefined` patikra būtų metusi klaidą kiekvienam
 * legacy job'ui iš Redis.
 */
function assertSupportedSchemaVersion(job) {
  /**
   * `null` job'as yra TEISĖTAS įėjimas – `authorizeJobExecution()` jį
   * praleidžia kaip `NO_ACTOR` (žr. `!job ||` patikrą ten). Invariantas neturi
   * to keisti: jis saugo nuo nežinomos EROS, ne nuo trūkstamo įrašo.
   */
  if (!job) return;

  if (job.schemaVersion != null && job.schemaVersion !== 2) {
    throw new Error(
      `Nepalaikoma job schemaVersion: ${job.schemaVersion} (job ${job.id}). ` +
        "Nauja era turi gauti savo maršrutizavimo šaką, ne paveldėti senąją."
    );
  }
}

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
  /**
   * Tikrinama PRIEŠ `actorSource` maršrutizavimą: `schemaVersion: 3` kitaip
   * nukristų į legacy šaką, jo `actor` būtų aiškinamas kaip vardas, ir dar
   * būtų užterštas legacy WARN signalas.
   */
  assertSupportedSchemaVersion(job);

  if (job.actorSource === "api-key") {
    return resolveApiKeyRole(env);
  }

  if (job.actorSource === "session" && job.actor) {
    /**
     * ERA, NE FORMA (#158).
     *
     * Repo turi TRIS eras, ir jos skiriasi ne aktoriaus eilutės forma, o įrašo
     * `schemaVersion`. Forma netiktų: vardo šablonas įleidžia UUID formos
     * vardą, o API rakto aktorius (`key_<hex>`) irgi nėra UUID.
     */
    if (job.schemaVersion === 2) {
      /**
       * `actor` yra stabilus `userId`. Nerastas ID reiškia IŠTRINTĄ vartotoją
       * → `ACTOR_UNKNOWN`.
       *
       * LEGACY FALLBACK ČIA BŪTŲ KLAIDA: ištrinto vartotojo įvykiai užterštų
       * WARN signalą, pagal kurį sprendžiama, kada legacy šaką galima šalinti.
       */
      const user = loadUsersById(env).get(job.actor);
      return user ? user.role : null;
    }

    /**
     * LEGACY (#18 era, be `schemaVersion`): `actor` yra vartotojo vardas.
     *
     * Šaka šalinama ATSKIRU PR po maksimalaus job TTL / retencijos lango nuo
     * diegimo. WARN leidžia stebėti, kada ji nustoja suveikti; jis SĄMONINGAI
     * atskiras nuo `ACTOR_UNKNOWN`, kad du signalai nesimaišytų.
     */
    log.warn(
      { jobId: job.id, event: "legacy_actor_lookup" },
      "Job be schemaVersion - tapatybė sprendžiama pagal vardą (#158 legacy šaka)"
    );
    const user = loadUsers(env).get(job.actor);
    return user ? user.role : null;
  }

  /**
   * ŽINOMA ERA, NEŽINOMAS `actorSource` → KONTROLIUOJAMA KLAIDA.
   *
   * Tylus `null` čia atrodytų kaip `ACTOR_UNKNOWN` (t. y. „vartotojas
   * ištrintas") ir paslėptų konfigūracijos ar kodo klaidą. Pre-v2 įrašams
   * paliekamas `null`: jų `actorSource` reikšmių rinkinys jau užfiksuotas
   * istorijoje ir keistis nebegali.
   */
  if (job.schemaVersion === 2) {
    throw new Error(`Nežinomas actorSource: ${job.actorSource}`);
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
   * EROS INVARIANTAS TIKRINAMAS PIRMAS – VIRŠ #17 short-circuit'o.
   *
   * Žemiau esanti `!job.actorSource` šaka praleidžia įrašą su `allowed: true`
   * ir niekada nekviečia `resolveCurrentRole()`. Be šios eilutės įrašas
   * `{schemaVersion: 3, actorSource: null}` apeitų eros patikrą ir būtų
   * PALEISTAS kaip #17 legacy – blogesnis atvejis nei klaidingas atmetimas,
   * nes nežinomos eros darbas realiai įvyktų.
   *
   * #17 semantika nekeičiama: `schemaVersion` nesantis ar `null` toliau
   * praeina į passthrough šaką.
   */
  assertSupportedSchemaVersion(job);

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
/**
 * ⚠️ ASYNC NUO 7.4a (#210 eksplicitiškai įvardija šią funkciją).
 *
 * Iki cutover ji kvietė `auditLog.record()` sinchroniškai ir NELAUKĖ. Po
 * `record()` async pakeitimo tas pats kodas taptų fire-and-forget: job'as būtų
 * atmestas, o audito įrašas galėtų niekada neatsirasti. `JOB_EXECUTION_DENIED`
 * yra BLOKUOJANTIS - atmetimas negali būti deklaruotas be patvirtinto įrašo.
 */
async function authorizeJobOrAudit(job, jobId, permission = PERMISSIONS.JOB_CREATE, env = process.env) {
  const decision = authorizeJobExecution(job, permission, env);

  if (!decision.allowed) {
    await rasytiAudita({
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

module.exports = {
  authorizeJobExecution,
  authorizeJobOrAudit,
  resolveCurrentRole,
  DENY_REASON,
  /**
   * Eksportuojama, kad DB `CHECK` aibė būtų tikrinama prieš ŠĮ autoritetą, o ne
   * prieš jo kopiją teste (`tests/dbRuntimeParity.integration.test.js`).
   */
  assertSupportedSchemaVersion,
};
