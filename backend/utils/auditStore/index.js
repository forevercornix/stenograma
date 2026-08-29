/**
 * AUDITO SAUGYKLOS FASADAS (#155, 7.4b / #211).
 *
 * ⚠️ NUMATYTASIS BACKEND'AS YRA ATMINTIS, IR JIS VEIKIA BE `init()`.
 *
 * Auditas rašomas iš daugybės kelių, įskaitant tokius, kurie sukasi be jokios
 * HTTP užklausos (worker'iai, retencijos ciklas). Reikalavimas kviesti `init()`
 * juos sulaužytų be jokios naudos: atminties režimu inicijuoti nėra ko.
 *
 * ⚠️ JOKIO FALLBACK Į ATMINTĮ PO PostgreSQL GEDIMO. `init()` klaida
 * propaguojama. Tylus grįžimas reikštų, kad operatorius paprašė persistentinio
 * audito, servisas pakilo ir rašo į vietą, kuri dingsta per restartą.
 */

const { createLogger } = require("../logger");
const { resolveAuditBackend } = require("./backendSelection");
const { auditTimeoutBudget } = require("./timeouts");
const { EVENT_PATTERN } = require("../auditEvents");
const { resolveKeyRing, HISTORICAL_SOFT_LIMIT } = require("./keyRing");
const memoryStore = require("./memoryStore");

const log = createLogger("audit-store");

/**
 * ⚠️ INVARIANTAI, KURIŲ SĄRAŠO PILNUMĄ TIKRINA MIGRACIJŲ TESTAS.
 *
 * Sąrašas čia yra STARTO barjeras: DB su dalimi migracijų lentelę turi, o
 * invariantų - ne. Jo PILNUMĄ (kad nė vienas migracijos `CHECK` nebūtų pamirštas)
 * išveda `tests/migrations.integration.test.js` iš šviežiai migruotos DB, o ne
 * šis rankinis sąrašas - žr. AGENTS.md §12.1.
 */
const REQUIRED_AUDIT_CONSTRAINTS = Object.freeze([
  "audit_log_event_pattern",
  "audit_log_meta_is_object",
  "audit_log_result_allowed",
]);

/**
 * ⚠️ KIEKVIENO INVARIANTO APIBRĖŽIMAS, NE TIK VARDAS.
 *
 * Nuklydusi DB gali turėti to paties vardo constraint'ą su susilpninta išraiška
 * (`CHECK (true)`). Vardo patikra tokį praleistų, ir tiesioginis ar senesnis
 * rašytojas galėtų išsaugoti skaliarinį `meta` arba nepalaikomą `result` -
 * startas paskelbtų schemą sveika. Ta pati pamoka kaip su trigeriu ir `seq`.
 *
 * Reikšmė - fragmentas, PRIVALANTIS būti `pg_get_constraintdef` išvestyje.
 * `audit_log_event_pattern` tikrinamas atskirai: jo fragmentas yra dabartinis
 * `EVENT_PATTERN.source`, kuris nėra konstanta.
 */
const REQUIRED_CONSTRAINT_FRAGMENTS = Object.freeze({
  audit_log_meta_is_object: "jsonb_typeof(meta)",
  audit_log_result_allowed: "'success'",
});

/**
 * ⚠️ UNIKALUMO INVARIANTAI TIKRINAMI ATSKIRAI NUO `CHECK`.
 *
 * `audit_log_seq_unique` yra `contype = 'u'`, tad `CHECK` užklausa jo NEMATO -
 * lygiai kaip nemato ir append-only trigerio. Be jo tiesioginis INSERT galėtų
 * pakartoti `seq`, ir `ORDER BY seq` taptų neapibrėžtas - o būtent `seq` yra
 * deklaruotas skaitymo tvarkos autoritetas (žr. migraciją ir
 * `docs/audit-storage.md` §5).
 */
const REQUIRED_AUDIT_UNIQUE_CONSTRAINTS = Object.freeze(["audit_log_seq_unique"]);

/**
 * ⚠️ AUDITO KONFIGŪRACIJOS RAKTAI - VIENAS SĄRAŠAS.
 *
 * Kiekvienas jų per `init(env)` tampa autoritetingas, o `process.env` lieka tik
 * atsarga. Sąrašas eksportuojamas todėl, kad testas galėtų tikrinti ATVIRKŠČIAI:
 * jokio audito modulio `process.env.AUDIT_*` skaitymo, kurio nėra šiame sąraše.
 * Be tokios sargybos ketvirtas „dvi konfigūracijos" simptomas atsirastų vėliau
 * ir atrodytų nesusijęs su ankstesniais trimis.
 */
const KONFIG_RAKTAI = Object.freeze([
  "AUDIT_ID_SALT",
  "PRIVACY_MODE",
  "AUDIT_WRITE_TIMEOUT_MS",
  "AUDIT_RETENTION_DAYS",
  "AUDIT_MAX_ENTRIES",
  /** #155, 7.4c (#212): istoriniai raktai ir sąmoningas GDPR garantijos laužymas. */
  "AUDIT_ID_SALT_PREVIOUS",
  "AUDIT_ALLOW_UNRESOLVABLE_KEY_GENERATIONS",
]);

/** Append-only trigeris - pagrindinė šios lentelės garantija. */
const REQUIRED_AUDIT_TRIGGER = "audit_log_no_update";

