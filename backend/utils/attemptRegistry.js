const crypto = require("node:crypto");

/**
 * BANDYMŲ REGISTRAS — ORPHAN'AS TAMPA MATOMAS DB KRYPTIMI (#157, PR-4).
 *
 * ⚠️ ĮRAŠAS ATSIRANDA PRIEŠ `put()`, NE PO JO.
 *
 * Po `put()` registruojant liktų tas pats langas, tik siauresnis: procesas, kritęs
 * tarp rašymo ir registravimo, paliktų objektą, kurio nerodo niekas. Registruojant
 * PRIEŠ, blogiausia būsena yra `pending` eilutė BE objekto — o ji nekainuoja nieko:
 * valymas kreipiasi į saugyklą, gauna „nėra" ir uždaro eilutę.
 *
 * ⚠️ KRYPTIS PASIRINKTA SĄMONINGAI: geriau eilutė be objekto, nei objektas be eilutės.
 * Pirmoji yra šiukšlė registre, antroji — transkripcija, kurios nepasiekia nei erasure,
 * nei DB krypties skenavimas (A3).
 *
 * ⚠️ REGISTRAS NEDENGIA objektų, atsiradusių NE per mūsų rašymo kelią (rankinis
 * kopijavimas, atkūrimas į kitą prefiksą) — riba užrašyta `docs/artefact-lifecycle.md`.
 *
 * ⚠️ PR-4 REGISTRAS YRA WRITE-ONLY, IR TAI SĄMONINGA, NE PRALEIDIMAS.
 *
 * `joboBandymai()` čia jau yra, bet už modulio ribų jo dar niekas nekviečia: erasure
 * jungtis ir šlavėjas gyvena PR-5 („Erasure ir registro vartotojai"). Savybė be ją
 * paisančio kelio yra dokumentacija, ne savybė — todėl tai užrašoma atvirai.
 *
 * ⚠️ KODĖL LANGAS NEPAVOJINGAS: external rašymas įsijungia TIK gavus `rasymoSaugykla`,
 * o produkcinis prijungimas vyksta PR-7 kartu su non-inline sargo pašalinimu. Skaitymo
 * pusė (PR-5) atsiranda ANKSČIAU, nei kelias tampa pasiekiamas — write-only langas
 * niekada nepersidengia su diegimu, kuris realiai rašo external rezultatus.
 *
 * Iš penkių sprendimo (b) sąlygų PR-4 įgyvendina dvi (įrašas prieš `put()`, cleanup tik
 * savo bandymo); trys likusios — erasure pagal registrą, šlavėjas ir retencija iš
 * `revivalHorizonsMs()` — yra PR-5 apimtis.
 */

/** Būsenos privalo sutapti su migracijos `job_result_attempts_busena_allowed`. */
const BUSENA = Object.freeze({
  /** Registruota prieš `put()`; objektas gali egzistuoti arba ne. */
  LAUKIA: "pending",
  /** Nuoroda įsipareigota `job_results` eilutėje — objektas NAUDOJAMAS. */
  ISIPAREIGOTA: "committed",
  /** Bandymas pralaimėjo ar buvo remontuotas — objektas šalintinas. */
  ATMESTA: "abandoned",
});

/**
 * Objekto raktas vienam bandymui.
 *
 * ⚠️ `jobId` PREFIKSAS YRA ERASURE REIKALAS, NE TAPATYBĖ. Jis leidžia žmogui matyti,
 * kam objektas priklauso; tapatybę neša `checksum` KOLONA, o unikalumą — `attemptId`.
 * ⚠️ Raktas NEIŠVEDAMAS iš checksum'o (A2 riba galioja abiem kryptimis).
 */
function bandymoRaktas(jobId, attemptId) {
  return `results/${jobId}/${attemptId}.json`;
}

/** Naujas bandymo identifikatorius. Atskira funkcija — kad testai galėtų jį fiksuoti. */
function naujasBandymas() {
  return crypto.randomUUID();
}

/**
 * Registruoja bandymą PRIEŠ rašymą.
 *
 * @param {{query: Function}} vykdytojas pool arba transakcijos klientas
 */
async function registruoti(vykdytojas, { attemptId, jobId, storageType, storageKey }) {
  await vykdytojas.query(
    `INSERT INTO job_result_attempts (attempt_id, job_id, storage_type, storage_key, busena)
     VALUES ($1, $2, $3, $4, $5)`,
    [attemptId, String(jobId), storageType, storageKey, BUSENA.LAUKIA]
  );
}

