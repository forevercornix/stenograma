
const tombstones = require("./deletionTombstones");
const erasureExport = require("./erasureExport");
const restoredJobStore = require("./restoredJobStore");
const erasureReplay = require("./erasureReplay");
const deploymentIdentity = require("./deploymentIdentity");
const postRestoreReconcile = require("./postRestoreReconcile");
const auditWrite = require("./auditWrite");
const { createLogger } = require("./logger");

const log = createLogger("dr-coordinator");

/**
 * DR KOORDINATORIUS (#155, 7.6c / #250).
 *
 * ```
 * restore → tombstone import/merge → erasure replay → sesijų revokacija
 *         → job'ų suderinimas → verifikacija → tik tada startas ir cutover
 * ```
 *
 * ⚠️ TVARKA YRA KONSTRUKCIJA, NE SUSITARIMAS.
 *
 * Kiekvienas žingsnis PRIVALO gauti ankstesniojo rezultatą kaip argumentą, ir tas
 * rezultatas nėra atkuriamas ranka: jame yra sulietų žymų aibė su `updatedAt` ir
 * ŽURNALO KONTROLINĖ SUMA, kurią gali pagaminti tik tikras, validuotas artefaktas.
 * `{ merged: true }` čia netinka — su juo tvarka vėl taptų sutartimi.
 *
 * ⚠️ MERGE EINA PRIEŠ SUDERINIMĄ. Ištrintas job'as kopijoje gali gulėti kaip
 * `queued`; jei 7.6b suderinimas pamatytų jį pirmas, jis terminalizuotų darbą su
 * jau ištrintais duomenimis.
 *
 * ⚠️ `maintenanceLock` ČIA NENAUDOJAMAS SĄMONINGAI. Jo `DEFAULT_MAX_HOLD_MS` yra
 * 10 min, o pilnos DR pratybos beveik tikrai ilgesnės — užraktas tyliai pasibaigtų
 * proceso viduryje ir duotų saugumo jausmą be saugumo. Tikroji riba yra 7.6b D1:
 * serveris ir worker'iai dar neveikia.
 */

/** Audito įvykiai — registruoti `utils/auditEvents.js`. */
const AUDITO_IVYKIS = "DR_RECOVERY_COMPLETED";
const SVIEZUMO_OVERRIDE_IVYKIS = "DR_STALE_LEDGER_ACCEPTED";

/**
 * D4 (b) — RIBOTAS GALUTINUMO/RPO KONTRAKTAS.
 *
 * ⚠️ PASIRINKTA (b), NE (a), IR PRIEŽASTIS YRA KODE, NE SKONYJE.
 *
 * (a) reikštų, kad ištrynimo kelias patvariai atnaujina IŠORINĘ būseną prieš
 * patvirtindamas galutinumą — t. y. sinchroninis išorinis I/O GDPR trynimo
 * transakcijoje ir naujas gedimo režimas kelyje, kuris šiandien yra paprastas.
 *
 * (b) yra pripažinimas, kad erasure galutinumas turi RPO: ištrynimai, įvykę po
 * paskutinio eksporto, gali būti prarasti. Langas ĮVARDIJAMAS ir TIKRINAMAS —
 * runbook'o „eksportuok dažnai" nė vienas iš dviejų nebūtų.
 */
/**
 * ⚠️ LANGAS SIETAS SU EKSPORTO KADENCIJA, NE SU APVALIA REIKŠME.
 *
 * Runbook'as reikalauja eksportuoti žurnalą PRIEŠ kiekvieną kopiją ir po
 * kiekvienos ištrynimų partijos, o kopijos daromos bent kas parą. 24 h langas
 * tokiai kadencijai yra DVIGUBA atsarga, ne riba: jei numatytoji reikšmė būtų
 * lygi kadencijai, override taptų kasdienis, o kasdienis override nustoja būti
 * sprendimu.
 *
 * Diegimai su retesnėmis kopijomis privalo langą PADIDINTI eksplicitiškai
 * (`ERASURE_EXPORT_MAX_AGE_MS`) — ir tuo pačiu pasakyti, kokį RPO priima.
 */
const NUMATYTAS_SVIEZUMO_LANGAS_MS = 24 * 60 * 60 * 1000;

function sviezumoLangasMs(env = process.env) {
  const reiksme = Number(env.ERASURE_EXPORT_MAX_AGE_MS);
  return Number.isFinite(reiksme) && reiksme > 0 ? reiksme : NUMATYTAS_SVIEZUMO_LANGAS_MS;
}

