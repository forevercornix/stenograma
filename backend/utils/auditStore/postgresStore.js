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
     * `id` generuoja aplikacija būtent todėl, kad pakartojimas būtų įmanomas be
     * dublikato.
     *
     * ⚠️ RIBA, KURIĄ BŪTINA ĮVARDYTI (AGENTS.md §12.1): tai SAUGYKLOS lygio
     * savybė, o ne end-to-end garantija. `auditLog.record()` kiekvieno kvietimo
     * metu generuoja NAUJĄ `randomUUID()`, o `rasytiAudita()` pakartojimo kilpos
     * neturi - tad šiandien produkcinis kelias šios šakos NEPASIEKIA. Ji
     * egzistuoja būsimam pakartojimo mechanizmui (patvari eilė, [7.5b]), kuris
     * per pakartojimo ribą privalės nešti STABILŲ `id`. Iki tol teigti
     * „pakartotas rašymas nesukuria antros eilutės" apie visą sistemą būtų
     * stipriau, nei kodas daro.
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

      /**
       * ⚠️ PUSLAPIS IR BENDRAS KIEKIS - VIENAME MOMENTINIAME VAIZDE.
       *
       * Ankstesnė versija tuščiam puslapiui darė ATSKIRĄ `COUNT(*)` užklausą.
       * Auditas rašomas nuolat ir lygiagrečiai, tad tarp dviejų užklausų galėjo
       * atsirasti atitinkantis įrašas, ir atsakymas grąžindavo `entries: []` su
       * `total: 1` net esant `offset: 0` - klientas matytų prieštaringą puslapį.
       *
       * CTE išsprendžia tai be transakcijos: `kiekis` visada duoda VIENĄ eilutę,
       * o `LEFT JOIN LATERAL` prie jos prikabina puslapį. Kai puslapis tuščias,
       * lieka ta viena eilutė su `NULL` stulpeliais - tad `total` gaunamas net
       * tada, kai eilučių nėra.
       */
      const { rows } = await pool.query(
        `WITH filtruoti AS (
           SELECT ${STULPELIU_SARASAS}, meta, seq FROM audit_log ${where}
         ),
         kiekis AS (SELECT COUNT(*)::int AS total FROM filtruoti)
         SELECT k.total, f.*
           FROM kiekis k
           LEFT JOIN LATERAL (
             SELECT * FROM filtruoti ORDER BY seq ASC ${ribos.join(" ")}
           ) f ON true`,
        reiksmes
      );

      const total = rows.length ? Number(rows[0].total) : 0;

      /** `f.*` esant tuščiam puslapiui duoda `NULL` - tokia eilutė nėra įrašas. */
      const entries = rows.filter((r) => r.id !== null).map(iEilute);

      return { entries, total };
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
     * ⚠️ NEPRIEINAMA PRODUKCINIAM KODUI - TAI NĖRA VIEN KOMENTARAS.
     *
     * Deklaruota vientisumo riba sako, kad store'as eksponuoja TIK subjektu
     * apribotą trynimą. Bet `clear()` vykdo neribotą `DELETE FROM audit_log`, o
     * `auditLog.clear()` jį persiunčia - tad atsitiktinis produkcinis kvietėjas
     * ištrintų VISĄ persistentinį audito pėdsaką, nepaisant dokumentuoto
     * apribojimo.
     *
     * Todėl riba tampa vykdoma: už testų ribų metama klaida. Šiandien
     * produkcinių `auditLog.clear()` kvietėjų nėra (patikrinta), tad tai nieko
     * nelaužo - bet ateities kvietėjas kris iškart, o ne ištrins žurnalą.
     */
    async clear() {
      if (process.env.NODE_ENV !== "test") {
        throw new Error(
          "auditStore.clear() persistentiniame režime leidžiamas TIK testuose: " +
            "neribotas `DELETE FROM audit_log` sunaikintų visą audito pėdsaką. " +
            "GDPR ištrynimui naudokite `removeBySubjectIdentifier()`."
        );
      }
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
