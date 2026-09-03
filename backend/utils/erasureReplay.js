const jobStore = require("./jobStore");
const tombstones = require("./deletionTombstones");
const { eraseJob } = require("./jobErasure");
const auditWrite = require("./auditWrite");
const { createLogger } = require("./logger");
const { arReikiaReplay } = require("./erasureExport");

const log = createLogger("erasure-replay");

/**
 * IŠTRYNIMŲ REPLAY PO ATKŪRIMO (#155, 7.6c / #250).
 *
 * ⚠️ ŽYMŲ GRĄŽINIMO NEPAKANKA.
 *
 * Senas dump'as jau atkūrė `jobs` ir `job_results`. Sulietos žymos duomenų
 * nepašalina — jos tik sako, kad tų duomenų būti NETURI. Todėl kiekvienai
 * galiojančiai žymai taikomas TAS PATS autoritetingas trynimas, kurį įvedė 7.5a.
 *
 * ⚠️ KODĖL NE `lifecycleService.deleteJobArtefacts()`.
 *
 * Jis turi TRIS trumpuosius kelius, ir po DR visi trys pataiko į mūsų atvejį:
 *
 * ⚠️ SĄLYGOS UŽRAŠYTOS GRETA NUMERIŲ, NES NUMERIAI SENSTA. Šiame darbe jau
 * matėme `jobPhase.js:486 → 517`; po pusmečio numeris turi būti patogumas, ne
 * vienintelė nuoroda.
 *
 *   sąlyga: barjeras neišspręstas (`isBarred`)     → `TOMBSTONE_UNRESOLVED` (~:205)
 *   sąlyga: žyma yra `deleted`                     → `ALREADY_DELETED` (~:217)
 *           grąžina `deleted: []` NEKVIESDAMAS `eraseJob()`, t. y. praneša apie
 *           sėkmingai užbaigtą ištrynimą, palikdamas eilutes GYVAS;
 *   sąlyga: žyma `deletion_pending`, kvietėjas ne vykdytojas → `IN_PROGRESS` (~:338)
 *           Po claim'ų nukirpimo (#250 D1) tai DAŽNIAUSIAS atvejis, tad jam yra
 *           ATSKIRAS testas: bendras „apeina trumpuosius kelius" padengtų vieną
 *           iš trijų, o lentelėje atrodytų kaip trys.
 *
 * Žyma čia yra įrodymas, kad trinti REIKIA, o ne kad jau ištrinta.
 *
 * ⚠️ ANTRA ERASURE SEMANTIKA NEKURIAMA. Kviečiamas `jobErasure.eraseJob()` — ta
 * pati artefaktų aibė; žymos uždarymas — per `tombstones.complete()`; auditas —
 * per 7.4 `rasytiAudita`. Restore-specific deletion SQL čia nėra ir negali būti.
 */

/** Audito įvykis — registruotas `utils/auditEvents.js`, ne naujas mechanizmas. */
const AUDITO_IVYKIS = "ERASURE_REPLAYED";

/**
 * ⚠️ `deletion_failed` ŽYMA UŽDAROMA EINANT GRAFU, NE JĮ APEINANT.
 *
 * `ALLOWED_TRANSITIONS` neturi `FAILED → DELETED` SĄMONINGAI (`index.js` `retry()`:
 * „patvirtintas ištrynimas visada turi prieš save `pending` būseną"). Replay yra
 * kaip tik tas antras bandymas, kurio įrodymo grafas reikalauja, tad jis pereina
 * per tą patį `retry()`, kurį naudoja operatoriaus kelias.
 *
 * ⚠️ TAI RADO TESTAS, NE PERŽIŪRA. Iki tol `failed` žymos replay duomenis
 * ištrindavo, kvitą įrašydavo, o žyma likdavo `deletion_failed` AMŽINAI — ir
 * `verify` blokuotų cutover'į be jokio kelio pirmyn.
 *
 * @returns {Promise<boolean>} ar žyma pasirengusi uždarymui
 */
async function _paruostiUzdarymui(jobId, status) {
  if (status !== tombstones.TOMBSTONE_STATUS.FAILED) return true;

  const perejo = await tombstones.retry(jobId, { actorKind: "operator" });
  return Boolean(perejo && perejo.status === tombstones.TOMBSTONE_STATUS.PENDING);
}