class DrCoordinatorError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "DrCoordinatorError";
    this.code = code;
  }
}

/**
 * VISI SARGAI PRIEŠ PIRMĄ RAŠYMĄ (D7c).
 *
 * ⚠️ 7.6b TURĖJO P1, KUR AŠYS BUVO SKAIČIUOJAMOS PO `COMMIT`: klaidinga
 * konfigūracija duodavo įsipareigotas, neaudituotas mutacijas, praneštas kaip
 * nesėkmė. Čia tvarka yra: tapatumas → žymų ašis → artefakto autentiškumas →
 * kilmė → šviežumas. Nė vienas jų nekeičia DB būsenos.
 */
async function patikrintiSargus({ targetUrl, artefaktas, vykdytojas, env = process.env, leistiPasenusi = false }) {
  const { tapatybe } = erasureExport.patikrintiSargus(targetUrl, env);

  /** Fail-closed: dešifravimas, suma ir rūšis — prieš bet kokį sprendimą. */
  const zurnalas = erasureExport.perskaitytiArtefakta({
    envelope: artefaktas.envelope,
    manifest: artefaktas.manifest,
    env,
  });

  const bazesDeploymentId = await deploymentIdentity.skaitytiTapatybe(vykdytojas);
  erasureExport.patikrintiKilme(zurnalas, bazesDeploymentId);

  /**
   * ⚠️ ŠVIEŽUMAS TIKRINAMAS ČIA, NE RUNBOOK'E (D4 b).
   *
   * Riba, likusi dokumente, yra būtent tai, ką #250 atmeta: ji nesustabdo
   * operatoriaus, atkuriančio su savaitės senumo žurnalu.
   */
  const amzius = Date.now() - Number(zurnalas.eksportuotaMs || 0);
  const langas = sviezumoLangasMs(env);

  if (amzius > langas && !leistiPasenusi) {
    throw new DrCoordinatorError(
      `Ištrynimo žurnalas pasenęs: ${Math.round(amzius / 1000)} s > ${Math.round(langas / 1000)} s ` +
        "(RPO kontraktas). Po jo įvykę ištrynimai atkūrime nedalyvautų.",
      "DR_LEDGER_STALE"
    );
  }

  return {
    tapatybe,
    zurnalas,
    deploymentId: bazesDeploymentId,
    zurnaloChecksum: artefaktas.manifest.checksum,
    amzius,
    langas,
    pasenes: amzius > langas,
  };
}

/**
 * 1 ŽINGSNIS — MONOTONIŠKAS SULIEJIMAS.
 *
 * ⚠️ SPRENDIMĄ PRIIMA `erasureExport.suliejimoPlanas()`, NE ŠIS MODULIS. Antra
 * tvarkos taisyklė čia būtų ta pati dviejų tiesų klasė, kurią repo jau gaudė.
 */
/**
 * PASENUSIO ŽURNALO PRIĖMIMO PĖDSAKAS (#250, D4 b).
 *
 * ⚠️ `rasytiAudita()` GRĄŽINA `null` DVIEM SKIRTINGAIS ATVEJAIS, ir jų SUPLAKTI
 * negalima — tai ta pati dviprasmybė, kurią 7.4e jau uždarė reikalaudama, kad
 * „rašymas nepavyko" ir „politika slopina" būtų atskiri faktai:
 *
 *   · rašymas NEPAVYKO            → gedimas, fail-closed teisingas;
 *   · `PRIVACY_MODE` SLOPINA įrašą → sąmoningas diegimo sprendimas, iš kurio
 *     NESEKA, kad operatorius negali priimti rizikos — seka tik tai, kad pėdsakas
 *     gyvens kitur.
 *
 * ⚠️ KODĖL TAI SVARBU. Traktavus abu vienodai, `PRIVACY_MODE` diegimas su
 * pasenusiu žurnalu NEGALĖTŲ atsigauti apskritai — o realioje avarijoje žurnalo
 * atnaujinti neįmanoma, nes šaltinio bazės nebėra. Privatumo nustatymas tyliai
 * išjungtų atkūrimą, ir tai paaiškėtų blogiausiu momentu.
 *
 * Todėl pėdsako LAIKMENA skiriasi, o reikalavimas — ne: be pėdsako nepratęsiama
 * abiem režimais. Privatumo režime pėdsakas yra operatoriaus patvirtinimas
 * reikšmėmis (tas pats modelis, kurį 7.6a §10 priėmė atkūrimo pusei).
 *
 * ⚠️ PATVIRTINIMAS LYGINAMAS VALANDOMIS, IR IŠ TO SEKA RIBA.
 *
 * Milisekundės niekada nesutaptų — tarp bloko išvedimo ir patvirtinimo praeina
 * laikas, tad sargas taptų neįveikiamas TEISĖTAI, o toks sargas apeinamas kitu
 * būdu. Kaina: patvirtinimas galioja iki valandos pabaigos — gavęs „25", operatorius
 * gali patvirtinti po 50 min, ir sutaps, nors realus pasenimas jau kitas. Skirtumas
 * yra viena valanda ties 25, tad praktinės žalos nėra; bet tai ta pati klasė kaip
 * `pgConnection` riba „du klasteriai tame pačiame hoste sutampa" — kyla iš
 * palyginimo GRANULIARUMO, ir jos vieta yra čia, prie autoriteto.
 */
