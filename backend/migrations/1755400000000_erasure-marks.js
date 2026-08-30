/**
 * IŠTRYNIMO ŽYMŲ SCHEMA (#155, 7.5a / #183).
 *
 * ⚠️ NAUJAS LAIKO ŽYMĖS FAILAS, NE ESAMOS MIGRACIJOS REDAGAVIMAS - ta pati
 * priežastis kaip `1755300000000_audit-log.js`: `node-pg-migrate` praleidžia
 * failą pagal VARDĄ, tad jau migruotoje DB pakeista sena migracija nebūtų
 * pritaikyta, ir egzistuojantis diegimas liktų BE `erasure_marks` - tyliai.
 *
 * ⚠️ FK Į `jobs` NĖRA IR NEBUS. `ON DELETE CASCADE` pašalintų žymą tuo momentu,
 * kai ji tampa reikalinga: žymos paskirtis yra atsakyti į klausimą PO TO, kai
 * jobo įrašo nebėra. Su FK vėluojanti eilės žinutė ištrintam jobui vėl galėtų
 * kurti artefaktus. Kaina - eilutė gali nurodyti neegzistuojantį `job_id`, ir
 * tai TEISINGA būsena, ne našlaitė.
 *
 * ⚠️ `job_id` YRA `text`, NE `uuid` - EKSPLICITINIS NUKRYPIMAS NUO ADR §5.
 *
 * `docs/decisions/155-postgres-authority.md` §5 fiksuoja „FK nėra", bet tipo
 * nefiksuoja, o gretima `job_results.job_id → jobs.id` eilutė yra `uuid` - tad
 * pažodinis skaitymas duotų `uuid`. Jis lūžtų BŪTENT ten, kur žyma svarbiausia:
 *
 *   - `lifecycleService.deleteJobArtefacts(null, jobId)` - žymima, kai `jobs`
 *     eilutės JAU NĖRA;
 *   - `adminJobService.adminCleanupOrphan(jobId)` ir `desktopCleanupOrphan(jobId)`
 *     - našlaičio valymas, kai store įraše jobo NIEKADA nebuvo (abu keliai rašo
 *     žymą nuo #183; iki tol jie trynė pėdsakus be barjero);
 *   - `erasure_marks` aktyvus vos yra `DATABASE_URL`, įskaitant diegimus, kur
 *     `jobStore` yra memory ar Redis, o ID forma `uuid` negarantuota.
 *
 * `uuid` stulpelis šiuose keliuose mestų tipo klaidą RAŠANT žymą - barjeras
 * neatsirastų tiksliai tais atvejais, dėl kurių jis egzistuoja.
 *
 * ⚠️ ASMENS IDENTIFIKATORIŲ ČIA NĖRA. Lentelė pergyvena jobą ir, skirtingai nei
 * `audit_log`, NEIŠBRAUKIAMA iš atsarginių kopijų. Plikas `ownerId` joje taptų
 * asmens duomenimis lentelėje, kurios paskirtis - įrodyti, kad asmens duomenys
 * pašalinti. Todėl saugoma tik `actor_kind` kategorija; tikslus aktorius lieka
 * audito kvite, kur veikia pseudonimizacija ir rakto rotacija.
 */

/**
 * ⚠️ AIBĖS ČIA UŽŠALDYTOS SĄMONINGAI - NEIMPORTUOJAMOS.
 *
 * Ta pati priežastis kaip `EVENT_PATTERN_FROZEN` audito migracijoje: migracija
 * yra ISTORIJOS ĮRAŠAS. Importavus konstantą, šviežia DB gautų naują
 * constraint'ą, o atnaujinta liktų su senu - abi startuotų, bet priimtų
 * SKIRTINGAS aibes, ir elgesys imtų priklausyti nuo diegimo istorijos.
 *
 * Autoritetas nedingsta: paritetą su `deletionTombstones` konstantomis tikrina
 * testas, o pasikeitus aibei reikia NAUJOS migracijos.
 */
const STATUSES_FROZEN = ["deletion_pending", "deleted", "deletion_failed"];
const REASONS_FROZEN = ["user_request", "retention_policy", "operator_cleanup"];
const ACTOR_KINDS_FROZEN = ["user", "operator", "system"];
/** Atitinka `lifecycleService.classifyFailure()` išvestį. */
const FAILURE_KINDS_FROZEN = ["retryable", "permanent", "already_absent"];

