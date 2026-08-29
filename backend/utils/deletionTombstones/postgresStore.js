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

const { TOMBSTONE_STATUS, assertReason, assertActorKind, assertFailureKind } = require("./states");

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
  completed_at, attempts, last_failure_kind
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
  };
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
        `INSERT INTO erasure_marks (job_id, status, reason, actor_kind)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (job_id) DO NOTHING
         RETURNING ${STULPELIAI}`,
        [jobId, TOMBSTONE_STATUS.PENDING, reason, actorKind]
      );

      if (rows.length) return iIrasa(rows[0]);

      /** Konfliktas: žyma jau buvo. Autoritetinga yra ESAMA būsena. */
      const esama = await klientas.query(
        `SELECT ${STULPELIAI} FROM erasure_marks WHERE job_id = $1`,
        [jobId]
      );

      return iIrasa(esama.rows[0]);
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
  async function transition(
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
        `UPDATE erasure_marks
            SET status = $3,
                updated_at = now(),
                completed_at = CASE WHEN $3 = '${TOMBSTONE_STATUS.DELETED}'
                                    THEN COALESCE($4::timestamptz, now())
                                    ELSE NULL END,
                attempts = attempts + CASE WHEN $3 = '${TOMBSTONE_STATUS.FAILED}' THEN 1 ELSE 0 END,
                last_failure_kind = CASE WHEN $3 = '${TOMBSTONE_STATUS.FAILED}' THEN $5 ELSE NULL END,
                actor_kind = COALESCE($6, actor_kind)
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
    mark,
    transition,
    get,
    isBarred,
    assertNotBarred,
    listUnresolved,
    purgeExpired,
    size,
    clear,
    close,
    backend: "postgres",
  };
}

module.exports = {
  createErasureMarkStore,
  LOCK_NAMESPACE,
  RETENCIJOS_BATCH,
};