/**
 * ⚠️ NERIBOTAS AUGIMAS - MATOMUMAS, NE STARTO KLAIDA (#155, 7.4b).
 *
 * `AUDIT_RETENTION_DAYS` ir `AUDIT_MAX_ENTRIES` galioja TIK atminties režimui:
 * jie taikomi masyvui `auditLog` viduje, o persistentinės retencijos savininkas
 * yra [7.4d]. Postgres režime `audit_log` eilutės automatiškai NEŠALINAMOS.
 *
 * Startas dėl to nenutraukiamas: persistentinis auditas be retencijos vis tiek
 * geriau nei jokio audito, ir operatorius gali turėti savo valymo politiką. Bet
 * tylėti negalima - diegimas, matantis `AUDIT_RETENTION_DAYS=30` konfigūracijoje,
 * pagrįstai manytų, kad ji galioja.
 *
 * ⚠️ EKSPORTUOJAMA KONSTANTA, ne inline eilutė: turinį reikia tikrinti BE tikros
 * DB, nes pats `init()` postgres šakoje be jos nevykdomas.
 */
/**
 * ⚠️ TEKSTAS PAKEISTAS 7.4d (#213), NES SENASIS TAPO MELU.
 *
 * Iki 7.4d jis skelbė, kad retencija postgres režime NEVEIKIA. Nuo šio darbo
 * `AUDIT_RETENTION_DAYS` taikoma ir persistentinei lentelei per centralizuotą
 * sweep'ą. Palikus seną tekstą, operatorius manytų, kad reikia išorinės valymo
 * politikos - ir arba pridėtų antrą trynimo mechanizmą, arba nepasitikėtų
 * veikiančiu. Dokumentacija, stipresnė ar silpnesnė už kodą, abiem atvejais
 * klaidina (AGENTS.md §12.1).
 */
const RETENCIJOS_ISPEJIMAS =
  "Audito retencija postgres režime taikoma per centralizuotą sweep'ą " +
  "(AUDIT_RETENTION_DAYS). `AUDIT_MAX_ENTRIES` yra TIK atminties apsauga ir " +
  "persistentinėms eilutėms NETAIKOMA - eilutės nešalinamos vien dėl kiekio. " +
  "Žr. docs/audit-storage.md §9.";

let store = memoryStore;
let _pool = null;

/**
 * ⚠️ VIENAS DRUSKOS AUTORITETAS (#211 peržiūra).
 *
 * `init(env)` priima konfigūraciją kaip objektą, o `auditLog.resolveSalt()`
 * skaitė TIK `process.env`. Įterptinis kvietėjas (ir PostgreSQL integraciniai
 * testai) taip gaudavo `hash_key_id` iš injektuotos konfigūracijos, o
 * `subject_id` - iš KITOS, galimai atsitiktinai sugeneruotos druskos. Po tikro
 * proceso restarto `removeBySubjectIdentifier()` senų eilučių neberastų, ir
 * GDPR ištrynimas jų nepasiektų - tyliai.
 *
 * Sugeneruota procesui lokali druska `shutdown()` išgyvena, tad restarto testas
 * šį neatitikimą UŽDENGDAVO.
 *
 * ⚠️ TA PATI YDA GALIOJA VISIEMS `init(env)` LAUKAMS, ne tik druskai:
 *
 *   `PRIVACY_MODE`          - `init()` priimtų `false`, o `auditLog` skaitytų
 *                             globalų `true` ir TYLIAI mestų kiekvieną įrašą;
 *                             procesas praneštų apie sėkmingai paruoštą
 *                             persistentinę saugyklą, kuri lieka tuščia.
 *   `AUDIT_WRITE_TIMEOUT_MS` - pool'o biudžetas skaičiuotųsi iš injektuotos
 *                             reikšmės, o `rasytiAudita()` - iš globalios;
 *                             fasadas praneštų nesėkmę anksčiau, nei DB spėtų
 *                             nutraukti užklausą, ir vėlyvo rašymo langas, kurio
 *                             biudžetas kaip tik ir vengia, grįžtų.
 *
 * Todėl fiksuojama VISA reikšminga konfigūracija, o vartotojai ją skaito PIRMA.
 */
let konfiguracija = null;
let keyRing = null;

/**
 * ⚠️ STARTO MOMENTO SNAPSHOT'AS, NE GYVA BŪSENA (#155, 7.4f / #231).
 *
 * Čia lieka generacijos, kurioms `init()` metu neturėjome rakto ir kurias
 * praleido `AUDIT_ALLOW_UNRESOLVABLE_KEY_GENERATIONS=true`. Readiness jomis
 * remiasi, tad būtina suprasti ribą: sąrašas NESEKA DB pokyčių. Išvalius
 * eilutes ar grąžinus raktą, jis atsinaujina tik per RESTARTĄ - ir taip turi
 * būti, nes pilnas generacijų skenavimas kiekvieno poll'o metu yra būtent tai,
 * ko 7.4c loose index scan vengia.
 *
 * ⚠️ VĖLIAVĖLĖ SNAPSHOT'O NEKEIČIA. Su `true` procesas startuoja, bet sąrašas
 * lieka toks pat, ir `/api/ready` toliau grąžina 503. Vėliavėlė leidžia
 * PAKILTI, ne deklaruoti sveikatą.
 */
let nasliaitesSnapshot = [];
let initPromise = null;
let paruosta = false;

function isReady(env = process.env) {
  try {
    /** Netinkamas jungiklis - fail-closed. `startupChecks` tai pagauna anksčiau. */
    return resolveAuditBackend(env) === "memory" ? true : paruosta;
  } catch {
    return false;
  }
}

/** Dabartinis backend'as - naudinga diagnostikai ir testams. */
function backend() {
  return store.backend;
}

