
/**
 * JOB METADUOMENŲ SCHEMA (#155, 7.2a).
 *
 * Ši migracija sukuria `jobs` ir `job_results` — lenteles, kurios po
 * aktyvavimo barjero taps autoritetinga job metaduomenų saugykla
 * (žr. `docs/decisions/155-postgres-authority.md`).
 *
 * ⚠️ VIENOS EILUTĖS INVARIANTAI PRIKLAUSO DB; PERĖJIMŲ GRAFAS — NE.
 *
 * `CHECK` constraint'ai čia atkartoja tik tai, ką galima nuspręsti žiūrint į
 * VIENĄ eilutę: `progress_known ↔ progress_*`, `status × phase`,
 * `owner_kind × owner_id`. Perėjimų grafas (`queued → processing → completed`)
 * lieka `utils/jobPhase.js` domenui — jo perrašymas SQL'e sukurtų antrą
 * autoritetą tiems patiems perėjimams.
 *
 * ⚠️ `CHECK` ATMETA TIK `FALSE`. `UNKNOWN` PostgreSQL PRIIMA.
 *
 * Todėl kiekvienas constraint'as žemiau parašytas taip, kad NIEKADA negrąžintų
 * `UNKNOWN`: nuosavybė per `CASE` su eksplicitine `NULL` šaka, o `status`,
 * `progress_known` ir `tenant_id` — `NOT NULL`. Su `NULL` stulpeliu abi
 * palyginimo šakos duotų `UNKNOWN`, ir eilutė, kurios
 * `assertConsistentJobRecord()` nepriimtų, DB būtų patvirtinta.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable("jobs", {
    id: { type: "uuid", primaryKey: true },

    /**
     * ĮRAŠO ERA (#158). `newJob()` nustato `2`, o
     * `jobAuthorization.resolveCurrentRole()` būtent pagal ją sprendžia, ar
     * `actor` yra userId (era 2), ar username (legacy).
     *
     * NULLABLE SĄMONINGAI: `restoreRecord()` atkuria pre-#158 įrašus, kurie
     * šio lauko neturi. `NOT NULL DEFAULT 2` juos tyliai „pakeltų" į naują erą
     * ir jų `actor` (username) staiga būtų aiškinamas kaip UUID.
     */
    schema_version: { type: "integer" },

    type: { type: "text", notNull: true },
    status: { type: "text", notNull: true },

    /**
     * FAZĖ (#154). Prasminga tik `status = 'processing'`; kitur `NULL`.
     */
    phase: { type: "text" },

    /**
     * PROGRESAS DVIEM STULPELIAIS, ne JSONB.
     *
     * `{current, total}` JSONB lauke `CHECK` galėtų tikrinti tik po
     * `->>` konversijos, ir `PROGRESS_INVARIANTS` atitikmuo taptų eilučių
     * aritmetika. Atskiri `double precision` stulpeliai leidžia invariantus
     * išreikšti tiesiogiai (žr. `jobs_progress_invariants`).
     */
    progress_current: { type: "double precision" },
    progress_total: { type: "double precision" },

    /**
     * ⚠️ `NOT NULL` BŪTINAS. Su `progress_known = NULL` abi
     * `jobs_progress_known` šakos duotų `UNKNOWN`, ir `(NULL, NULL, NULL)`
     * praeitų — o `assertProgressInvariant()` tokio įrašo nepriima.
     */
    progress_known: { type: "boolean", notNull: true, default: false },

    /**
     * NUOSAVYBĖ (#159). `owner_kind` NULL = legacy įrašas iš prieš #159;
     * `create()` jo nekuria, `restoreRecord()` — taip.
     *
     * FK į vartotojus NĖRA: `AUTH_USERS` gyvena env kintamajame, ne DB.
     */
    owner_kind: { type: "text" },
    owner_id: { type: "uuid" },

    /**
     * ⚠️ SENTINELIS, NE `NULL`. PostgreSQL `UNIQUE` indekse `NULL` reikšmės
     * laikomos nelygiomis, tad su `tenant_id = NULL` idempotency indeksas
     * leistų dvi eilutes su tuo pačiu raktu ir taptų dekoracija.
     *
     * `DEFAULT` vieno nepakanka: `newJob()` materializuoja `tenantId: null`,
     * tad `INSERT` siunčia EKSPLICITINĮ `NULL`, o tokiu atveju `DEFAULT`
     * netaikomas. Vertimą `null ↔ sentinelis` daro `postgresStore` viduje.
     */
    tenant_id: {
      type: "uuid",
      notNull: true,
      default: "00000000-0000-0000-0000-000000000000",
    },

    idempotency_key: { type: "text" },

    actor: { type: "text" },
    actor_role: { type: "text" },
    actor_source: { type: "text" },
    request_id: { type: "text" },

    storage_key: { type: "text" },

    /** Artefaktų inventorius (#19 PR1) — struktūrizuotas, tad JSONB. */
    artefacts: { type: "jsonb", notNull: true, default: pgm.func("'[]'::jsonb") },

    error_code: { type: "text" },
    error_message: { type: "text" },

    attempt_count: { type: "integer", notNull: true, default: 0 },

    /**
     * VALYMO PAKARTOJIMAI IR JŲ TERMINAI.
     *
     * ⚠️ `*_next_attempt_at` PRIVALO TURĖTI STULPELĮ. `utils/deletionRetry.js`
     * juos rašo per `jobStore.update()`, o memory/Redis saugyklos bet kokį
     * patch'o lauką išsaugo (`{ ...job, ...patch }`). PostgreSQL rašo tik
     * `COLUMNS` sąrašą, tad be šių stulpelių terminas dingtų TYLIAI:
     * `update()` pavyktų, `_išsaugotiBandymą()` išvalytų atsarginę kopiją
     * atmintyje, o kitas praėjimas job'ą laikytų iškart vykdytinu -
     * eksponentinis backoff nustotų veikti, ir taip po KIEKVIENO restarto.
     */
    audio_cleanup_pending: { type: "boolean", notNull: true, default: false },
    audio_cleanup_attempts: { type: "integer", notNull: true, default: 0 },
    audio_cleanup_next_attempt_at: { type: "timestamptz" },
    deletion_pending: { type: "boolean", notNull: true, default: false },
    deletion_attempts: { type: "integer", notNull: true, default: 0 },
    deletion_next_attempt_at: { type: "timestamptz" },

    created_at: { type: "timestamptz", notNull: true },
    updated_at: { type: "timestamptz", notNull: true },
    started_at: { type: "timestamptz" },
    completed_at: { type: "timestamptz" },
  });

  /**
   * ⚠️ ERA TIK IŠ PALAIKOMOS AIBĖS.
   *
   * Neapribotas `integer` priimtų `schemaVersion: 3` iš ateities kopijos:
   * `_validateContent()` tikrina tik ID buvimą, `restoreRecord()` įrašo, ir
   * atkūrimas praneštų SĖKMĘ - o `authorizeJobExecution()` vėliau mestų
   * „Nepalaikoma job schemaVersion", ir atkurtas job'as niekada nepasileistų.
   *
   * ⚠️ AIBĖ = `{NULL, 2}`, NE `{NULL, 1, 2}`. `assertSupportedSchemaVersion()`
   * (`jobAuthorization.js:65`) atmeta KIEKVIENĄ ne-`null` reikšmę, kuri nėra
   * `2` - įskaitant `1`. Constraint'as, priimantis `1`, tik perkeltų tą patį
   * gedimą iš atkūrimo į vykdymą: restore praneštų sėkmę, o job'as niekada
   * nepasileistų.
   *
   * `NULL` = pre-#158 legacy įrašas (žr. stulpelio komentarą).
   */
  pgm.addConstraint("jobs", "jobs_schema_version_supported", {
    check: "schema_version IS NULL OR schema_version = 2",
  });

  /**
   * ⚠️ UŽDARA TIPŲ AIBĖ.
   *
   * Be jos `type: "bogus"` iš sugadintos kopijos būtų įrašytas: `restoreRecord()`
   * tikrina tik ID buvimą, o `assertConsistentJobRecord()` tipą tikrina TIK
   * `processing` eilutėse. `queued` ar terminalus įrašas su nežinomu tipu
   * praeitų, o pirma gyvavimo ciklo operacija mestų `UNKNOWN_JOB_TYPE`.
   */
  pgm.addConstraint("jobs", "jobs_type_values", {
    check: "type IN ('transcription', 'protocol')",
  });

  pgm.addConstraint("jobs", "jobs_status_values", {
    check: "status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')",
  });

  /**
   * `status × phase`.
   *
   * ⚠️ LEGACY `processing + phase = NULL` NEATMETAMAS, BET IŠIMTIS SIAURA.
   *
   * #154 tai eksplicitiškai laiko realiu pre-#154 atsarginių kopijų formatu:
   * `finish()` tokį įrašą terminalizuoja, o `restoreService` perduoda
   * `restoreRecord()` nepakeistą. Constraint'as, atmetantis šią būseną,
   * sulaužytų atkūrimo kontraktą.
   *
   * ⚠️ BET IŠIMTIS RIBOJAMA `schema_version IS NULL`. Besąlyginė ji priimtų ir
   * DABARTINĮ (`schema_version = 2`) įrašą tokioje būsenoje - o
   * `assertConsistentJobRecord()` (`jobPhase.js:166`) jį atmeta kaip
   * `INVALID_STATUS_PHASE`. Sugadinta nauja kopija būtų sėkmingai įrašyta ir
   * UŽSTRIGTŲ: `finish()` ją dar terminalizuotų, bet progreso ir perėjimų
   * apdorojimas mestų. Era yra tikslus legacy žymuo - `newJob()` nuo #158
   * visada nustato `2`, o pre-#154 įrašai lauko neturi.
   */
  pgm.addConstraint("jobs", "jobs_status_phase", {
    check: `
      CASE
        WHEN status <> 'processing' THEN phase IS NULL
        WHEN phase IS NULL          THEN schema_version IS NULL
        WHEN type = 'transcription' THEN phase IN ('validating', 'transcribing', 'diarizing', 'merging')
        WHEN type = 'protocol'      THEN phase IN ('validating', 'generating_protocol')
        ELSE false
      END
    `,
  });

  /**
   * `progress_known ↔ progress_*` (#154, 4 punktas).
   *
   * `progressKnown = true, progress = null` yra dviprasmybė, kurios frontend'as
   * negalėtų interpretuoti; `progressKnown = false, progress != null` —
   * duomenys, kurių niekas nerodo.
   */
  pgm.addConstraint("jobs", "jobs_progress_known", {
    check: `
      CASE
        WHEN progress_known
          THEN progress_current IS NOT NULL AND progress_total IS NOT NULL
        ELSE progress_current IS NULL AND progress_total IS NULL
      END
    `,
  });

  /**
   * `PROGRESS_INVARIANTS` atitikmuo SQL'e (`utils/jobPhase.js`).
   *
   * ⚠️ BAIGTINUMAS TIKRINAMAS EKSPLICITIŠKAI. `double precision` priima
   * `NaN` ir `±Infinity`, o PostgreSQL'e `NaN = NaN` yra **TRUE** — tad
   * savilygybės patikra (`x = x`) `NaN` NEPAGAUTŲ. Vienintelis būdas —
   * `<> 'NaN'::float8`: kai stulpelis yra `NaN`, ši sąlyga duoda `FALSE` ir
   * eilutė atmetama.
   *
   * ⚠️ `numeric` NEBŪTŲ SPRENDIMAS: jis irgi priima `NaN`, o naujesnės
   * PostgreSQL versijos — ir begalybes. Tipas pasirinktas `double precision`
   * sąmoningai, o baigtinumas užtikrinamas čia.
   */
  pgm.addConstraint("jobs", "jobs_progress_invariants", {
    check: `
      progress_current IS NULL OR (
        progress_current <> 'NaN'::float8
        AND progress_current <> 'Infinity'::float8
        AND progress_current <> '-Infinity'::float8
        AND progress_total <> 'NaN'::float8
        AND progress_total <> 'Infinity'::float8
        AND progress_total <> '-Infinity'::float8
        AND progress_total > 0
        AND progress_current >= 0
        AND progress_current <= progress_total
      )
    `,
  });

  /**
   * PROGRESAS TIK `processing` EILUTĖSE.
   *
   * ⚠️ ATSKIRAS CONSTRAINT'AS, ne `status × phase` dalis. Tos dvi patikros
   * nesikerta, tad `completed + phase = NULL + galiojantis progresas` praeitų
   * abi — nors `finish()` grąžina `progress: null, progressKnown: false`, o
   * `queued` perėjimai progresą irgi išvalo.
   *
   * `PROGRESS_INVARIANTS` šio kryžminio ryšio neaprėpia (jie kalba tik apie
   * `progress` objekto vidų), tad paritetu jo nepagausi.
   */
  pgm.addConstraint("jobs", "jobs_progress_only_processing", {
    check: "status = 'processing' OR NOT progress_known",
  });

  /**
   * `owner_kind × owner_id` (#159).
   *
   * ⚠️ `CASE`, NE `OR` GRANDINĖ. Su `OR` derinys
   * `(owner_kind = NULL, owner_id = <uuid>)` duotų `UNKNOWN`, o `CHECK`
   * atmeta tik `FALSE` — DB priimtų nuosavybės būseną, kurios
   * `assertOwnerIdentity()` sukurti negali. `CASE` su eksplicitine `NULL`
   * šaka visada grąžina `true`/`false`.
   */
  pgm.addConstraint("jobs", "jobs_owner_identity", {
    check: `
      CASE
        WHEN owner_kind = 'user'    THEN owner_id IS NOT NULL
        WHEN owner_kind = 'api-key' THEN owner_id IS NULL
        WHEN owner_kind = 'unowned' THEN owner_id IS NULL
        WHEN owner_kind IS NULL     THEN owner_id IS NULL
        ELSE false
      END
    `,
  });

  /**
   * IDEMPOTENCY. Dalinis indeksas: `NULL` raktas nekonfliktuoja su niekuo, o
   * vienos nuomos režime visos eilutės turi tą patį `tenant_id` sentinelį,
   * tad raktai realiai konfliktuoja.
   */
  pgm.createIndex("jobs", ["tenant_id", "idempotency_key"], {
    name: "jobs_idempotency",
    unique: true,
    where: "idempotency_key IS NOT NULL",
  });

  pgm.createIndex("jobs", ["tenant_id", "created_at"], { name: "jobs_tenant_created" });
  pgm.createIndex("jobs", ["owner_id", "status"], { name: "jobs_owner_status" });

  /**
   * Retencijos ir valymo užklausų keliai: `sweepExpired()` filtruoja pagal
   * terminalumą ir `updated_at`, `listByFlag()` — pagal vėliavas.
   */
  pgm.createIndex("jobs", ["status", "updated_at"], { name: "jobs_status_updated" });

  /**
   * REZULTATAI ATSKIROJE LENTELĖJE.
   *
   * Transkripcijos yra didžiausias ir jautriausias turinys; atskira lentelė
   * leidžia jai turėti savo saugyklos tipą (#157 prideda `s3` be schemos
   * migracijos) ir neužkrauna kiekvienos job metaduomenų užklausos.
   *
   * ⚠️ Kaina: `completed` be `job_results` eilutės tampa įmanoma būsena.
   * 7.5b ją apibrėžia kaip remontą reikalaujančią, ne sėkmę, ir reikalauja
   * transakcinio užbaigimo. Iki tol PostgreSQL lieka už aktyvavimo barjero.
   */
  pgm.createTable("job_results", {
    job_id: {
      type: "uuid",
      primaryKey: true,
      references: "jobs(id)",
      onDelete: "CASCADE",
    },
    /** `inline` — turinys `payload` stulpelyje; #157 prideda `s3`. */
    storage_type: { type: "text", notNull: true, default: "inline" },
    storage_key: { type: "text" },
    payload: { type: "jsonb" },
    created_at: { type: "timestamptz", notNull: true },
  });

  pgm.addConstraint("job_results", "job_results_storage_type_values", {
    check: "storage_type IN ('inline', 's3')",
  });

  /**
   * `inline` reikalauja turinio, išorinė saugykla — rakto. Be šito eilutė be
   * nė vieno iš jų atrodytų kaip galiojantis rezultatas.
   */
  pgm.addConstraint("job_results", "job_results_storage_shape", {
    check: `
      CASE storage_type
        WHEN 'inline' THEN payload IS NOT NULL AND storage_key IS NULL
        ELSE storage_key IS NOT NULL
      END
    `,
  });
};

exports.down = (pgm) => {
  pgm.dropTable("job_results");
  pgm.dropTable("jobs");
};