/**
 * ⚠️ BŪSENOS PERĖJIMAS VYKSTA TOJE PAČIOJE TRANSAKCIJOJE KAIP NUORODOS ĮRAŠYMAS.
 *
 * Kitaip liktų langas, kuriame `job_results` jau rodo į objektą, o registras dar sako
 * „pending": valymas, pamatęs seną `pending` eilutę, ištrintų NAUDOJAMĄ objektą.
 * Todėl `vykdytojas` čia yra transakcijos klientas, ne pool'as.
 */
async function pazymeti(vykdytojas, attemptId, busena) {
  const { rowCount } = await vykdytojas.query(
    `UPDATE job_result_attempts SET busena = $2, updated_at = now() WHERE attempt_id = $1`,
    [attemptId, busena]
  );

  return rowCount > 0;
}

/**
 * ĮSIPAREIGOJIMAS: šis bandymas tampa `committed`, visi ANKSTESNI — `abandoned`.
 *
 * ⚠️ INVARIANTAS: JOB'AS TURI DAUGIAUSIA VIENĄ ĮSIPAREIGOTĄ BANDYMĄ (išmatuota
 * CI 34083939521).
 *
 * Pirmoji redakcija tik pažymėdavo naująjį. Po REMONTO registre likdavo DU
 * `committed` įrašai: senasis (kurio objekto nebėra) ir naujasis. Registras tada
 * teigtų, kad naudojami DU objektai, o šlavėjas (PR-5) senojo niekada neliestų — jis
 * atrodytų reikalingas.
 *
 * ⚠️ INVARIANTAS GYVENA DB, NE ČIA (migracija `1756400000000`).
 *
 * Ši funkcija jį PALAIKO, bet neberemia juo garantijos: dalinis unikalus indeksas
 * `UNIQUE (job_id) WHERE busena = 'committed'` daro antrą įsipareigotą bandymą
 * NEIŠREIŠKIAMĄ. Priežastis — šlavėjas (PR-5) trins objektus pagal registrą, tad
 * prielaida bus ne šio modulio vidaus reikalas.
 *
 * ⚠️ PERĖJIMAS DVIEM SAKINIAIS, NE VIENU `CASE` — TAI INDEKSO PASEKMĖ.
 *
 * Dalinio unikalaus indekso atidėti negalima (`DEFERRABLE` reikalauja constraint'o,
 * o constraint'as negali būti dalinis), tad unikalumas tikrinamas kiekvieno sakinio
 * pabaigoje. Viename `UPDATE ... CASE` sakinyje eilučių tvarka neapibrėžta: jei
 * naujasis būtų pažymėtas `committed` prieš nuvertinant senąjį, sakinys kristų
 * ATSITIKTINAI. Todėl pirma nuvertinama, tada įsipareigojama.
 *
 * Abu sakiniai eina TOJE PAČIOJE transakcijoje kaip nuorodos įrašymas, tad išorėje
 * momento „įsipareigotų du arba nė vieno" nesimato — jis egzistuoja tik šios
 * transakcijos viduje, kur nė vienas kitas skaitytojas jo nepasiekia.
 */
async function isipareigoti(vykdytojas, { jobId, attemptId }) {
  await vykdytojas.query(
    `UPDATE job_result_attempts
        SET busena = $3, updated_at = now()
      WHERE job_id = $1 AND busena = $4 AND attempt_id <> $2`,
    [String(jobId), attemptId, BUSENA.ATMESTA, BUSENA.ISIPAREIGOTA]
  );

  await vykdytojas.query(
    `UPDATE job_result_attempts
        SET busena = $3, updated_at = now()
      WHERE job_id = $1 AND attempt_id = $2`,
    [String(jobId), attemptId, BUSENA.ISIPAREIGOTA]
  );
}

/** Visi job'o bandymai — erasure kelias (PR-5) trina PAGAL REGISTRĄ, ne pagal nuorodą. */
async function joboBandymai(vykdytojas, jobId) {
  const { rows } = await vykdytojas.query(
    `SELECT attempt_id, job_id, storage_type, storage_key, busena, created_at
       FROM job_result_attempts WHERE job_id = $1 ORDER BY created_at`,
    [String(jobId)]
  );

  return rows;
}