/**
 * AUDITO POOL'O NUSTATYMAI VIENOJE VIETOJE.
 *
 * Iškelta iš `initializePostgres()`, kad ribų buvimą būtų galima patikrinti be
 * tikros DB: `new Pool(...)` viduje jos liktų nepasiekiamos testui, ir
 * vienintelis įrodymas būtų šaltinio teksto paieška (AGENTS.md §9.2).
 *
 * ⚠️ RIBOS ATEINA IŠ BENDRO BIUDŽETO, ne iš atskirų kintamųjų - žr.
 * `timeouts.js`. `statement_timeout` sąmoningai MAŽESNIS už
 * `AUDIT_WRITE_TIMEOUT_MS`, kad DB spėtų nutraukti užklausą anksčiau, nei
 * fasadas nustos jos laukti.
 */
function auditoPoolNustatymai(env = process.env) {
  const { poolAcquireMs, statementMs, clientMs } = auditTimeoutBudget(env);

  /**
   * ⚠️ `connectionString` TIK KAI `DATABASE_URL` REALIAI YRA (#211 peržiūra).
   *
   * Dokumentuotas Compose diegimas perduoda `PGHOST`/`PGPORT`/`PGUSER`/
   * `PGPASSWORD`/`PGDATABASE`, o ne URL - sąmoningai, nes slaptažodis su URI
   * simboliais (`/`, `?`, `#`, `@`) URL'e reikštų kitką. `pg` tuos kintamuosius
   * skaito pats, bet TIK kai `connectionString` neperduotas: `undefined` čia
   * nėra tas pats, kas lauko nebuvimas.
   */
  const nustatymai = {
    connectionTimeoutMillis: poolAcquireMs,
    /** ⚠️ Serveris NUTRAUKIA anksčiau, klientas - tik atsarga. Žr. `timeouts.js`. */
    statement_timeout: statementMs,
    query_timeout: clientMs,
  };

  if (env.DATABASE_URL) {
    nustatymai.connectionString = env.DATABASE_URL;
    return nustatymai;
  }

  /**
   * ⚠️ `PG*` PERSIUNČIAMI EKSPLICITIŠKAI, NE PALIEKAMI `pg` NUOŽIŪRAI.
   *
   * `pg` `PG*` skaito iš `process.env`, o `init(env)` priima konfigūraciją kaip
   * OBJEKTĄ. Įterptinis kvietėjas, perdavęs `PGHOST` tik objekte,
   * `resolveAuditBackend()` praeitų (jis žiūri į tą patį objektą), o pool'as
   * jungtųsi prie GLOBALIOS aplinkos nurodytos - arba numatytosios - duomenų
   * bazės. Tai ta pati „dvi konfigūracijos" šeima kaip druska, `PRIVACY_MODE` ir
   * timeout, tik čia antrasis skaitytojas yra ne mūsų kodas, o pati biblioteka -
   * todėl `process.env` tripwire jos nepagauna.
   *
   * Persiunčiama TIK kai `DATABASE_URL` nėra: kartu su `connectionString` `pg`
   * taikytų juos abu, ir pirmenybė taptų neakivaizdi.
   */
  const PG_ATITIKMENYS = {
    PGHOST: "host",
    PGPORT: "port",
    PGUSER: "user",
    PGPASSWORD: "password",
    PGDATABASE: "database",
  };

  for (const [envRaktas, poolRaktas] of Object.entries(PG_ATITIKMENYS)) {
    if (env[envRaktas] !== undefined) {
      nustatymai[poolRaktas] = poolRaktas === "port" ? Number(env[envRaktas]) : env[envRaktas];
    }
  }

  return nustatymai;
}

