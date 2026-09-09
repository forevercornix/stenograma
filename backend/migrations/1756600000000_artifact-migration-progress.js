/**
 * MIGRACIJOS PROGRESAS — AUDITO ĮRAŠAS, NE BŪSENOS KOPIJA (#157, PR-6).
 *
 * ⚠️ KODĖL ATSKIRA LENTELĖ.
 *
 * #157 body: „migracijos progresas nesaugomas kaip negaliojanti `job_results`
 * būsena". Tai DRAUDIMAS, ir po PR-1 jis yra ne tik principas: `job_results`
 * negaliojančios būsenos apskritai NEĮMANOMOS — išmatuota, kad visi 60 dalinių
 * perėjimo sakinių atmetami `23514` ties `job_results_storage_shape`
 * (`jobResultsShapeDomain.integration`, CI 34323230438). Progresui `job_results`
 * eilutėje vietos nėra nei pagal politiką, nei pagal schemą.
 *
 * ⚠️ KĄ ŠI LENTELĖ SAUGO — IR KO SĄMONINGAI NESAUGO.
 *
 * Didžiausia rizika kuriant progreso lentelę yra ANTRA TO PATIES FAKTO KOPIJA,
 * kuri ilgainiui išsiskiria. Repo tą klasę jau turi užregistravęs šešis kartus
 * (#305), ir paskutinis atvejis — `PILNA_FORMA` — parodė, kad kopija pavojinga
 * net testų viduje. Todėl aibė apribota tam, ko NEGALIMA išvesti iš esamos
 * būsenos:
 *
 *   NESAUGOMA `in_progress` — vykdomo rašymo savininkas yra BANDYMŲ REGISTRAS
 *     (`job_result_attempts.busena = 'pending'`). Antras „vyksta" žymuo būtų
 *     lygiai ta pati kopija, tik kitoje lentelėje.
 *
 *   NESAUGOMA „ar eilutė external" — tai sako `job_results.storage_type`.
 *
 *   SAUGOMA `failed` su KODU — tai vienintelė būsena, kurios neišveda niekas:
 *     job'as, kurio migruoti nepavyko, iš `job_results` atrodo lygiai taip pat
 *     kaip dar nemigruotas. Be įrašo pakartotinis paleidimas jį bandytų amžinai,
 *     o operatorius neturėtų sąrašo, ką tikrinti.
 *
 *   SAUGOMA `done` — nors „eilutė external" išvedama, „ŠI migracija ją perkėlė,
 *     tada ir tuo raktu" — ne. Tai auditinis faktas, ne dabartinė būsena, ir jis
 *     yra vienintelė pusė poros „progresas ↔ nuoroda", kurią tikrina §9.1
 *     stebėtojas. `job_results` po perkėlimo neatskiria migracijos nuo įprasto
 *     external užbaigimo.
 *
 * ⚠️ PRIEŽASTIS YRA KODAS, NE TEKSTAS — PRIVATUMO RIBA.
 *
 * Laisvas tekstas anksčiau ar vėliau atneštų klaidos pranešimą, o klaidos
 * pranešimas migracijos kelyje gali cituoti REZULTATO TURINĮ. Lentelė pergyvena
 * job'ą (žr. FK pastabą žemiau), tad tekstas joje taptų transkripcijos fragmentu
 * lentelėje, kurios paskirtis — apskaityti perkėlimą. Tas pats sprendimas ir tas
 * pats precedentas kaip `erasure_marks.reason` allowlist.
 *
 * ⚠️ FK Į `jobs` NĖRA — ta pati priežastis kaip `job_result_attempts` ir
 * `erasure_marks`: `ON DELETE CASCADE` pašalintų įrašą būtent tada, kai jis
 * reikalingas kaip įrodymas. Eilutė, rodanti į nebeegzistuojantį `job_id`, yra
 * TEISINGA būsena, ne našlaitė.
 *
 * ⚠️ `job_id` YRA `text`, NE `uuid` — tas pats nukrypimas ir ta pati priežastis:
 * lentelė aprašo perkėlimą, o ID forma `uuid` negarantuota visuose diegimuose.
 *
 * ⚠️ ASMENS DUOMENŲ ČIA NĖRA: adresas, būsena, kodas ir laikas. Nei turinio, nei
 * savininko.
 */