/**
 * ŠLAVIMO KANDIDATAI — RETENCIJOS PREDIKATAS VIENU SAKINIU (#157, PR-5).
 *
 * ⚠️ APSAUGA YRA DVIGUBA, IR ABI ŠAKOS BŪTINOS (įėjimo sąlyga 3).
 *
 * 1. **Nuoroda:** eilutė, kurios `storage_key` yra gyvoje `job_results` eilutėje, NĖRA
 *    kandidatė. Predikatas per nuorodą, ne per `busena = 'committed'`: būsena yra
 *    TVIRTINIMAS, o nuoroda — FAKTAS, ir jiedu gali išsiskirti (ranka redaguota eilutė,
 *    atkūrimas iš dviejų skirtingų momentų).
 * 2. **Ištrynimo žyma:** ištrynimas NAIKINA nuorodas (`job_results` turi
 *    `ON DELETE CASCADE` nuo `jobs`), tad pirmoji šaka dingsta būtent tada, kai jos
 *    labiausiai reikia — daliniame gedime. Žyma rašoma PRIEŠ šalinimą, tad ji išgyvena
 *    nuorodos dingimą ir pati savaime pasibaigia, kai ištrynimas patvirtinamas.
 *
 * Be antrosios šakos galima seka: `delete()` krenta -> job'o eilutė vis tiek pašalinama ->
 * bandymų eilutės nebeapsaugotos -> retencija jas pašalina -> `deletionRetry` grįžta prie
 * pažymėto job'o ir nebeturi iš kur sužinoti adresų -> objektas lieka amžiams.
 *
 * ⚠️ VIENAS SAKINYS, NE DVIEJŲ SAUGYKLŲ PALYGINIMAS. `erasure_marks` gyvena toje pačioje
 * bazėje kaip `job_result_attempts`, tad predikatas skaičiuojamas DB pusėje; lyginant per
 * programą tarp dviejų skaitymų liktų langas, kuriame žyma spėtų atsirasti.
 *
 * ⚠️ `pending` IR `abandoned` TURI SKIRTINGAS RIBAS (įėjimo sąlyga 4a).
 *
 * `abandoned` reiškia, kad rašytojas BAIGĖ — tai žinoma iš būsenos, tad pakanka prikėlimo
 * horizonto. `pending` reiškia „gali būti vykdoma DABAR": eilutė sukuriama PRIEŠ `put()`,
 * o laikinas failas nuo PR-5 turi APSKAIČIUOJAMĄ vardą, tad šlavėjas gali ištrinti
 * vykstančio rašymo laikinąjį failą. Todėl `pending` riba turi atskirą narį.
 *
 * ⚠️ `created_at` ATEITYJE — NEŠLUOJAMA, IR TAI SKAIČIUOJAMA (įėjimo sąlyga 4b).
 *
 * Po atkūrimo iš `pg_dump` žymos yra ŠALTINIO laiko (ta pati klasė kaip
 * `deploymentIdentity`), tad amžius iš jų gali būti nepalyginamas. Ateityje esantis
 * `created_at` yra vienintelė DETEKTUOJAMA to dalis; įtartinai senos, bet praeityje
 * esančios eilutės nuo tikrai senų neatskiriamos — riba užrašyta plane, ne nutylėta.
 *
 * @returns {Promise<{kandidatai: Array<object>, praleista: number}>}
 */
async function valytiniBandymai(
  vykdytojas,
  { laukianciuRibaMs, atmestuRibaMs, kiekis = 200 }
) {
  /**
   * ⚠️ ŽYMŲ SĄLYGĄ DUODA AUTORITETAS, NE ŠIS MODULIS. `erasure_marks` SQL neegzistuoja
   * už `deletionTombstones/` ribų (tripwire per visą repo, #183), tad lentelės vardą,
   * stulpelį ir statuso reikšmę žino TIK jis; čia gaunamas tekstas su mūsų alias'u.
   */
  const { neisspresptosZymosSalyga } = require("./deletionTombstones/postgresStore");
  const zymosSalyga = neisspresptosZymosSalyga("a");

  const { rows } = await vykdytojas.query(
    `SELECT a.attempt_id, a.job_id, a.storage_type, a.storage_key, a.busena, a.created_at,
            (a.created_at > now()) AS laikas_ateityje
       FROM job_result_attempts a
      WHERE a.busena <> $1
        AND NOT EXISTS (
              SELECT 1 FROM job_results r WHERE r.storage_key = a.storage_key
            )
        AND ${zymosSalyga}
        AND (
              a.created_at > now()
              OR a.created_at < now() - (
                   CASE WHEN a.busena = $2 THEN $3::double precision ELSE $4::double precision END
                     * INTERVAL '1 millisecond'
                 )
            )
      ORDER BY a.created_at
      LIMIT $5`,
    [BUSENA.ISIPAREIGOTA, BUSENA.LAUKIA, Number(laukianciuRibaMs), Number(atmestuRibaMs), Number(kiekis)]
  );

  return {
    kandidatai: rows.filter((r) => !r.laikas_ateityje),
    praleista: rows.filter((r) => r.laikas_ateityje).length,
  };
}

module.exports = {
  BUSENA,
  valytiniBandymai,
  bandymoRaktas,
  naujasBandymas,
  registruoti,
  pazymeti,
  isipareigoti,
  joboBandymai,
};