async function initializePostgres(env) {
  const { Pool } = require("pg");
  const { createPostgresStore } = require("./postgresStore");

  const pool = new Pool(auditoPoolNustatymai(env));

  /**
   * ⚠️ BE ŠIO KLAUSYTOJO PROCESAS KRENTA (#211 peržiūra, P1).
   *
   * `pg-pool` neveiklios jungties klaidą (PostgreSQL restartas, tinklo trūkis)
   * skelbia kaip `error` įvykį ANT POOL'O. `EventEmitter` neapdorotą `error`
   * meta, tad Node nutraukia visą procesą - HTTP serverį arba worker'į. Tai
   * apeitų įprastą store'o klaidų apdorojimą abiem įvykių kategorijoms: nei
   * blokuojantis atmetimas, nei neblokuojantis skaitiklis nebesuveiktų, nes
   * proceso nebeliktų.
   *
   * ⚠️ KLAIDOS TEKSTAS NELOGINAMAS ŽALIAS: `pg` pranešime gali būti vartotojo
   * vardas (`password authentication failed for user "x"`).
   */
  pool.on("error", (klaida) => {
    log.error("Audito pool'o neveiklios jungties klaida - jungtis pašalinta", {
      klaida: klaida && klaida.code ? klaida.code : "nežinoma",
    });
  });

  try {
    await pool.query("SELECT 1");

    const { rows: lenteles } = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'audit_log'`
    );
    if (lenteles.length === 0) {
      throw new Error(
        "PostgreSQL pasiekiamas, bet trūksta `audit_log` lentelės. " +
          "Paleiskite `npm run migrate:up` prieš startą."
      );
    }

    const { rows: cRows } = await pool.query(
      `SELECT c.conname
         FROM pg_constraint c
         JOIN pg_class t     ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE t.relname = 'audit_log'
          AND n.nspname = current_schema()
          AND c.contype = 'c'`
    );
    const rasti = cRows.map((r) => r.conname);
    const truksta = REQUIRED_AUDIT_CONSTRAINTS.filter((c) => !rasti.includes(c));

    if (truksta.length > 0) {
      throw new Error(
        `PostgreSQL audito schema pasenusi - trūksta invariantų: ${truksta.join(", ")}. ` +
          "Paleiskite `npm run migrate:up`: be jų DB priimtų įrašus su nežinomu " +
          "įvykiu ar neleistina baigtimi."
      );
    }

    const { rows: uRows } = await pool.query(
      `SELECT c.conname, pg_get_constraintdef(c.oid) AS apibrezimas
         FROM pg_constraint c
         JOIN pg_class t     ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE t.relname = 'audit_log'
          AND n.nspname = current_schema()
          AND c.contype = 'u'`
    );
    const trukstaU = REQUIRED_AUDIT_UNIQUE_CONSTRAINTS.filter(
      (c) => !uRows.map((r) => r.conname).includes(c)
    );

    if (trukstaU.length > 0) {
      throw new Error(
        `PostgreSQL audito schemai trūksta unikalumo invariantų: ${trukstaU.join(", ")}. ` +
          "Be jų tiesioginis INSERT galėtų pakartoti `seq`, ir skaitymo tvarka " +
          "(`ORDER BY seq`) taptų neapibrėžta. Paleiskite `npm run migrate:up`."
      );
    }

    /**
     * ⚠️ TIKRINAMAS APIBRĖŽIMAS, NE VARDAS.
     *
     * Nuklydusi DB gali turėti to paties vardo unikalumo constraint'ą ant KITO
     * stulpelio - vardo patikra tokį praleistų, o `seq` dublikatai liktų
     * teisėti, ir `ORDER BY seq` taptų neapibrėžtas. Ta pati yda kaip tikrinti
     * trigerį pagal vardą.
     */
    const seqDef = uRows.find((r) => r.conname === "audit_log_seq_unique");
    if (seqDef && !/UNIQUE\s*\(\s*seq\s*\)/i.test(seqDef.apibrezimas)) {
      throw new Error(
        "PostgreSQL `audit_log_seq_unique` dengia NE `seq` stulpelį " +
          `(${seqDef.apibrezimas}). \`seq\` dublikatai liktų teisėti, ir skaitymo ` +
          "tvarka - deklaruotas jos autoritetas - taptų neapibrėžta."
      );
    }

    /**
     * ⚠️ TRIGERIS TIKRINAMAS ATSKIRAI NUO `CHECK` INVARIANTŲ.
     *
     * Append-only nėra `CHECK` - jis gyvena `BEFORE UPDATE` trigeryje, tad
     * `contype = 'c'` užklausa jo NEMATO. Be šios patikros DB, kurioje trigeris
     * nukrito (rankinis `DROP`, dalinė migracija), startuotų sėkmingai, o
     * audito įrašai taptų redaguojami - tyliai.
     */
    /**
     * ⚠️ TIKRINAMA IR SCHEMA, IR AR TRIGERIS ĮJUNGTAS.
     *
     * Dvi spragos, kurias tai uždaro:
     *
     *  1. `ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update` trigerio
     *     NEPAŠALINA - `pg_trigger` eilutė lieka, tik `tgenabled` tampa `D`.
     *     Be šios patikros startas paskelbtų append-only barjerą veikiančiu, o
     *     `UPDATE` praeitų.
     *  2. Be `pg_namespace` apribojimo tiktų ir to paties vardo trigeris ant
     *     `audit_log` KITOJE schemoje - o dirbame su `current_schema()`.
     *     Gretima invariantų užklausa schemą riboja; ši nuo jos buvo atsilikusi
     *     (AGENTS.md §16).
     *
     * `tgenabled`: `O` (origin), `R` (replica), `A` (always) - įjungtas;
     * `D` - išjungtas.
     */
    const { rows: trigeriai } = await pool.query(
      `SELECT tg.tgname, tg.tgenabled
         FROM pg_trigger tg
         JOIN pg_class t     ON t.oid = tg.tgrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE t.relname = 'audit_log'
          AND n.nspname = current_schema()
          AND tg.tgname = $1
          AND NOT tg.tgisinternal`,
      [REQUIRED_AUDIT_TRIGGER]
    );

    if (trigeriai.length === 0) {
      throw new Error(
        `PostgreSQL audito lentelė be \`${REQUIRED_AUDIT_TRIGGER}\` trigerio: įrašai ` +
          "būtų redaguojami. Auditas, kurį galima pataisyti, nėra auditas. " +
          "Paleiskite `npm run migrate:up`."
      );
    }

    /**
     * ⚠️ TIKRINAMA BALTASIS SĄRAŠAS, NE `!== "D"`.
     *
     * `tgenabled` turi keturias reikšmes, ir tik dvi apsaugo šį darbo krūvį:
     *
     *   `O` origin  - suveikia įprastoms sesijoms          ✓
     *   `A` always  - suveikia visada                      ✓
     *   `R` replica - suveikia TIK kai `session_replication_role = 'replica'`;
     *                 aplikacijos sesijos veikia kaip `origin`, tad trigeris
     *                 NESUVEIKIA ir `UPDATE` praeina                        ✗
     *   `D` disabled                                                        ✗
     *
     * Ankstesnė versija atmetė tik `D`, tad
     * `ALTER TABLE ... ENABLE REPLICA TRIGGER` paliktų startą paskelbusį
     * append-only barjerą veikiančiu, nors įprastos sesijos jį apeitų.
     */
    const APSAUGANTYS_REZIMAI = ["O", "A"];

    if (!APSAUGANTYS_REZIMAI.includes(trigeriai[0].tgenabled)) {
      throw new Error(
        `PostgreSQL append-only trigeris \`${REQUIRED_AUDIT_TRIGGER}\` neapsaugo šio ` +
          `darbo krūvio: tgenabled="${trigeriai[0].tgenabled}" ` +
          '(reikia "O" arba "A"). "D" reiškia išjungtą, "R" - kad jis suveikia tik ' +
          "replikos vaidmeniu, o aplikacijos sesijos veikia kaip `origin`. Abiem " +
          "atvejais `UPDATE` praeina, ir audito įrašai redaguojami. Įjunkite: " +
          `ALTER TABLE audit_log ENABLE ALWAYS TRIGGER ${REQUIRED_AUDIT_TRIGGER}`
      );
    }
    /**
     * ⚠️ VISŲ `CHECK` INVARIANTŲ APIBRĖŽIMAI - žr. `REQUIRED_CONSTRAINT_FRAGMENTS`.
     */
    const { rows: visiDef } = await pool.query(
      `SELECT c.conname, pg_get_constraintdef(c.oid) AS apibrezimas
         FROM pg_constraint c
         JOIN pg_class t     ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE t.relname = 'audit_log' AND n.nspname = current_schema() AND c.contype = 'c'`
    );

    for (const [vardas, fragmentas] of Object.entries(REQUIRED_CONSTRAINT_FRAGMENTS)) {
      const def = visiDef.find((r) => r.conname === vardas);

      if (!def || !def.apibrezimas.includes(fragmentas)) {
        throw new Error(
          `PostgreSQL invariantas \`${vardas}\` susilpnintas arba pakeistas: ` +
            `apibrėžime nerasta \`${fragmentas}\` (${def ? def.apibrezimas : "constraint'o nėra"}). ` +
            "Vardo sutapimo nepakanka - DB priimtų įrašus, kuriuos invariantas turi atmesti."
        );
      }
    }

    /**
     * ⚠️ ĮVYKIO ŠABLONO PARITETAS TIKRINAMAS PAGAL APIBRĖŽIMĄ, NE PAGAL VARDĄ.
     *
     * Migracijoje šablonas UŽŠALDYTAS (istorijos įrašas nekeičiamas). Pakeitus
     * `EVENT_PATTERN` be naujos migracijos, šviežia ir atnaujinta DB priimtų
     * SKIRTINGAS įvykių aibes, o vardas abiejose liktų tas pats - startas to
     * nepastebėtų. Todėl lyginamas tikrasis `CHECK` tekstas.
     */
    const { rows: cDef } = await pool.query(
      `SELECT pg_get_constraintdef(c.oid) AS apibrezimas
         FROM pg_constraint c
         JOIN pg_class t     ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE t.relname = 'audit_log' AND n.nspname = current_schema()
          AND c.conname = 'audit_log_event_pattern'`
    );

    if (!cDef.length || !cDef[0].apibrezimas.includes(EVENT_PATTERN.source)) {
      throw new Error(
        "PostgreSQL įvykių šablonas išsiskyrė su runtime `EVENT_PATTERN`: DB priima " +
          `kitą aibę nei aplikacija (${cDef[0] ? cDef[0].apibrezimas : "constraint'o nėra"}). ` +
          "Pakeitus šabloną reikia NAUJOS migracijos - senoji jau pažymėta pritaikyta, " +
          "tad atnaujintoje DB ji nebeperrašoma."
      );
    }

    /**
     * ⚠️ APPEND-ONLY TIKRINAMAS ELGSENA, NE METADUOMENIMIS.
     *
     * `tgname` + `tgenabled` patikra praleistų to paties vardo trigerį, kuris
     * kabo ant kitos operacijos (`BEFORE INSERT`) arba kviečia pakeistą, nieko
     * nedarančią funkciją. Abiem atvejais startas paskelbtų barjerą veikiančiu,
     * o `UPDATE` praeitų. Metaduomenų tikrinimas čia turi tą pačią ydą kaip
     * statinė patikra teste (AGENTS.md §9.2): jis įrodo, kad kažkas parašyta, o
     * ne kad veikia.
     *
     * Zondas vyksta transakcijoje, kuri VISADA atsukama, tad eilučių nelieka.
     * `seq` sekos reikšmė sunaudojama (sekos netransakcinės) - tarpai tvarkos
     * nekeičia, nes reikalingas tik monotoniškumas.
     */
    const klientas = await pool.connect();
    try {
      await klientas.query("BEGIN");
      const zondoId = require("node:crypto").randomUUID();

      await klientas.query(
        `INSERT INTO audit_log (id, event, hash_key_id, result)
         VALUES ($1, 'STARTUP_APPEND_ONLY_PROBE', $2, 'success')`,
        [zondoId, env.AUDIT_ID_SALT_ID]
      );

      let updatePraejo = false;
      try {
        await klientas.query("UPDATE audit_log SET result = 'failure' WHERE id = $1", [zondoId]);
        updatePraejo = true;
      } catch (klaida) {
        /**
         * ⚠️ TIK LAUKIAMAS SQLSTATE LAIKOMAS ĮRODYMU.
         *
         * Trigeris kelia `restrict_violation` (`23001`). Bet kuri kita klaida -
         * nutrūkusi jungtis, `statement_timeout`, teisių trūkumas - reiškia, kad
         * zondas NIEKO NEĮRODĖ. Anksčiau tuščias `catch` bet kokį gedimą laikė
         * patvirtinimu, tad startas galėjo pavykti su NEPATIKRINTA arba
         * neprieinama audito DB - tiksliai priešingai, nei zondas skirtas.
         */
        if (klaida.code !== "23001") throw klaida;
      }

      if (updatePraejo) {
        throw new Error(
          "PostgreSQL append-only barjeras NEVEIKIA: bandomasis `UPDATE` praėjo. " +
            `Trigeris \`${REQUIRED_AUDIT_TRIGGER}\` egzistuoja, bet arba kabo ant kitos ` +
            "operacijos, arba kviečia pakeistą funkciją. Audito įrašai redaguojami."
        );
      }
    } finally {
      await klientas
        .query("ROLLBACK")
        .catch((e) => log.error("Zondo transakcijos atsukimas nepavyko", { klaida: e && e.code }));
      klientas.release();
    }

    /**
     * ⚠️ PO ZONDO PATIKRINAMA, KAD POOL'AS DAR VEIKIA.
     *
     * Zondas dirbo su viena jungtimi. Jei ji nutrūko ties `ROLLBACK`, klaida
     * tik loginama - kitaip užgožtume pirminę priežastį. Todėl prieinamumas
     * patvirtinamas atskira, paprasta užklausa: startas neturi pavykti su
     * saugykla, kurios paskutinis realus kontaktas buvo nesėkmingas.
     */
    await pool.query("SELECT 1");
  } catch (err) {
    await pool.end().catch(() => {});
    throw err;
  }

  /**
   * ⚠️ READINESS BIUDŽETAS PERDUODAMAS, NE ATKARTOJAMAS (#233 Codex raundas 2, #3).
   *
   * Zondo single-flight įrašas galioja tol, kol maršrutas dar laukia. Reikšmė
   * imama iš to paties `READINESS_TIMEOUT_MS`, kurį skaito `server.js` - antra
   * konstanta store'e reikštų dvi konfigūracijos tiesas, o jos išsiskyrimo
   * niekas nepastebėtų (7.4b peržiūra tą ydą rado keturis kartus).
   */
  return {
    store: createPostgresStore(pool, {
      hashKeyId: env.AUDIT_ID_SALT_ID,
      readinessBudgetMs: env.READINESS_TIMEOUT_MS,
    }),
    pool,
  };
}

