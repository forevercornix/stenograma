const crypto = require("node:crypto");

const attemptRegistry = require("./attemptRegistry");
const { paruostiReiksme, ArtifactStoreError, KLAIDA } = require("./artifactStore/validation");
const { createLogger } = require("./logger");

/**
 * `inline` → external MIGRACIJA (#157, PR-6).
 *
 * ⚠️ TVARKA YRA VISA ESMĖ, IR JI TA PATI KAIP PRODUKCINIAME KELYJE.
 *
 *   registras (`pending`) → `put()` → `verify()` → ATOMINIS reference switch
 *
 * Ne todėl, kad taip gražiau, o todėl, kad kiekvienas žingsnis uždaro konkrečią
 * gedimo klasę, ir jos jau apmokėtos PR-4/PR-5 kaina:
 *
 *   - registras PRIEŠ `put()` — procesas, kritęs po rašymo, palieka objektą su
 *     ADRESU DB pusėje; be to įrašo tai būtų transkripcija, kurios nepasiekia
 *     nei erasure, nei šlavėjas (A3: `list(prefix)` nėra);
 *   - `verify()` PRIEŠ perjungimą — `payload` naikinamas tik po to, kai objekto
 *     vientisumas PATVIRTINTAS TURINIU, ne dydžiu. `head()` čia nepakanka: ji
 *     grąžina tik baitus, tad sugadintas to paties ilgio objektas ją praeina
 *     (sąlyga 7: „vienintelė kopija");
 *   - perjungimas VIENU sakiniu — išmatuota, kad kitaip DB ir nepriima
 *     (`jobResultsShapeDomain.integration`: visi 60 dalinių sakinių → `23514`).
 *
 * ⚠️ SĄLYGA 6 PLANE NEBUVO. Planas PR-6 rašytas PRIEŠ PR-4 orphan sprendimą.
 * Migracija rašo objektą ir tik paskui perjungia nuorodą — tiksliai ta seka, dėl
 * kurios bandymų registras ir atsirado. Be registro migracija būtų NAUJAS
 * orphan'ų šaltinis, t. y. ta pati klasė, kurią PR-5 ką tik uždarė.
 *
 * ⚠️ KĄ MIGRACIJA DARO ATOMIŠKAI, IR KODĖL BŪTENT ŠIUOS TRIS DALYKUS.
 *
 * Vienoje transakcijoje: reference switch, `attemptRegistry.isipareigoti()` ir
 * `artifact_migration_progress` įrašas. Ne dėl patogumo — dėl poros
 * „progresas ↔ nuoroda". Jei progresas rašomas ATSKIRAI, atsiranda commit'inta
 * būsena, kurioje progresas sako `done`, o eilutė tebėra `inline` (arba
 * atvirkščiai), ir jokia `CHECK` sąlyga to negina: pora yra TARP dviejų lentelių.
 * Būtent šitą tikrina §9.1 stebėtojas — nes `job_results` eilutės viduje tikrinti
 * nebėra ko.
 */

const log = createLogger("artifact-migration");

/** Privalo sutapti su migracijos `artifact_migration_progress_busena_allowed`. */
const BUSENA = Object.freeze({
  ATLIKTA: "done",
  NEPAVYKO: "failed",
});

/** Privalo sutapti su `artifact_migration_progress_priezastis_allowed`. */
const PRIEZASTIS = Object.freeze({
  PAYLOAD_NEATVAIZDUOJAMAS: "payload_neatvaizduojamas",
  SAUGYKLOS_KLAIDA: "saugyklos_klaida",
  VIENTISUMAS_NEPATVIRTINTAS: "vientisumas_nepatvirtintas",
  EILUTE_PASIKEITE: "eilute_pasikeite",
});

/**
 * Kandidatai: `inline` eilutės, kurių šis kelias dar nepaženklino nesėkme.
 *
 * ⚠️ ATRANKA YRA VIENINTELIS „PROGRESO" ŠALTINIS, IR TAI SĄMONINGA. Perkeltos
 * eilutės nebėra `inline`, tad kitas paleidimas jų tiesiog nebemato — idempotencija
 * gaunama iš duomenų, ne iš žymeklio, kurį reikėtų sinchronizuoti (žr. migracijos
 * `1756600000000` komentarą apie antrą kopiją).
 *
 * ⚠️ `failed` PRALEIDŽIAMOS PAGAL NUTYLĖJIMĄ, BET NEUŽRAKINAMOS. Nesėkmė gali
 * būti ir laikina (saugyklos gedimas), ir galutinė (neatvaizduojamas `payload`);
 * atskirti jas gali tik operatorius, tad kartojimas yra JO sprendimas
 * (`retryFailed`), o ne tylus ciklas, kuris kas paleidimą bando tą patį.
 */
