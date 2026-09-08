const path = require("path");
const fs = require("fs").promises;

const jobStore = require("./jobStore");
const auditLog = require("./auditLog");
const tombstones = require("./deletionTombstones");
const {
  ERASURE_REASON,
  ACTOR_KIND,
  TOMBSTONE_STATUS,
} = require("./deletionTombstones/states");
const { rasytiAudita } = require("./auditWrite");
const fileStorage = require("./fileStorage");
const { getPrivacyPolicy } = require("./privacyPolicy");
const { createLogger } = require("../utils/logger");

/** Vieno ciklo riba - žr. `_valytiPasenusiusJobus`. */
const JOBU_BATCH = 500;
const log = createLogger("retention");

/**
 * AUTOMATINIS RETENCIJOS ŠALINIMAS (GDPR issue #2).
 *
 * Iki šiol veikė tik `jobStore.sweepExpired()` (jobo metaduomenys + rezultatas)
 * ir audito `purgeExpired()` rašymo/skaitymo metu. Trūko trijų dalykų:
 *
 *   1) NUSKENDĘ (orphan) audio failai. Failas trinamas po galutinio jobo statuso,
 *      bet jei procesas nukrito tarp `putFile()` ir jobo užbaigimo, storage
 *      kataloge lieka failas, kurio nebeturi nė vienas jobas. Niekas jo nešalino.
 *   2) Audito retencija be srauto. `purgeExpired()` kviečiamas tik rašant ar
 *      skaitant - nustojus naudoti sistemą pasenę įrašai likdavo.
 *   3) Įrašo, KAD šalinimas įvyko. GDPR reikalauja parodyti, jog retencijos
 *      politika realiai veikia, o ne tik aprašyta README.
 *
 * Šalinimo įvykiai rašomi kaip `RETENTION_PURGE` su kiekiais - be jokių
 * identifikatorių, failų vardų ar turinio (`subjectId` = null).
 */

const AUDIO_PREFIX = "uploads";

/**
 * Nuskendę audio failai: senesni nei `audioRetentionHours` IR nepaminėti nė
 * viename gyvame jobe. Amžiaus riba būtina - kitaip ištrintume ką tik įkeltą
 * failą, kurio jobas dar tik kuriamas.
 */
async function purgeOrphanedAudio({ now = Date.now(), retentionHours } = {}) {
  const config = getPrivacyPolicy();
  const maxAgeMs = (retentionHours || config.audioRetentionHours) * 60 * 60 * 1000;

  const dir = path.join(path.resolve(fileStorage.STORAGE_DIR), AUDIO_PREFIX);

  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (e) {
    if (e && e.code === "ENOENT") return { removed: 0, skipped: 0 };
    throw e;
  }

  // Raktai, kuriuos DAR naudoja bet kuris gyvas jobas - NEPRIKLAUSOMAI nuo statuso
  // ar vėliavų.
  //
  // KLAIDA, kurią tai taiso: anksčiau čia buvo renkami tik `deletion_pending` ir
  // `audio_cleanup_pending` jobai. Todėl paprastas `queued`/`processing` jobas su
  // senesniu nei AUDIO_RETENTION_HOURS audio (4 val. įrašas, užstrigusi eilė, GPU
  // trūkumas, maža retencijos reikšmė) būdavo palaikomas orphan ir jo failas
  // IŠTRINAMAS dar apdorojant - jobas krisdavo be jokio ryšio su priežastimi.
  const referencedList = await jobStore.system.listReferencedStorageKeys();

  if (referencedList === null) {
    // Saugykla neleidžia išvardyti jobų - tada NIEKO netrinam. Geriau likęs
    // failas nei ištrintas naudojamas.
    log.warn(
      "Retencija: saugykla nepalaiko listReferencedStorageKeys() - " +
        "nuskendusių audio failų šalinimas praleidžiamas (fail-safe)."
    );
    return { removed: 0, skipped: 0, skippedReason: "unsupported-store" };
  }

  const referenced = new Set(referencedList);

  let removed = 0;
  let skipped = 0;

  for (const entry of entries) {
    const key = `${AUDIO_PREFIX}/${entry}`;

    if (referenced.has(key)) {
      skipped += 1;
      continue;
    }

    let stat;
    try {
      stat = await fs.stat(path.join(dir, entry));
    } catch {
      continue;
    }

    if (!stat.isFile() || now - stat.mtimeMs < maxAgeMs) {
      skipped += 1;
      continue;
    }

    try {
      if (await fileStorage.del(key)) removed += 1;
    } catch (e) {
      // Nekritinė: bus pakartota kitą ciklą. Bet nenutylim.
      log.error(`Retencija: nepavyko ištrinti ${key}: ${e.message}`);
      skipped += 1;
    }
  }

  return { removed, skipped };
}