/**
 * DB GENERACIJŲ PATIKRA (#155, 7.4c / #212).
 *
 * ⚠️ RAKTO NEGALIMA PAMIRŠTI, KOL DB YRA JUO PSEUDONIMIZUOTŲ ĮRAŠŲ.
 *
 * Tai GDPR korektiškumo, ne konfigūracijos higienos reikalavimas. Praradus
 * secret'ą, `removeBySubjectIdentifier(jobId)` nebegali apskaičiuoti tų eilučių
 * `subject_id` - jos tampa amžinai nepasiekiamos ištrynimui, nors fiziškai
 * egzistuoja. Todėl startas nutraukiamas FAIL-CLOSED.
 *
 * ⚠️ ABI TAISYKLĖS IŠVEDAMOS IŠ VIENO SKENAVIMO. `usedGenerations()` grąžina
 * generacijas, faktiškai esančias lentelėje; iš to matyti ir našlaitės, ir tai,
 * kurie istoriniai raktai dar reikalingi.
 */
async function patikrintiGeneracijas(pgStore, env) {
  const dbGeneracijos = await pgStore.usedGenerations();
  const zinomos = keyRing.visi;

  const nasliaites = dbGeneracijos.filter((id) => !zinomos.has(id));

  if (nasliaites.length > 0) {
    /**
     * ⚠️ ATSISTATYMO KELIAS PRIVALOMAS (#212).
     *
     * Negrįžtamai praradus secret'ą fail-closed kitaip reikštų amžinai
     * nepaleidžiamą backend'ą. Vėliava paleidžia sistemą, bet KIEKVIENO starto
     * metu rėkia - tai sąmoningas GDPR garantijos laužymas, ne konfigūracijos
     * niuansas.
     */
    if (String(env.AUDIT_ALLOW_UNRESOLVABLE_KEY_GENERATIONS).toLowerCase() === "true") {
      nasliaitesSnapshot = [...nasliaites];

      log.warn(
        "GDPR GARANTIJA LAUŽOMA SĄMONINGAI: `audit_log` yra įrašų, kurių generacijai " +
          `neturime rakto (${nasliaites.join(", ")}). Šių įrašų ` +
          "`removeBySubjectIdentifier()` NEBEPASIEKS - asmens duomenų ištrynimas jų " +
          "nepašalins. Leista per AUDIT_ALLOW_UNRESOLVABLE_KEY_GENERATIONS=true. " +
          "Žr. docs/audit-storage.md."
      );
    } else {
      throw new Error(
        "PostgreSQL `audit_log` yra įrašų, kurių generacijai neturime rakto: " +
          `${nasliaites.join(", ")}. Jų \`subject_id\` nebeįmanoma atkurti, tad GDPR ` +
          "ištrynimas jų NEPASIEKS. Grąžinkite raktą į AUDIT_ID_SALT_PREVIOUS " +
          "(formatas `id:secret`) arba, negrįžtamai jį praradus, paleiskite su " +
          "AUDIT_ALLOW_UNRESOLVABLE_KEY_GENERATIONS=true - tai dokumentuotas " +
          "sąmoningas garantijos laužymas."
      );
    }
  }

  /**
   * ⚠️ KIEKIO RIBA ATMETA TIK NEBEREIKALINGUS RAKTUS (#212).
   *
   * Naivus derinys „maks. N" + „negalima pašalinti, kol yra įrašų" duotų
   * nepaleidžiamą sistemą: pasukus raktą N+1 kartų greičiau nei suveikia
   * retencija, viršijimas blokuoja startą, o pašalinti nė vieno negalima.
   * Todėl riba pažeidžiama tik tada, kai bent vienas istorinis raktas DB įrašų
   * NEBETURI - tokį pašalinti saugu, ir operatorius turi realų išėjimą.
   */
  if (keyRing.historicalCount > HISTORICAL_SOFT_LIMIT) {
    const naudojamos = new Set(dbGeneracijos);
    const nebereikalingi = keyRing.historical.filter((k) => !naudojamos.has(k.id)).map((k) => k.id);

    if (nebereikalingi.length > 0) {
      throw new Error(
        `AUDIT_ID_SALT_PREVIOUS turi ${keyRing.historicalCount} generacijas (riba - ` +
          `${HISTORICAL_SOFT_LIMIT}), o šios DB įrašų nebeturi: ${nebereikalingi.join(", ")}. ` +
          "Pašalinkite jas iš konfigūracijos. Raktai, kurie DB įrašų DAR TURI, " +
          "neatmetami niekada - riba jų neliečia."
      );
    }
  }
}

