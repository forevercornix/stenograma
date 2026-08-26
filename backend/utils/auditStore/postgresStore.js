/**
 * AUDITO SAUGYKLA POSTGRESQL (#155, 7.4b / #211).
 *
 * ⚠️ TAS PATS STEBIMAS KONTRAKTAS KAIP `memoryStore`: tie patys metodai, tie
 * patys grąžinamų objektų raktai, ta pati `null`/`undefined` semantika. Bendras
 * parametrizuotas testų rinkinys tikrina abu, tad skirtumas negali atsirasti
 * tyliai.
 */

const { STULPELIAI, META_LAUKAI, isrinktiMeta } = require("./fields");

/** DB stulpelių sąrašas SELECT'ui - tvarka nesvarbi, bet vienoda abiem kryptim. */
const STULPELIU_SARASAS = Object.values(STULPELIAI)
  .map((s) => `"${s}"`)
  .join(", ");

/**
 * DB eilutė → `record()` formos objektas.
 *
 * ⚠️ `meta` IŠSKLEIDŽIAMAS PRO TĄ PATĮ ALLOWLIST, kaip ir rašant. JSONB'e
 * atsiradęs svetimas raktas (rankinis INSERT, senesnė aplikacijos versija)
 * neturi tyliai grįžti į atsakymą - skaitymas nėra vieta, kur allowlist'as
 * gali būti švelnesnis.
 *
 * ⚠️ TRŪKSTAMI `meta` RAKTAI TAMPA `null`, ne `undefined`: memory backend'as
 * juos visada turi (`record()` priskiria `null`), tad be šito paritetas lūžtų
 * ties raktų aibe, o ne ties reikšmėmis.
 */
function iEilute(row) {
  const eilute = {
    id: row.id,
    /** ISO 8601 - tas pats formatas, kurį atmintyje duoda `toISOString()`. */
    timestamp: row.timestamp instanceof Date ? row.timestamp.toISOString() : row.timestamp,
    event: row.event,
    subjectId: row.subject_id,
    result: row.result,
    requestId: row.request_id,
  };

  const meta = row.meta || {};
  for (const laukas of META_LAUKAI) {
    eilute[laukas] = laukas in meta ? meta[laukas] : null;
  }

  return eilute;
}

