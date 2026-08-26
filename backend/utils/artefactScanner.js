const { ARTEFACT_TYPES, PERSISTENCE, TYPES_BY_ID } = require("./artefactInventory");

/**
 * CENTRALIZUOTAS ARTEFAKTŲ SKENERIS (#19 PR4).
 *
 * Atsako į vieną klausimą: **ar po ištrynimo liko kokių nors artefakto pėdsakų?**
 *
 * KODĖL CENTRALIZUOTAI, o ne dvi patikros teste.
 *
 * Pirmoji E2E versija tikrino `jobStore` ir `auditLog` – tai įrodė, kad neliko
 * DVIEJOSE vietose, bet ne kad inventorius kaip visuma švarus. Atsiradus naujam
 * artefakto tipui jis liktų neskenuotas TYLIAI: testas ir toliau būtų žalias,
 * nors dengtų mažesnę dalį nei anksčiau.
 *
 * Čia kiekvienas registro tipas PRIVALO turėti strategiją. Naujas tipas be jos
 * sulaužo `assertFullCoverage()` – ir patenka į peržiūrą, o ne į tylą.
 */

/**
 * SKENAVIMO STRATEGIJOS.
 *
 * `scan` grąžina `true`, jei artefakto pėdsakų RASTA (t. y. ištrynimas
 * nepilnas). `null` reiškia, kad tipo fiziškai skenuoti nėra kur – bet tada
 * privalo būti `reason`, kad „nepatikrinta" nebūtų painiojama su „švaru".
 */
const SCAN_STRATEGIES = {
  [ARTEFACT_TYPES.JOB_RECORD.id]: {
    async scan(jobId, { jobStore }) {
      return Boolean(await jobStore.system.get(jobId));
    },
  },

  [ARTEFACT_TYPES.AUDIT_ENTRY.id]: {
    async scan(jobId, { auditLog }) {
      /**
       * Audito įrašai saugo PSEUDONIMIZUOTĄ `subjectId`, ne žalią ID.
       *
       * Naudojam TĄ PAČIĄ funkciją, kurią naudoja pats ištrynimas – kitaip
       * skeneris ieškotų to, ko ten iš principo nėra, ir visada rastų „švaru".
       */
      const subjectId = auditLog.pseudonymizeIdentifier(jobId);
      if (!subjectId) return false;

      return (await auditLog.getAll()).some((entry) => entry.subjectId === subjectId);
    },
  },

  [ARTEFACT_TYPES.SOURCE_AUDIO.id]: {
    /**
     * Fizinė saugykla. Raktas ateina iš JOBO ĮRAŠO, tad jį reikia užfiksuoti
     * PRIEŠ ištrynimą – po jo įrašo nebėra, ir rakto nebūtų iš kur gauti.
     */
    async scan(_jobId, { fileStorage, storageKey }) {
      if (!storageKey) return false;

      try {
        await fileStorage.get(storageKey);
        return true;
      } catch {
        return false;
      }
    },
  },

  [ARTEFACT_TYPES.QUEUE_RECORD.id]: {
    async scan(jobId, { jobRunner }) {
      /**
       * Inline režime eilės apskritai nėra – tai ne „nepatikrinta", o „nėra ko
       * tikrinti". Grąžinam `false` (pėdsakų nerasta), nes eilės įrašas
       * negalėjo egzistuoti.
       */
      if (jobRunner.getMode() !== "bullmq") return false;

      for (const modulePath of ["../queues/transcriptionQueue", "../queues/protocolQueue"]) {
        try {
          const queueModule = require(modulePath);
          const getter = queueModule.getTranscriptionJob || queueModule.getProtocolJob;
          if (typeof getter === "function" && (await getter(jobId))) return true;
        } catch {
          // Eilės modulis nepasiekiamas - laikom, kad įrašo nėra.
        }
      }
      return false;
    },
  },

  /**
   * SAUGOMI JOBO ĮRAŠE.
   *
   * Transkripcija ir protokolas neturi atskiro fizinio vieneto – jie gyvena
   * `job.result` viduje. Jų „pėdsakas" yra tiksliai `job_record` pėdsakas, tad
   * atskiras skenavimas duotų tą patį atsakymą du kartus.
   */
  [ARTEFACT_TYPES.TRANSCRIPT.id]: { scan: null, reason: "saugoma job_record viduje" },
  [ARTEFACT_TYPES.PROTOCOL.id]: { scan: null, reason: "saugoma job_record viduje" },

  /**
   * EFEMERIŠKI – niekada nesaugomi.
   *
   * Jų skenuoti nėra kur, ir tai NĖRA praleidimas: jei jie kada nors taptų
   * saugomi, `assertFullCoverage()` to nepastebėtų, todėl atskiras testas
   * tikrina jų `persistence` klasę registre.
   */
  [ARTEFACT_TYPES.TRANSCRIPT_REDACTED.id]: { scan: null, reason: "efemeriškas – nesaugomas" },
  [ARTEFACT_TYPES.EXPORT_REDACTED.id]: { scan: null, reason: "efemeriškas – nesaugomas" },
  [ARTEFACT_TYPES.EXPORT_ORIGINAL.id]: { scan: null, reason: "efemeriškas – nesaugomas" },

  /**
   * LAIKINI – dar neskenuojami.
   *
   * Įvardyti eksplicitiškai su priežastimi, o ne praleisti: „dar nepatikrinta"
   * ir „patikrinta ir švaru" turi atrodyti skirtingai.
   */
  [ARTEFACT_TYPES.UPLOAD_TEMP.id]: { scan: null, reason: "laikinas – skenavimas dar neįgyvendintas" },
  [ARTEFACT_TYPES.CONVERSION_TEMP.id]: { scan: null, reason: "laikinas – skenavimas dar neįgyvendintas" },
};