/**
 * ⚠️ `init()` GRĄŽINA BENDRĄ PROMISE - tas pats modelis kaip `jobStore.init()`
 * ir `sessionStore.init()`: lygiagretūs kvietėjai laukia TO PATIES vykstančio
 * inicijavimo, ne boolean vėliavos, kuri jau `true`, kol jungtis dar keliama.
 */
async function init(env = process.env) {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    /**
     * ⚠️ SNAPSHOT'AS VALOMAS KIEKVIENO BANDYMO PRADŽIOJE (#231 Codex peržiūra, P2).
     *
     * `init()` po nesėkmės leidžiamas pakartoti be `shutdown()` (žr. `catch`
     * žemiau). Be valymo pirmo bandymo našlaičių ID išliktų: operatorius
     * pataisytų konfigūraciją, antras bandymas pavyktų, o `/api/ready` liktų 503
     * dėl seno bandymo duomenų - iki restarto, kurio niekas nesuprastų reikiant.
     */
    nasliaitesSnapshot = [];

    const backendas = resolveAuditBackend(env);

    /**
     * Užfiksuojama ABIEM režimams: jei kvietėjas druską perdavė, ji yra
     * autoritetas neatsižvelgiant į backend'ą. Neperdavus - lieka `process.env`
     * kelias, tad esamas elgesys nesikeičia.
     */
    konfiguracija = Object.freeze({
      salt: env.AUDIT_ID_SALT || null,
      privacyMode: env.PRIVACY_MODE === undefined ? null : String(env.PRIVACY_MODE).toLowerCase() === "true",
      writeTimeoutMs: env.AUDIT_WRITE_TIMEOUT_MS === undefined ? null : env.AUDIT_WRITE_TIMEOUT_MS,
      retentionDays: env.AUDIT_RETENTION_DAYS === undefined ? null : env.AUDIT_RETENTION_DAYS,
      maxEntries: env.AUDIT_MAX_ENTRIES === undefined ? null : env.AUDIT_MAX_ENTRIES,
    });

    /**
     * ⚠️ ŽIEDAS SUDAROMAS ABIEM BACKEND'AMS, bet aktyvaus ID reikalaujama tik
     * persistentiniam: atmintyje `hash_key_id` niekur nerašomas.
     */
    keyRing = resolveKeyRing(env, {
      aktyvusSecret: konfiguracija.salt || env.AUDIT_ID_SALT || null,
      reikalaujamaAktyvausId: backendas === "postgres",
    });

    /**
     * ⚠️ ĮSPĖJIMAS APIE TRŪKSTAMĄ `AUDIT_ID_SALT_ID` ATMINTIES REŽIME (7.4c).
     *
     * ID čia neprivalomas sąmoningai: `hash_key_id` atmintyje niekur nerašomas.
     * Bet tylėti negalima - tai VIENINTELĖ vieta, kur operatorius gali sužinoti
     * IŠ ANKSTO, kad perjungus `AUDIT_BACKEND=postgres` startas nutrūks. Kitaip
     * jis tai pamatytų tik migracijos metu, kai jau vėlu.
     */
    if (backendas === "memory" && keyRing.activeSecret && !keyRing.activeId) {
      log.warn(
        "AUDIT_ID_SALT nustatytas, o AUDIT_ID_SALT_ID - ne. Atminties režimu tai " +
          "leistina (generacijos etiketė niekur nerašoma), bet perjungus " +
          "AUDIT_BACKEND=postgres startas NUTRŪKS: persistentiniam auditui ID " +
          "privalomas. Žr. docs/audit-storage.md §13."
      );
    }

    if (backendas === "memory") {
      store = memoryStore;
      paruosta = true;
      log.info("Audito saugykla: atmintis (vienas procesas, dingsta per restartą)");
      return store;
    }

    const { store: pgStore, pool } = await initializePostgres(env);

    /**
     * `PRIVACY_MODE` STARTO BARJERAS (#155, 7.4d / #213).
     *
     * ⚠️ TVARKA NĖRA STILIAUS KLAUSIMAS. Purge eina PRIEŠ
     * `patikrintiGeneracijas()`: išvalius eilutes `usedGenerations()` grąžina
     * `[]`, tad 7.4c fail-closed taisyklė nebeturi ko atmesti. Priešinga tvarka
     * sustabdytų startą dėl našlaičių generacijų, kurias purge tuoj pat būtų
     * ištrynęs - t. y. dėl eilučių, kurių po sekundės nebebūtų.
     *
     * ⚠️ FAIL-CLOSED IR `await`INTA. Jokio `catch`: tęsti su
     * `PRIVACY_MODE=true` ir senomis eilutėmis DB reikštų, kad vėliava žada
     * ištrynimą, o duoda nutildymą. Fire-and-forget čia reikštų tą patį, tik
     * nematomai.
     *
     * Vieta pasirinkta sąmoningai: DB pool paruoštas, schema ir invariantai
     * patikrinti, store sukurtas - anksčiau valyti reikštų lenktynes.
     */
    if (String(env.PRIVACY_MODE).toLowerCase() === "true") {
      const kiek = await pgStore.purgeAllForPrivacy();

      /**
       * ⚠️ ĮSPĖJAMA VISADA, NET KAI PAŠALINTA 0 EILUČIŲ.
       *
       * Iki 7.4d šis derinys buvo starto klaida (#211), tad jis negalėjo likti
       * nepastebėtas. Panaikinus sargą, tyla reikštų sukonfigūruotą,
       * persistentinę ir amžinai tuščią audito lentelę, kuri stebint atrodo kaip
       * veikianti sistema - tiksliai tas scenarijus, dėl kurio 7.4b sargą ir
       * įvedė. Įspėjimas kiekvieno starto metu yra jo pakaitalas.
       */
      log.warn(
        "PRIVACY_MODE=true SU AUDIT_BACKEND=postgres - auditas IŠJUNGTAS SĄMONINGAI. " +
          `Persistentinės eilutės išvalytos starto metu (${kiek}); tai NEGRĮŽTAMA. ` +
          "Kol vėliava įjungta, nauji įrašai nepersistinami, o `audit_log` lieka tuščia. " +
          "Išjungus vėliavą seni įrašai NEATSIKURIA. Žr. docs/audit-storage.md §9."
      );
    }

    await patikrintiGeneracijas(pgStore, env);

    store = pgStore;
    _pool = pool;
    paruosta = true;
    log.info("Audito saugykla: PostgreSQL (persistentinė, append-only)");

    /**
     * ⚠️ ĮSPĖJAMA TIK TADA, KAI YRA KĄ ĮSPĖTI (#213, 7.4d).
     *
     * Iki 7.4d įspėjimas kildavo kiekvieno postgres starto metu, nes retencija
     * ten NEVEIKĖ - tai galiojo visiems. Dabar ji veikia, ir vienintelis likęs
     * skirtumas yra `AUDIT_MAX_ENTRIES`: jis persistentinėms eilutėms
     * NETAIKOMAS. Operatoriui, kuris jo nenustatė, pranešti nėra ko, o
     * kiekvieno starto įspėjimas apie normalią būseną yra triukšmas, kurį
     * išmokstama ignoruoti - kartu su tais, kurie svarbūs.
     */
    if (env.AUDIT_MAX_ENTRIES !== undefined && env.AUDIT_MAX_ENTRIES !== "") {
      log.warn(RETENCIJOS_ISPEJIMAS);
    }

    return store;
  })().catch((error) => {
    initPromise = null; // leidžiam pakartoti init po nesėkmės
    paruosta = false;
    throw error;
  });

  return initPromise;
}

