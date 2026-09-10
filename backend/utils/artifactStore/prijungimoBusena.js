/**
 * ARTEFAKTŲ SAUGYKLOS PRIJUNGIMO STEBĖTOJAS (#157, PR-7, 3 sąlyga).
 *
 * ⚠️ KODĖL JIS PARAŠYTAS PRIEŠ PRIJUNGIMĄ (§12.1: PIRMOJI REDAKCIJA SAKĖ „KAM JIS,
 * KAI PRIJUNGIMO DAR NĖRA" — PRIJUNGIMAS JAU YRA).
 *
 * Iki PR-7 prijungimo žingsnio `initializePostgres()` kvietė `createPostgresStore(pool)`
 * BE saugyklos: diegimas su `ARTIFACT_STORE_BACKEND=s3` startuodavo žaliai ir toliau
 * rašydavo `inline` — TYLIAI. Klaida paaiškėtų ne starte, o po savaitės, kai kas nors
 * pastebėtų, kad kibiras tuščias, arba niekada.
 *
 * Stebėtojas parašytas PRIEŠ tą prijungimą sąmoningai: jis yra tas įrankis, kuriuo
 * prijungimas patikrintas. Sukurtas po jo, jis tikrintų pats save.
 *
 * ⚠️ IR TAI IŠMATUOTA, NE TEIGIAMA: `jobStoreArtefaktuPrijungimas.integration` VIENAME
 * teste, prieš TĄ PAČIĄ bazę ir TA PAČIA funkcija, gauna `rasymas_neprijungtas` be
 * paduotos saugyklos ir žalią verdiktą po `initializePostgres()`.
 *
 * ⚠️ LYGINAMOS TRYS AIBĖS, NE VIENA BŪSENA.
 *
 *   PARINKTA   — ko prašo operatorius (`ARTIFACT_STORE_BACKEND`).
 *   PRIJUNGTA  — kas realiai registruota `postgresStore` rezolveryje.
 *   REIKALINGA — kokių tipų eilutės BAZĖJE jau yra (`job_results`, `job_result_attempts`).
 *
 * Nė vienos poros nepakanka. „Parinkta vs prijungta" praleidžia diegimą, perėjusį iš
 * `s3` į `fs`: rašymas teisingas, bet seni `s3` rezultatai nebeperskaitomi. „Prijungta
 * vs reikalinga" praleidžia priešingą atvejį: skaitymas veikia, o rašymas tyliai eina
 * ne ten, kur prašyta. Abu yra tikri gedimai ir abu matomi tik lyginant visas tris.
 *
 * ⚠️ STEBĖTOJAS NESTABDO STARTO.
 *
 * Fail-closed startas yra 10 sąlyga ir jis eina KARTU SU BARJERU, ne čia. Šiame PR
 * verdiktas yra matomas, bet nekeičia proceso baigties — įskaitant patį stebėjimą:
 * kritusi užklausa duoda `nezinoma: true`, ne kritusį startą. Diagnostika, tapusi
 * nauju gedimo tašku, yra blogesnė už jos nebuvimą.
 *
 * ⚠️ SANITIZACIJA — KONSTRUKCIJA, NE VALYMAS (#319 pamoka).
 *
 * `REDIS_URL` atveju priežastis buvo formuojama iš eilutės su slaptažodžiu ir teko
 * ją TRINTI regexp'u. Čia to kelio nėra: verdiktas neša TIK backend'ų ir tipų VARDUS
 * (`inline`, `fs`, `s3`) — niekada endpoint'o, kibiro, rakto ar `ARTIFACT_FS_ROOT`
 * reikšmės. Vardų aibė yra `LEISTINI`, ji uždara, ir jos elementai nėra kredencialai.
 * Tai tikrina testas, ne šis komentaras: `artifactStorePrijungimas` paduoda realias
 * paslaptis per `env` ir reikalauja, kad nė viena neatsirastų verdikte.
 */

/**
 * ⚠️ `inline` SAUGYKLOS NEREIKALAUJA — turinys gyvena `job_results.payload` eilutėje.
 * Ta pati riba, kaip `restoredJobStore.paruosti()`, ir dėl tos pačios priežasties.
 */
const BE_SAUGYKLOS = "inline";

