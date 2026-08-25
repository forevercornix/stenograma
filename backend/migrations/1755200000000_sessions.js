/**
 * SESIJŲ SCHEMA (#155, 7.3).
 *
 * ⚠️ NAUJAS LAIKO ŽYMĖS FAILAS, NE ESAMOS MIGRACIJOS REDAGAVIMAS.
 *
 * `node-pg-migrate` praleidžia failą pagal VARDĄ (`pgmigrations` lentelė), tad
 * jau migruotoje DB pakeista sena migracija NEBŪTŲ pritaikyta: švarios DB
 * testai praeitų, o egzistuojanti DB liktų BE `sessions` lentelės - tyliai,
 * nes antras `migrate:up` teisėtai yra no-op. Tai jau įvyko #155 darbe (#200).
 *
 * ⚠️ SESIJŲ LENTELĖ NEPRIKLAUSO NUO `jobs`. FK tarp jų nėra sąmoningai:
 * autentikacija ir job metaduomenys aktyvuojami ATSKIRAIS jungikliais
 * (`SESSION_STORE_BACKEND` vs `JOB_STORE_BACKEND`), tad viena lentelė negali
 * reikalauti, kad kita jau būtų naudojama.
 *
 * ⚠️ `id` YRA SUROGATAS, NE BEARER TOKEN'AS.
 *
 * Iki 7.3 `sessionStore` cookie rašė 256 bitų `crypto.randomBytes` reikšmę,
 * kuri kartu buvo ir žemėlapio raktas. Perkeliant į DB akivaizdus žingsnis -
 * `uuid` pirminis raktas cookie'je - būtų DVIGUBA regresija: entropija
 * nukristų nuo 256 iki 122 bitų, IR paslaptis taptų tuo, kas saugoma
 * lentelėje. Todėl bearer token'as gyvena TIK pas klientą, o DB turi jo
 * SHA-256 maišą.
 *
 * ⚠️ `idle_expires_at` YRA ATSKIRAS STULPELIS, NE IŠVESTINIS.
 *
 * `sessionStore.touch()` visada tikrino DU nepriklausomus langus: neveiklumo
 * ir absoliutų. Schema su vienu `expires_at` išreikštų tik antrąjį, ir
 * 30 minučių neveiklumo timeout dingtų tyliai - pavogtas įrenginys su atidaryta
 * sesija liktų autorizuotas 12 valandų vietoj 30 minučių.
 *
 * ⚠️ `last_seen_at <= expires_at` SĄMONINGAI NĖRA `CHECK`.
 *
 * Paskutinio naudojimo žyma ir absoliutus galiojimas turi ribinių atvejų
 * (laikrodžio poslinkis tarp replikų, `touch` ties pat riba), kuriuose
 * constraint'as atmestų teisėtą įrašą.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable("sessions", {
    /** SUROGATAS. Klientas jo NIEKADA nemato - žr. failo antraštę. */
    id: { type: "uuid", primaryKey: true },

    /**
     * SHA-256(bearer token), lowercase hex.
     *
     * `unique`, nes paieška vyksta būtent per jį: `WHERE token_hash = $1`.
     * Be unikalumo dvi eilutės su ta pačia maiša reikštų neapibrėžtą, kurią
     * sesiją autentikacija pratęsia.
     */
    token_hash: { type: "text", notNull: true, unique: true },

    /**
     * STABILI TAPATYBĖ (#158), NE vardas.
     *
     * `NOT NULL`: PostgreSQL režime sesija be stabilaus ID negalima. `username`
     * NEPERSISTINAMAS - jis yra `AUTH_USERS` rodinys, ir jo įrašymas reikštų
     * antrą tapatybės autoritetą, kuris po pervadinimo pradeda meluoti.
     */
    user_id: { type: "uuid", notNull: true },

    /**
     * ROLĖS SNAPSHOT'AS.
     *
     * Saugomas todėl, kad startinis suderinimas ir `touch()` galėtų palyginti
     * jį su GYVA `AUTH_USERS` reikšme: nesutapimas reiškia pažeminimą, po kurio
     * sesija privalo būti revokuota, o ne tyliai toliau autorizuoti sena role.
     */
    role: { type: "text", notNull: true },

    created_at: { type: "timestamptz", notNull: true },

    /** ABSOLIUTUS langas. `touch()` jo NEPRATĘSIA. */
    expires_at: { type: "timestamptz", notNull: true },

    /** NEVEIKLUMO langas. `touch()` pratęsia TIK jį. */
    idle_expires_at: { type: "timestamptz", notNull: true },

    last_seen_at: { type: "timestamptz" },

    /**
     * LOGINĖ revokacija.
     *
     * `destroy()` ir `destroyAllForUserId()` PostgreSQL režime nustato būtent
     * šį lauką, o ne trina eilutę: fizinis ištrynimas iš karto atimtų galimybę
     * atsakyti, ar cookie buvo ATŠAUKTA, ar jos niekada nebuvo.
     */
    revoked_at: { type: "timestamptz" },

    /**
     * SESIJOS EILUTĖS FORMATAS.
     *
     * ⚠️ NESUSIJĘ su `jobs.schema_version`. Tas žymi ĮRAŠO ERĄ (#158, `actor`
     * interpretavimą) ir naudoja aibę `{NULL, 2}`; čia - eilutės formatą,
     * palaikoma aibė `{1}`. Dvi nepriklausomos numeracijos.
     */
    schema_version: { type: "integer", notNull: true, default: 1 },
  });

  /**
   * LAIKO INVARIANTAI DB LYGIU.
   *
   * ⚠️ `CHECK` ATMETA TIK `FALSE`; `UNKNOWN` PostgreSQL PRIIMA. Todėl
   * `NULL`-galimi stulpeliai (`last_seen_at`, `revoked_at`) turi eksplicitinę
   * `IS NULL` šaką - be jos `NULL >= created_at` duotų `UNKNOWN`, ir
   * constraint'as tokiai eilutei tiesiog neveiktų. `created_at`, `expires_at`
   * ir `idle_expires_at` yra `NOT NULL`, tad jų palyginimai visada apibrėžti.
   */
  pgm.addConstraint("sessions", "sessions_expires_after_created", {
    check: "expires_at > created_at",
  });
  pgm.addConstraint("sessions", "sessions_idle_after_created", {
    check: "idle_expires_at > created_at",
  });
  pgm.addConstraint("sessions", "sessions_last_seen_after_created", {
    check: "last_seen_at IS NULL OR last_seen_at >= created_at",
  });
  pgm.addConstraint("sessions", "sessions_revoked_after_created", {
    check: "revoked_at IS NULL OR revoked_at >= created_at",
  });

  /**
   * INDEKSAI - abu aptarnauja konkretų kelią, ne „dėl visa ko".
   *
   * `user_id`: globali revokacija (`destroyAllForUserId`) ir startinis
   * suderinimas, kurie filtruoja būtent pagal jį.
   *
   * `expires_at`: retencija (`sweepExpired`) skenuoja pasibaigusias eilutes.
   *
   * `token_hash` indekso ČIA NĖRA, nes `unique` jį jau sukūrė - antras būtų
   * tik dubliuota rašymo kaina.
   */
  pgm.createIndex("sessions", "user_id");
  pgm.createIndex("sessions", "expires_at");
};

exports.down = (pgm) => {
  pgm.dropTable("sessions");
};