/**
 * PASENUSIŲ JOB'Ų VALYMAS SU IŠTRYNIMO ŽYMA (#183).
 *
 * ⚠️ ANKSČIAU ŠIS KELIAS BARJERO NEPALIKDAVO.
 *
 * `jobStore.sweepExpired()` bendru `DELETE` pašalindavo pasenusius job'us, ir
 * `ERASURE_REASON.RETENTION_POLICY` neturėjo NĖ VIENO produkcinio kvietėjo -
 * reikšmė buvo apibrėžta, bet niekur nenaudojama. Pasibaigusio termino jobas
 * dingdavo be žymos, o `restoreRecord()` po to tą ID iš senesnės kopijos
 * priimdavo: ištrynimas atsistatydavo.
 *
 * ⚠️ Tai buvo ir `docs/deletion-guarantees.md` teiginio „barjerą palieka VISI
 * ištrynimo keliai" paneigimas - dokumentacija buvo stipresnė už kodą.
 *
 * Tvarka ta pati kaip visur: žyma PIRMA, šalinimas antras.
 *
 * ⚠️ PRETENZIJA, NE VIEN ŽYMA. Jei jobą tuo metu jau trina kita replika ar
 * vartotojo `DELETE`, pretenzijos negaunam ir job'o NELIEČIAM - antraip
 * retencija dubliuotų destruktyvų darbą ir lenktyniautų dėl to paties įrašo.
 *
 * ⚠️ APRIBOTAS BATCH. Retencija gali rasti tūkstančius pasenusių job'ų;
 * neapribotas ciklas laikytų pool'ą ir audito rašymą užimtą neapibrėžtą laiką.
 * Likusieji išvalomi kitame cikle - ta pati tvarka kaip audito retencijoje.
 */
async function _valytiPasenusiusJobus(now) {
  const kandidatai = await jobStore.listExpired(now, JOBU_BATCH);

  let pasalinta = 0;
  let praleista = 0;

  for (const jobId of kandidatai) {
    const { vykdytojas } = await tombstones.claimForDeletion(jobId, {
      reason: ERASURE_REASON.RETENTION_POLICY,
      actorKind: ACTOR_KIND.SYSTEM,
    });

    /** Jobą jau tvarko kitas vykdytojas - retencija nesikiša. */
    if (!vykdytojas) {
      praleista += 1;
      continue;
    }

    try {
      const nuimta = await jobStore.system.remove(jobId);
      if (nuimta) pasalinta += 1;

      await tombstones.complete(jobId, TOMBSTONE_STATUS.DELETED);
    } catch (e) {
      /**
       * Šalinimas nepavyko po pretenzijos - žyma privalo tai atspindėti, kitaip
       * ji liktų `deletion_pending` be vykdytojo ir kiekvienas vėlesnis kelias
       * gautų „jau vykdoma" amžinai.
       */
      await tombstones
        .complete(jobId, TOMBSTONE_STATUS.FAILED, { failureKind: "retryable" })
        .catch(() => {});

      throw e;
    }
  }

  /**
   * ⚠️ BACKEND'O VIDINĖ PRIEŽIŪRA - TIK KAI KANDIDATŲ NEBUVO IŠVIS.
   *
   * `sweepExpired()` Redis režime genėja `jobs:index` (priežiūra), o
   * `postgres`/`memory` režimuose TRINA bendru `DELETE`, nežiūrėdamas į žymas.
   *
   * ⚠️ PIRMOJI ŠIO SARGO VERSIJA BUVO PER SILPNA, IR TESTAS TAI PAGAVO.
   * Ji leido priežiūrą, kai batch'as nepilnas - bet tada bendras `DELETE`
   * pašalindavo BŪTENT tuos job'us, kuriuos ciklas sąmoningai praleido dėl
   * svetimos pretenzijos. Retencija atimdavo darbą iš kito vykdytojo ir dar be
   * žymos.
   *
   * Kai kandidatų nebuvo, `postgres`/`memory` režimuose `sweepExpired()`
   * neranda ko trinti, o Redis atlieka savo indekso priežiūrą.
   */
  if (kandidatai.length === 0) {
    await jobStore.sweepExpired(now);
  }

  return { pasalinta, praleista };
}

