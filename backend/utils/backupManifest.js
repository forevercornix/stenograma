const crypto = require("crypto");
const backupPolicy = require("./backupPolicy");

/**
 * ATSARGINĖS KOPIJOS MANIFESTAS (#20 PR1).
 *
 * Manifestas yra kopijos „pasas": jis atsako, KADA ji sukurta, KOKIA politika
 * galiojo, KAS į ją pateko ir AR turinys nepakitęs.
 *
 * KODĖL BE JO NEUŽTENKA.
 *
 * Kopija be manifesto yra failų rinkinys, apie kurį nieko negalima teigti.
 * Atkuriant tektų spėti: ar formatas suderinamas? ar turinys pilnas? ar tai
 * kopija iš prieš savaitę, ar iš prieš metus? Kiekvienas spėjimas yra vieta,
 * kur atkūrimas gali tyliai duoti ne tai, ko tikėtasi.
 *
 * ⚠️ MANIFESTE NĖRA ASMENS DUOMENŲ. Jame tik metaduomenys: tipai, skaičiai,
 * kontrolinės sumos. Manifestą turi būti galima peržiūrėti nepasiekiant paties
 * turinio – kitaip diagnostika reikštų prieigą prie duomenų.
 */

/** Privalomi manifesto laukai. Trūkstant bet kurio, kopija laikoma netinkama. */
const REQUIRED_FIELDS = [
  "formatVersion",
  "applicationVersion",
  "createdAt",
  "policy",
  "contents",
  "checksum",
];

/**
 * Programos versija, su kuria kopija sukurta.
 *
 * ATSKIRA nuo `formatVersion` sąmoningai. Formato versija atsako „ar šią kopiją
 * apskritai galima perskaityti"; programos versija – „kokia sistema ją sukūrė".
 * Jos keičiasi nepriklausomai: daug programos leidimų gali dalintis tuo pačiu
 * formatu.
 *
 * Operatoriui tai svarbu PRIEŠ atkūrimą: iš manifesto iš karto matyti, ar kopija
 * iš tos pačios versijos, ar iš gerokai senesnės – nereikia jos išpakuoti, kad
 * tai sužinotum.
 */
function applicationVersion() {
  try {
    return require("../package.json").version || "unknown";
  } catch {
    /**
     * `package.json` gali būti nepasiekiamas supakuotoje aplinkoje. Manifestas
     * dėl to neturi tapti negaliojantis – geriau įrašyti `unknown`, nei
     * sustabdyti kopijavimą dėl metaduomens.
     */
    return "unknown";
  }
}

/**
 * Sukuria manifestą.
 *
 * @param {object} params
 * @param {Array<{type: string, count: number, bytes: number}>} params.contents
 * @param {string} params.checksum - viso turinio kontrolinė suma
 * @param {object} [params.env]
 */
function createManifest({ contents, checksum, env = process.env }) {
  if (!Array.isArray(contents)) {
    throw _manifestError("Manifesto `contents` privalo būti masyvas.");
  }
  if (!checksum) {
    throw _manifestError("Manifestas be kontrolinės sumos – tokios kopijos vientisumo patikrinti nebūtų kaip.");
  }

  const policy = backupPolicy.policySnapshot(env);

  /**
   * TIPAI, KURIŲ NETURĖTŲ BŪTI.
   *
   * Tikrinama KURIANT, ne tik atkuriant: kopija su efemerišku artefaktu
   * reikštų antrą asmens duomenų kopiją ten, kur jos sąmoningai nebuvo. Tokią
   * klaidą pigiau sustabdyti kūrimo metu, nei aptikti po metų.
   */
  const forbidden = contents.filter((entry) => !backupPolicy.isIncluded(entry.type));

  if (forbidden.length > 0) {
    throw _manifestError(
      `Kopijoje yra tipų, kurių politika neleidžia: ${forbidden.map((f) => f.type).join(", ")}.`
    );
  }

  return {
    formatVersion: policy.formatVersion,
    applicationVersion: applicationVersion(),
    createdAt: new Date().toISOString(),
    policy,
    contents,
    checksum,

    /**
     * Retencijos terminas įrašomas Į MANIFESTĄ, ne skaičiuojamas atkuriant.
     *
     * Politika gali pasikeisti; kopijai galioja ta, kuri veikė ją kuriant.
     * Priešingu atveju sumažinus `BACKUP_RETENTION_DAYS` senos kopijos staiga
     * taptų „pasibaigusiomis" atgaline data, o padidinus – atgytų.
     */
    expiresAt: new Date(Date.now() + policy.retentionDays * 24 * 60 * 60 * 1000).toISOString(),
  };
}

