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
 * ⚠️ UNIKALUMO INVARIANTAI TIKRINAMI ATSKIRAI NUO `CHECK`.
 *
 * `audit_log_seq_unique` yra `contype = 'u'`, tad `CHECK` užklausa jo NEMATO -
 * lygiai kaip nemato ir append-only trigerio. Be jo tiesioginis INSERT galėtų
 * pakartoti `seq`, ir `ORDER BY seq` taptų neapibrėžtas - o būtent `seq` yra
 * deklaruotas skaitymo tvarkos autoritetas (žr. migraciją ir
 * `docs/audit-storage.md` §5).
 */
const REQUIRED_AUDIT_UNIQUE_CONSTRAINTS = Object.freeze(["audit_log_seq_unique"]);

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
const RETENCIJOS_ISPEJIMAS =
  "Audito retencija NEVEIKIA postgres režime: AUDIT_RETENTION_DAYS ir " +
  "AUDIT_MAX_ENTRIES taikomi tik atminties backend'ui, tad `audit_log` " +
  "eilutės automatiškai nešalinamos ir lentelė augs neribotai. " +
  "Persistentinę retenciją įgyvendina [7.4d]; iki tol reikalinga išorinė " +
  "valymo politika. Žr. docs/audit-storage.md §9.";

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
 */
let konfiguruotaDruska = null;
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

  if (env.DATABASE_URL) nustatymai.connectionString = env.DATABASE_URL;

  return nustatymai;
}

async function initializePostgres(env) {
  const { Pool } = require("pg");
  const { createPostgresStore } = require("./postgresStore");

  const pool = new Pool(auditoPoolNustatymai(env));

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
      `SELECT c.conname
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
      } catch {
        /** Laukiamas kelias: trigeris atmetė. */
      }

      if (updatePraejo) {
        throw new Error(
          "PostgreSQL append-only barjeras NEVEIKIA: bandomasis `UPDATE` praėjo. " +
            `Trigeris \`${REQUIRED_AUDIT_TRIGGER}\` egzistuoja, bet arba kabo ant kitos ` +
            "operacijos, arba kviečia pakeistą funkciją. Audito įrašai redaguojami."
        );
      }
    } finally {
      await klientas.query("ROLLBACK").catch(() => {});
      klientas.release();
    }
  } catch (err) {
    await pool.end().catch(() => {});
    throw err;
  }

  return { store: createPostgresStore(pool, { hashKeyId: env.AUDIT_ID_SALT_ID }), pool };
}

/**
 * ⚠️ `init()` GRĄŽINA BENDRĄ PROMISE - tas pats modelis kaip `jobStore.init()`
 * ir `sessionStore.init()`: lygiagretūs kvietėjai laukia TO PATIES vykstančio
 * inicijavimo, ne boolean vėliavos, kuri jau `true`, kol jungtis dar keliama.
 */
async function init(env = process.env) {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const backendas = resolveAuditBackend(env);

    /**
     * Užfiksuojama ABIEM režimams: jei kvietėjas druską perdavė, ji yra
     * autoritetas neatsižvelgiant į backend'ą. Neperdavus - lieka `process.env`
     * kelias, tad esamas elgesys nesikeičia.
     */
    konfiguruotaDruska = env.AUDIT_ID_SALT || null;

    if (backendas === "memory") {
      store = memoryStore;
      paruosta = true;
      log.info("Audito saugykla: atmintis (vienas procesas, dingsta per restartą)");
      return store;
    }

    const { store: pgStore, pool } = await initializePostgres(env);
    store = pgStore;
    _pool = pool;
    paruosta = true;
    log.info("Audito saugykla: PostgreSQL (persistentinė, append-only)");

    log.warn(RETENCIJOS_ISPEJIMAS);

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
  konfiguruotaDruska = null;
}

/**
 * Druska, perduota per `init(env)`, arba `null`.
 *
 * `auditLog.resolveSalt()` ja remiasi PIRMIAUSIA - kitaip pseudonimizacija ir
 * `hash_key_id` galėtų remtis skirtingais raktais.
 */
function konfiguruotaDruskaReiksme() {
  return konfiguruotaDruska;
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
  REQUIRED_AUDIT_CONSTRAINTS,
  REQUIRED_AUDIT_UNIQUE_CONSTRAINTS,
  REQUIRED_AUDIT_TRIGGER,
  RETENCIJOS_ISPEJIMAS,
};