/**
 * ⚠️ AIBĖS UŽŠALDYTOS — NEIMPORTUOJAMOS.
 *
 * Migracija yra ISTORIJOS ĮRAŠAS. Importavus konstantą iš `utils/`, šviežia DB
 * gautų naują `CHECK`, o atnaujinta liktų su senu: abi startuotų ir priimtų
 * SKIRTINGAS aibes. Paritetą su kodu tikrina testas, ne bendras modulis.
 */
const BUSENOS_FROZEN = ["done", "failed"];

/**
 * Nesėkmės kodai. Kiekvienas atitinka VIENĄ atskiriamą gedimo tašką migracijos
 * kelyje; bendro `error` sąmoningai nėra — jis panaikintų visą kodų prasmę.
 */
const PRIEZASTYS_FROZEN = [
  /** `ArtifactStore` riba atmetė reikšmę (`ARTIFACT_VALUE_UNSUPPORTED`). */
  "payload_neatvaizduojamas",
  /** `put()` arba `delete()` krito saugyklos pusėje. */
  "saugyklos_klaida",
  /** `head()` po rašymo nepatvirtino dydžio — saugykloje guli ne tai, ką parašėm. */
  "vientisumas_nepatvirtintas",
  /** Eilutė pasikeitė tarp atrankos ir transakcijos — perkėlimas neįvyko. */
  "eilute_pasikeite",
];

const sarasas = (reiksmes) => reiksmes.map((r) => `'${r}'`).join(", ");

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable("artifact_migration_progress", {
    /** Vienas įrašas vienam job'ui: perkėlimas yra job'o, ne eilutės, įvykis. */
    job_id: { type: "text", primaryKey: true },
    busena: { type: "text", notNull: true },
    /** Užpildoma TIK `done`: adresas, į kurį perjungta nuoroda. */
    storage_type: { type: "text" },
    storage_key: { type: "text" },
    /** Užpildoma TIK `failed`. */
    priezastis: { type: "text" },
    /**
     * Paleidimo identifikatorius.
     *
     * Be jo „kada perkelta" atsako `updated_at`, bet „kuriuo paleidimu" —
     * niekas, o būtent to klausia operatorius, kai vienas raundas paliko
     * nesėkmes ir buvo paleistas antras.
     */
    run_id: { type: "uuid", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("artifact_migration_progress", "artifact_migration_progress_busena_allowed", {
    check: `busena IN (${sarasas(BUSENOS_FROZEN)})`,
  });

  pgm.addConstraint("artifact_migration_progress", "artifact_migration_progress_priezastis_allowed", {
    check: `priezastis IS NULL OR priezastis IN (${sarasas(PRIEZASTYS_FROZEN)})`,
  });

  /**
   * ⚠️ SIMETRIŠKA FORMA — ABI ŠAKOS PILNOS.
   *
   * Ta pati pamoka, kurią #289 Codex rado `job_results_storage_shape` inline
   * šakoje: nesimetriškas invariantas priima būseną, kurios niekas neaprašė —
   * čia tai būtų `done` su priežastimi arba `failed` su raktu. Abi reikštų, kad
   * įrašas vienu metu teigia du skirtingus dalykus, o operatorius nebeturėtų
   * kuo pasitikėti.
   */
  pgm.addConstraint("artifact_migration_progress", "artifact_migration_progress_shape", {
    check: `
      CASE busena
        WHEN 'done' THEN storage_type IS NOT NULL
             AND storage_key IS NOT NULL
             AND priezastis IS NULL
        ELSE storage_type IS NULL
             AND storage_key IS NULL
             AND priezastis IS NOT NULL
      END
    `,
  });

  /**
   * Operatoriaus užklausa yra „ką reikia peržiūrėti", tad indeksuojamos
   * NESĖKMĖS. `done` eilučių dauguma, ir jų šis kelias neklausia.
   */
  pgm.createIndex("artifact_migration_progress", ["busena", "updated_at"], {
    name: "artifact_migration_progress_nesekmes",
    where: "busena = 'failed'",
  });
};

exports.down = (pgm) => {
  pgm.dropTable("artifact_migration_progress");
};