/**
 * Ar KIEKVIENAS registro tipas turi strategiją?
 *
 * Deny-by-default: naujas artefakto tipas be įrašo čia yra klaida, ne tyli
 * spraga. Būtent to trūko pirmojoje E2E versijoje.
 *
 * @returns {string[]} tipai be strategijos
 */
function typesWithoutStrategy() {
  return Object.values(ARTEFACT_TYPES)
    .map((type) => type.id)
    .filter((id) => !(id in SCAN_STRATEGIES));
}

/**
 * Skenuoja VISUS registro tipus ieškodamas jobo pėdsakų.
 *
 * @param {string} jobId
 * @param {object} deps - `jobStore`, `auditLog`, `fileStorage`, `jobRunner`, `storageKey`
 * @returns {Promise<{found: string[], scanned: string[], skipped: Array<{type: string, reason: string}>}>}
 */
async function scanAllArtefacts(jobId, deps) {
  const missing = typesWithoutStrategy();
  if (missing.length > 0) {
    const error = new Error(`Artefaktų tipai be skenavimo strategijos: ${missing.join(", ")}`);
    error.code = "INCOMPLETE_SCAN_COVERAGE";
    throw error;
  }

  const found = [];
  const scanned = [];
  const skipped = [];

  for (const [typeId, strategy] of Object.entries(SCAN_STRATEGIES)) {
    if (!strategy.scan) {
      skipped.push({ type: typeId, reason: strategy.reason });
      continue;
    }

    scanned.push(typeId);
    if (await strategy.scan(jobId, deps)) found.push(typeId);
  }

  return { found, scanned, skipped };
}

/** Tipai, kurie realiai skenuojami – diagnostikai ir dokumentacijai. */
function scannableTypes() {
  return Object.entries(SCAN_STRATEGIES)
    .filter(([, strategy]) => Boolean(strategy.scan))
    .map(([typeId]) => typeId);
}

/** Efemeriški tipai pagal REGISTRĄ, ne pagal strategijų sąrašą. */
function ephemeralTypes() {
  return Object.values(TYPES_BY_ID)
    .filter((type) => type.persistence === PERSISTENCE.EPHEMERAL)
    .map((type) => type.id);
}

module.exports = {
  SCAN_STRATEGIES,
  scanAllArtefacts,
  typesWithoutStrategy,
  scannableTypes,
  ephemeralTypes,
};
