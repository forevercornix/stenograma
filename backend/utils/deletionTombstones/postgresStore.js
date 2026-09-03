/**
 * IŠTRYNIMO ŽYMOS PostgreSQL'e (#155, 7.5a / #183).
 *
 * ⚠️ KOORDINAVIMO MODELIS - LOCK'AS SAUGO PERĖJIMĄ, ŽYMA SAUGO DARBO EIGĄ.
 *
 * Kiekvienas būsenos pakeitimas vyksta TRUMPOJE transakcijoje su
 * `pg_advisory_xact_lock(NAMESPACE, hashtext(job_id))`. Transakcija apima TIK
 * claim'ą (`INSERT`/`UPDATE` + autoritetingas skaitymas) ir baigiasi PRIEŠ
 * funkcijai grįžtant - t. y. prieš bet kokį išorinį I/O (failai, S3, Redis).
 *
 * Tai STRUKTŪRINĖ, ne drausminė garantija: `eraseJob()` kviečiamas jau grįžus
 * iš šio modulio, tad lock'o per jį išlaikyti fiziškai nėra kaip. Realizacija,
 * apgaubianti visą ištrynimą viena ilga transakcija, praeitų paprastą lenktynių
 * testą ir produkcijoje išsemtų pool'ą - būtent todėl transakcijos ribos čia
 * sutampa su funkcijos ribomis.
 *
 * ⚠️ TRANSAKCINIS, NE SESIJINIS LOCK'AS. `pg_advisory_xact_lock` atlaisvinamas
 * `COMMIT`/`ROLLBACK` metu automatiškai, tad kritęs procesas negali palikti
 * užrakinto `job_id`. Su sesijiniu lock'u nutekėjusi jungtis užrakintų job'ą
 * iki pool'o perkrovimo.
 *
 * ⚠️ VIENINTELIS VYKDYTOJAS - SĄLYGINIS RAŠYMAS, NE LOCK'AS. Lock'as reikalingas
 * dėl vieno konkretaus dalyko: `INSERT ... ON CONFLICT DO NOTHING` konflikto
 * atveju eilutės negrąžina, tad autoritetingą būseną tenka skaityti atskira
 * užklausa. Be lock'o tarp jų įsiterptų trečias procesas ir kvietėjas gautų
 * būseną, kurios niekada nebuvo jo perėjimo metu.
 *
 * ⚠️ `hashtext()` SKAIČIUOJAMAS SQL'e, ne JS. Kitaip dvi replikos su
 * skirtingomis Node versijomis ar hash realizacijomis rakinėtų skirtingus
 * raktus, o lenktynių apsauga tyliai išnyktų.
 */

const { randomUUID } = require("crypto");

const {
  TOMBSTONE_STATUS,
  assertReason,
  assertActorKind,
  assertFailureKind,
  allowedSources,
} = require("./states");

/**
 * Advisory lock'ų erdvė. Bet koks fiksuotas int32; svarbu, kad jis būtų
 * VIENAS ir kitos posistemės jo nenaudotų.
 */
const LOCK_NAMESPACE = 7541;

/**
 * Retencijos batch'as - ta pati priežastis kaip `auditStore.RETENCIJOS_BATCH`:
 * neribotas `DELETE` užrakintų lentelę visam trynimo laikui.
 */
const RETENCIJOS_BATCH = 500;

const STULPELIAI = `
  job_id, status, reason, actor_kind, marked_at, updated_at,
  completed_at, attempts, last_failure_kind, claim_token
`;

function laikas(reiksme) {
  return reiksme === null || reiksme === undefined ? null : new Date(reiksme).getTime();
}

function iIrasa(row) {
  if (!row) return null;

  return {

    jobId: row.job_id,
    status: row.status,
    reason: row.reason,
    actorKind: row.actor_kind,
    /** DB stulpelis `marked_at`; vardas paliktas dėl esamo rezultato kontrakto. */
    requestedAt: laikas(row.marked_at),
    updatedAt: laikas(row.updated_at),
    completedAt: laikas(row.completed_at),
    attempts: row.attempts,
    lastFailureKind: row.last_failure_kind,
    /** `null`, kai pretenzijos niekas nelaiko - žr. migraciją 1755700000000. */
    claimToken: row.claim_token,
  };
}

