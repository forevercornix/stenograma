/**
 * AUDITO ŽURNALO SCHEMA (#155, 7.4b / #211).
 *
 * ⚠️ NAUJAS LAIKO ŽYMĖS FAILAS, NE ESAMOS MIGRACIJOS REDAGAVIMAS.
 *
 * `node-pg-migrate` praleidžia failą pagal VARDĄ (`pgmigrations` lentelė), tad
 * jau migruotoje DB pakeista sena migracija NEBŪTŲ pritaikyta: švarios DB
 * testai praeitų, o egzistuojanti DB liktų BE `audit_log` lentelės - tyliai,
 * nes antras `migrate:up` teisėtai yra no-op.
 *
 * ⚠️ STULPELIAI vs `meta`. Stulpeliais tampa TIK tie laukai, pagal kuriuos
 * ieškoma; likusieji gyvena `meta` JSONB. Priežastis eksplicitinė #211:
 * filtruojami laukai turi turėti SAVO indeksus, o ne remtis pilnu JSONB
 * skenavimu. Skirstymas nėra šio failo nuosavybė - jį valdo
 * `utils/auditStore/fields.js`, ir paritetą tikrina testas.
 *
 * ⚠️ PLIKOJO `job_id` STULPELIO NĖRA IR NEBUS. Auditas mato tik
 * `subject_id` - HMAC pseudonimą. Transkripcijos, prompt'o ar audio turinio
 * laukų taip pat nėra: jų nėra ir `record()` išvestyje, o `meta` allowlist
 * neleidžia jiems atsirasti pro šoną.
 */

/**
 * ⚠️ ĮVYKIO ŠABLONAS ČIA UŽŠALDYTAS SĄMONINGAI - NEIMPORTUOJAMAS.
 *
 * Pirmoji versija darė `require("../utils/auditEvents")`, kad autoritetas liktų
 * vienas. Bet migracija yra ISTORIJOS ĮRAŠAS: pakeitus `EVENT_PATTERN` vėlesnėje
 * versijoje, šviežia DB gautų NAUJĄ constraint'ą, o atnaujinta - liktų su SENU,
 * nes `node-pg-migrate` šią migraciją jau pažymėjo pritaikyta. Abi startuotų
 * (vardas tas pats), bet priimtų SKIRTINGAS įvykių aibes - audito elgesys imtų
 * priklausyti nuo diegimo istorijos.
 *
 * Autoritetas nedingsta: `auditStore.init()` starte lygina TIKRĄ constraint'o
 * apibrėžimą su dabartiniu `EVENT_PATTERN`, tad neatitikimas pastebimas iškart,
 * o ne po pirmo atmesto rašymo. Pasikeitus šablonui reikia NAUJOS migracijos.
 */
const EVENT_PATTERN_FROZEN = "^[A-Z][A-Z0-9_]{1,63}$";

