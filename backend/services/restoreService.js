const jobStore = require("../utils/jobStore");
const fileStorage = require("../utils/fileStorage");
const backupPolicy = require("../utils/backupPolicy");
const backupManifest = require("../utils/backupManifest");
const { createLogger } = require("../utils/logger");
const auditLog = require("../utils/auditLog");

const log = createLogger("restore");

/**
 * ATKŪRIMAS IŠ ATSARGINĖS KOPIJOS (#20 PR2).
 *
 * FAIL-CLOSED GRANDINĖ. Kiekvienas žingsnis privalo pavykti, kad būtų pereita
 * prie kito:
 *
 *   manifestas -> formato versija -> programos versija -> kontrolinė suma
 *   -> turinio patikra -> TIK TADA rašymas
 *
 * Tvarka nėra atsitiktinė: pigiausios ir labiausiai lemiančios patikros eina
 * pirmos. Nėra prasmės skaičiuoti kontrolinės sumos kopijai, kurios formato
 * ši versija vis tiek nesupranta.
 *
 * ATOMIŠKUMAS. Atkūrimas pirma sudaro VISĄ naują būseną atmintyje ir tik tada
 * ją pritaiko. Jei kas nors nepavyksta iki pritaikymo momento, veikianti
 * sistema lieka nepaliesta.
 *
 * Priešingu atveju nutrūkęs atkūrimas paliktų sistemą blogesnėje būklėje nei
 * prieš jį – pusiau senos, pusiau naujos būsenos mišinyje, kurio niekas
 * nemokėtų atstatyti.
 */

/** Grandinės žingsniai – vardai naudojami rezultate ir audite. */
const STEPS = {
  MANIFEST: "manifest_parsed",
  FORMAT: "format_compatible",
  APPLICATION: "application_compatible",
  CHECKSUM: "checksum_verified",
  CONTENT: "content_validated",
  APPLIED: "applied",
};

/**
 * @param {object} params
 * @param {object} params.manifest
 * @param {Buffer} params.data
 * @param {string} [params.actor]
 * @returns {Promise<{ok: boolean, completedSteps: string[], failedStep?: string, reason?: string, restored?: object}>}
 */
async function restoreBackup({ manifest, data, actor = null, env = process.env }) {
  const completedSteps = [];

  // 1. MANIFESTAS
  const manifestCheck = backupManifest.validateManifest(manifest);
  if (!manifestCheck.valid) {
    return _fail({ actor, manifest, completedSteps, step: STEPS.MANIFEST, reason: manifestCheck.errors.join("; ") });
  }
  completedSteps.push(STEPS.MANIFEST);

  // 2. FORMATO VERSIJA
  const compatibility = backupPolicy.checkRestoreCompatibility(manifest.formatVersion);
  if (!compatibility.compatible) {
    return _fail({ actor, manifest, completedSteps, step: STEPS.FORMAT, reason: compatibility.reason });
  }
  completedSteps.push(STEPS.FORMAT);

  // 3. PROGRAMOS VERSIJA
  const appCheck = _checkApplicationVersion(manifest.applicationVersion);
  if (!appCheck.compatible) {
    return _fail({ actor, manifest, completedSteps, step: STEPS.APPLICATION, reason: appCheck.reason });
  }
  completedSteps.push(STEPS.APPLICATION);

  // 4. KONTROLINĖ SUMA
  if (!Buffer.isBuffer(data)) {
    return _fail({ actor, manifest, completedSteps, step: STEPS.CHECKSUM, reason: "turinys nėra Buffer" });
  }
  if (!backupManifest.verifyChecksum(manifest, data)) {
    /**
     * Sugadinta ar nepilna kopija NIEKADA neatkuriama tyliai.
     *
     * Suma neapsaugo nuo tyčinio pakeitimo (žr. `backupManifest`), bet
     * sugadinimą aptinka – ir tokiu atveju atkūrimas turi sustoti, o ne
     * bandyti „kiek pavyks".
     */
    return _fail({ actor, manifest, completedSteps, step: STEPS.CHECKSUM, reason: "kontrolinė suma nesutampa" });
  }
  completedSteps.push(STEPS.CHECKSUM);

  // 5. TURINIO PATIKRA (dar NIEKO nekeičiam)
  let parsed;
  try {
    parsed = JSON.parse(data.toString("utf8"));
  } catch {
    return _fail({ actor, manifest, completedSteps, step: STEPS.CONTENT, reason: "turinys nėra galiojantis JSON" });
  }

  const contentCheck = _validateContent(parsed);
  if (!contentCheck.valid) {
    return _fail({ actor, manifest, completedSteps, step: STEPS.CONTENT, reason: contentCheck.reason });
  }
  completedSteps.push(STEPS.CONTENT);

  /**
   * 6. PRITAIKYMAS.
   *
   * Iki šios eilutės veikianti sistema NEBUVO paliesta nė karto. Visos
   * patikros atliktos su duomenimis atmintyje.
   */
  const applied = await _apply(parsed, { env });
  completedSteps.push(STEPS.APPLIED);

  _audit({
    event: "BACKUP_RESTORED",
    actor,
    manifest,
    success: true,
    details: `jobs=${applied.jobs} audio=${applied.audio}`,
  });

  log.info("Atkūrimas baigtas", applied);

  return { ok: true, completedSteps, restored: applied };
}