/**
 * MAKSIMALI VIENO RAŠYMO TRUKMĖ — EURISTIKA, NE IŠVEDIMAS (#157, PR-5, sąlyga 4c).
 *
 * ⚠️ IŠ KO KILO. `pending` registro eilutė atsiranda PRIEŠ `put()`, o laikinas failas nuo
 * PR-5 turi APSKAIČIUOJAMĄ vardą — tad šlavėjas galėtų ištrinti vykstančio rašymo
 * laikinąjį failą. Prikėlimo horizonto čia neužtenka: `revivalHorizonsMs()` atsako „kada
 * eilė gali prikelti darbą", ne „kiek gali trukti vienas rašymas". Dvi skirtingos
 * trukmės, sutampančios tik atsitiktinai.
 *
 * ⚠️ KODĖL EURISTIKA, O NE IŠVEDIMAS. Viršutinės rašymo trukmės ribos nėra ne todėl, kad
 * jos neapskaičiavome, o todėl, kad JOS NIEKAS NEAPIBRĖŽIA: `fs` `put()` timeout'o
 * neturi, `s3` naudoja AWS SDK numatytuosius, o `API_TIMEOUT_MS` yra `httpClient`
 * konstanta ir saugyklų neliečia. Vienintelis realus rėmas yra `MAX_RESULT_BYTES`
 * (20 MiB numatyta), bet be timeout'o jis trukmės neriboja.
 *
 * ⚠️ KADA NUSTOTŲ GALIOTI: pridėjus saugyklos užklausos timeout'ą. Tada šis narys
 * privalo tapti IŠVEDIMU iš jo, o ne likti pasirinktu skaičiumi. Ta pati forma kaip
 * `MAX_SEGMENTO_BAITAI` (#294): riba, kuri žino savo pačios galiojimo sąlygą.
 *
 * Vienas rašymas, trunkantis ilgiau nei valandą, šiandien reikštų pakibusį procesą, o ne
 * lėtą saugyklą — o pakibusio proceso eilutė teisėtai tampa šluotina.
 */
const MAX_RASYMO_TRUKME_MS = 60 * 60 * 1000;

/**
 * REZULTATO BANDYMŲ ŠLAVIMAS (#157, PR-5).
 *
 * ⚠️ ŽINGSNIS STABDOMAS VISAS, JEI ŽYMŲ SAUGYKLA NĖRA `postgres` (sąlyga 3a).
 *
 * Retencijos predikatas remiasi DVIEM apsaugomis: nuoroda ir neišspręsta ištrynimo žyma.
 * Atminties režime `erasure_marks` lentelė lieka tuščia, tad antra šaka neapsaugotų NIEKO,
 * o pirmoji gina tik REFERENCUOTUS objektus — būtent tuos, kurių šlavėjas ir neliečia.
 * Vadinasi liktų nulis apsaugų tai kategorijai, kurią šlavėjas trina.
 *
 * Sąlyga 8 (DB invariantas „daugiausia vienas įsipareigotas") čia NĖRA pakaitalas dėl tos
 * pačios priežasties: ji sako, kuris bandymas referencuotas, o šlavėjo dalykas yra
 * nereferencuoti.
 */