async function _uzfiksuotiOverride({ sargai, zurnalas, actor, patvirtinimas, auditLog = require("./auditLog") }) {
  const pasenimoValandos = Math.floor(sargai.amzius / 3_600_000);

  if (auditLog.isPrivacyModeEnabled()) {
    const laukiama = {
      deploymentId: String(sargai.deploymentId),
      zurnaloChecksum: String(sargai.zurnaloChecksum),
      pasenimoValandos,
    };

    const gauta = patvirtinimas || {};
    const sutampa =
      String(gauta.deploymentId) === laukiama.deploymentId &&
      String(gauta.zurnaloChecksum) === laukiama.zurnaloChecksum &&
      Number(gauta.pasenimoValandos) === laukiama.pasenimoValandos;

    if (!sutampa) {
      throw new DrCoordinatorError(
        "`PRIVACY_MODE`: audito įrašas slopinamas, tad pasenusio žurnalo priėmimas " +
          "reikalauja EKSPLICITINIO patvirtinimo reikšmėmis. Laukiama: " +
          `deployment=${laukiama.deploymentId} checksum=${laukiama.zurnaloChecksum} ` +
          `pasenimoValandos=${laukiama.pasenimoValandos}.`,
        "DR_STALE_OVERRIDE_UNCONFIRMED"
      );
    }

    /**
     * ⚠️ PATVIRTINIMAS REIKŠMĖMIS, NE `true`. Sutapimas įrodo, kad operatorius
     * MATĖ pasenimo dydį ir diegimo tapatybę; `--yes` neįrodytų nieko.
     */
    log.warn("PRIVACY_MODE: pasenęs žurnalas priimtas operatoriaus patvirtinimu", {
      stage: "dr_stale_override",
      pasenimoValandos,
      langasMs: sargai.langas,
      deployment: sargai.deploymentId,
      actor: actor || null,
    });

    return { laikmena: "operatoriaus_patvirtinimas", pasenimoValandos };
  }

  const kvitas = await auditWrite.rasytiAudita({
    event: SVIEZUMO_OVERRIDE_IVYKIS,
    success: true,
    actor: actor || undefined,
    details:
      `amziusMs=${sargai.amzius} langasMs=${sargai.langas} ` +
      `virsijaMs=${sargai.amzius - sargai.langas} zymos=${zurnalas.zymos.length} ` +
      `deployment=${sargai.deploymentId}`,
  });

  /**
   * ⚠️ ČIA `null` GALI REIKŠTI TIK GEDIMĄ: privatumo režimas jau apdorotas
   * aukščiau, tad šakojimasis pagal `null` nebėra dviprasmiškas.
   */
  if (!kvitas) {
    throw new DrCoordinatorError(
      "Pasenusio žurnalo priėmimo NEPAVYKO užfiksuoti (audito įrašo nėra). " +
        "Sąmoningas rizikos prisiėmimas be pėdsako neleidžiamas.",
      "DR_STALE_OVERRIDE_UNRECORDED"
    );
  }

  return { laikmena: "audito_irasas", pasenimoValandos };
}