/** Vienintelės leistinos `result` reikšmės - žr. `auditLog.record()`. */
const RESULTS = ["success", "failure"];

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable("audit_log", {
    /**
     * UUID, ne skaitiklis. `record()` jį generuoja programoje sąmoningai:
     * pakartotinis rašymas (at-least-once) atpažįstamas būtent pagal `id`,
     * tad jis privalo būti žinomas PRIEŠ INSERT.
     */
    id: { type: "uuid", primaryKey: true },

    /**
     * ⚠️ TVARKOS AUTORITETAS. `timestamp` jam NETINKA: `now()` vienoje
     * transakcijoje visoms eilutėms grąžina TĄ PATĮ momentą, tad įrašymo
     * tvarka būtų neapibrėžta. UUID tvarka irgi netinka - `randomUUID()`
     * nemonotoniškas.
     *
     * `seq` duoda tą pačią tvarką, kurią atmintyje duoda masyvo indeksas -
     * 1:1 su memory backend'u, ko ir reikalauja bendras kontraktas.
     */
    seq: { type: "bigserial", notNull: true },

    /**
     * ⚠️ LAIKO AUTORITETAS - DUOMENŲ BAZĖ. Aplikacija jo NEPERDUODA.
     *
     * Programos laikrodis skiriasi tarp replikų, o auditas turi turėti vieną
     * tvarką. `DEFAULT now()` reiškia, kad įrašo laiko negali parinkti nei
     * kvietėjas, nei sugedęs NTP viename konteineryje.
     */
    timestamp: { type: "timestamptz", notNull: true, default: pgm.func("now()") },

    event: { type: "text", notNull: true },

    /**
     * HMAC PSEUDONIMAS, ne identifikatorius. `NULL` leistinas: dalis įvykių
     * (retencijos ciklas, eksportas) su konkrečiu subjektu nesusiję.
     */
    subject_id: { type: "text" },

    /**
     * ⚠️ OPERATORIAUS PRISKIRTA ETIKETĖ (`AUDIT_ID_SALT_ID`), NE IŠVESTINĖ IŠ
     * RAKTO.
     *
     * Išvedus ją iš druskos (pvz. maiša), etiketė taptų orakulu: turintis
     * lentelę galėtų tikrinti druskos spėjimus. Etiketė egzistuoja tam, kad
     * 7.4c rotacija žinotų, KURIS raktas skaičiavo kurį `subject_id` - tam
     * pakanka nesusijusio žymens.
     */
    hash_key_id: { type: "text", notNull: true },

    result: { type: "text", notNull: true },

    request_id: { type: "text" },

    /**
     * LIKĘ `record()` laukai. Rašomi PRO ALLOWLIST (`utils/auditStore/fields.js`):
     * nežinomas laukas nutylimas, o ne persistinamas. Be allowlist'o bet kuris
     * naujas `record()` laukas automatiškai taptų saugomas - įskaitant tokį,
     * kuris atneštų turinio ar PII.
     */
    meta: { type: "jsonb", notNull: true, default: "{}" },
  });

  /**
   * ⚠️ ĮVYKIO IR RUNTIME PARITETAS. Šablonas ateina iš `auditEvents.js` -
   * žr. failo antraštę.
   */
  pgm.addConstraint("audit_log", "audit_log_event_pattern", {
    check: `event ~ '${EVENT_PATTERN_FROZEN}'`,
  });

  /**
   * ⚠️ `meta` PRIVALO BŪTI JSON OBJEKTAS, NE BET KOKS JSONB.
   *
   * JSONB teisėtai priima ir skaliarus (`42`, `"tekstas"`, `true`). Tiesioginis
   * SQL rašytojas ar senesnis producer'is tokią eilutę įrašytų, o skaitymo
   * sluoksnis, tikrindamas `laukas in meta`, mestų `TypeError` - ir VISAS
   * `GET /api/audit` puslapis, kuriame ta eilutė pasitaiko, grąžintų 500.
   * Vienas įrašas taptų nuodinga eilute, kurios per API nebeperskaitytum.
   */
  pgm.addConstraint("audit_log", "audit_log_meta_is_object", {
    check: "jsonb_typeof(meta) = 'object'",
  });

  pgm.addConstraint("audit_log", "audit_log_result_allowed", {
    check: `result IN (${RESULTS.map((r) => `'${r}'`).join(", ")})`,
  });

  /**
   * `seq` unikalumas nėra dekoracija: jis yra skaitymo tvarkos raktas, ir
   * dublikatas padarytų `ORDER BY seq` neapibrėžtą.
   */
  pgm.addConstraint("audit_log", "audit_log_seq_unique", { unique: "seq" });

  /**
   * INDEKSAI TIK FILTRUOJAMIEMS LAUKAMS (#211).
   *
   * `id` jau turi indeksą kaip pirminis raktas, `seq` - kaip `unique`. Antri
   * indeksai jiems būtų tik dviguba rašymo kaina.
   */
  for (const stulpelis of ["timestamp", "event", "subject_id", "hash_key_id", "result", "request_id"]) {
    pgm.createIndex("audit_log", stulpelis);
  }

  /**
   * ⚠️ APPEND-ONLY DB LYGIU.
   *
   * Auditas, kurį galima redaguoti, nėra auditas: įrašas apie neteisėtą
   * veiksmą yra tiksliai tas, kurį užpuolikas norėtų pataisyti. Apribojimas
   * gyvena DB, o ne store'e, todėl galioja ir tiesioginiam `psql` prisijungimui,
   * ir bet kuriai ateities aplikacijai.
   *
   * ⚠️ `DELETE` ČIA NERIBOJAMAS - TAI SĄMONINGAS SPRENDIMAS, NE PRALEIDIMAS.
   *
   * GDPR ištrynimas (`removeBySubjectIdentifier`) fiziškai TRINA eilutes, tad
   * `DELETE` atėmimas sulaužytų būtent tą kelią, kurį auditas turi aptarnauti.
   * Apribojimas gyvena API lygmenyje: store neeksponuoja bendro trynimo, tik
   * subjektu apribotą. Žr. `docs/audit-storage.md`.
   */
  pgm.createFunction(
    "audit_log_reject_update",
    [],
    { returns: "trigger", language: "plpgsql", replace: true },
    `
    BEGIN
      RAISE EXCEPTION 'audit_log is append-only: UPDATE is not permitted'
        USING ERRCODE = 'restrict_violation';
    END;
    `
  );

  pgm.createTrigger("audit_log", "audit_log_no_update", {
    when: "BEFORE",
    operation: "UPDATE",
    level: "ROW",
    function: "audit_log_reject_update",
  });
};

exports.down = (pgm) => {
  pgm.dropTrigger("audit_log", "audit_log_no_update", { ifExists: true });
  pgm.dropFunction("audit_log_reject_update", [], { ifExists: true });
  pgm.dropTable("audit_log");
};