/**
 * ⚠️ `store` — SAUGYKLA, KURIOJE REALIAI GULI DUOMENYS (#250, C sprendimas).
 *
 * Numatytoji reikšmė yra `jobStore` fasadas, tad visi esami kvietėjai elgesio
 * nekeičia. DR kelyje koordinatorius perduoda ATKURTOS bazės saugyklą
 * (`utils/restoredJobStore.js`): be jos replay per fasadą būtų vakuumas, nes
 * 7.2a barjeras job'ų autoritetu palieka atmintį arba Redis, o asmens duomenys
 * guli atkurtoje bazėje. Ir job'o SKAITYMAS, ir jo ŠALINIMAS eina per tą pačią
 * saugyklą — kitaip replay tikrintų vieną vietą, o trintų kitą.
 *
 * @param {object} opcijos
 * @param {Array<object>} opcijos.zymos sulietos žymos (visos, ne tik `deleted`)
 * @param {string|null} opcijos.actor operatorius evidencijai
 * @param {object} [opcijos.store] saugykla; numatytoji — `jobStore` fasadas
 * @returns {Promise<{apdorota: number, istrinta: string[], jauNebuvo: string[], nesekmes: Array<object>}>}
 */
async function replay({ zymos, actor = null, store = jobStore } = {}) {
  const istrinta = [];
  const jauNebuvo = [];
  const uzdarytosZymos = [];
  const nesekmes = [];

  for (const zyma of zymos) {
    if (!arReikiaReplay(zyma.status)) continue;

    /**
     * ⚠️ JOB'AS SKAITOMAS PER `system.get()`, NE PER SAVININKO KELIĄ.
     *
     * Replay vykdomas offline, be HTTP konteksto ir be `ownerId`: savininko
     * patikra čia neturėtų ką tikrinti, o `system` kelias yra tas pats, kurį
     * naudoja kiti sisteminiai valytojai.
     */
    const job = await store.system.get(zyma.jobId);

    if (!job) {
      /**
       * ⚠️ „NĖRA KO TRINTI" NĖRA NESĖKMĖ, BET IR NE TYLA. Po antro paleidimo
       * (D5) tai normali būsena; ji grąžinama atskirai, kad skirtųsi nuo realaus
       * ištrynimo ir kad idempotentiškumą būtų galima ĮRODYTI, ne teigti.
       *
       * ⚠️ ČIA UŽDAROMAS LANGAS, KURIO IDEMPOTENTIŠKUMAS NEUŽDARO.
       *
       * Jei ankstesnis paleidimas krito PO `eraseJob()`, bet PRIEŠ
       * `tombstones.complete()`, duomenys jau ištrinti, o žyma liko `pending`.
       * Vien „job'o nėra" grąžinimas paliktų ją atvirą AMŽINAI — tyliai, nes
       * viskas atrodytų pavykę. Todėl neterminali žyma čia UŽDAROMA: trinti
       * nebėra ko, o galutinumas privalo būti užfiksuotas.
       *
       * ⚠️ TAI ATSTATYMAS, NE APTIKIMAS. Verifikacija, pranešanti apie būseną,
       * kurios niekas negali ištaisyti, būtų runbook'o aklavietė.
       */
      jauNebuvo.push(zyma.jobId);

      const esama = await tombstones.get(zyma.jobId);
      if (esama && esama.status !== tombstones.TOMBSTONE_STATUS.DELETED) {
        /**
         * ⚠️ AUDITAS PRIEŠ `complete()`, NE PO JO.
         *
         * Atvirkštinė tvarka turi tylų gedimą: uždarius žymą pirma, nepavykęs
         * kvitas paliktų būseną, kurios NIEKAS nebekartos — kitas paleidimas
         * pamatytų `deleted` ir praeitų pro šalį. Tokia tvarka gedimas palieka
         * žymą ATVIRĄ, tad kitas paleidimas grįžta būtent čia.
         *
         * KAINA UŽRAŠOMA: jei kvitas įrašomas, o `complete()` krenta, kitas
         * paleidimas parašys ANTRĄ `erasure_confirmed`. Pasikartojantis matomas
         * įrašas pasirinktas sąmoningai vietoj vienintelio tylaus praradimo.
         */
        try {
          /** Atskiras `outcome`: šiame paleidime duomenų NESHALINOME, tik užfiksavome galutinumą. */
          await auditWrite.rasytiAudita({
            event: AUDITO_IVYKIS,
            success: true,
            outcome: "erasure_confirmed",
            actor: actor || undefined,
            details: `zymosStatusas=${esama.status} duomenu=nebuvo`,
          });
        } catch (klaida) {
          nesekmes.push({ jobId: zyma.jobId, priezastis: klaida.code || klaida.message });
          continue;
        }

        if (!(await _paruostiUzdarymui(zyma.jobId, esama.status))) {
          nesekmes.push({ jobId: zyma.jobId, priezastis: "`failed` žyma negrįžo į `pending`" });
          continue;
        }

        const uzdaryta = await tombstones.complete(zyma.jobId, tombstones.TOMBSTONE_STATUS.DELETED, {
          completedAt: Date.now(),
        });

        if (!uzdaryta || uzdaryta.status !== tombstones.TOMBSTONE_STATUS.DELETED) {
          nesekmes.push({ jobId: zyma.jobId, priezastis: "neuždaryta žyma be duomenų" });
          continue;
        }

        uzdarytosZymos.push(zyma.jobId);
      }

      continue;
    }

    try {
      const outcome = await eraseJob(job, { store });

      /**
       * ⚠️ SĖKMĖ IŠVEDAMA IŠ `outcome`, NE IŠ TO, KAD `eraseJob()` NEMETĖ.
       *
       * `jobErasure.js` kritinę nesėkmę (eilė, saugykla, audito eilučių šalinimas)
       * grąžina VĖLIAVA, ne išimtimi: job'o įrašas paliekamas gyvas su
       * `deletion_pending`, kad operaciją būtų galima pakartoti. Be šios patikros
       * replay tokiu atveju parašytų kvitą apie neįvykusį ištrynimą IR uždarytų
       * žymą — t. y. sunaikintų vienintelį žymeklį, kuris darė jį pakartojamą.
       *
       * ⚠️ TA PATI #183 PAMOKA VIENU LYGIU AUKŠČIAU. Ji jau buvo pritaikyta
       * `tombstones.complete()` grąžinamai reikšmei, bet ne `eraseJob()` — ir
       * skirtumą parodė testas su krentančia audito saugykla, ne peržiūra.
       */
      if (outcome && outcome.criticalFailure) {
        nesekmes.push({
          jobId: zyma.jobId,
          priezastis: `ištrynimas nepavyko: ${(outcome.errors || []).join("; ") || "kritinė nesėkmė"}`,
        });
        continue;
      }

      /**
       * ⚠️ KVITAS RAŠOMAS BE `jobId` — IR TAI NE PRALEIDIMAS.
       *
       * Pirmoji versija perdavė `jobId`, kad `auditLog` išvestų `subjectId`
       * (`auditLog.js:532`) ir kvitas būtų susietas su subjektu. MATAVIMAS parodė,
       * kad toks įrašas NEĮMANOMAS: `auditStore` barjeras (7.4e / #216) atmeta
       * kiekvieną rašymą, kur yra IR `jobId`, IR `subjectId`, o replay'inamas
       * job'as PAGAL APIBRĖŽIMĄ turi ištrynimo žymą. Kiekvienas ištrynimas
       * grįždavo kaip `AUDIT_WRITE_BLOCKED`.
       *
       * Barjeras čia teisus, o klaida buvo konstrukcijoje. Subjektui susietas
       * kvitas neišgyventų to, ką fiksuoja: `eraseJob()` šalina audito eilutes
       * per `removeBySubjectIdentifier(jobId)`, tad kitas to paties job'o
       * ištrynimas jį pašalintų. Būtent todėl `jobErasure.js:135-141` kvitą
       * apibrėžia BE sąsajos su subjektu, o `lifecycleService.writeAudit()`
       * `jobId` neperduoda. Šis kelias seka tuo pačiu sprendimu, ne kuria trečią.
       *
       * ⚠️ PER-SUBJEKTO ĮRODYMĄ JAU RAŠO AUTORITETAS. `eraseJob()` kiekvienam
       * job'ui rašo `DATA_ERASED` — po vieną kvitą vienam ištrynimui. Šis įrašas
       * prideda tai, ko ten nėra: kad ištrynimas buvo PAKARTOTAS po atkūrimo.
       */
      await auditWrite.rasytiAudita({
        event: AUDITO_IVYKIS,
        success: true,
        outcome: "erasure_replayed",
        actor: actor || undefined,
        details: `zymosStatusas=${zyma.status} auditoIrasai=${outcome && outcome.auditEntriesRemoved ? outcome.auditEntriesRemoved : 0}`,
      });

      /**
       * ⚠️ ŽYMOS UŽDARYMAS PER ESAMĄ AUTORITETĄ, ir sėkmė išvedama iš GRĄŽINTOS
       * žymos, ne iš to, kad `complete()` nemetė — ta pati #183 pamoka, kurią
       * `lifecycleService` jau užrašė.
       *
       * ⚠️ PO KVITO, NE PRIEŠ JĮ. Nepavykęs kvitas palieka žymą ATVIRĄ, tad
       * duomenų pašalinimas (jį jau fiksavo `DATA_ERASED`) lieka nepatvirtintas,
       * o kitas paleidimas grįžta į „job'o nebėra, žyma neuždaryta" šaką ir ją
       * uždaro. Uždarius pirma, kvito gedimas liktų amžinai neištaisytas.
       */
      if (!(await _paruostiUzdarymui(zyma.jobId, zyma.status))) {
        nesekmes.push({ jobId: zyma.jobId, priezastis: "`failed` žyma negrįžo į `pending`" });
        continue;
      }

      const uzbaigta = await tombstones.complete(zyma.jobId, tombstones.TOMBSTONE_STATUS.DELETED, {
        completedAt: Date.now(),
      });

      if (!uzbaigta || uzbaigta.status !== tombstones.TOMBSTONE_STATUS.DELETED) {
        nesekmes.push({ jobId: zyma.jobId, priezastis: "žyma neužsidarė kaip `deleted`" });
        continue;
      }

      /**
       * ⚠️ `istrinta` PILDOMAS TIK PO ABIEJŲ. Anksčiau jis buvo pildomas iškart po
       * `eraseJob()`, tad nepavykęs kvitas duodavo TĄ PATĮ `jobId` ir `istrinta`,
       * ir `nesekmes` sąrašuose — ataskaita prieštaraudavo pati sau.
       */
      istrinta.push(zyma.jobId);

      /**
       * ⚠️ ASINCHRONINIS AUDIO VALYMAS NĖRA SĖKMINGAS REVIVE.
       *
       * `eraseJob()` audio šalinimą gali palikti vėlesniam bandymui (7.4e
       * barjeras + `audio_cleanup_pending`). Tokia būsena registruojama, bet
       * NIEKADA nereiškia, kad job'as gyvas: metaduomenys ir rezultatas jau
       * pašalinti, o valymo skola lieka esamame mechanizme.
       */
      if (outcome && outcome.audioCleanupPending) {
        log.warn("Audio valymas liko atidėtas po replay", { jobId: zyma.jobId, stage: "erasure_replay" });
      }
    } catch (klaida) {
      nesekmes.push({ jobId: zyma.jobId, priezastis: klaida.code || klaida.message });
    }
  }

  /**
   * ⚠️ SUVESTINĖ — Į LOGĄ, NE Į AUDITĄ.
   *
   * Antras audito įrašas tam pačiam veiksmui reikštų, kad `ERASURE_REPLAYED`
   * skaičiavimas (kiek subjektų ištrinta) priklausytų nuo to, ar kvietėjas moka
   * atskirti suvestinę nuo per-job įrašo. Audite lieka VIENAS įrašas vienam
   * ištrynimui.
   *
   * ⚠️ `audit_log` Į KOPIJĄ NEPATENKA (7.6a `--exclude-table-data`), tad šie
   * įrašai gula į GYVĄ audito saugyklą jau po restore. Tai teisinga, bet
   * pasakyta runbook'e — kitaip kas nors jų ieškos dump'e.
   */
  log.info("Ištrynimų replay baigtas", {
    stage: "erasure_replay",
    zymos: zymos.length,
    istrinta: istrinta.length,
    jauNebuvo: jauNebuvo.length,
    uzdarytosZymos: uzdarytosZymos.length,
    nesekmes: nesekmes.length,
  });

  return { apdorota: zymos.length, istrinta, jauNebuvo, uzdarytosZymos, nesekmes };
}

module.exports = { AUDITO_IVYKIS, replay };