async function sulieti({
  targetUrl,
  artefaktas,
  vykdytojas,
  actor = null,
  env = process.env,
  leistiPasenusi = false,
  patvirtinimas = null,
}) {
  const sargai = await patikrintiSargus({ targetUrl, artefaktas, vykdytojas, env, leistiPasenusi });
  const { zurnalas } = sargai;

  /**
   * ⚠️ OVERRIDE YRA ĮRODYMAS, NE VĖLIAVA — ir jis PRIVALO būti užfiksuotas prieš
   * pirmą rašymą. `DR_STALE_LEDGER_ACCEPTED` klasifikuotas neblokuojančiu
   * sąmoningai (procedūros faktas), bet ŠIS kelias fiksuoja sprendimą sąmoningai
   * rizikuoti, tad sąlyga yra KELIO, ne įvykio klasifikacijos.
   */
  let override = null;
  if (sargai.pasenes) {
    override = await _uzfiksuotiOverride({ sargai, zurnalas, actor, patvirtinimas });
  }

  const vietinesSarasas = await tombstones.listAll();
  const vietines = new Map(vietinesSarasas.map((z) => [z.jobId, z]));

  const planas = erasureExport.suliejimoPlanas(zurnalas.zymos, vietines);

  for (const zyma of planas.rasyti) await tombstones.importuotiZyma(zyma);

  /**
   * ⚠️ HORIZONTAS SULIEJAMAS PRIEŠ RETENCIJĄ. Senesnio snapshot'o atkūrimas
   * `backup_horizon` atsuka atgal; importuotos žymos taptų šalintinos, nors jas
   * apimanti kopija dar gali prikelti job'us.
   */
  const vietinisHorizontas = await tombstones.refreshBackupHorizon();
  const horizontas = erasureExport.horizontoMaksimumas(zurnalas.horizontas, vietinisHorizontas);
  if (horizontas !== null && horizontas !== vietinisHorizontas) await tombstones.recordBackupHorizon(horizontas);

  /**
   * ⚠️ REZULTATAS, KURIO NEGALIMA SUKONSTRUOTI RANKA.
   *
   * Jame yra žurnalo kontrolinė suma (ją duoda tik validuotas artefaktas) ir
   * sulietų žymų aibė su `updatedAt`. Kitas žingsnis be jo neįvyksta, tad tvarka
   * yra kontrakto savybė, ne susitarimas.
   */
  return {
    zingsnis: "merge",
    tapatybe: sargai.tapatybe,
    deploymentId: sargai.deploymentId,
    zurnaloChecksum: artefaktas.manifest.checksum,
    zymos: zurnalas.zymos,
    sulietos: planas.rasyti.map((z) => ({ jobId: z.jobId, status: z.status, updatedAt: z.updatedAt })),
    praleistos: planas.praleisti,
    nukirptiClaimai: planas.nukirptiClaimai,
    horizontas,
    /**
     * ⚠️ PASENIMO FAKTAS KELIAUJA SU REZULTATU, NE LIEKA LOGE.
     *
     * Operatoriui ir DR ataskaitai svarbu, ar atkūrimas ėjo per pasenusio
     * žurnalo šaką IR kokia laikmena buvo pėdsakas — kitaip tą patį tektų
     * atkurti iš audito arba iš atminties. `null` reiškia „žurnalas buvo šviežias".
     */
    pasenes: sargai.pasenes,
    overrideLaikmena: override ? override.laikmena : null,
    pasenimoValandos: override ? override.pasenimoValandos : null,
  };
}

/** Merge rezultato tikrumo patikra — be jos „privalomas argumentas" būtų tik forma. */
function _patikrintiMerge(merge) {
  if (!merge || merge.zingsnis !== "merge" || !merge.zurnaloChecksum || !Array.isArray(merge.zymos)) {
    throw new DrCoordinatorError(
      "Replay be tikro suliejimo rezultato: žingsnių tvarka yra kontrakto dalis, " +
        "o ne operatoriaus pasirinkimas.",
      "DR_SEQUENCE_VIOLATION"
    );
  }
}

/**
 * 2 ŽINGSNIS — REPLAY. Privalo gauti 1 žingsnio rezultatą.
 *
 * ⚠️ REPLAY VYKDOMAS PRIEŠ ATKURTĄ BAZĘ, NE PRIEŠ FASADĄ (#250, C sprendimas).
 *
 * Koordinatorius yra vienintelė vieta, kuri žino tikslinę bazę, tad būtent jis
 * sudaro nukreiptą saugyklą. Per fasadą replay būtų VAKUUMAS: 7.2a barjeras
 * job'ų autoritetu palieka atmintį arba Redis, o ištrintų žmonių duomenys guli
 * atkurtoje bazėje — `jobs` eilutės liktų neribotai, o kvitas skelbtų sėkmę.
 *
 * ⚠️ `vykdytojas` PRIVALOMAS. Be jo tyliai grįžtume prie fasado, t. y. prie to
 * paties vakuumo, tik be jokio ženklo. Fail-closed čia pigesnis už bet kokį
 * numatytąjį elgesį.
 */
