const jobStore = require("../utils/jobStore");
const fileStorage = require("../utils/fileStorage");
const backupPolicy = require("../utils/backupPolicy");
const backupManifest = require("../utils/backupManifest");
const { createLogger } = require("../utils/logger");
const secretsInventory = require("../utils/secretsInventory");
const startupChecks = require("../utils/startupChecks");
const privacyConfig = require("../utils/privacyConfig");
const backupEncryption = require("../utils/backupEncryption");
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
  /** Dešifravimas – po kontrolinės sumos, nes ji dengia šifruotą turinį. */
  DECRYPTED: "decrypted",
  CONTENT: "content_validated",
  /** Konfigūracija — TA PATI validacija kaip paleidžiant sistemą (#14). */
  CONFIGURATION: "configuration_valid",
  /** Paslaptys — kopijoje jų negali būti. */
  SECRETS: "no_secrets_in_backup",
  /** Privatumo režimas — atkurti duomenys negali jo apeiti. */
  PRIVACY: "privacy_compatible",
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

  /**
   * 5. DEŠIFRAVIMAS.
   *
   * PO kontrolinės sumos sąmoningai: suma skaičiuojama nuo to, kas realiai
   * saugoma – t. y. nuo šifruoto turinio. Taip sugadintas failas aptinkamas
   * IŠ KARTO, o ne po nepavykusio dešifravimo, kai priežastis jau būtų
   * dviprasmiška (sugadinta ar netinkamas raktas?).
   */
  let payload = data;

  /**
   * ALGORITMO NUOSEKLUMAS (P2-1).
   *
   * `encrypted: true` be algoritmo arba su nežinomu algoritmu yra nenuoseklus
   * manifestas. Anksčiau laukas buvo tik įrašomas, bet netikrinamas – tad
   * komentaras „kad atkūrimas nespėliotų" nebuvo iki galo įgyvendintas.
   */
  const SUPPORTED_ALGORITHM = `${backupEncryption.ALGORITHM}-${backupEncryption.FORMAT}`;

  /**
   * `encrypted` PRIVALO BŪTI GRIEŽTAS BOOLEAN.
   *
   * `"false"`, `0` ar `null` turi skirtingas truthy/falsy interpretacijas
   * skirtingose vietose – o šis laukas sprendžia, ar apskritai dešifruoti.
   * Neapibrėžtumas čia reikštų, kad manifesto downgrade galimas net be
   * klastojimo, vien dėl tipo painiavos.
   */
  if (typeof manifest.encrypted !== "boolean") {
    return _fail({
      actor,
      manifest,
      completedSteps,
      step: STEPS.DECRYPTED,
      reason: "manifesto `encrypted` privalo būti boolean",
    });
  }

  if (manifest.encrypted && manifest.encryptionAlgorithm !== SUPPORTED_ALGORITHM) {
    /**
     * NEBEPALAIKOMAS FORMATAS – KONKREČIA priežastimi (P2-1).
     *
     * Algoritmo patikra vyksta PRIEŠ envelope analizę, tad be šio atvejo tikra
     * `v1` kopija būtų atmesta kaip „nepalaikomas algoritmas", ir
     * `UNSUPPORTED_FORMATS` paaiškinimas operatoriaus nepasiektų. Jis ieškotų
     * blogo rakto ar sugadinto failo, o problema būtų kita.
     */
    const legacyFormat = String(manifest.encryptionAlgorithm || "").replace(`${backupEncryption.ALGORITHM}-`, "");
    const legacyReason = backupEncryption.UNSUPPORTED_FORMATS[legacyFormat];

    return _fail({
      actor,
      manifest,
      completedSteps,
      step: STEPS.DECRYPTED,
      reason: legacyReason
        ? `kopijos formatas "${legacyFormat}" nebepalaikomas: ${legacyReason}`
        : `nepalaikomas šifravimo algoritmas: ${manifest.encryptionAlgorithm || "nenurodytas"}`,
    });
  }

  /**
   * DOWNGRADE APTIKIMAS: manifestas sako „nešifruota", o duomenys yra envelope.
   *
   * Be šios patikros `encrypted: true → false` klastojimas praeitų pro
   * dešifravimo šaką visai (ji nebūtų vykdoma), ir AAD apsauga nebūtų
   * pasiekta. Gedimas įvyktų vėliau, turinio validacijoje, su klaidinančiu
   * pranešimu „laukas `jobs` privalo būti masyvas" – operatorius ieškotų
   * sugadintos kopijos, o problema būtų suklastotas manifestas.
   *
   * Kontrolinė suma to nesustabdo: ją galima perskaičiuoti.
   */
  if (!manifest.encrypted && _looksLikeEnvelope(data)) {
    return _fail({
      actor,
      manifest,
      completedSteps,
      step: STEPS.DECRYPTED,
      reason: "manifestas sako `encrypted: false`, bet turinys yra šifruotas envelope – manifesto downgrade",
    });
  }

  if (!manifest.encrypted && manifest.encryptionAlgorithm) {
    return _fail({
      actor,
      manifest,
      completedSteps,
      step: STEPS.DECRYPTED,
      reason: "nenuoseklus manifestas: algoritmas nurodytas, bet `encrypted` yra false",
    });
  }

  if (manifest.encrypted) {
    try {
      const envelope = JSON.parse(data.toString("utf8"));

      /**
       * MANIFESTAS perduodamas kaip AAD.
       *
       * Be jo užpuolikas galėtų sukeisti šifruotus turinius tarp kopijų arba
       * suklastoti manifesto teiginius, ir dešifravimas vis tiek pavyktų –
       * kontrolinė suma to nesustabdytų, nes ją galima perskaičiuoti.
       */
      const decrypted = backupEncryption.decrypt(envelope, { env, manifest });
      payload = decrypted.plaintext;

      if (decrypted.usedPreviousKey) {
        /**
         * Operatoriui svarbu ŽINOTI, kad panaudotas senas raktas: tai reiškia,
         * kad kopija dar nepersišifruota, ir po `BACKUP_ENCRYPTION_KEY_PREVIOUS`
         * pašalinimo ji taps neatkuriama.
         */
        log.warn("Atkurta ANKSTESNIU šifravimo raktu – kopija dar nepersišifruota", {
          formatVersion: manifest.formatVersion,
        });
      }
    } catch (error) {
      return _fail({
        actor,
        manifest,
        completedSteps,
        step: STEPS.DECRYPTED,
        // Klaidos KODAS, ne pranešimas: pastarasis gali turėti detalių apie raktą.
        reason: `dešifruoti nepavyko (${error.code || "nežinoma"})`,
      });
    }
  }
  completedSteps.push(STEPS.DECRYPTED);

  // 6. TURINIO PATIKRA (dar NIEKO nekeičiam)
  let parsed;
  try {
    parsed = JSON.parse(payload.toString("utf8"));
  } catch {
    return _fail({ actor, manifest, completedSteps, step: STEPS.CONTENT, reason: "turinys nėra galiojantis JSON" });
  }

  const contentCheck = await _validateContent(parsed);
  if (!contentCheck.valid) {
    return _fail({ actor, manifest, completedSteps, step: STEPS.CONTENT, reason: contentCheck.reason });
  }
  completedSteps.push(STEPS.CONTENT);

  /**
   * 6. PASLAPTYS KOPIJOJE.
   *
   * Kopija NIEKADA neturi turėti raktų ar kredencialų. Jei jų ten atsirado,
   * kopija yra paslapčių nutekėjimas – ir atkurti ją reikštų tą nutekėjimą
   * pakartoti, o dar blogiau, priimti kaip normą.
   *
   * Tikrinamos REIKŠMĖS, ne vardai: kintamojo vardas turinyje būtų
   * nekenksmingas, o reikšmė – ne.
   */
  const leaked = secretsInventory.findLeakedSecrets(payload.toString("utf8"), env);
  if (leaked.length > 0) {
    /**
     * Pranešime — tik VARDAI, niekada reikšmės. Priešingu atveju klaidos
     * tekstas taptų antru nutekėjimo kanalu.
     */
    return _fail({
      actor,
      manifest,
      completedSteps,
      step: STEPS.SECRETS,
      reason: `kopijoje aptikta paslapčių: ${leaked.join(", ")}`,
    });
  }
  completedSteps.push(STEPS.SECRETS);

  /**
   * 7. KONFIGŪRACIJA – TA PATI validacija kaip paleidžiant sistemą.
   *
   * Atkurti duomenys pateks į DABARTINĘ konfigūraciją, ne į tą, kuri veikė
   * kopijos kūrimo metu. Jei dabartinė netinkama, atkūrimas duotų veikiančius
   * duomenis neveikiančioje sistemoje – ir gedimas pasirodytų vėliau, jau
   * atrodydamas kaip atkūrimo problema.
   *
   * Naudojamas `startupChecks.validateConfig`, o ne atskira patikra: dvi
   * validacijos ilgainiui išsiskirtų, ir atkūrimas priimtų tai, ko paleidimas
   * nepriimtų.
   */
  const configCheck = startupChecks.validateConfig(env);
  if (configCheck.errors.length > 0) {
    return _fail({
      actor,
      manifest,
      completedSteps,
      step: STEPS.CONFIGURATION,
      reason: `konfigūracija netinkama: ${configCheck.errors.length} klaidos`,
    });
  }
  completedSteps.push(STEPS.CONFIGURATION);

  /**
   * 8. PRIVATUMO REŽIMAS.
   *
   * ⚠️ ATKURTI DUOMENYS NEGALI APEITI DABARTINĖS KONFIGŪRACIJOS.
   *
   * Efemeriškame režime (`persistentStorage: false`) sistema sąmoningai
   * nesaugo turinio. Atkūrus į ją kopiją, diske atsirastų būtent tai, ko šis
   * režimas žada neturėti – ir žadas taptų melu, nors kiekvienas komponentas
   * atskirai veiktų teisingai.
   *
   * Tai nėra teorinis atvejis: kopija galėjo būti sukurta anksčiau, kai
   * profilis buvo kitoks. Būtent tada tokia patikra ir reikalinga.
   */
  const privacy = privacyConfig.getPrivacyConfig(env);

  /**
   * ⚠️ TIKRINAMAS EKSPLICITINIS `PERSISTENT_STORAGE=false`, ne `persistentStorage`.
   *
   * `persistentStorage` reiškia „Redis saugykla", ir be `REDIS_URL` jis yra
   * `false` net įprastame diegime. Pirmoji šios patikros versija tai supainiojo
   * ir blokavo VISUS atkūrimus atmintinėje saugykloje – t. y. daugumą.
   *
   * Neišsaugojimo režimas yra kitas dalykas: administratorius EKSPLICITIŠKAI
   * nurodė `PERSISTENT_STORAGE=false`, tad sistema žada nelaikyti turinio.
   * Atkūrus į ją kopiją, diske atsirastų būtent tai, ko šis režimas žada
   * neturėti – ir žadas taptų melu, nors kiekvienas komponentas atskirai
   * veiktų teisingai.
   */
  const noPersistenceMode = privacy.persistentExplicit && !privacy.persistentStorage;

  if (noPersistenceMode) {
    return _fail({
      actor,
      manifest,
      completedSteps,
      step: STEPS.PRIVACY,
      reason: "neišsaugojimo režimas (`PERSISTENT_STORAGE=false`) – atkūrimas jį apeitų",
    });
  }

  const privacyCheck = privacyConfig.validatePrivacyConfig(env);
  if (privacyCheck && Array.isArray(privacyCheck.errors) && privacyCheck.errors.length > 0) {
    return _fail({
      actor,
      manifest,
      completedSteps,
      step: STEPS.PRIVACY,
      reason: `privatumo konfigūracija netinkama: ${privacyCheck.errors.length} klaidos`,
    });
  }
  completedSteps.push(STEPS.PRIVACY);

  /**
   * 9. PRITAIKYMAS.
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
 * Ar duomenys atrodo kaip šifruotas envelope?
 *
 * Naudojama downgrade aptikimui. Tikrinami TIK struktūriniai požymiai – jokio
 * dešifravimo bandymo, nes tuo momentu dar nežinom, ar apskritai turėtume.
 */