function _manifestError(message) {
  const error = new Error(message);
  error.code = "BACKUP_MANIFEST_INVALID";
  return error;
}

/**
 * Patikrina manifestą PRIEŠ atkūrimą.
 *
 * FAIL-CLOSED: bet kuri abejonė reiškia atsisakymą. Atkūrimas iš kopijos,
 * kuria negalima pasitikėti, yra blogiau nei atsisakymas – jis atrodo kaip
 * sėkmė.
 *
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateManifest(manifest) {
  const errors = [];

  if (!manifest || typeof manifest !== "object") {
    return { valid: false, errors: ["manifesto nėra arba jis netinkamo tipo"] };
  }

  for (const field of REQUIRED_FIELDS) {
    if (manifest[field] === undefined || manifest[field] === null) {
      errors.push(`trūksta privalomo lauko: ${field}`);
    }
  }

  if (errors.length > 0) return { valid: false, errors };

  /**
   * ⚠️ FORMATO VERSIJA ČIA NETIKRINAMA SĄMONINGAI.
   *
   * `validateManifest` atsako tik į STRUKTŪROS klausimą: ar manifestas turi
   * visus laukus ir ar jų tipai teisingi. Versijų suderinamumas yra ATSKIRAS
   * atkūrimo grandinės žingsnis (`restoreService`).
   *
   * Pirmoji versija tikrino ir čia, ir grandinėje – ir tai reiškė, kad
   * grandinės „formato" žingsnis niekada nebuvo pasiekiamas: nesuderinama
   * kopija krisdavo dar struktūros patikroje. Diagnostika tada meluodavo –
   * operatorius matytų „manifestas netinkamas", nors manifestas buvo tvarkingas,
   * tik iš naujesnės versijos.
   */

  if (!Array.isArray(manifest.contents)) {
    errors.push("`contents` privalo būti masyvas");
  } else {
    /**
     * Ar kopijoje nėra tipų, kurių dabartinė politika neleidžia?
     *
     * Tai gali nutikti su SENA kopija, sukurta kitokia politika – pvz. kai
     * eksportai dar buvo saugomi. Atkūrus ją, atsirastų duomenų, kurių sistema
     * nebeturi teisės laikyti.
     */
    const forbidden = manifest.contents.filter((entry) => !backupPolicy.isIncluded(entry.type));
    if (forbidden.length > 0) {
      errors.push(
        `kopijoje yra tipų, kurių dabartinė politika neleidžia: ${forbidden.map((f) => f.type).join(", ")}`
      );
    }
  }

  if (!isValidTimestamp(manifest.createdAt)) errors.push("`createdAt` nėra galiojanti data");
  if (manifest.expiresAt && !isValidTimestamp(manifest.expiresAt)) {
    errors.push("`expiresAt` nėra galiojanti data");
  }

  return { valid: errors.length === 0, errors };
}

function isValidTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

/**
 * Ar kopija pasibaigusi?
 *
 * Pasibaigusi kopija NĖRA automatiškai netinkama atkūrimui – ji tiesiog turėjo
 * būti pašalinta. Sprendimą, ką su ja daryti, priima operatorius; funkcija tik
 * atsako į faktą.
 */
function isExpired(manifest, now = Date.now()) {
  if (!manifest || !manifest.expiresAt) return false;
  const expires = Date.parse(manifest.expiresAt);
  return Number.isFinite(expires) && expires <= now;
}

/**
 * Turinio kontrolinė suma.
 *
 * ⚠️ SUMA APSAUGO NUO SUGADINIMO, NE NUO PAKEITIMO.
 *
 * SHA-256 čia aptinka nutrūkusį įrašymą, sugedusį diską ar nepilną perkėlimą.
 * Ji NEAPSAUGO nuo tyčinio kopijos pakeitimo: kas gali pakeisti turinį, gali
 * perskaičiuoti ir sumą, nes jokios paslapties čia nedalyvauja.
 *
 * Apsaugai nuo pakeitimo reikia parašo su raktu (HMAC ar asimetrinis parašas),
 * o tai priklauso raktų valdymo etapui. Iki tol kopijų vientisumas remiasi
 * SAUGYKLOS prieigos kontrole, ne šia suma – ir taip turi būti suprantama
 * grėsmių modelyje.
 */
function computeChecksum(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/** Ar turinys atitinka manifeste nurodytą sumą? */
function verifyChecksum(manifest, buffer) {
  if (!manifest || !manifest.checksum) return false;
  return computeChecksum(buffer) === manifest.checksum;
}

module.exports = {
  REQUIRED_FIELDS,
  createManifest,
  validateManifest,
  isExpired,
  computeChecksum,
  verifyChecksum,
};