async function replay({ merge, vykdytojas, actor = null }) {
  _patikrintiMerge(merge);

  if (!vykdytojas || typeof vykdytojas.query !== "function") {
    throw new DrCoordinatorError(
      "Replay be tikslinės bazės kliento: per fasadą jis šalintų iš atminties, " +
        "o atkurtos `jobs` eilutės liktų. Perduokite tą patį pool'ą kaip sargams.",
      "DR_REPLAY_STORE_MISSING"
    );
  }

  const store = restoredJobStore.sukurti(vykdytojas);
  const rezultatas = await erasureReplay.replay({ zymos: merge.zymos, actor, store });

  if (rezultatas.nesekmes.length > 0) {
    throw new DrCoordinatorError(
      `Replay nepavyko ${rezultatas.nesekmes.length} job'ui (-ams): ` +
        `${rezultatas.nesekmes.map((n) => `${n.jobId}: ${n.priezastis}`).join("; ")}.`,
      "DR_REPLAY_FAILED"
    );
  }

  return { zingsnis: "replay", ...rezultatas, zurnaloChecksum: merge.zurnaloChecksum, zymos: merge.zymos };
}

function _patikrintiReplay(replayRez) {
  if (!replayRez || replayRez.zingsnis !== "replay" || !replayRez.zurnaloChecksum) {
    throw new DrCoordinatorError(
      "Suderinimas be tikro replay rezultato: ištrintas job'as kopijoje gali gulėti " +
        "kaip `queued`, ir suderinimas terminalizuotų darbą su jau ištrintais duomenimis.",
      "DR_SEQUENCE_VIOLATION"
    );
  }
}

/**
 * 3 ŽINGSNIS — 7.6b suderinimas. Privalo gauti 2 žingsnio rezultatą.
 *
 * ⚠️ ANTROS REALIZACIJOS NĖRA: kviečiamas tas pats `postRestoreReconcile`, kurį
 * operatorius kviestų atskirai.
 */
async function suderinti({ replay: replayRez, targetUrl, actor = null, env = process.env }) {
  _patikrintiReplay(replayRez);

  const rezultatas = await postRestoreReconcile.suderinti({ targetUrl, actor, env });
  return { zingsnis: "reconcile", ...rezultatas, zurnaloChecksum: replayRez.zurnaloChecksum };
}

/**
 * 4 ŽINGSNIS — VERIFIKACIJA.
 *
 * ⚠️ TIKRINAMAS REZULTATAS, NE KLAIDOS NEBUVIMAS.
 *
 * Be „žymos uždarytos" patikros lieka langas, kurio idempotentiškumas NEUŽDARO:
 * jei koordinatorius krito po `eraseJob()`, bet prieš `complete()`, duomenys jau
 * ištrinti, o žyma amžinai `pending` — antras paleidimas job'o neberastų ir
 * grąžintų `jauNebuvo`, o žyma liktų atvira TYLIAI.
 *
 * ⚠️ TA BŪSENA ATSTATOMA, NE TIK APTINKAMA: `erasureReplay` job'o nebuvimo atveju
 * uždaro žymą per tą patį `complete()`, tad pakartotinis paleidimas ją ištaiso.
 * Verifikacija, kuri praneša apie būseną, kurios niekas negali ištaisyti, būtų
 * runbook'o aklavietė.
 */
async function patikrinti({ reconcile, targetUrl, env = process.env }) {
  if (!reconcile || reconcile.zingsnis !== "reconcile") {
    throw new DrCoordinatorError(
      "Verifikacija be suderinimo rezultato.",
      "DR_SEQUENCE_VIOLATION"
    );
  }

  const zymos = await tombstones.listAll();
  const neuzdarytos = zymos
    .filter((z) => z.status !== tombstones.TOMBSTONE_STATUS.DELETED)
    .map((z) => `${z.jobId}:${z.status}`);

  const b76 = await postRestoreReconcile.patikrinti({ targetUrl, env });

  return {
    zingsnis: "verify",
    suderinta: b76.suderinta && neuzdarytos.length === 0,
    neuzdarytosZymos: neuzdarytos,
    b76,
  };
}