/**
 * ⚠️ `now` ČIA SĄMONINGAI NEPERDUODAMAS — AMŽIŲ SKAIČIUOJA DB LAIKRODIS.
 *
 * Kiti retencijos žingsniai gauna `now` iš kvietėjo (testams). Čia palyginimas vyksta
 * SQL sakinyje prieš `now()`, ir tai ne praleidimas: `created_at` rašo DB, tad lyginant
 * su programos laiku bet koks nesutapimas tarp aplikacijos ir bazės laikrodžių taptų
 * paslinkta riba — o visas 4b klausimas kaip tik ir yra apie nepatikimas laiko žymas.
 * Kaina: šio žingsnio negalima „pasukti į priekį" iš testo, tad ribos tikrinamos
 * senindant EILUTES, ne laiką.
 */
async function _valytiRezultatoBandymus() {
  const tuscias = { pasalinta: 0, praleista: 0, pazeidimai: 0, nevykdyta: false };

  /**
   * ⚠️ TIKRINAMA EFEKTYVI TIKROVĖ, NE DEKLARACIJA (Codex, #304; #245 pamoka).
   *
   * Ankstesnė redakcija lygino VARDĄ (`tombstones.backend !== "postgres"`). Bet abu
   * komponentai gali būti „postgres" ir rodyti į SKIRTINGAS bazes — tada kandidatų
   * užklausa skaito tuščią `erasure_marks` šalia `job_result_attempts`, ir žymų šaka
   * tyliai negina NIEKO. Būtent ta apsauga yra sąlygos 3a esmė.
   *
   * #245 ta pačią klaidą jau ištaisė kitoje vietoje: `arDviprasmiskaKonfiguracija` buvo
   * perrašyta iš vardų palyginimo į EFEKTYVIŲ PARAMETRŲ palyginimą, ir
   * `jungtiesTapatybe()` egzistuoja kaip tik šiam klausimui. Čia jis panaudojamas
   * tiesiogiai.
   */
  const zymuTapatybe = tombstones.jungtiesTapatybe ? tombstones.jungtiesTapatybe() : null;
  const bandymuTapatybe = await jobStore.system.jungtiesTapatybe().catch(() => null);
  const { tapatybesTekstas } = require("./pgConnection");

  const tosPacios =
    zymuTapatybe &&
    bandymuTapatybe &&
    tapatybesTekstas(zymuTapatybe) === tapatybesTekstas(bandymuTapatybe);

  if (!tosPacios) {
    /**
     * ⚠️ PRANEŠAMA VIENĄ KARTĄ, ŽINGSNIO LYGIU — ne kaip N praleistų eilučių. Priešingu
     * atveju konfigūracijos klaida atrodytų kaip normalus fail-closed darbas.
     */
    log.warn(
      "Retencija: žymos ir bandymų registras NE TOJE PAČIOJE bazėje - rezultato bandymų " +
        "šlavimas NEVYKDOMAS (žymų šaka apsaugotų nulį nereferencuotų objektų).",
      {
        stage: "attempt_sweep_skipped",
        zymos: tapatybesTekstas(zymuTapatybe),
        bandymai: tapatybesTekstas(bandymuTapatybe),
      }
    );
    return { ...tuscias, nevykdyta: true };
  }

  const { revivalHorizonsMs } = require("../queues/config");
  const horizontas = revivalHorizonsMs().horizonMs;

  const { kandidatai, praleista } = await jobStore.system.valytiniBandymai({
    atmestuRibaMs: horizontas,
    laukianciuRibaMs: horizontas + MAX_RASYMO_TRUKME_MS,
    kiekis: JOBU_BATCH,
  });

  if (praleista > 0) {
    /**
     * ⚠️ 7.5a PRECEDENTAS: „FAIL-SAFE nėra klaida - tai sąmoningas atsisakymas spėlioti.
     * Bet jis privalo būti matomas: tyliai praleistas valymas atrodytų kaip valymas."
     */
    log.warn(
      `Retencija: ${praleista} bandymo eilutė(-ės) praleista - \`created_at\` ateityje ` +
        "(tikėtina, atkurta iš dump'o su šaltinio laiko žymomis)."
    );
  }

  const verdiktai = await jobStore.system.sweepResultArtifacts(kandidatai);

  if (verdiktai === null) {
    log.warn("Retencija: saugykla nepalaiko `sweepResultArtifacts()` - šlavimas NEVYKDOMAS.");
    return { ...tuscias, praleista, nevykdyta: true };
  }

  let pasalinta = 0;
  let pazeidimai = 0;
  const uzdarytini = [];

  for (const v of verdiktai) {
    if (v.verdiktas === "pazeidimas") {
      pazeidimai += 1;
      log.error("Retencija: INVARIANTO PAŽEIDIMAS bandymų registre", {
        stage: "attempt_sweep_violation",
        raktas: v.storageKey,
        priezastis: v.priezastis,
      });
      continue;
    }

    if (v.verdiktas === "nepavyko") {
      log.warn(`Retencija: bandymo objekto pašalinti nepavyko (${v.storageKey}): ${v.priezastis}`);
      continue;
    }

    if (v.verdiktas === "pasalinta") pasalinta += 1;

    /**
     * ⚠️ EILUTĖ ŠALINAMA TIK TADA, KAI OBJEKTO TIKRAI NEBĖRA. Eilutė yra vienintelis
     * adresas; pašalinus ją anksčiau, likęs objektas taptų nebeatrandamas.
     */
    uzdarytini.push(v.attemptId);
  }

  if (uzdarytini.length > 0) await jobStore.system.pasalintiBandymus(uzdarytini);

  return { pasalinta, praleista, pazeidimai, nevykdyta: false };
}