const KANDIDATAI_SQL = `
  SELECT r.job_id, r.payload
    FROM job_results r
   WHERE r.storage_type = 'inline'
     AND r.payload IS NOT NULL
     AND ($2::boolean OR NOT EXISTS (
           SELECT 1 FROM artifact_migration_progress p
            WHERE p.job_id = r.job_id::text AND p.busena = 'failed'
         ))
   ORDER BY r.created_at
   LIMIT $1
`;

async function irasytiNesekme(vykdytojas, { jobId, priezastis, runId }) {
  await vykdytojas.query(
    `INSERT INTO artifact_migration_progress (job_id, busena, priezastis, run_id, created_at, updated_at)
     VALUES ($1, 'failed', $2, $3, now(), now())
     ON CONFLICT (job_id) DO UPDATE
        SET busena = 'failed',
            priezastis = EXCLUDED.priezastis,
            storage_type = NULL,
            storage_key = NULL,
            run_id = EXCLUDED.run_id,
            updated_at = now()`,
    [String(jobId), priezastis, runId]
  );
}

/**
 * ⚠️ VALYMAS TRINA TIK SAVO BANDYMĄ — ta pati konstrukcija kaip `postgresStore`.
 *
 * Su attempt-unique raktu pralaimėjęs fiziškai neturi kaip paliesti svetimo
 * objekto. Registro eilutė LIEKA, tik pažymima `abandoned`: ji yra įrodymas, kad
 * objektas egzistavo, ir šlavėjui reikalinga net tada, kai trynimas dabar nepavyko.
 */
async function isvalytiBandyma(pool, saugykla, { attemptId, raktas }) {
  if (!attemptId) return;

  try {
    await saugykla.delete(raktas);
  } catch (klaida) {
    log.error("Nepavykusio migracijos bandymo objekto pašalinti nepavyko", {
      code: klaida && klaida.code,
    });
  }

  await attemptRegistry.pazymeti(pool, attemptId, attemptRegistry.BUSENA.ATMESTA).catch((klaida) => {
    log.error("Bandymo pažymėti `abandoned` nepavyko", { code: klaida && klaida.code });
  });
}

/**
 * Vienos eilutės perkėlimas. Grąžina `{ verdiktas, priezastis?, storageKey? }`.
 *
 * ⚠️ NEMETA. Vienos eilutės nesėkmė neturi stabdyti viso paleidimo: migracija yra
 * masinė operacija, ir vienas neatvaizduojamas `payload` neturi palikti likusių
 * dešimt tūkstančių nepaliestų. Nesėkmė UŽRAŠOMA, ne praryjama.
 */
