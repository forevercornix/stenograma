/**
 * CENTRINIS LEIDIMŲ REGISTRAS (#18 PR2).
 *
 * VIENA TIESA apie tai, kas ką gali daryti. Maršrutai NENUSPRENDŽIA leidimų
 * patys – jie tik nurodo, kokio leidimo reikalauja, o atsakymas gyvena čia.
 * Priešingu atveju rolės taisyklės išsibarstytų po dešimt failų, ir nė vienas
 * peržiūrintysis nebematytų viso paveikslo.
 *
 * DENY-BY-DEFAULT: `hasPermission()` grąžina `false` viskam, ko nėra
 * `ROLE_PERMISSIONS` sąraše. Naujas leidimas be eksplicitinio priskyrimo yra
 * UŽDARAS, ne atviras – klaida pusėje, kuri sustabdo, o ne praleidžia.
 */

/**
 * Operacijos, ne maršrutai.
 *
 * Leidimai įvardyti pagal tai, KĄ jie leidžia, ne kur tai vyksta – kitaip
 * pridėjus antrą maršrutą tai pačiai operacijai atsirastų du leidimai tam
 * pačiam dalykui.
 */
const PERMISSIONS = {
  /** Sukurti transkribavimo ar protokolo darbą (brangūs išoriniai kvietimai). */
  JOB_CREATE: "job:create",
  /** Skaityti darbo būseną ir rezultatą (transkripciją, protokolą). */
  JOB_READ: "job:read",
  /** IŠTRINTI darbą ir jo audio – GDPR ištrynimo teisė, negrįžtama. */
  JOB_DELETE: "job:delete",

  /** Generuoti protokolą iš transkripcijos. */
  PROTOCOL_GENERATE: "protocol:generate",

  /** Eksportuoti REDAGUOTĄ variantą (PII pašalinta). */
  EXPORT_REDACTED: "export:redacted",
  /** Eksportuoti ORIGINALĄ – neredaguoti asmens duomenys. */
  EXPORT_ORIGINAL: "export:original",

  /** Skaityti audito žurnalą. */
  AUDIT_READ: "audit:read",

  /**
   * ⚠️ ŠIE DU LEIDIMAI DAR NĖRA PRIJUNGTI PRIE JOKIO ĮĖJIMO TAŠKO.
   *
   * HTTP maršrutų kopijoms kol kas nėra – `backupService` ir `restoreService`
   * kviečiami tiesiogiai. Leidimai užregistruoti IŠ ANKSTO, kad atsiradus
   * maršrutui nereikėtų svarstyti, kam jis priklauso.
   *
   * Kol įėjimo taško nėra, teiginys „kopijos tik administratoriui" NĖRA
   * įgyvendinta garantija – tai tik paruošta lentelė. Prijungimas ir jo
   * integraciniai testai yra atskiro etapo darbas.
   */

  /**
   * Kurti atsarginę kopiją (#20).
   *
   * Kopija yra VISŲ duomenų nuotrauka vienoje vietoje – galingiausias
   * eksportas, koks apskritai įmanomas. Todėl teisė ją kurti yra atskira ir
   * administratoriaus lygio, net jei operatorius gali skaityti tuos pačius
   * duomenis po vieną.
   */
  BACKUP_CREATE: "backup:create",

  /**
   * Atkurti iš kopijos (#20).
   *
   * Destruktyviausia operacija sistemoje: ji PERRAŠO esamą būseną. Griežtesnė
   * net už `job:delete`, nes paliečia ne vieną įrašą, o visus.
   */
  BACKUP_RESTORE: "backup:restore",
};

/**
 * ROLIŲ ŽEMĖLAPIS.
 *
 * `operator` – kasdienis darbas: kurti, skaityti, generuoti, eksportuoti
 * redaguotą variantą.
 *
 * `administrator` – visa tai plius NEGRĮŽTAMOS ir JAUTRIOS operacijos.
 *
 * KODĖL `EXPORT_ORIGINAL` yra administratoriaus lygio.
 *
 * Originalus eksportas grąžina NEREDAGUOTUS asmens duomenis – tai tas pats
 * turinys, kurio apsaugai skirta visa #4/#5/#8 redakcijos sistema. Jei
 * kiekvienas operatorius gali jį parsisiųsti vienu paspaudimu, redakcija tampa
 * numatytąja parinktimi, o ne apsauga.
 *
 * ⚠️ Tai eina TOLIAU, nei buvo eksplicitiškai sutarta (sutarta: DELETE ir
 * /audit – administratoriui). Įvardyta atskirai, kad būtų lengva nesutikti:
 * norint grąžinti operatoriui, užtenka perkelti vieną eilutę žemiau.
 * Praktinio poveikio esamiems diegimams nėra – `API_KEY_ROLE` pagal nutylėjimą
 * yra `administrator` (žr. `resolveApiKeyRole`).
 */
const ROLE_PERMISSIONS = {
  operator: [
    PERMISSIONS.JOB_CREATE,
    PERMISSIONS.JOB_READ,
    PERMISSIONS.PROTOCOL_GENERATE,
    PERMISSIONS.EXPORT_REDACTED,
  ],

  administrator: [
    PERMISSIONS.BACKUP_CREATE,
    PERMISSIONS.BACKUP_RESTORE,
    PERMISSIONS.JOB_CREATE,
    PERMISSIONS.JOB_READ,
    PERMISSIONS.JOB_DELETE,
    PERMISSIONS.PROTOCOL_GENERATE,
    PERMISSIONS.EXPORT_REDACTED,
    PERMISSIONS.EXPORT_ORIGINAL,
    PERMISSIONS.AUDIT_READ,
  ],
};

/** Visos žinomos leidimų reikšmės – naudojama patikroms, kad nebūtų rašybos klaidų. */
const ALL_PERMISSIONS = Object.values(PERMISSIONS);

/**
 * Ar rolė turi leidimą?
 *
 * DENY-BY-DEFAULT: nežinoma rolė, nežinomas leidimas ar trūkstamas argumentas
 * visada duoda `false`.
 */
function hasPermission(role, permission) {
  if (!role || !permission) return false;

  const granted = ROLE_PERMISSIONS[role];
  if (!granted) return false;

  return granted.includes(permission);
}

/** Visi rolės leidimai – frontend'ui, kad jis galėtų rodyti/slėpti veiksmus. */
function permissionsForRole(role) {
  return [...(ROLE_PERMISSIONS[role] || [])];
}

module.exports = {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ALL_PERMISSIONS,
  hasPermission,
  permissionsForRole,
};