function _looksLikeEnvelope(data) {
  try {
    const parsed = JSON.parse(data.toString("utf8"));
    return Boolean(
      parsed &&
        typeof parsed === "object" &&
        typeof parsed.format === "string" &&
        typeof parsed.iv === "string" &&
        typeof parsed.authTag === "string" &&
        typeof parsed.ciphertext === "string"
    );
  } catch {
    return false;
  }
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
async function _validateContent(parsed) {
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

  /**
   * ⚠️ BACKEND'O ATSTOVAUJAMUMO PREFLIGHT (#180 P2-E).
   *
   * `_apply()` pirma įrašo VISĄ audio, paskui job'us po vieną. Jei
   * neatstovaujamas įrašas būtų pastebėtas tik jį pasiekus, ankstesni job'ai ir
   * visas audio JAU BŪTŲ pritaikyti - deterministinė turinio klaida virstų
   * DALINIU atkūrimu.
   *
   * Todėl VISI įrašai tikrinami ČIA, „dar NIEKO nekeičiam" fazėje. Naudojamas
   * tas pats autoritetingas validatorius, kurį `restoreRecord()` kviečia kaip
   * gynybą giliai viduje - tik anksčiau ir visiems iš karto.
   */
  for (const job of parsed.jobs) {
    try {
      await jobStore.assertRestorable(job);
    } catch (e) {
      return {
        valid: false,
        reason: `jobas ${job.id} neatstovaujamas aktyvioje saugykloje: ${e.message}`,
      };
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