function createPostgresStore(pool, { hashKeyId }) {
  return {
    backend: "postgres",

    /**
     * ⚠️ `timestamp` NEPERDUODAMAS - jį parenka DB (`DEFAULT now()`).
     *
     * `record()` savo `timestamp` vis tiek suskaičiuoja (memory pusei), bet
     * persistuojant autoritetas yra DB: programos laikrodis skiriasi tarp
     * replikų, ir auditas turi turėti vieną tvarką. Grąžinama eilutė ateina iš
     * `RETURNING`, tad kvietėjas mato TIKRĄJĮ įrašytą laiką, ne savo spėjimą.
     *
     * ⚠️ `ON CONFLICT (id) DO NOTHING` - at-least-once idempotencija (#211).
     * Pakartotas rašymas (retry po timeout) nesukuria antros eilutės. `id`
     * generuoja aplikacija būtent todėl, kad tai būtų įmanoma.
     */
    async append(eilute) {
      const { rows } = await pool.query(
        `INSERT INTO audit_log (id, event, subject_id, hash_key_id, result, request_id, meta)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING
         RETURNING ${STULPELIU_SARASAS}, meta`,
        [
          eilute.id,
          eilute.event,
          eilute.subjectId,
          hashKeyId,
          eilute.result,
          eilute.requestId,
          isrinktiMeta(eilute),
        ]
      );

      /**
       * Tuščias `rows` reiškia, kad eilutė su tuo `id` jau buvo - konfliktas
       * praleistas. Grąžinam esamą, kad kvietėjas gautų tą patį objektą kaip ir
       * pirmą kartą, o ne `undefined`.
       */
      if (rows.length === 0) {
        const { rows: esama } = await pool.query(
          `SELECT ${STULPELIU_SARASAS}, meta FROM audit_log WHERE id = $1`,
          [eilute.id]
        );
        return esama.length ? iEilute(esama[0]) : null;
      }

      return iEilute(rows[0]);
    },

    /**
     * ⚠️ RIBA IR FILTRAI TAIKOMI SQL, NE PO ATSIĖMIMO (#211).
     *
     * `SELECT *` su `.slice()` Node'e reikštų, kad kiekviena audito užklausa
     * perkelia visą lentelę per tinklą - o auditas yra būtent ta lentelė, kuri
     * auga be ribos.
     *
     * ⚠️ TVARKA PAGAL `seq`, NE `timestamp`. `now()` vienoje transakcijoje
     * visoms eilutėms grąžina tą patį momentą, tad `ORDER BY timestamp` būtų
     * neapibrėžta. `seq` duoda tą pačią tvarką, kurią atmintyje duoda masyvo
     * indeksas.
     */
    async list({ limit = null, offset = 0, event = null, requestId = null } = {}) {
      const salygos = [];
      const reiksmes = [];

      if (event) {
        reiksmes.push(event);
        salygos.push(`event = $${reiksmes.length}`);
      }
      if (requestId) {
        reiksmes.push(requestId);
        salygos.push(`request_id = $${reiksmes.length}`);
      }

      const where = salygos.length ? `WHERE ${salygos.join(" AND ")}` : "";

      /**
       * `total` skaičiuojamas TA PAČIA užklausa (`COUNT(*) OVER ()`), o ne
       * antra: dvi atskiros užklausos be transakcijos gali matyti skirtingą
       * lentelės būseną, ir klientas gautų puslapį, neatitinkantį savo bendro
       * skaičiaus.
       */
      const ribos = [];
      if (limit !== null) {
        reiksmes.push(limit);
        ribos.push(`LIMIT $${reiksmes.length}`);
      }
      if (offset) {
        reiksmes.push(offset);
        ribos.push(`OFFSET $${reiksmes.length}`);
      }

      const { rows } = await pool.query(
        `SELECT ${STULPELIU_SARASAS}, meta, COUNT(*) OVER () AS _total
           FROM audit_log ${where}
          ORDER BY seq ASC ${ribos.join(" ")}`,
        reiksmes
      );

      /**
       * Tuščiam puslapiui lango funkcija eilučių negrąžina, tad `total` reikia
       * atskirai - bet TIK tada, kai puslapis tuščias. Dažniausiu atveju antros
       * užklausos nėra.
       */
      if (rows.length === 0) {
        const { rows: c } = await pool.query(
          `SELECT COUNT(*)::int AS total FROM audit_log ${where}`,
          reiksmes.slice(0, salygos.length)
        );
        return { entries: [], total: c[0].total };
      }

      return { entries: rows.map(iEilute), total: Number(rows[0]._total) };
    },

    /**
     * ⚠️ VIENINTELIS TRYNIMO KELIAS - APRIBOTAS SUBJEKTU.
     *
     * Bendro `delete`/`truncate` store'as NEEKSPONUOJA sąmoningai: append-only
     * garantiją DB lygiu užtikrina trigeris ant `UPDATE`, o `DELETE` lieka
     * neribotas, nes be jo GDPR ištrynimas būtų neįmanomas. Riba gyvena ČIA -
     * API lygmenyje. Žr. `docs/audit-storage.md`.
     */
    async removeBySubject(subjectId) {
      if (!subjectId) return 0;

      const { rowCount } = await pool.query("DELETE FROM audit_log WHERE subject_id = $1", [
        subjectId,
      ]);
      return rowCount;
    },

    /**
     * ⚠️ SKAIČIUOJAMA SQL PUSĖJE.
     *
     * Kvietėjui (`artefactScanner`) rūpi tik „ar yra". Atsiėmus visą žurnalą ir
     * ieškant Node'e, kiekviena artefaktų patikra perkeltų per tinklą visą
     * lentelę - o auditas yra būtent ta lentelė, kuri auga be ribos.
     */
    async countBySubject(subjectId) {
      if (!subjectId) return 0;

      const { rows } = await pool.query(
        "SELECT COUNT(*)::int AS kiekis FROM audit_log WHERE subject_id = $1",
        [subjectId]
      );
      return rows[0].kiekis;
    },

    /**
     * ⚠️ TIK TESTŲ VALYMUI. Produkciniame kelyje nekviečiama - `auditLog.clear()`
     * kvietėjai yra testai (žr. `docs/audit-storage.md`).
     */
    async clear() {
      await pool.query("DELETE FROM audit_log");
    },

    async probe() {
      await pool.query("SELECT 1");
      return true;
    },

    async close() {
      await pool.end();
    },
  };
}

module.exports = { createPostgresStore, iEilute };