/** Radinių kodai — užšaldyti, nes juos cituoja `doctor` išvestis ir testai. */
const RADINIAI = Object.freeze({
  /** Parinktas ne `inline` backend'as, bet rašymo saugykla neprijungta visai. */
  RASYMAS_NEPRIJUNGTAS: "rasymas_neprijungtas",
  /** Prijungta saugykla, bet KITO backend'o, nei parinkta. */
  RASYMAS_NE_TAS: "rasymas_ne_tas",
  /** Bazėje yra eilučių, kurių tipui saugykla neregistruota — skaitymas kris. */
  SKAITYMUI_TRUKSTA: "skaitymui_truksta",
  /** `ARTIFACT_STORE_BACKEND` konfigūracija netinkama — parinkimas krito. */
  KONFIGURACIJA_NETINKAMA: "konfiguracija_netinkama",
});

const rusiuoti = (reiksmes) => [...new Set(reiksmes)].filter(Boolean).sort();
const sarasas = (reiksmes) => (reiksmes.length > 0 ? reiksmes.join(", ") : "nė vieno");

/**
 * Gryna verdikto funkcija — be DB, be `process.env`, be laiko.
 *
 * @param {object} p
 * @param {string|null} p.parinktas `parinktiBackenda()` rezultatas; `null`, jei krito
 * @param {string|null} p.konfiguracijosKlaida `ArtifactStoreError.kodas`, jei parinkimas krito
 * @param {string|null} p.rasymoBackend realiai prijungtos rašymo saugyklos `backend`
 * @param {string[]} p.registruotiTipai `storage_type` reikšmės, kurioms yra saugykla
 * @param {string[]} p.reikalingiTipai `storage_type` reikšmės, esančios bazėje
 * @param {boolean} [p.nezinoma] stebėjimas neįvyko (užklausa krito) — verdiktas nepilnas
 */
function ivertintiPrijungima({
  parinktas = null,
  konfiguracijosKlaida = null,
  rasymoBackend = null,
  registruotiTipai = [],
  reikalingiTipai = [],
  nezinoma = false,
} = {}) {
  const registruoti = rusiuoti(registruotiTipai);
  const reikalingi = rusiuoti(reikalingiTipai).filter((tipas) => tipas !== BE_SAUGYKLOS);
  const truksta = reikalingi.filter((tipas) => !registruoti.includes(tipas));
  const radiniai = [];

  if (konfiguracijosKlaida) {
    radiniai.push(RADINIAI.KONFIGURACIJA_NETINKAMA);
  } else if (parinktas && parinktas !== BE_SAUGYKLOS) {
    if (!rasymoBackend) radiniai.push(RADINIAI.RASYMAS_NEPRIJUNGTAS);
    else if (rasymoBackend !== parinktas) radiniai.push(RADINIAI.RASYMAS_NE_TAS);
  }

  if (truksta.length > 0) radiniai.push(RADINIAI.SKAITYMUI_TRUKSTA);

  return {
    /**
     * ⚠️ `nezinoma` NĖRA `ok: false`. „Nepavyko pažiūrėti" ir „pažiūrėjau, blogai" yra
     * skirtingi faktai, ir operatoriui, gavusiam raudoną varnelę, pirmas klausimas
     * būtų „kas būtent blogai" — į kurį pirmuoju atveju atsakymo nėra.
     */
    ok: radiniai.length === 0,
    nezinoma,
    parinktas,
    rasymoBackend,
    registruotiTipai: registruoti,
    reikalingiTipai: reikalingi,
    truksta,
    radiniai,
    santrauka: suformuotiSantrauka({ parinktas, rasymoBackend, registruoti, reikalingi, truksta, radiniai, nezinoma }),
  };
}

function suformuotiSantrauka({ parinktas, rasymoBackend, registruoti, reikalingi, truksta, radiniai, nezinoma }) {
  const kontekstas =
    `parinkta: ${parinktas || "(neatsakyta)"}; rašymas: ${rasymoBackend || "neprijungtas"}; ` +
    `registruoti: ${sarasas(registruoti)}; bazėje: ${sarasas(reikalingi)}`;

  if (nezinoma) return `būsenos nustatyti nepavyko (${kontekstas})`;
  if (radiniai.length === 0) return `saugyklų prijungimas atitinka konfigūraciją ir bazės turinį (${kontekstas})`;

  const paaiskinimai = radiniai.map((radinys) => {
    if (radinys === RADINIAI.KONFIGURACIJA_NETINKAMA) return "`ARTIFACT_STORE_BACKEND` konfigūracija netinkama";
    if (radinys === RADINIAI.RASYMAS_NEPRIJUNGTAS)
      return `parinkta '${parinktas}', bet rašymo saugykla NEPRIJUNGTA — rezultatai rašomi 'inline'`;
    if (radinys === RADINIAI.RASYMAS_NE_TAS)
      return `parinkta '${parinktas}', bet prijungta '${rasymoBackend}'`;
    return `bazėje yra eilučių, kurių saugykla neregistruota: ${sarasas(truksta)} — skaitymas kris`;
  });

  return `${paaiskinimai.join("; ")} (${kontekstas})`;
}