const sarasas = (reiksmes) => reiksmes.map((r) => `'${r}'`).join(", ");

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable("erasure_marks", {
    job_id: { type: "text", primaryKey: true },
    status: { type: "text", notNull: true },
    reason: { type: "text", notNull: true },
    /** Kategorija, ne identifikatorius. Žr. failo viršų. */
    actor_kind: { type: "text" },
    /** Pirmojo žymėjimo laikas. Po sukūrimo NEKEIČIAMAS (trigeris žemiau). */
    marked_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    /** Paskutinio perėjimo laikas. */
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    /**
     * PATVIRTINTO ištrynimo momentas.
     *
     * ⚠️ NE `updated_at` DUBLIKATAS. `lifecycleService` užbaigia žymą tik PO
     * audito ir perduoda SAVO laiko žymą (#210), kad ištrynimo kvitas ir žyma
     * neštų tą patį momentą. Po retry `updated_at` pasistumtų, o šis - ne.
     */
    completed_at: { type: "timestamptz" },
    /** Diagnostika operatoriui: kiek kartų bandyta. Ne turinys. */
    attempts: { type: "integer", notNull: true, default: 0 },
    /** Allowlist'inta kategorija, NE klaidos tekstas. */
    last_failure_kind: { type: "text" },
  });

  pgm.addConstraint("erasure_marks", "erasure_marks_status_allowed", {
    check: `status IN (${sarasas(STATUSES_FROZEN)})`,
  });

  pgm.addConstraint("erasure_marks", "erasure_marks_reason_allowed", {
    check: `reason IN (${sarasas(REASONS_FROZEN)})`,
  });

  pgm.addConstraint("erasure_marks", "erasure_marks_actor_kind_allowed", {
    check: `actor_kind IS NULL OR actor_kind IN (${sarasas(ACTOR_KINDS_FROZEN)})`,
  });

  pgm.addConstraint("erasure_marks", "erasure_marks_failure_kind_allowed", {
    check: `last_failure_kind IS NULL OR last_failure_kind IN (${sarasas(FAILURE_KINDS_FROZEN)})`,
  });

  /**
   * ⚠️ NESĖKMĖ NEGALI TURĖTI IŠTRYNIMO LAIKO, O SĖKMĖ NEGALI JO NETURĖTI.
   *
   * Iki 7.5a tai buvo `complete()` viduje esanti taisyklė. DB lygyje ji tampa
   * netaikoma pro šoną: eilutė su `deletion_failed` ir `completed_at` reikštų
   * „nepavyko, bet štai kada pavyko" - būseną, kuria remiasi ištrynimo kvitas.
   */
  pgm.addConstraint("erasure_marks", "erasure_marks_completed_at_matches_status", {
    check: "(status = 'deleted') = (completed_at IS NOT NULL)",
  });

  /**
   * ⚠️ INDEKSAI TIK TEN, KUR YRA REALUS KVIETĖJAS.
   *
   * PK aptarnauja barjero skaitymą (karštas kelias - kiekvienas worker'io ir
   * jobStore kvietimas). Šie du - vienintelius du skenuojančius kelius:
   *
   *   1) retencijos sweep'as: `status = 'deleted' AND updated_at < riba`;
   *   2) operatoriaus sąrašas: neterminalės žymos pagal amžių.
   *
   * Abu daliniai: pilnas indeksas ant `updated_at` aptarnautų abu prasčiau ir
   * augtų kartu su terminalėmis eilutėmis, kurių sąrašo kelias niekada neliečia.
   */
  pgm.createIndex("erasure_marks", "updated_at", {
    name: "erasure_marks_deleted_updated_at",
    where: "status = 'deleted'",
  });

  pgm.createIndex("erasure_marks", "marked_at", {
    name: "erasure_marks_unresolved_marked_at",
    where: "status <> 'deleted'",
  });

  /**
   * ⚠️ `marked_at` NEKEIČIAMAS - DB LYGIU, NE SUSITARIMU.
   *
   * `marked_at` atsako „kada ištrynimo paprašyta". Pakartotinis žymėjimas ar
   * retry, pastumdamas jį į priekį, padarytų ištrynimo kvitą netiksliu -
   * atskaitomybei tai svarbiausias laukas.
   *
   * Trigeris atmeta TIK `marked_at` keitimą; `status`, `updated_at`,
   * `completed_at`, `attempts` ir `last_failure_kind` keičiami laisvai, kitaip
   * būsenų mašina apskritai negalėtų judėti.
   */
  pgm.createFunction(
    "erasure_marks_reject_marked_at_update",
    [],
    { returns: "trigger", language: "plpgsql", replace: true },
    `
    BEGIN
      IF NEW.marked_at IS DISTINCT FROM OLD.marked_at THEN
        RAISE EXCEPTION 'erasure_marks.marked_at is immutable'
          USING ERRCODE = 'restrict_violation';
      END IF;
      RETURN NEW;
    END;
    `
  );

  pgm.createTrigger("erasure_marks", "erasure_marks_marked_at_immutable", {
    when: "BEFORE",
    operation: "UPDATE",
    level: "ROW",
    function: "erasure_marks_reject_marked_at_update",
  });
};

exports.down = (pgm) => {
  pgm.dropTrigger("erasure_marks", "erasure_marks_marked_at_immutable", { ifExists: true });
  pgm.dropFunction("erasure_marks_reject_marked_at_update", [], { ifExists: true });
  pgm.dropTable("erasure_marks");
};