/**
 * GYVA AUDITO AUTORITETO BŪSENA. Fail-closed ir NIEKADA nemeta - readiness
 * privalo atsakyti visada, net kai atsakymas yra „neparuošta".
 *
 * ⚠️ KLAIDOS TEKSTAS NELOGINAMAS: `pg` pranešime gali būti vartotojo vardas.
 */
async function probe(env = process.env) {
  if (!isReady(env)) return false;
  try {
    return (await store.probe()) === true;
  } catch {
    return false;
  }
}

/**
 * Švarus išjungimo kelias - be jo integraciniai testai kabotų su atviromis
 * jungtimis, o konteinerio stabdymas paliktų neuždarytas DB sesijas.
 */
async function shutdown() {
  if (_pool) {
    const pool = _pool;
    _pool = null;
    await pool.end().catch(() => {});
  }
  store = memoryStore;
  paruosta = false;
  initPromise = null;
  konfiguracija = null;
  keyRing = null;
  nasliaitesSnapshot = [];
}

/**
 * Druska, perduota per `init(env)`, arba `null`.
 *
 * `auditLog.resolveSalt()` ja remiasi PIRMIAUSIA - kitaip pseudonimizacija ir
 * `hash_key_id` galėtų remtis skirtingais raktais.
 */
function konfiguruotaDruskaReiksme() {
  return konfiguracija ? konfiguracija.salt : null;
}