/**
 * PILNA SEKA — vienas operatoriaus kelias.
 *
 * ⚠️ FAIL-CLOSED: bet kuriam žingsniui metus, vėlesni NEVYKDOMI. Klaida keliauja
 * kvietėjui, o ne virsta „dalinai pavyko" rezultatu.
 */
/**
 * ⚠️ `patvirtinimas` PRAEINA IKI SARGO — ANKSČIAU JIS DINGDAVO ČIA (#250, Codex).
 *
 * `paleisti()` jo nepriimdavo, o CLI jį perduodavo, tad `PRIVACY_MODE` režime
 * operatoriaus patvirtinimas iki `_uzfiksuotiOverride()` NEPASIEKDAVO ir kelias
 * visada baigdavosi `DR_STALE_OVERRIDE_UNCONFIRMED`. Vadinasi teisėto atsigavimo
 * su pasenusiu žurnalu tokiame diegime NEBŪDAVO IŠVIS — o būtent dėl jo ta šaka
 * ir egzistuoja.
 *
 * Defekto nepagavo testai, nes buvo padengtos tik NEIGIAMOS šakos
 * (`UNRECORDED`, `UNCONFIRMED`) ir tik `_uzfiksuotiOverride()` lygyje. Teigiamas
 * kelias per visą seką liko neįrodytas — ta pati „patikra be teigiamos
 * kontrolės" forma, tik viena pakopa aukščiau.
 */
async function paleisti({
  targetUrl,
  artefaktas,
  vykdytojas,
  actor = null,
  env = process.env,
  leistiPasenusi = false,
  patvirtinimas = null,
}) {
  const merge = await sulieti({
    targetUrl,
    artefaktas,
    vykdytojas,
    actor,
    env,
    leistiPasenusi,
    patvirtinimas,
  });
  const replayRez = await replay({ merge, vykdytojas, actor });
  const reconcile = await suderinti({ replay: replayRez, targetUrl, actor, env });
  const verify = await patikrinti({ reconcile, targetUrl, env });

  if (!verify.suderinta) {
    throw new DrCoordinatorError(
      `Verifikacija nepraėjo: neuždarytų žymų ${verify.neuzdarytosZymos.length}; ` +
        `7.6b verdiktas ${verify.b76.suderinta}. Cutover negalimas.`,
      "DR_VERIFICATION_FAILED"
    );
  }

  /**
   * ⚠️ EVIDENCIJA TIK PO VISOS SEKOS. Įrašas po dalinio darbo skelbtų atkūrimą,
   * kurio nebuvo — ta pati taisyklė kaip 7.6b (`POST_RESTORE_RECONCILED` po commit'o).
   */
  await auditWrite.rasytiAudita({
    event: AUDITO_IVYKIS,
    success: true,
    actor: actor || undefined,
    details:
      `db=${merge.tapatybe} deployment=${merge.deploymentId} ` +
      `sulietos=${merge.sulietos.length} praleistos=${merge.praleistos.length} ` +
      `nukirptiClaimai=${merge.nukirptiClaimai.length} istrinta=${replayRez.istrinta.length} ` +
      `jauNebuvo=${replayRez.jauNebuvo.length} sesijos=${reconcile.sesijos}`,
  });

  log.info("DR atkūrimas baigtas", { stage: "dr_recovery_completed", istrinta: replayRez.istrinta.length });

  return { merge, replay: replayRez, reconcile, verify };
}

module.exports = {
  AUDITO_IVYKIS,
  SVIEZUMO_OVERRIDE_IVYKIS,
  NUMATYTAS_SVIEZUMO_LANGAS_MS,
  DrCoordinatorError,
  sviezumoLangasMs,
  patikrintiSargus,
  sulieti,
  replay,
  suderinti,
  patikrinti,
  paleisti,
  /**
   * ⚠️ EKSPORTUOJAMA TESTUI, IR TAI UŽRAŠYTA.
   *
   * Seka tikrinama KRITIMU, ne stebėjimu; override pėdsako abi laikmenos
   * (audito įrašas ir operatoriaus patvirtinimas) tikrinamos tiesiogiai, nes per
   * pilną `sulieti()` joms reikėtų tikros DB — o sprendimas, kuris jų reikalauja,
   * yra grynas.
   */
  _uzfiksuotiOverride,
  _patikrintiMerge,
  _patikrintiReplay,
};