/**
 * Kokių tipų eilučių bazėje JAU YRA.
 *
 * ⚠️ DU ŠALTINIAI, NE VIENAS. `job_results` sako, ką reikės PERSKAITYTI; nebaigtų
 * `job_result_attempts` tipai sako, ką reikės IŠŠLUOTI. Šlavėjas be saugyklos palieka
 * našlaitį saugykloje — būtent tai, ko registras egzistuoja neleisti.
 *
 * ⚠️ `42P01` = lentelės nėra: tai NE gedimas, o senesnė schema. Ta pati riba ir tas
 * pats precedentas kaip `restoredJobStore.paruosti()`. Bet kokia kita klaida keliauja
 * toliau — ją gaudo kvietėjas ir verčia į `nezinoma`.
 *
 * ⚠️ UŽKLAUSOS APRIBOTOS LAIKU, IR TAI NE ATSARGUMAS, O KAINOS RIBA.
 *
 * `storage_type` neturi indekso nė vienoje lentelėje, tad `SELECT DISTINCT` yra
 * SEQ SCAN. Milijono eilučių bazėje stebėtojas pridėtų sekundes prie KIEKVIENO
 * starto — diagnostika, tapusi lėtinimo šaltiniu, būtų nuimta pirmą kartą, kai
 * kam nors pritrūktų kantrybės, ir tada nebeliktų nei jos, nei matomumo.
 *
 * Riba paverčia neribotą kainą į žinomą: nespėta užklausa duoda `nezinoma`, o tai
 * yra sąžiningas atsakymas („nepavyko pažiūrėti"), ne tylus žalias. Dalinis
 * indeksas (`WHERE storage_type <> 'inline'`) būtų geresnis ilgalaikis sprendimas
 * ir tuščioje-inline bazėje nieko nekainuotų, bet tai SCHEMOS pokytis, kurio šis
 * žingsnis neapima; jis priimamas išmatavus, ne spėjus.
 *
 * ⚠️ `SET LOCAL` TRANSAKCIJOJE, NE `SET` KLIENTE. Pooled klientas grįžta į pool'ą
 * su visais savo nustatymais; `statement_timeout`, paliktas ant jo, galiotų
 * SEKANČIAM kvietėjui, kuris apie jį nieko nežino. Ta pati klasė kaip pataisyto
 * kliento nutekėjimas — tik tyliau, nes pasireikštų tik po apkrovos.
 */
async function nustatytiReikalingusTipus(pool, { timeoutMs = 2000 } = {}) {
  /**
   * ⚠️ RIBA NORMALIZUOJAMA, NE PASITIKIMA. Netinkama reikšmė duotų netinkamą SQL,
   * o tas kristų kaip stebėjimo gedimas — stebėtojas TYLIAI pavirstų amžinu
   * `nezinoma`, t. y. tiksliai ta būsena, kurios jis egzistuoja neleisti.
   */
  const riba = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 2000;
  const klientas = await pool.connect();

  /**
   * Kiekviena užklausa — SAVO transakcijoje.
   *
   * ⚠️ NE DĖL IZOLIACIJOS, O DĖL `42P01`. Kritusi užklausa PERVEDA transakciją į
   * `25P02` būseną, tad senesnė schema (nėra `job_result_attempts`) sugriautų ir
   * gretimą užklausą — t. y. palaikomas kelias virstų `nezinoma` verdiktu.
   */
  const uzklausti = async (sakinys) => {
    try {
      await klientas.query("BEGIN");
      await klientas.query(`SET LOCAL statement_timeout = ${riba}`);
      const { rows } = await klientas.query(sakinys);
      await klientas.query("COMMIT");
      return rows.map((eilute) => eilute.storage_type);
    } catch (klaida) {
      await klientas.query("ROLLBACK").catch(() => {});
      if (klaida.code === "42P01") return [];
      throw klaida;
    }
  };

  try {
    const rezultatai = await uzklausti(
      "SELECT DISTINCT storage_type FROM job_results WHERE storage_type <> 'inline'"
    );
    const bandymai = await uzklausti("SELECT DISTINCT storage_type FROM job_result_attempts");
    return { rezultatai: rusiuoti(rezultatai), bandymai: rusiuoti(bandymai) };
  } finally {
    klientas.release();
  }
}