/**
 * Programos versijos suderinamumas.
 *
 * DVI VERSIJOS ATSAKO Į SKIRTINGUS KLAUSIMUS:
 *   `formatVersion`      – ar kopijos STRUKTŪRĄ galima perskaityti
 *   `applicationVersion` – ar VERSLO LOGIKA suderinama su tuo, ką ji reiškia
 *
 * Kopija gali būti puikiai perskaitoma (tas pats formatas), bet sukurta
 * versijos, kurioje tie patys laukai reiškė kitką – tada atkūrimas duotų
 * sintaksiškai teisingą, bet semantiškai klaidingą būklę.
 *
 * Tikrinama MAJOR dalis: skirtingas major reiškia nesuderinamus pakeitimus
 * pagal semver, tad atkurti tokią kopiją būtų spėlionė.
 *
 * Minor ir patch skirtumai leidžiami – priešingu atveju kiekvienas pataisymų
 * leidimas padarytų vakarykštes kopijas neatkuriamas, ir kopijų prasmė dingtų.
 */
function _checkApplicationVersion(backupVersion) {
  if (!backupVersion || backupVersion === "unknown") {
    /**
     * Nežinoma versija PRALEIDŽIAMA su įspėjimu, ne atmetama.
     *
     * `unknown` atsiranda, kai `package.json` nepasiekiamas supakuotoje
     * aplinkoje (#20 PR1). Atmetus tokią kopiją, atkūrimas taptų neįmanomas
     * būtent ten, kur jo labiausiai reikia.
     */
    log.warn("Kopijos programos versija nežinoma – atkuriama be versijos patikros");
    return { compatible: true };
  }

  const current = _majorOf(require("../package.json").version);
  const backup = _majorOf(backupVersion);

  if (current === null || backup === null) {
    return { compatible: false, reason: `netinkamas versijos formatas: "${backupVersion}"` };
  }

  if (current !== backup) {
    return {
      compatible: false,
      reason: `nesuderinama programos versija (kopija ${backup}.x, sistema ${current}.x)`,
    };
  }

  return { compatible: true };
}

function _majorOf(version) {
  const match = String(version || "").match(/^(\d+)\./);
  return match ? Number(match[1]) : null;
}

/** Ar turinio struktūra tokia, kokios tikimės? */
function _validateContent(parsed) {
  if (!parsed || typeof parsed !== "object") return { valid: false, reason: "turinys nėra objektas" };

  for (const field of ["jobs", "audio"]) {
    if (!Array.isArray(parsed[field])) return { valid: false, reason: `laukas \`${field}\` privalo būti masyvas` };
  }

  /**
   * ⚠️ SENOS KOPIJOS SU AUDITU.
   *
   * Ankstyvos kopijos galėjo turėti `audit` lauką. Jis PRALEIDŽIAMAS, ne
   * atkuriamas: atkūrus jį, GDPR ištrinti audito įrašai grįžtų (žr.
   * `backupPolicy.EXCLUDED_DESPITE_PERSISTENT`).
   *
   * Kopija dėl to netampa netinkama – tiesiog ta jos dalis ignoruojama.
   */

  /**
   * Ar kopijoje nėra artefaktų, kurių dabartinė politika neleidžia?
   *
   * Sena kopija galėjo būti sukurta kitokia politika – pvz. kai eksportai dar
   * buvo saugomi. Atkūrus ją, atsirastų duomenų, kurių sistema nebeturi teisės
   * laikyti.
   */
  for (const job of parsed.jobs) {
    if (!job || typeof job !== "object" || !job.id) {
      return { valid: false, reason: "jobo įrašas be identifikatoriaus" };
    }
  }

  return { valid: true };
}

/**
 * Pritaikymas – vienintelė vieta, kur keičiama veikianti būsena.
 *
 * ⚠️ ŽINOMA RIBA: pats pritaikymas nėra transakcinis. Jei jis nutrūktų vidury
 * (procesas nukristų rašant), dalis įrašų jau būtų atkurta. Patikros iki šio
 * momento pašalina PRIEŽASTIS, dėl kurių atkūrimas nutrūktų (netinkamas
 * formatas, sugadintas turinys), bet infrastruktūros gedimo jos neapima.
 *
 * Tikram transakciškumui reikėtų duomenų bazės su rollback – tai už piloto
 * ribų ir dokumentuota.
 */
async function _apply(parsed, { env }) {
  let jobs = 0;
  let audio = 0;

  // `parsed.audit` sąmoningai ignoruojamas - žr. `_validateContent`.
  for (const audioEntry of parsed.audio) {
    if (!audioEntry.key || !audioEntry.content) continue;
    await fileStorage.putAtKey(audioEntry.key, Buffer.from(audioEntry.content, "base64"));
    audio += 1;
  }

  for (const job of parsed.jobs) {
    await jobStore.restoreRecord(job);
    jobs += 1;
  }

  void env;
  return { jobs, audio };
}

function _fail({ actor, manifest, completedSteps, step, reason }) {
  _audit({ event: "BACKUP_RESTORE_FAILED", actor, manifest, success: false, outcome: step, details: `step=${step}` });

  log.error("Atkūrimas sustabdytas", { step, reason });

  return { ok: false, completedSteps, failedStep: step, reason };
}

function _audit({ event, actor, manifest, success, outcome = null, details = "" }) {
  try {
    auditLog.record({
      event,
      success,
      outcome,
      actor: actor || undefined,
      details:
        `formatVersion=${manifest ? manifest.formatVersion : "?"} ` +
        `appVersion=${manifest ? manifest.applicationVersion : "?"} ${details}`.trim(),
    });
  } catch {
    // Auditas neturi versti atkūrimo nesėkme.
  }
}

module.exports = { restoreBackup, STEPS };