async function perkeltiEilute(pool, saugykla, { jobId, payload, runId }) {
  /* ═══ 1. RIBA PRIEŠ VISKĄ ═══
   *
   * Jei reikšmės riba nepriima, saugykloje neturi atsirasti niekas — nei objekto,
   * nei registro eilutės. Patikra pigi, tad daroma pirma.
   */
  let paruosta;
  try {
    paruosta = paruostiReiksme(payload);
  } catch (klaida) {
    const ribosKlaida =
      klaida instanceof ArtifactStoreError && klaida.code === KLAIDA.REIKSME;
    if (!ribosKlaida) throw klaida;

    await irasytiNesekme(pool, { jobId, priezastis: PRIEZASTIS.PAYLOAD_NEATVAIZDUOJAMAS, runId });
    return { verdiktas: BUSENA.NEPAVYKO, priezastis: PRIEZASTIS.PAYLOAD_NEATVAIZDUOJAMAS };
  }

  /* ═══ 2. REGISTRAS PRIEŠ `put()` ═══ */

  const attemptId = attemptRegistry.naujasBandymas();
  const raktas = attemptRegistry.bandymoRaktas(jobId, attemptId);

  await attemptRegistry.registruoti(pool, {
    attemptId,
    jobId: String(jobId),
    storageType: saugykla.backend,
    storageKey: raktas,
  });

  /* ═══ 3. RAŠYMAS IR VIENTISUMO PATVIRTINIMAS ═══ */

  let kvitas;
  try {
    kvitas = await saugykla.put(raktas, paruosta);
  } catch (klaida) {
    await isvalytiBandyma(pool, saugykla, { attemptId, raktas });
    await irasytiNesekme(pool, { jobId, priezastis: PRIEZASTIS.SAUGYKLOS_KLAIDA, runId });
    log.error("Migracijos rašymas nepavyko", { code: klaida && klaida.code });
    return { verdiktas: BUSENA.NEPAVYKO, priezastis: PRIEZASTIS.SAUGYKLOS_KLAIDA };
  }

  /**
   * ⚠️ SĄLYGA 7 GYVENA ČIA, IR JAI REIKIA `verify()`, NE `head()`.
   *
   * `head()` grąžina tik egzistavimą ir baitus — `fs` ir `s3` tai daro SĄMONINGAI
   * (metadata-only kaina). Sugadintas TO PAČIO ILGIO objektas tokią patikrą
   * praeina, ir kitas `UPDATE` sunaikina vienintelę galiojančią inline kopiją, o
   * `job_results` išsaugo ORIGINALO `checksum`. Nuo tada `verify()` visada sakys
   * „nesutampa" — jau po to, kai atkurti nebėra iš ko.
   *
   * ⚠️ IŠMATUOTA, NE NUMANYTA. CI 34360090645: objektas sugadintas failų sistemoje
   * nepakeičiant ilgio, `head()` grąžino tą patį dydį kaip kvitas, ir migracija
   * `payload` sunaikino. Su `verify()` tas pats testas praeina.
   *
   * ⚠️ TA PATI KLASĖ, KURIĄ PR-4 UŽDARĖ PRE-CHECK'E: verdiktas skelbiamas remiantis
   * įrodymu, kuris nustato tik DYDĮ. Ten pasekmė buvo sugadintas rezultatas
   * klientui; čia — sunaikinta vienintelė kopija.
   *
   * ⚠️ KAINA UŽRAŠOMA, NE NUTYLIMA. `verify()` PERSKAITO visą objektą, ir `fsStore`
   * komentaras sako, kad būtent dėl šios kainos metadata-only keliuose jis
   * DRAUDŽIAMAS. Čia ji pateisinama tuo, ko nėra kituose keliuose: iškart po šios
   * patikros naikinama vienintelė kopija. Migracija yra vienintelė vieta, kur
   * skaitymo kaina mažesnė už klaidos kainą.
   *
   * ⚠️ `nepriklausomas !== true` IRGI ATMETAMAS. `inlineStore` (`inlineStore.js:210`)
   * lygina reikšmę SU SAVIMI ir grąžina `false`; toks verdiktas migracijai
   * neįrodo nieko, o `payload` naikinimas remiasi būtent tuo įrodymu.
   */
  let vientisumas = null;
  try {
    vientisumas = await saugykla.verify(raktas, {
      bytes: kvitas.bytes,
      checksum: kvitas.checksum,
    });
  } catch (klaida) {
    log.error("Migracijos `verify()` krito", { code: klaida && klaida.code });
  }

  if (!vientisumas || vientisumas.ok !== true || vientisumas.nepriklausomas !== true) {
    await isvalytiBandyma(pool, saugykla, { attemptId, raktas });
    await irasytiNesekme(pool, { jobId, priezastis: PRIEZASTIS.VIENTISUMAS_NEPATVIRTINTAS, runId });
    return { verdiktas: BUSENA.NEPAVYKO, priezastis: PRIEZASTIS.VIENTISUMAS_NEPATVIRTINTAS };
  }

  /* ═══ 4. ATOMINIS PERJUNGIMAS ═══ */

  const client = await pool.connect();
  let isipareigota = false;

  try {
    await client.query("BEGIN");

    /**
     * ⚠️ VIENAS SAKINYS — NE STILIUS, O VIENINTELIS BŪDAS.
     *
     * Išmatuota (`jobResultsShapeDomain.integration`): visi 30 dalinių priskyrimų
     * poaibių kiekviena kryptimi atmetami `23514`. Skaidymas čia net nebūtų
     * „blogesnis variantas" — jis tiesiog nepraeitų.
     *
     * ⚠️ `WHERE` SĄLYGA YRA CAS, NE PATOGUMAS. Tarp atrankos ir šios transakcijos
     * eilutę galėjo pakeisti įprastas užbaigimo kelias. Be sąlygos perrašytume
     * svetimą, ką tik įsipareigotą nuorodą, ir jos objektas liktų be jokios
     * rodyklės — tiksliai tas orphan'as, dėl kurio egzistuoja registras.
     */
    const perjungimas = await client.query(
      `UPDATE job_results
          SET storage_type = $2,
              storage_key = $3,
              bytes = $4,
              checksum = $5,
              payload = NULL
        WHERE job_id = $1
          AND storage_type = 'inline'
          AND payload IS NOT NULL`,
      [jobId, saugykla.backend, kvitas.reference, kvitas.bytes, kvitas.checksum]
    );

    if (perjungimas.rowCount !== 1) {
      await client.query("ROLLBACK");
      await isvalytiBandyma(pool, saugykla, { attemptId, raktas });
      await irasytiNesekme(pool, { jobId, priezastis: PRIEZASTIS.EILUTE_PASIKEITE, runId });
      return { verdiktas: BUSENA.NEPAVYKO, priezastis: PRIEZASTIS.EILUTE_PASIKEITE };
    }

    await attemptRegistry.isipareigoti(client, { jobId: String(jobId), attemptId });

    /**
     * ⚠️ PROGRESAS RAŠOMAS TOJE PAČIOJE TRANSAKCIJOJE.
     *
     * Atskirai rašomas progresas sukurtų commit'intą būseną, kurioje jis sako
     * `done`, o eilutė tebėra `inline` — pora, kurios negina joks `CHECK`, nes ji
     * yra tarp dviejų lentelių. Tai vienas iš dviejų dalykų, kuriuos §9.1
     * stebėtojas realiai gali pagauti.
     */
    await client.query(
      `INSERT INTO artifact_migration_progress
             (job_id, busena, storage_type, storage_key, run_id, created_at, updated_at)
       VALUES ($1, 'done', $2, $3, $4, now(), now())
       ON CONFLICT (job_id) DO UPDATE
          SET busena = 'done',
              storage_type = EXCLUDED.storage_type,
              storage_key = EXCLUDED.storage_key,
              priezastis = NULL,
              run_id = EXCLUDED.run_id,
              updated_at = now()`,
      [String(jobId), saugykla.backend, kvitas.reference, runId]
    );

    await client.query("COMMIT");
    isipareigota = true;

    return { verdiktas: BUSENA.ATLIKTA, storageKey: kvitas.reference };
  } catch (klaida) {
    await client.query("ROLLBACK").catch(() => {});
    throw klaida;
  } finally {
    client.release();
    if (!isipareigota) await isvalytiBandyma(pool, saugykla, { attemptId, raktas });
  }
}