/**
 * Pilnas verdiktas: konfigūracija + rezolveris + bazė.
 *
 * ⚠️ SUDĖTIS GYVENA ČIA, NE `jobStore/index.js`, IR TAI TESTUOJAMUMO SPRENDIMAS.
 *
 * `index.js` yra singleton su `initPromise`; ten paliktas sudėjimas būtų pasiekiamas
 * tik per pilną `init()`, tad testas arba paliestų viso proceso būseną, arba
 * PERRAŠYTŲ tą pačią sudėtį pas save — o antra kopija nustotų atitikti pirmąją tyliai.
 * Modulyje ji yra paprasta funkcija su aiškiomis įvestimis.
 *
 * ⚠️ NIEKADA NEMETA. Verdiktas apie prijungimą, pats tapęs starto gedimu, būtų
 * blogesnis už jo nebuvimą; nepavykęs stebėjimas grąžinamas kaip `nezinoma`.
 *
 * @param {object} pool `pg` pool su prieiga prie `job_results`
 * @param {object} pgStore `createPostgresStore()` rezultatas
 * @param {object} [parinktys]
 * @param {object} [parinktys.env] aplinka (`ARTIFACT_STORE_BACKEND`)
 * @param {(zinute: string, ctx: object) => void} [parinktys.ispeti] pranešėjas apie neįvykusį stebėjimą
 */
async function nustatytiPrijungimoBusena(pool, pgStore, { env = process.env, ispeti = null } = {}) {
  const { parinktiBackenda } = require("./backendSelection");

  let parinktas = null;
  let konfiguracijosKlaida = null;
  try {
    ({ backend: parinktas } = parinktiBackenda(env));
  } catch (klaida) {
    /**
     * ⚠️ IMAMAS TIK KODAS, NE PRANEŠIMAS. `ArtifactStoreError` pranešimas šiandien
     * vardija tik kintamųjų VARDUS, bet verdiktas keliauja į `doctor` išvestį, o ten
     * pakliuvęs kredencialas nebeatšaukiamas. Kodas pakanka: „kuris kintamasis"
     * pasako startą sustabdžiusi klaida, kuri lieka loge.
     */
    konfiguracijosKlaida = klaida.kodas || klaida.code || "ARTIFACT_CONFIG_INVALID";
  }

  /**
   * ⚠️ TIKRINAMAS DUBLIŲ, NE PRODUKCIJOS, LABUI.
   *
   * Visi TRYS backend'ai metodą deklaruoja privalomai (`jobStoreBackendContract`,
   * 26 metodai), tad produkcijoje jo nebuvimas neįmanomas. Sąlyga saugo testų
   * dublius, kuriems pilnos aibės nereikia; produkcinę spragą gaudo sargas, ne ji.
   */
  const busena = pgStore && typeof pgStore.saugykluBusena === "function" ? pgStore.saugykluBusena() : {};
  const bendra = {
    parinktas,
    konfiguracijosKlaida,
    rasymoBackend: busena.rasymoBackend || null,
    registruotiTipai: busena.registruotiTipai || [],
  };

  try {
    const saltiniai = await nustatytiReikalingusTipus(pool);
    return {
      ...ivertintiPrijungima({
        ...bendra,
        reikalingiTipai: [...saltiniai.rezultatai, ...saltiniai.bandymai],
      }),
      saltiniai,
    };
  } catch (klaida) {
    if (ispeti) ispeti("Artefaktų saugyklos būsenos nustatyti nepavyko", { code: klaida.code });
    return ivertintiPrijungima({ ...bendra, nezinoma: true });
  }
}

module.exports = { RADINIAI, ivertintiPrijungima, nustatytiReikalingusTipus, nustatytiPrijungimoBusena };