/**
 * Vienas pilnas retencijos ciklas. Grąžina suvestinę (naudinga testams ir logams).
 */
async function runRetentionSweep({ now = Date.now() } = {}) {
  const summary = {
    jobs: 0,
    /** Kiek pasenusių job'ų paliko kitam vykdytojui (#183). */
    jobsSkipped: 0,
    audio: 0,
    auditEntries: 0,
    tombstones: 0,
    /**
     * ⚠️ REZULTATO BANDYMŲ ŠLAVIMAS — `null` REIŠKIA „NEVYKDYTA" (#157, PR-5, sąlyga 3a).
     *
     * Nulis reikštų „nieko nebuvo", o čia reikia atskirti „nežinau, ar buvo": kai žymų
     * saugykla nėra `postgres`, retencijos predikato antra šaka neveikia, ir žingsnis
     * stabdomas VISAS. Sulietus abu, sustabdytas žingsnis atrodytų kaip tuščias — ta
     * pati riba kaip fasado `null` („nežinau, netrink").
     */
    resultAttempts: null,
    /** Praleista dėl fail-closed (ateities `created_at`) — sąlyga 4b. */
    resultAttemptsSkipped: 0,
    /** Invarianto pažeidimai: laikinas IR galutinis objektas tuo pačiu raktu (4d). */
    resultAttemptsViolations: 0,
    errors: [],
  };

  try {
    const r = await _valytiPasenusiusJobus(now);
    summary.jobs = r.pasalinta;
    summary.jobsSkipped = r.praleista;
  } catch (e) {
    summary.errors.push(`jobs: ${e.message}`);
  }

  try {
    const bandymai = await _valytiRezultatoBandymus();
    summary.resultAttempts = bandymai.pasalinta;
    summary.resultAttemptsSkipped = bandymai.praleista;
    summary.resultAttemptsViolations = bandymai.pazeidimai;
    if (bandymai.nevykdyta) summary.resultAttempts = null;
  } catch (e) {
    summary.errors.push(`result attempts: ${e.message}`);
  }

  try {
    const audio = await purgeOrphanedAudio({ now });
    summary.audio = audio.removed;
  } catch (e) {
    summary.errors.push(`audio: ${e.message}`);
  }

  try {
    /**
     * ⚠️ `await` PRIVALOMAS (#155, 7.4d / #213).
     *
     * Nuo 7.4d `purgeExpired()` yra asinchroninė - persistentiniame režime ji
     * vykdo ribotus DB batch'us. Be `await` čia atsidurtų `Promise`: logas
     * rodytų `[object Promise]` vietoj skaičiaus, `RETENTION_PURGE` įrašas
     * meluotų, o klaida taptų neapdorotu rejection - tyliu būtent tame kelyje,
     * kuris turi įrodyti, kad asmens duomenys pašalinti.
     */
    summary.auditEntries = await auditLog.purgeExpired(now);
  } catch (e) {
    /**
     * ⚠️ JAU PAŠALINTOS EILUTĖS PATENKA Į SUVESTINĘ (#233 Codex, P2).
     *
     * Retencija persistentiniame režime vyksta batch'ais, ir kiekvienas jų
     * commit'inasi atskirai. Kritus vėlesniam batch'ui, priskyrimas aukščiau
     * neįvyksta - be šito `auditEntries` liktų nulis, ciklas atrodytų tuščias,
     * ir `RETENTION_PURGE` įrašas nebūtų parašytas. Eilutės būtų negrįžtamai
     * ištrintos be pėdsako audito žurnale.
     */
    summary.auditEntries = Number.isInteger(e.pasalinta) ? e.pasalinta : 0;
    summary.errors.push(`audit: ${e.message}`);
  }

  try {
    /**
     * ⚠️ ŽYMŲ VALYMAS ČIA, NE SAVO TIMER'YJE (#155, 7.5a / #183).
     *
     * Iki 7.5a `deletionTombstones` turėjo savo `setInterval`. Du valymo ciklai
     * ant to paties duomenų gyvavimo ciklo reikštų dvi konfigūracijas, du
     * laikrodžius, o `RETENTION_PURGE` įrašas rodytų tik vieno jų darbą - ta
     * pati taisyklė, kurią 7.4d pritaikė auditui.
     *
     * ⚠️ ŠALINAMOS TIK `deleted` ŽYMOS. `pending` ir `failed` nesensta: jos
     * reiškia, kad jautrūs duomenys dar gali egzistuoti.
     */
    const zymos = await tombstones.purgeExpired(now);
    summary.tombstones = zymos.removed;

    if (zymos.skipped) {
      /**
       * FAIL-SAFE nėra klaida - tai sąmoningas atsisakymas spėlioti. Bet jis
       * privalo būti matomas: tyliai praleistas valymas atrodytų kaip valymas.
       */
      log.warn("Retencija: žymų terminas neapskaičiuojamas - žymos NEŠALINAMOS.");
    }
  } catch (e) {
    /** ⚠️ Jau pašalinti barjerai patenka į suvestinę - žr. `purgeExpired` (#183). */
    summary.tombstones = Number.isInteger(e.pasalinta) ? e.pasalinta : 0;
    summary.errors.push(`tombstones: ${e.message}`);
  }

  /**
   * ⚠️ `resultAttempts` PRIVALO BŪTI ČIA (Codex, #304).
   *
   * Tas pats defektas, kuris praeitame raunde buvo uždarytas `jobErasure` pusėje
   * (`anythingRemoved` / `found`), tik ANTROJE suvestinėje: ciklas, pašalinęs TIK
   * apleistus rezultato artefaktus, neišrašydavo `RETENTION_PURGE` kvito — automatinis
   * asmens duomenų šalinimas be pėdsako.
   *
   * ⚠️ `null` (žingsnis NEVYKDYTAS) čia nėra „nieko nebuvo": `> 0` jam netaikoma, tad
   * sustabdytas žingsnis emisijos nesukelia, o tai teisinga — nevykdytas žingsnis nieko
   * ir nepašalino. Bet pažeidimai ir praleidimai skaičiuojami: jie yra ĮVYKIS, net kai
   * nieko nepašalinta.
   */
  const removedAnything =
    summary.jobs > 0 ||
    summary.audio > 0 ||
    summary.auditEntries > 0 ||
    summary.tombstones > 0 ||
    summary.resultAttempts > 0 ||
    summary.resultAttemptsViolations > 0 ||
    summary.resultAttemptsSkipped > 0;

  /**
   * ⚠️ KLAIDA IRGI YRA ĮVYKIS (#233 Codex, P2).
   *
   * Iki šito ciklas, kuris nieko nepašalino IR krito, baigdavosi visiškoje
   * tyloje: nei `RETENTION_PURGE` įrašo, nei klaidos - `startRetentionSweeper`
   * logina tik tada, kai visas pažadas atmetamas, o klaidos čia sugaunamos.
   * Nesėkmingas automatinis asmens duomenų šalinimas privalo palikti pėdsaką.
   */
  const verta = removedAnything || summary.errors.length > 0;

  // Įrašom TIK kai kažkas realiai pašalinta arba kai buvo klaidų - kitaip kas
  // valandą rašytume tuščią įvykį ir per AUDIT_MAX_ENTRIES išstumtume naudingus.
  if (verta) {
    /**
     * ⚠️ AUDITO KLAIDA PROPAGUOJAMA (#155, 7.4a / #210).
     *
     * `RETENTION_PURGE` yra BLOKUOJANTIS: automatinis asmens duomenų šalinimas
     * be patvirtinto įrašo yra tas pats trūkumas kaip ir rankinis. Ciklas
     * nutrūksta, o `startRetentionSweeper` klaidą sulogina - kitas ciklas
     * kartos.
     */
    await rasytiAudita({
      event: "RETENTION_PURGE",
      success: summary.errors.length === 0,
      error: summary.errors.length ? summary.errors.join("; ") : null,
      details:
        `jobs=${summary.jobs} audio=${summary.audio} audit=${summary.auditEntries} ` +
        `tombstones=${summary.tombstones} ` +
        /**
         * ⚠️ `attempts=` ATSKIRAI, IR `nevykdyta` NĖRA NULIS. Kvitas, rodantis `0` ten,
         * kur žingsnis buvo sustabdytas, tvirtintų, kad šluoti nebuvo ko.
         */
        `attempts=${summary.resultAttempts === null ? "nevykdyta" : summary.resultAttempts}` +
        `/${summary.resultAttemptsSkipped}/${summary.resultAttemptsViolations}`,
    });
    log.info(
      `Retencija: pašalinta jobų=${summary.jobs}, audio failų=${summary.audio}, ` +
        `audito įrašų=${summary.auditEntries}, ištrynimo žymų=${summary.tombstones}.`
    );
  }

  return summary;
}