/**
 * BARJERO PATIKRA KVIETĖJO JUNGTIMI - BE POOL'O IR BE `init()` (#183).
 *
 * ⚠️ FUNKCIJA SĄMONINGAI MODULIO LYGIO, NE FABRIKO VIDUJE.
 *
 * Ji naudoja TIK perduotą klientą, tad pool'o jai nereikia. Kviečiant per
 * fasadą (`deletionTombstones.assertNotBarred`) prieš tai įvyktų `ensureInit()`,
 * kuris jungiasi pagal `process.env.DATABASE_URL` - o tai gali būti KITA
 * duomenų bazė nei ta, kurioje vyksta kvietėjo transakcija.
 *
 * Būtent tai ir sulaužė CI: `postgresStore.integration` migruoja `<bazė>_store`,
 * o fasadas jungėsi prie `<bazė>` be `erasure_marks` ir krito fail-closed.
 * Testas buvo teisingas - klaidingas buvo kelias, kuriuo barjeras ieškojo
 * lentelės.
 *
 * Semantiškai tai griežčiau, ne laisviau: barjeras PRIVALO būti skaitomas toje
 * pačioje DB ir transakcijoje, kur vyksta rašymas. Kitos DB pasiekiamumas apie
 * šį rašymą neįrodo nieko.
 */
/**
 * BARJERO PASIEKIAMUMAS PER SVETIMĄ JUNGTĮ (#155, 7.4e / #216).
 *
 * ⚠️ UŽKLAUSA GYVENA ČIA, NE KVIETĖJO MODULYJE.
 *
 * 7.4e barjeras skaito `erasure_marks` per AUDITO jungtį, tad readiness turi
 * patikrinti lentelę būtent per ją - `init()` zondas tikrina savo pool'ą.
 * Bet pati užklausa yra ŽYMŲ modulio dalykas: `SELECT ... FROM erasure_marks`
 * audito store'e būtų antra vieta, kur žinoma šios lentelės forma, ir
 * `erasureMarks.test.js` „VIENAS AUTORITETAS" tripwire tai pagauna (pagavo).
 *
 * ⚠️ TIKRINAMI STULPELIAI, NE VIEN LENTELĖ - ta pati priežastis kaip `init()`:
 * `SELECT 1` pavyksta ir tada, kai diegimas nutrūko po lentelės sukūrimo, bet
 * PRIEŠ vėlesnę migraciją.
 *
 * ⚠️ NIEKADA NEMETA: readiness privalo atsakyti ir tada, kai atsakymas yra „ne".
 */
async function probeBarrierWithClient(vykdytojas) {
  if (!vykdytojas || typeof vykdytojas.query !== "function") return false;

  try {
    await vykdytojas.query(`SELECT ${STULPELIAI} FROM erasure_marks WHERE false`);
    return true;
  } catch {
    return false;
  }
}

async function assertNotBarredWithClient(klientas, jobId) {
  if (!klientas || typeof klientas.query !== "function") {
    throw new TypeError("assertNotBarred: reikia kviečiančiojo DB kliento (transakcijos).");
  }

  await klientas.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [
    LOCK_NAMESPACE,
    jobId,
  ]);

  const { rows } = await klientas.query(
    "SELECT status FROM erasure_marks WHERE job_id = $1",
    [jobId]
  );

  if (rows.length) {
    const klaida = new Error(`Job ${jobId} užbarjeruotas ištrynimo žyma (${rows[0].status}).`);
    klaida.code = "ERASURE_BARRIER";
    klaida.status = rows[0].status;
    throw klaida;
  }
}