/**
 * Sausas paleidimas: ką migracija PADARYTŲ, nieko nekeisdama.
 *
 * ⚠️ NELIEČIA NEI SAUGYKLOS, NEI DB — net progreso lentelės. Dry-run, kuris rašo,
 * nėra dry-run; o „tik progresą" rašantis variantas paliktų įrašus apie darbą,
 * kurio niekas nedirbo.
 *
 * ⚠️ KĄ JIS TIKRAI PATIKRINA: reikšmės ribą. Tai vienintelis atsakymas, kurį
 * galima gauti nerašant, ir kartu vienintelė nesėkmės klasė, kuri yra GALUTINĖ —
 * saugyklos gedimo sausas paleidimas nuspėti negali, ir to neteigia.
 */
async function sausasPaleidimas(pool, { limit = 1000, retryFailed = false } = {}) {
  const { rows } = await pool.query(KANDIDATAI_SQL, [limit, retryFailed]);

  const suvestine = { kandidatai: rows.length, perkeltini: 0, neatvaizduojami: [] };

  for (const eilute of rows) {
    try {
      paruostiReiksme(eilute.payload);
      suvestine.perkeltini += 1;
    } catch (klaida) {
      if (klaida instanceof ArtifactStoreError && klaida.code === KLAIDA.REIKSME) {
        suvestine.neatvaizduojami.push(String(eilute.job_id));
        continue;
      }
      throw klaida;
    }
  }

  return suvestine;
}

/**
 * Tikras paleidimas.
 *
 * @param {object} pool     `pg` pool.
 * @param {object} saugykla `ArtifactStore` su `put`/`head`/`delete` ir `backend`.
 */
async function migruoti(pool, saugykla, { limit = 1000, retryFailed = false, runId = null } = {}) {
  if (!saugykla || typeof saugykla.put !== "function") {
    throw new TypeError("artifactMigration: reikia rašymo saugyklos su `put()`.");
  }

  const paleidimas = runId || crypto.randomUUID();
  const { rows } = await pool.query(KANDIDATAI_SQL, [limit, retryFailed]);

  const suvestine = { runId: paleidimas, kandidatai: rows.length, perkelta: 0, nepavyko: {} };

  for (const eilute of rows) {
    const rezultatas = await perkeltiEilute(pool, saugykla, {
      jobId: eilute.job_id,
      payload: eilute.payload,
      runId: paleidimas,
    });

    if (rezultatas.verdiktas === BUSENA.ATLIKTA) {
      suvestine.perkelta += 1;
    } else {
      suvestine.nepavyko[rezultatas.priezastis] =
        (suvestine.nepavyko[rezultatas.priezastis] || 0) + 1;
    }
  }

  return suvestine;
}

module.exports = {
  BUSENA,
  PRIEZASTIS,
  KANDIDATAI_SQL,
  migruoti,
  sausasPaleidimas,
};