/**
 * Paleidžia periodinį retencijos šalinimą. Timer'is `unref()`-intas.
 *
 * ⚠️ CIKLAI NEPERSIDENGIA (#155, 7.4d / #213).
 *
 * Nuo 7.4d sweep'as trina ir persistentines audito eilutes ribotais DB
 * batch'ais, tad didelėje lentelėje jis gali trukti ilgiau nei intervalas. Be
 * apsaugos kitas `setInterval` tick'as paleistų antrą ciklą to paties proceso
 * viduje: du sweep'ai konkuruotų dėl tų pačių eilučių, o `RETENTION_PURGE`
 * įrašai persidengtų.
 *
 * ⚠️ APSAUGA GYVENA SCHEDULER'YJE, NE `runRetentionSweep()` VIDUJE. Tiesioginis
 * kvietimas (testai, rankinis paleidimas) privalo likti sinchroniškai
 * nuspėjamas: praleistas ciklas ten reikštų tyliai neįvykusį valymą.
 *
 * Tai proceso lokali spyna. Multi-instance korektiškumo ji NEGARANTUOJA ir
 * neturi - tam yra `FOR UPDATE SKIP LOCKED` batch'ų atrankoje.
 */
function startRetentionSweeper({ intervalMs, runImmediately = true } = {}) {
  const config = getPrivacyPolicy();
  const interval = intervalMs || config.retentionSweepMinutes * 60 * 1000;

  let vykstantis = null;

  const paleisti = (kontekstas) => {
    if (vykstantis) {
      log.warn(`${kontekstas}: praleistas - ankstesnis retencijos ciklas dar vyksta.`);
      return;
    }

    vykstantis = runRetentionSweep()
      .catch((e) => log.error(`${kontekstas} nepavyko: ${e.message}`))
      .finally(() => {
        vykstantis = null;
      });
  };

  // PRADINIS ciklas iškart po starto. Be jo po restarto pasenę duomenys liktų dar
  // visą intervalą (numatytai valandą) - automatinei retencijai tai per ilgai.
  // `unref`-intas timeout, kad neblokuotų proceso pabaigos ir netrikdytų testų.
  if (runImmediately) {
    setTimeout(() => paleisti("Pradinis retencijos ciklas"), 5000).unref();
  }

  const timer = setInterval(() => paleisti("Retencijos ciklas"), interval);

  timer.unref();
  return timer;
}

module.exports = { runRetentionSweep, purgeOrphanedAudio, startRetentionSweeper };