function createErasureMarkStore(pool) {
  /**
   * Trumpa transakcija su per-`job_id` advisory lock'u.
   *
   * ⚠️ PRIELAIDA, KURIĄ SAUGO ŠIS KOMENTARAS: `darbas` NEVYKDO išorinio I/O.
   * Jis daro tik SQL prieš tą patį klientą. Įdėjus čia failų ar tinklo kvietimą,
   * lock'as vėl imtų dengti nekontroliuojamą trukmę.
   */
  async function suRakinimu(jobId, darbas) {
    const klientas = await pool.connect();

    try {
      await klientas.query("BEGIN");
      await klientas.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [
        LOCK_NAMESPACE,
        jobId,
      ]);

      const rezultatas = await darbas(klientas);

      await klientas.query("COMMIT");
      return rezultatas;
    } catch (klaida) {
      await klientas.query("ROLLBACK").catch(() => {});
      throw klaida;
    } finally {
      klientas.release();
    }
  }

  /**
   * Idempotentinis žymėjimas.
   *
   * ⚠️ `DO NOTHING`, NE `DO UPDATE`. `DO UPDATE` pastumtų `marked_at` ir galėtų
   * grąžinti jau `deleted` žymą atgal į `pending` - lygiai tos pačios klasės
   * defektas, kaip vėlyvas `deletion_failed`, perrašantis patvirtintą ištrynimą.
   */
  async function mark(jobId, { reason, actorKind = null } = {}) {
    if (!jobId) return null;

    assertReason(reason);
    assertActorKind(actorKind);

    return suRakinimu(jobId, async (klientas) => {
      const { rows } = await klientas.query(
        `INSERT INTO erasure_marks (job_id, status, reason, actor_kind, claim_token)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (job_id) DO NOTHING
         RETURNING ${STULPELIAI}`,
        [jobId, TOMBSTONE_STATUS.PENDING, reason, actorKind, randomUUID()]
      );

      /**
       * ⚠️ EILUTĘ GRĄŽINA TIK ĮTERPĖJAS - TAI IR YRA PRETENZIJA (`claimed`).
       *
       * `ON CONFLICT DO NOTHING RETURNING` konflikto atveju negrąžina nieko, tad
       * `rows.length` yra atominis atsakymas į klausimą „ar AŠ esu šio jobo
       * ištrynimo vykdytojas". Be jo kvietėjas mato `deletion_pending` ir negali
       * pasakyti, ar tai jo paties žyma, ar kitos replikos - ir abi replikos
       * pradeda tą patį destruktyvų I/O.
       *
       * Pretenzija atominė PAČIAME `INSERT`-e, ne `SELECT`-e prieš jį: tarp
       * skaitymo ir rašymo langas liktų.
       */
      if (rows.length) return { ...iIrasa(rows[0]), claimed: true };

      /** Konfliktas: žyma jau buvo. Autoritetinga yra ESAMA būsena. */
      const esama = await klientas.query(
        `SELECT ${STULPELIAI} FROM erasure_marks WHERE job_id = $1`,
        [jobId]
      );

      /**
       * ⚠️ TUŠČIAS REZULTATAS ČIA YRA LENKTYNĖS SU RETENCIJA, NE „NĖRA ŽYMOS".
       *
       * `purgeExpired()` NEIMA per-job advisory lock'o (jis dirba batch'ais), tad
       * tarp `ON CONFLICT DO NOTHING` ir šio `SELECT` pasibaigusio termino
       * `deleted` eilutė gali būti pašalinta. Anksčiau tai duodavo įrašą be
       * statuso su `claimed: false`, ir ABU ištrynimo keliai kritdavo į
       * destruktyvų I/O tarsi turėdami pretenziją - o `complete()` dingusios
       * žymos nebeatkurtų. Ištrynimas liktų BE barjero.
       *
       * Kartojam įterpimą: eilutės nebėra, tad šįkart jis pavyks, ir kvietėjas
       * gaus TIKRĄ pretenziją. Vienas pakartojimas pakanka - antrą kartą
       * pataikyti į tą patį langą su ką tik sukurta `pending` eilute neįmanoma:
       * retencija šalina tik `deleted`.
       */
      if (!esama.rows.length) {
        const { rows: pakartoti } = await klientas.query(
          `INSERT INTO erasure_marks (job_id, status, reason, actor_kind, claim_token)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (job_id) DO NOTHING
           RETURNING ${STULPELIAI}`,
          [jobId, TOMBSTONE_STATUS.PENDING, reason, actorKind, randomUUID()]
        );

        if (pakartoti.length) return { ...iIrasa(pakartoti[0]), claimed: true };

        const treti = await klientas.query(
          `SELECT ${STULPELIAI} FROM erasure_marks WHERE job_id = $1`,
          [jobId]
        );

        if (!treti.rows.length) {
          throw new Error(
            `Ištrynimo žymos ${jobId} nepavyko nei rasti, nei sukurti. Tęsti ` +
              "negalima: ištrynimas be barjero yra negrįžtamas."
          );
        }

        return { ...iIrasa(treti.rows[0]), claimed: false };
      }

      return { ...iIrasa(esama.rows[0]), claimed: false };
    });
  }

  /**
   * SĄLYGINIS perėjimas.
   *
   * ⚠️ `deleted` NĖRA NĖ VIENAME `from` SĄRAŠE - tai ir yra pagrindinė
   * daugiaprocesio lenktynių garantija. Ji gyvena `WHERE` sakinio FORMOJE, ne
   * runtime `if`-e, tad jos negalima apeiti nei kitu kvietėju, nei kita
   * replika. Grąžina `null`, kai perėjimas neleidžiamas iš dabartinės būsenos.
   */
  async function transition(jobId, to, options = {}) {
    return _perkelti(jobId, allowedSources(to), to, options);
  }

  /**
   * PRETENZIJA Į AUTORIZUOTĄ PAKARTOJIMĄ (#183).
   *
   * ⚠️ IŠSKIRTINUMAS ČIA YRA BŪSENA, NE AKIMIRKA. `claim_token IS NULL` sąlyga
   * galioja visą vykdymo laiką: vėliau atėjusi replika mato jau nustatytą
   * žetoną ir pretenzijos nebegauna, nesvarbu, kiek laiko praėjo. Būtent tuo
   * tai skiriasi nuo `updated_at` palyginimo, kuris atskiria tik vienu metu
   * skaičiusius.
   *
   * Grąžina `null`, kai žetoną jau kažkas laiko arba žyma nebe `pending`.
   */
  async function claimRetry(jobId) {
    if (!jobId) return null;

    return suRakinimu(jobId, async (klientas) => {
      const { rows } = await klientas.query(
        `UPDATE erasure_marks
            SET claim_token = $2,
                updated_at = now()
          WHERE job_id = $1
            AND status = $3
            AND claim_token IS NULL
        RETURNING ${STULPELIAI}`,
        [jobId, randomUUID(), TOMBSTONE_STATUS.PENDING]
      );

      return rows.length ? iIrasa(rows[0]) : null;
    });
  }

  /**
   * IŠLEISTOS KOPIJOS GALIOJIMAS - AUKŠČIAUSIAS VANDUO (#183 Codex, P1).
   *
   * ⚠️ `GREATEST`, ne priskyrimas: horizontas gali tik KILTI. Sumažinus
   * `BACKUP_RETENTION_DAYS`, jau išleista ilgesnio galiojimo kopija savo
   * galiojimo nepraranda, tad ir barjeras negali sutrumpėti.
   */
  async function recordBackupHorizon(expiresAtMs) {
    if (!Number.isFinite(expiresAtMs)) return null;

    const { rows } = await pool.query(
      `INSERT INTO backup_horizon (id, expires_at, updated_at)
       VALUES (true, $1, now())
       ON CONFLICT (id) DO UPDATE
         SET expires_at = GREATEST(backup_horizon.expires_at, EXCLUDED.expires_at),
             updated_at = now()
       RETURNING expires_at`,
      [new Date(expiresAtMs).toISOString()]
    );

    return rows.length ? new Date(rows[0].expires_at).getTime() : null;
  }

  /** Grąžina aukščiausią išleistos kopijos galiojimą arba `null`. */
  async function backupHorizon() {
    const { rows } = await pool.query("SELECT expires_at FROM backup_horizon WHERE id");
    return rows.length ? new Date(rows[0].expires_at).getTime() : null;
  }

  /** Sąmoningas lentelės apėjimas - tik operatoriaus išeičiai. Žr. `memoryStore`. */
  async function transitionOverride(jobId, from, to, options = {}) {
    return _perkelti(jobId, from, to, options);
  }

  async function _perkelti(
    jobId,
    from,
    to,
    { completedAt = null, failureKind = null, actorKind = undefined } = {}
  ) {
    if (!jobId) return null;

    const kind = assertFailureKind(failureKind);
    if (actorKind !== undefined) assertActorKind(actorKind);

    return suRakinimu(jobId, async (klientas) => {
      const { rows } = await klientas.query(
      /**
       * ⚠️ `claim_token = NULL` ČIA YRA VIENINTELĖ ŽETONO VALYMO VIETA (#183).
       *
       * Žetonas galioja lygiai tiek, kiek trunka `deletion_pending` būsena, tad
       * KIEKVIENAS perėjimas jį nuvalo:
       *
       *   - `pending -> deleted` - terminalizacija; ten jis nieko nebegintų, o
       *     paliktas keltų klausimą, ar pretenzija dar aktyvi;
       *   - `pending -> failed` - įskaitant `release`;
       *   - `failed -> pending` - `retry` palieka NULL: autorizuota, nepaimta.
       *
       * Dvi valymo vietos (pvz. atskirai `release` ir `retry`) būtų ta pati
       * klasė kaip dvi kartojimo sistemos, todėl taisyklė gyvena čia - viename
       * `UPDATE`, pro kurį eina visi perėjimai - o ne kvietėjuose.
       */
        `UPDATE erasure_marks
            SET status = $3,
                updated_at = now(),
                completed_at = CASE WHEN $3 = '${TOMBSTONE_STATUS.DELETED}'
                                    THEN COALESCE($4::timestamptz, now())
                                    ELSE NULL END,
                attempts = attempts + CASE WHEN $3 = '${TOMBSTONE_STATUS.FAILED}' THEN 1 ELSE 0 END,
                last_failure_kind = CASE WHEN $3 = '${TOMBSTONE_STATUS.FAILED}' THEN $5 ELSE NULL END,
                actor_kind = COALESCE($6, actor_kind),
                claim_token = NULL
          WHERE job_id = $1
            AND status = ANY($2)
        RETURNING ${STULPELIAI}`,
        [
          jobId,
          from,
          to,
          completedAt === null || completedAt === undefined
            ? null
            : new Date(completedAt).toISOString(),
          kind,
          actorKind === undefined ? null : actorKind,
        ]
      );

      return rows.length ? iIrasa(rows[0]) : null;
    });
  }

  async function get(jobId) {
    if (!jobId) return null;

    const { rows } = await pool.query(
      `SELECT ${STULPELIAI} FROM erasure_marks WHERE job_id = $1`,
      [jobId]
    );

    return iIrasa(rows[0]);
  }

  /**
   * Barjero klausimas - karštas kelias.
   *
   * Atskiras nuo `get()`, nes worker'iui, jobStore'ui ir eilėms rūpi TIK „ar
   * yra žyma", ir eilutės nešti į Node dėl to nereikia.
   */
  async function isBarred(jobId) {
    if (!jobId) return false;

    const { rowCount } = await pool.query(
      "SELECT 1 FROM erasure_marks WHERE job_id = $1",
      [jobId]
    );

    return rowCount > 0;
  }

  /**
   * 7.4e TOCTOU PRIELAIDA - patikra KVIETĖJO transakcijoje.
   *
   * ⚠️ KODĖL NE `SELECT ... FOR SHARE`. Eilutės gali dar nebūti, o neegzistuojanti
   * eilutė nieko neužrakina: lygiagretus `mark()` įsiterptų tarp patikros ir
   * kvietėjo `INSERT`. Todėl imamas TAS PATS advisory lock'as, kurį ima `mark()`
   * ir `transition()` - dvi operacijos serializuojasi, ir „patikrink, tada rašyk"
   * tampa atominis.
   *
   * Lock'as transakcinis, tad jį atlaisvina kvietėjo `COMMIT`/`ROLLBACK`.
   * 7.4e naudoja taip: BEGIN → assertNotBarred(client, jobId) → audito INSERT → COMMIT.
   */
  async function assertNotBarred(klientas, jobId) {
    return assertNotBarredWithClient(klientas, jobId);
  }
  /**
   * VISOS žymos — įskaitant `deleted` (#250, 7.6c).
   *
   * ⚠️ `listUnresolved()` EKSPORTUI NEPAKANKA, IR TAI NE DETALĖ. Ji sąmoningai
   * praleidžia `deleted`, o būtent tos žymos yra 7.6c priežastis: jos įrodo, kad
   * subjekto duomenų būti negali. Eksportas be jų atkurtų DB be pačių svarbiausių
   * ištrynimų.
   *
   * ⚠️ BE `limit`: eksportas privalo būti PILNAS. Riba čia reikštų tylų
   * praradimą — būtent tai, ko visa procedūra ir vengia.
   */
  async function listAll() {
    const { rows } = await pool.query(
      `SELECT ${STULPELIAI} FROM erasure_marks ORDER BY job_id`
    );

    return rows.map(iIrasa);
  }

  /**
   * SULIETOS ŽYMOS ĮRAŠYMAS (#250, 7.6c).
   *
   * ⚠️ SPRENDIMAS PRIIMAMAS NE ČIA. Ką rašyti, nusprendžia
   * `utils/erasureExport.js` (`suliejimoPlanas`) PRIEŠ bet kokį rašymą; ši
   * funkcija tik vykdo. Antra tvarkos taisyklė SQL'e būtų ta pati dviejų tiesų
   * klasė, kurią repo jau gaudė.
   *
   * ⚠️ `claim_token` VISADA `NULL`. Svetimas žetonas žymi mirusį pre-restore
   * vykdytoją; jį persistinus autoritetingas kelias grąžintų `IN_PROGRESS`
   * neribotai.
   *
   * ⚠️ LAIKO ŽYMOS IŠSAUGOMOS IŠ EKSPORTO, ne `now()`. `updated_at` yra ir
   * retencijos raktas (`retencijosRiba`), ir suliejimo tvarkos raktas: perrašius
   * jį rašymo metu, antras paleidimas matytų „naujesnę" vietinę žymą, o retencija
   * pailgėtų be priežasties.
   */
  async function importuotiZyma(irasas) {
    const { rows } = await pool.query(
      `INSERT INTO erasure_marks
         (job_id, status, reason, actor_kind, marked_at, updated_at, completed_at,
          attempts, last_failure_kind, claim_token)
       VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0), to_timestamp($6 / 1000.0),
               CASE WHEN $7::bigint IS NULL THEN NULL ELSE to_timestamp($7 / 1000.0) END,
               $8, $9, NULL)
       ON CONFLICT (job_id) DO UPDATE
          SET status = EXCLUDED.status,
              reason = EXCLUDED.reason,
              actor_kind = EXCLUDED.actor_kind,
              marked_at = LEAST(erasure_marks.marked_at, EXCLUDED.marked_at),
              updated_at = EXCLUDED.updated_at,
              completed_at = EXCLUDED.completed_at,
              attempts = GREATEST(erasure_marks.attempts, EXCLUDED.attempts),
              last_failure_kind = EXCLUDED.last_failure_kind,
              claim_token = NULL
       RETURNING ${STULPELIAI}`,
      [
        irasas.jobId,
        irasas.status,
        irasas.reason,
        irasas.actorKind,
        Number(irasas.requestedAt),
        Number(irasas.updatedAt),
        irasas.completedAt === null || irasas.completedAt === undefined ? null : Number(irasas.completedAt),
        Number(irasas.attempts) || 0,
        irasas.lastFailureKind || null,
      ]
    );

    return iIrasa(rows[0]);
  }

  async function listUnresolved({ olderThanMs = 0, limit = 100 } = {}) {
    const { rows } = await pool.query(
      `SELECT ${STULPELIAI},
              EXTRACT(EPOCH FROM (now() - marked_at)) * 1000 AS age_ms
         FROM erasure_marks
        WHERE status <> $1
          AND marked_at <= now() - make_interval(secs => $2)
        ORDER BY marked_at
        LIMIT $3`,
      [TOMBSTONE_STATUS.DELETED, olderThanMs / 1000, limit]
    );

    return rows.map((row) => ({ ...iIrasa(row), ageMs: Math.round(Number(row.age_ms)) }));
  }

  /**
   * Retencija: TIK `deleted`, ribotais batch'ais.
   *
   * `FOR UPDATE SKIP LOCKED` - ta pati priežastis kaip audito retencijoje: dvi
   * instancijos gali valyti tą pačią lentelę vienu metu be deadlock'o ir be
   * dvigubo darbo.
   */
  /**
   * RETENCIJOS RIBA IŠ **DB LAIKRODŽIO** (#183 Codex, P2).
   *
   * ⚠️ TREČIAS TOS PAČIOS KLAIDOS ATVEJIS PROJEKTE. `updated_at` rašomas DB
   * `now()`, o riba ateidavo iš `Date.now()`: skubantis replikos laikrodis
   * ištrindavo barjerus anksčiau, nei pagal juos sukūrusią DB suėjo horizontas.
   * Tas pats defektas jau taisytas 7.4d audito retencijoje (Node laikrodis) ir
   * jos DST variante - žr. ataskaitos riziką apie laikrodžio autoritetą.
   *
   * Riba prašoma VIENĄ kartą per sweep'ą ir perduodama visiems batch'ams.
   */
  async function retencijosRiba(terminasMs) {
    const skaicius = Number(terminasMs);

    if (!Number.isFinite(skaicius) || skaicius <= 0) {
      throw new Error(`Retencijos terminas privalo būti teigiamas (gauta: ${terminasMs}).`);
    }

    const { rows } = await pool.query(
      "SELECT (now() - ($1 || ' milliseconds')::interval) AS riba",
      [String(Math.round(skaicius))]
    );

    return new Date(rows[0].riba).getTime();
  }

  async function purgeExpired(cutoffMs, limit = RETENCIJOS_BATCH) {
    const riba = Number(limit);

    if (!Number.isInteger(riba) || riba < 1) {
      throw new TypeError(`Batch dydis privalo būti teigiamas sveikasis (gauta: ${limit}).`);
    }

    const { rowCount } = await pool.query(
      `DELETE FROM erasure_marks em
        USING (
          SELECT job_id FROM erasure_marks
           WHERE status = $1
             AND updated_at < $2
           ORDER BY updated_at
           LIMIT $3
           FOR UPDATE SKIP LOCKED
        ) kandidatai
        WHERE em.job_id = kandidatai.job_id`,
      [TOMBSTONE_STATUS.DELETED, new Date(cutoffMs).toISOString(), riba]
    );

    return rowCount;
  }

  async function size() {
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM erasure_marks");
    return rows[0].n;
  }

  /**
   * ⚠️ TIK TESTAMS. Produkcijoje bendro trynimo kelio nėra sąmoningai: žyma yra
   * įrodymas, kad asmens duomenys pašalinti, ir jos masinis valymas turi eiti
   * per retenciją, kuri paiso prikėlimo horizonto.
   */
  async function clear() {
    if (process.env.NODE_ENV !== "test") {
      throw new Error("erasure_marks.clear() leidžiamas TIK testuose.");
    }
    await pool.query("DELETE FROM erasure_marks");
  }

  async function close() {
    /** Pool'o gyvavimo ciklas priklauso fasadui, ne saugyklai. */
  }

  return {
    /**
     * ZONDAS: LENTELĖ PASIEKIAMA IR TEISĖS YRA (#183 Codex, P1).
     *
     * ⚠️ NE `SELECT 1`. Ryšys gali būti gyvas, o `erasure_marks` neegzistuoti
     * (nepritaikyta migracija) arba rolė neturėti teisių - tada barjeras kristų
     * VYKDYMO metu, jau priėmus srautą. Zondas nemutuoja:
     * `has_table_privilege()` yra katalogo funkcija.
     *
     * ⚠️ `DELETE` TIKRINAMAS KARTU (#183 Codex, P2). Be jo readiness liktų
     * žalias, o kiekvienas retencijos sweep kristų ties `purgeExpired()`, ir
     * terminalės žymos kauptųsi neribotai - tyliai, nes barjero skaitymas
     * veiktų. Ta pati klaida kaip 7.4f audito zonde, kur `DELETE` pridėtas
     * būtent dėl GDPR kelio.
     */
    async probe() {
      const { rows } = await pool.query(
        `SELECT has_table_privilege('erasure_marks', 'SELECT') AS skaityti,
                has_table_privilege('erasure_marks', 'INSERT') AS rasyti,
                has_table_privilege('erasure_marks', 'UPDATE') AS keisti,
                has_table_privilege('erasure_marks', 'DELETE') AS trinti`
      );

      const e = rows[0];
      return (
        e.skaityti === true && e.rasyti === true && e.keisti === true && e.trinti === true
      );
    },
    mark,
    transition,
    transitionOverride,
    claimRetry,
    recordBackupHorizon,
    backupHorizon,
    get,
    isBarred,
    assertNotBarred,
    retencijosRiba,
    listUnresolved,
    listAll,
    importuotiZyma,
    purgeExpired,
    size,
    clear,
    close,
    backend: "postgres",
  };
}

module.exports = {
  STULPELIAI,
  assertNotBarredWithClient,
  probeBarrierWithClient,
  createErasureMarkStore,
  LOCK_NAMESPACE,
  RETENCIJOS_BATCH,
};
