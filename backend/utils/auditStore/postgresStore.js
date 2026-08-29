/**
 * AUDITO SAUGYKLA POSTGRESQL (#155, 7.4b / #211).
 *
 * ⚠️ TAS PATS STEBIMAS KONTRAKTAS KAIP `memoryStore`: tie patys metodai, tie
 * patys grąžinamų objektų raktai, ta pati `null`/`undefined` semantika. Bendras
 * parametrizuotas testų rinkinys tikrina abu, tad skirtumas negali atsirasti
 * tyliai.
 */

const { STULPELIAI, META_LAUKAI, isrinktiMeta } = require("./fields");

/**
 * PRIVILEGIJOS, BE KURIŲ AUDITAS NEVEIKIA (#155, 7.4f / #231).
 *
 * `DELETE` čia nėra perteklius: be jos `removeBySubjectIdentifier()` lūžtų
 * VYKDYMO metu, o visi sveikatos signalai liktų žali - GDPR ištrynimas kristų
 * tyliai, tiksliai tada, kai jo prireiktų.
 */
const BUTINOS_PRIVILEGIJOS = Object.freeze(["SELECT", "INSERT", "DELETE"]);

/**
 * SEKOS PRIVILEGIJOS - PAKANKA BET KURIOS (#231 Codex peržiūra, P1).
 *
 * ⚠️ `INSERT` ANT LENTELĖS NEPAKANKA. `seq BIGSERIAL` kiekvieno `append()` metu
 * kviečia `nextval()` ant atskiro sekos objekto, o sekos teisės suteikiamos
 * atskirai nuo lentelės. Rolė su atimta teise ant sekos zondą praeitų žalią, o
 * kiekvienas rašymas kristų vykdymo metu - tiksliai tas tylaus gedimo režimas,
 * dėl kurio privilegijų zondas apskritai daromas.
 *
 * `nextval()` reikalauja `USAGE` ARBA `UPDATE`, tad reikalauti vien `USAGE`
 * reikštų klaidingai raudoną zondą veikiančiam diegimui.
 */
const SEKOS_PRIVILEGIJOS = Object.freeze(["USAGE", "UPDATE"]);

/**
 * RETENCIJOS BATCH DYDIS - VIENAS AUTORITETAS (#155, 7.4d / #213).
 *
 * ⚠️ SKAIČIUS GYVENA ČIA, NE KODE IR TESTE ATSKIRAI. Ranka įrašytas dydis
 * dviejose vietose yra ta pati rankomis palaikomo sąrašo klasė, kurią 7.4f
 * pašalino kitur: testas praeitų su viena reikšme, o produkcija naudotų kitą.
 *
 * Dydis riboja VIENĄ `DELETE` kvietimą, ne visą sweep'ą - ilgą trynimą sweep'as
 * baigia keliais kvietimais. Prasmė - trumpos transakcijos ir trumpi užraktai,
 * o ne bendras šalinimo limitas.
 */
const RETENCIJOS_BATCH = 500;

/** Teigiamo zondo rezultato galiojimas. Orkestruotojo poll'ai kitaip generuotų SQL kiekvienam. */
const PROBE_CACHE_TTL_MS = 2000;

/**
 * KIEK ILGAI SINGLE-FLIGHT PAŽADAS DAR GALI BŪTI DALINAMAS (#233 Codex raundas 2, #3).
 *
 * ⚠️ BE RIBOS SINGLE-FLIGHT VIRSTA UŽRAKTU. Kai `READINESS_TIMEOUT_MS`
 * trumpesnis už pool'o `query_timeout`, maršrutas nutrūksta, o kabanti užklausa
 * lieka. Kiekvienas kitas poll'as gaudavo TĄ PATĮ pažadą, tad atsistačiusios
 * DB readiness nepamatydavo, kol sena užklausa pagaliau baigsis - galimai
 * dešimtimis sekundžių vėliau. Tai atvirkščias tikslas nei tas, dėl kurio
 * single-flight ir daromas.
 *
 * Numatytoji reikšmė sutampa su `READINESS_TIMEOUT_MS` numatytąja: kol maršrutas
 * dar laukia, dalintis prasminga; kai jis jau pasidavė, įrašas nebegalioja pagal
 * konstrukciją. Tikslią biudžeto reikšmę perduoda `init()`.
 */