/**
 * Visa per `init(env)` perduota konfigūracija arba `null`.
 *
 * `auditLog` ir `auditWrite` ja remiasi PIRMIAUSIA - kitaip tas pats sprendimas
 * būtų priimamas iš dviejų skirtingų šaltinių.
 */
function konfiguracijaReiksme() {
  return konfiguracija;
}

/**
 * Aktyvus raktų žiedas arba `null`, jei `init()` dar nevykdytas.
 *
 * ⚠️ VIENINTELIS KELIAS PRIE ISTORINIŲ RAKTŲ. Užklausa ir ištrynimas jį ima iš
 * čia; `AUDIT_ID_SALT_PREVIOUS` niekur kitur neparsinamas (#212).
 */
function keyRingReiksme() {
  return keyRing;
}

/**
 * Generacijos, kurioms starto metu neturėjome rakto (tuščias masyvas - viskas
 * išsprendžiama).
 *
 * ⚠️ SNAPSHOT'AS - žr. `nasliaitesSnapshot` paaiškinimą. Readiness jį naudoja,
 * kad `AUDIT_ALLOW_UNRESOLVABLE_KEY_GENERATIONS=true` paleistas procesas
 * NEDEKLARUOTŲ sveikatos, nors liveness lieka 200.
 */
function nasliaitesGeneracijos() {
  return [...nasliaitesSnapshot];
}

/** Aktyvus store'as - `auditLog` fasadui. */
function current() {
  return store;
}

module.exports = {
  init,
  shutdown,
  isReady,
  probe,
  backend,
  current,
  auditoPoolNustatymai,
  konfiguruotaDruskaReiksme,
  konfiguracijaReiksme,
  keyRingReiksme,
  nasliaitesGeneracijos,
  KONFIG_RAKTAI,
  REQUIRED_AUDIT_CONSTRAINTS,
  REQUIRED_AUDIT_UNIQUE_CONSTRAINTS,
  REQUIRED_AUDIT_TRIGGER,
  RETENCIJOS_ISPEJIMAS,
};