const PROBE_SINGLE_FLIGHT_MAX_MS = 2000;

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

  /**
   * ⚠️ ANTRA GYNYBOS LINIJA: NEPALAIKOMA FORMA NORMALIZUOJAMA, NE METAMA.
   *
   * Schema reikalauja `jsonb_typeof(meta) = 'object'`, bet ta patikra galioja
   * tik naujoms eilutėms. DB, migruota anksčiau, arba eilutė, įrašyta prieš
   * constraint'ą, gali turėti skaliarą - ir `laukas in meta` tada mestų
   * `TypeError`, paverčiantį visą audito puslapį 500 klaida.
   *
   * Skaitymas yra netinkama vieta kristi: viena bloga eilutė neturi padaryti
   * neperskaitomo viso žurnalo.
   */
  const svarusMeta = row.meta !== null && typeof row.meta === "object" && !Array.isArray(row.meta)
    ? row.meta
    : {};

  for (const laukas of META_LAUKAI) {
    eilute[laukas] = laukas in svarusMeta ? svarusMeta[laukas] : null;
  }

  return eilute;
}

function createPostgresStore(pool, { hashKeyId, readinessBudgetMs }) {
  /**
   * Readiness biudžetas ateina iš `init(env)` - to paties `READINESS_TIMEOUT_MS`,
   * kurį naudoja maršrutas. Antra reikšmė čia reikštų dvi konfigūracijos tiesas.
   */
  const singleFlightMaxMs =
    Number(readinessBudgetMs) > 0 ? Number(readinessBudgetMs) : PROBE_SINGLE_FLIGHT_MAX_MS;

  /** Zondo būsena - VIENAM store'ui, ne moduliui: du pool'ai neturi dalintis kešu. */
  let kesas = null;
  let vykstantisZondas = null;

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
     * KEYSET PUSLAPIS: `seq DESC`, filtrai VIENOJE užklausoje.
     *
     * ⚠️ `seq`, NE `timestamp`. `now()` vienoje transakcijoje visoms eilutėms
     * grąžina tą patį momentą, tad `timestamp` kursoriui netiktų. `seq` unikalus
     * ir monotoniškas - laužtuko nereikia (7.4b tvarkos autoritetas, #212).
     *
     * ⚠️ `subject_id = ANY($n)` - VIENAS set-based predikatas, ne po užklausą
     * kiekvienai raktų generacijai. Kandidatus apskaičiuoja `keyRing`, o jų aibę
     * apibrėžia DB esančios generacijos.
     *
     * ⚠️ JOKIO `OFFSET`. `limit + 1` peržvalga pasako, ar yra kitas puslapis, tad
     * tuščio paskutinio puslapio nebūna, o lygiagretūs INSERT'ai eilučių
     * nepraleidžia ir nedubliuoja: riba yra `seq`, ne pozicija.
     */
    async queryPage({
      limit = 100,
      afterSeq = null,
      action = null,
      requestId = null,
      from = null,
      to = null,
      subjectIds = null,
    } = {}) {
      const salygos = [];
      const reiksmes = [];

      const pridėti = (sablonas, reiksme) => {
        reiksmes.push(reiksme);
        salygos.push(sablonas.replace("$n", `$${reiksmes.length}`));
      };

      if (action) pridėti("event = $n", action);
      if (requestId) pridėti("request_id = $n", requestId);
      if (from) pridėti('"timestamp" >= $n', from);
      if (to) pridėti('"timestamp" <= $n', to);
      if (subjectIds) pridėti("subject_id = ANY($n)", subjectIds);
      if (afterSeq !== null) pridėti("seq < $n", afterSeq);

      reiksmes.push(limit + 1);
      const limitPlaceholder = `$${reiksmes.length}`;

      const where = salygos.length ? `WHERE ${salygos.join(" AND ")}` : "";

      const { rows } = await pool.query(
        `SELECT ${STULPELIU_SARASAS}, meta, seq
           FROM audit_log ${where}
          ORDER BY seq DESC
          LIMIT ${limitPlaceholder}`,
        reiksmes
      );

      const yraDaugiau = rows.length > limit;
      const grazinami = yraDaugiau ? rows.slice(0, limit) : rows;

      return {
        entries: grazinami.map(iEilute),
        nextAfterSeq: yraDaugiau ? Number(grazinami[grazinami.length - 1].seq) : null,
      };
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
      /**
       * ⚠️ PRIIMA IR MASYVĄ - VIENAS `DELETE`, NE PO UŽKLAUSĄ GENERACIJAI (#212).
       *
       * Rotavus raktą tas pats job'as turi skirtingą `subject_id` kiekvienoje
       * generacijoje. Ištrynimas privalo pasiekti visas; N atskirų `DELETE` būtų
       * ir lėta, ir neatomiška - dalis generacijų galėtų likti.
       *
       * Vieno ID forma išlaikoma, kad 7.4b paritetų rinkinys liktų nepakeistas.
       */
      const sarasas = (Array.isArray(subjectId) ? subjectId : [subjectId]).filter(Boolean);
      if (sarasas.length === 0) return 0;

      const { rowCount } = await pool.query("DELETE FROM audit_log WHERE subject_id = ANY($1)", [
        sarasas,
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
     * RETENCIJOS RIBA IŠ **DB LAIKRODŽIO** (#233 Codex, P1).
     *
     * ⚠️ TRYNIMO RIBA PRIVALO ATEITI IŠ TO PATIES LAIKRODŽIO KAIP RAŠYMO ŽYMA.
     *
     * `timestamp` sąmoningai rašomas DB `now()`, nes replikų laikrodžiai
     * skiriasi (7.4b sprendimas; dėl to ir 7.4c atsisakė `timestamp` kaip sort
     * key). Skaičiuojant ribą Node procese, skubantis vienos replikos laikrodis
     * NEGRĮŽTAMAI ištrintų eilutes, kurioms `AUDIT_RETENTION_DAYS` dar nesuėjo,
     * o lėtas paliktų pasenusias. Dvi replikos tuo pačiu metu naudotų skirtingas
     * ribas.
     *
     * Skaičiuojama VIENĄ kartą per sweep'ą; `now` argumentas čia sąmoningai
     * ignoruojamas - persistentiniame režime kontroliuojamas laiko šaltinis yra
     * DB, ne kvietėjas.
     */
    async retencijosRiba(dienos) {
      const skaicius = Number(dienos);

      if (!Number.isFinite(skaicius) || skaicius <= 0) {
        throw new Error(`Retencijos terminas privalo būti teigiamas (gauta: ${dienos}).`);
      }

      const { rows } = await pool.query(
        "SELECT (now() - ($1 || ' days')::interval) AS riba",
        [String(skaicius)]
      );

      return new Date(rows[0].riba).toISOString();
    },

    /**
     * RETENCIJA: VIENAS RIBOTAS BATCH'AS (#155, 7.4d / #213).
     *
     * ⚠️ KANDIDATAI ATRENKAMI DB PUSĖJE. Parsisiųsti expired eilutes į Node ir
     * trinti po vieną reikštų O(n) round-trip'ų ir nekontroliuojamą trukmę.
     * `DELETE` neturi paprasto `LIMIT`, tad riba taikoma kandidatų CTE.
     *
     * ⚠️ `FOR UPDATE SKIP LOCKED` - MULTI-INSTANCE KOREKTIŠKUMAS. Dvi instancijos
     * gali sweep'inti tą pačią lentelę vienu metu. Be `SKIP LOCKED` antroji
     * lauktų pirmosios užrakintų eilučių arba susidurtų deadlock'e; su juo ji
     * tiesiog praleidžia užimtas eilutes ir paima kitas. Rezultatas
     * idempotentiškas: jau ištrinta eilutė nebeatrenkama.
     *
     * ⚠️ `timestamp < $1` - riba GRIEŽTA. `== cutoff` LIEKA (fiksuotas #213
     * sprendimas). Indeksas `timestamp` sukurtas 7.4b migracijoje.
     *
     * @returns {Promise<number>} kiek eilučių pašalinta ŠIUO kvietimu.
     */
    async purgeExpired(cutoffIso, limit = RETENCIJOS_BATCH) {
      const riba = Number(limit);

      if (!Number.isInteger(riba) || riba < 1) {
        throw new Error(`Retencijos batch dydis privalo būti teigiamas sveikasis (gauta: ${limit}).`);
      }

      const { rowCount } = await pool.query(
        `WITH kandidatai AS (
           SELECT id FROM audit_log
            WHERE timestamp < $1
            ORDER BY seq
            LIMIT $2
            FOR UPDATE SKIP LOCKED
         )
         DELETE FROM audit_log a USING kandidatai k WHERE a.id = k.id`,
        [cutoffIso, riba]
      );

      return rowCount;
    },

    /**
     * `PRIVACY_MODE` STARTO VALYMAS (#155, 7.4d / #213).
     *
     * ⚠️ ATSKIRAS METODAS, NE `clear()` SU IŠIMTIMI. `clear()` yra testų
     * įrankis, kuris produkcijoje SĄMONINGAI meta klaidą (žr. žemiau). Privacy
     * valymas yra teisėtas produkcinis kelias, bet tik VIENAS: jį kviečia
     * `auditStore.init()` starto metu ir daugiau niekas.
     *
     * Atskiras vardas išlaiko 7.4b ribą: bendro `DELETE FROM audit_log`
     * primityvo produkcinis kvietėjas negauna - jis gauna tris tikslinius kelius
     * (erasure, retencija, privacy purge), kurių kiekvieno prasmė matoma iš
     * pavadinimo.
     *
     * ⚠️ BATCH'INAMA, KAIP IR RETENCIJA (#233 Codex, P2).
     *
     * Vienas neribotas `DELETE FROM audit_log` perrašo kiekvieną eilutę ir
     * indekso įrašą viename sakinyje, o tam pačiam pool'ui galioja audito
     * `statement_timeout` (~1,1 s). Ant išaugusios lentelės - ypač per pirmą
     * atnaujinimą iš anksčiau neribotos saugyklos - KIEKVIENAS `PRIVACY_MODE`
     * startas baigtųsi timeout'u dar prieš readiness. Ironiška būtų batch'inti
     * retenciją ir palikti nebatch'intą purge, kuris dirba su didesniu kiekiu.
     *
     * ⚠️ `FOR UPDATE` BE `SKIP LOCKED` - SKIRTUMAS NUO RETENCIJOS, IR SĄMONINGAS.
     *
     * Retencijai praleisti užrakintą eilutę saugu: ją pašalins kitas ciklas.
     * Privacy purge tokios antros progos neturi - jis privalo išvalyti VISKĄ
     * prieš instancijai pradedant aptarnauti srautą, tad geriau palaukti
     * konkuruojančios transakcijos nei palikti eilutę.
     *
     * Ciklas baigiasi, kai partija pašalina 0 eilučių.
     *
     * @returns {Promise<number>} pašalintų eilučių skaičius.
     */
    async purgeAllForPrivacy(limit = RETENCIJOS_BATCH) {
      let viso = 0;

      for (;;) {
        const { rowCount } = await pool.query(
          `WITH kandidatai AS (
             SELECT id FROM audit_log LIMIT $1 FOR UPDATE
           )
           DELETE FROM audit_log a USING kandidatai k WHERE a.id = k.id`,
          [limit]
        );

        viso += rowCount;
        if (rowCount === 0) return viso;
      }
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

    /**
     * Generacijos (`hash_key_id`), FAKTIŠKAI esančios lentelėje.
     *
     * ⚠️ LOOSE INDEX SCAN, NE `SELECT DISTINCT` (#212).
     *
     * `DISTINCT` kas startą būtų pilnas augančios lentelės skenavimas. Rekursyvus
     * CTE šokinėja per 7.4b `hash_key_id` indeksą: viena eilutė kiekvienai
     * generacijai, ne viena kiekvienam įrašui. Naujos lentelės nekuriama.
     *
     * ⚠️ Iš ŠIO vieno skenavimo išvedamos ABI starto taisyklės - ir našlaitės
     * generacijos, ir kiekio riba. Antros užklausos nereikia.
     */
    async usedGenerations() {
      const { rows } = await pool.query(
        `WITH RECURSIVE gen AS (
           (SELECT hash_key_id FROM audit_log ORDER BY hash_key_id LIMIT 1)
           UNION ALL
           SELECT (SELECT a.hash_key_id
                     FROM audit_log a
                    WHERE a.hash_key_id > g.hash_key_id
                    ORDER BY a.hash_key_id
                    LIMIT 1)
             FROM gen g
            WHERE g.hash_key_id IS NOT NULL
         )
         SELECT hash_key_id FROM gen WHERE hash_key_id IS NOT NULL`
      );

      return rows.map((r) => r.hash_key_id);
    },

    /**
     * READINESS ZONDAS: TIKRINA TEISES, NE VIEN RYŠĮ (#155, 7.4f / #231).
     *
     * ⚠️ `SELECT 1` ĮRODO TIK TIEK, KAD JUNGTIS GYVA. Rolė su atimta `DELETE`
     * teise jį praeitų, o GDPR ištrynimas kristų. Tas pats galioja `SELECT 1
     * FROM audit_log LIMIT 1`: jis įrodo skaitymą, bet ne rašymą.
     *
     * ⚠️ ZONDAS NEMUTUOJA. Teisės tikrinamos per `has_table_privilege()`
     * katalogo funkciją, ne bandomuoju įrašu: readiness kviečiamas kiekvieno
     * orkestruotojo probe metu, ir bandomasis `INSERT`/`DELETE` reikštų nuolatinį
     * audito lentelės šiukšlinimą bei WAL srautą dėl diagnostikos. Append-only
     * trigeris tokių eilučių dar ir neleistų ištrinti be pėdsako.
     *
     * VIENAS round-trip:
     *   - `FROM audit_log LIMIT 1` - lentelė egzistuoja ir realiai skenuojama
     *     (be `SELECT` teisės - `permission denied`, be lentelės - `does not
     *     exist`; abu virsta klaida, kurią sprendžia kvietėjas);
     *   - `has_table_privilege(...)` - teisės, kurių reikia rašymui ir trynimui.
     *
     * Šablonas tas pats kaip `sessionStore/postgresStore.js` - antra realizacija
     * išsiskirtų tyliai.
     */
    async probe() {
      /**
       * ⚠️ KEŠUOJAMAS TIK TEIGIAMAS REZULTATAS.
       *
       * Neigiamo kešuoti negalima: atsistačiusi DB turi būti pastebėta per kitą
       * poll'ą, ne po TTL. Bet be jokios apsaugos krentanti DB gautų užklausą
       * kiekvienam poll'ui - tas pats apkrovos kelias, kurio kešas ir vengia,
       * tik blogiausiu momentu.
       *
       * Sprendimas - SINGLE-FLIGHT, ne trumpas neigiamas TTL: vykstant zondui
       * visi kiti kvietėjai gauna TĄ PATĮ promise'ą. Tai apriboja lygiagrečias
       * užklausas iki VIENOS nepriklausomai nuo poll'ų dažnio, ir, skirtingai
       * nei neigiamas TTL, atsistatymo aptikimo NEATIDEDA nė milisekunde.
       */
      const dabar = Date.now();

      if (kesas && kesas.rezultatas === true && dabar - kesas.laikas < PROBE_CACHE_TTL_MS) {
        return true;
      }

      /**
       * ⚠️ DALINAMASI TIK NEPASENUSIU ĮRAŠU. Senesnis už readiness biudžetą
       * reiškia užklausą, kurios atsakymo niekas nebelaukia - naujas poll'as
       * privalo pradėti savo, kitaip atsistatymas lieka nematomas.
       */
      if (vykstantisZondas && dabar - vykstantisZondas.pradzia < singleFlightMaxMs) {
        return vykstantisZondas.pazadas;
      }

      const irasas = { pradzia: dabar, pazadas: null };

      irasas.pazadas = (async () => {
        const stulpeliai = BUTINOS_PRIVILEGIJOS.map(
          (p, i) => `has_table_privilege('audit_log', $${i + 1}) AS "${p.toLowerCase()}"`
        ).join(", ");

        /**
         * ⚠️ SEKA RANDAMA PER KATALOGĄ, NE PAGAL VARDĄ. `pg_get_serial_sequence`
         * grąžina faktinį objektą (`audit_log_seq_seq` yra numatytoji forma, bet
         * ne garantija). `NULL` reiškia, kad stulpelis nebeturi sekos - schema
         * ne ta, kurios laukiam, tad fail-closed.
         *
         * Abu iškvietimai nemutuojantys: tai katalogo funkcijos, ne `nextval()`.
         */
        const { rows } = await pool.query(
          `WITH skaitymas AS (SELECT 1 FROM audit_log LIMIT 1),
                seka AS (SELECT pg_get_serial_sequence('audit_log', 'seq') AS vardas)
           SELECT (SELECT count(*) FROM skaitymas)::int AS perskaityta,
                  COALESCE(
                    (SELECT has_sequence_privilege(vardas, 'USAGE')
                         OR has_sequence_privilege(vardas, 'UPDATE')
                       FROM seka WHERE vardas IS NOT NULL),
                    false
                  ) AS seka_leidziama,
                  ${stulpeliai}`,
          [...BUTINOS_PRIVILEGIJOS]
        );

        const eilute = rows[0];

        return (
          BUTINOS_PRIVILEGIJOS.every((p) => eilute[p.toLowerCase()] === true) &&
          eilute.seka_leidziama === true
        );
      })();

      vykstantisZondas = irasas;

      try {
        const rezultatas = await irasas.pazadas;

        /**
         * ⚠️ KEŠĄ PILDO TIK TUO METU REGISTRUOTAS ZONDAS (#233 Codex raundas 3, #1).
         *
         * Šią spragą įnešė pats single-flight senaties taisymas. Scenarijus:
         * zondas A pasensta, poll'as paleidžia zondą B, B grąžina „trūksta
         * teisių" (`false`), ir tada A PAVĖLUOTAI baigiasi su senu `true` bei
         * įrašo jį į kešą. Readiness dvi sekundes rodo žalią - be jokios
         * užklausos ir su atimtomis teisėmis.
         *
         * Tai tiksliai tas tylaus gedimo režimas, dėl kurio privilegijų zondas
         * apskritai daromas, tik dabar per savo paties kešą.
         *
         * Pasenusio įrašo rezultatas ATMETAMAS, o ne kešuojamas, ir kvietėjui
         * grąžinamas `false`: atsakymas, kurio niekas nebelaukia, yra per senas,
         * kad juo remtųsi readiness. Fail-closed - kitas poll'as tiesiog
         * paklaus iš naujo.
         */
        if (vykstantisZondas !== irasas) return false;

        /** Kešuojam tik `true` - žr. paaiškinimą aukščiau. */
        kesas = rezultatas === true ? { rezultatas, laikas: Date.now() } : null;
        return rezultatas;
      } finally {
        /**
         * ⚠️ TIK SAVO ĮRAŠĄ. Pavėluotai pasibaigusi sena užklausa kitaip
         * nutrintų naujesnę, ir kitas poll'as be reikalo pradėtų trečią.
         */
        if (vykstantisZondas === irasas) vykstantisZondas = null;
      }
    },

    /** ⚠️ Tik testams: leidžia įrodyti, kad kešas realiai baigia galioti. */
    _resetProbeCacheForTests() {
      kesas = null;
      vykstantisZondas = null;
    },

    async close() {
      await pool.end();
    },
  };
}

module.exports = {
  createPostgresStore,
  iEilute,
  RETENCIJOS_BATCH,
  BUTINOS_PRIVILEGIJOS,
  SEKOS_PRIVILEGIJOS,
  PROBE_CACHE_TTL_MS,
  PROBE_SINGLE_FLIGHT_MAX_MS,
};
