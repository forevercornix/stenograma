/**
 * INDEKSO TAPATYBĖ TESTUOSE — VIENA PAIEŠKA, NE KETURIOS KOPIJOS (#376 Codex P2 #2).
 *
 * ⚠️ VARDAS NĖRA TAPATYBĖ. `relname` PostgreSQL kataloge unikalus tik SCHEMOS
 * ribose. Paieška vien pagal jį ras indeksą bet kurioje `search_path` schemoje ir
 * ant bet kurios lentelės — tad testas, tvirtinantis „indeksas yra", gali tvirtinti
 * apie visai kitą objektą nei tas, kurį stato migracija.
 *
 * ⚠️ KODĖL TAI SVARBU BŪTENT TESTUOSE. Trys tvirtinimai (`migrations.integration`,
 * `postgresStore.integration`, `registryErasure`) būtent tuo ir remiasi: jie sako
 * „invariantas galioja". Neteisingai kvalifikuota paieška paverstų juos žaliais
 * bazėje, kurioje invarianto nėra — sargu, kuris negali kristi.
 *
 * ⚠️ KODĖL HELPER'IS, O NE PATAISYTOS KETURIOS KOPIJOS. Keturios to paties
 * klausimo realizacijos šioje sekoje išsiskyrė ne kartą; čia jos dar ir turėtų
 * sutapti su produkcine `jobStore/index.js` patikra, kuri naudoja tą patį
 * `current_schema()` filtrą.
 */

/**
 * Grąžina indekso įrašą TIK jei jis toje pačioje schemoje ir ant nurodytos lentelės.
 *
 * @param {{query: Function}} vykdytojas pool arba klientas
 * @param {string} vardas indekso vardas
 * @param {string} lentele lentelė, ant kurios jis privalo būti
 * @returns {Promise<{indisvalid: boolean, indisunique: boolean, stulpeliai: string[]}|null>}
 */
async function rastiIndeksa(vykdytojas, vardas, lentele) {
  const { rows } = await vykdytojas.query(
    `SELECT i.indisvalid,
            i.indisunique,
            (SELECT array_agg(pg_get_indexdef(i.indexrelid, k.ord::int, true) ORDER BY k.ord)
               FROM generate_series(1, i.indnkeyatts) AS k(ord)
            ) AS stulpeliai
       FROM pg_index i
       JOIN pg_class ic    ON ic.oid = i.indexrelid
       JOIN pg_class t     ON t.oid  = i.indrelid
       JOIN pg_namespace n ON n.oid  = ic.relnamespace
      WHERE ic.relname = $1
        AND t.relname  = $2
        AND n.nspname  = current_schema()`,
    [vardas, lentele]
  );

  return rows[0] || null;
}

/**
 * ⚠️ `DROP`/`CREATE` PRIVALO TAIKYTI TĄ PATĮ OBJEKTĄ, KURĮ TIKRINA `rastiIndeksa()`.
 *
 * Nekvalifikuotas `DROP INDEX x` taikosi pagal `search_path`, o patikra — pagal
 * `current_schema()`. Kol schema viena, jie sutampa; kai `search_path` turi daugiau
 * nei vieną, testas pašalintų vieną objektą, o tikrintų kitą — ir izoliacija dingtų
 * TYLIAI, nes abi operacijos „pavyktų".
 *
 * ⚠️ SCHEMA IMAMA IŠ SERVERIO, NE SPĖJAMA. `current_schema()` užklausiamas ir
 * įterpiamas per `quote_ident`, tad veikia ir su schema, kurios vardas reikalauja
 * kabučių. Prielaidos „testo DB turi vieną schemą" čia NĖRA — ji būtų dar viena
 * neužrašyta sąlyga, o būtent tokias šis PR ir šalina.
 *
 * ⚠️ KVALIFIKUOJAMAS TIK `DROP`, NE `CREATE` — IR TAI NE PASIRINKIMAS.
 *
 * PostgreSQL `CREATE INDEX` schemos prefikso indekso varde NEPRIIMA: indeksas
 * visada kuriamas TOJE schemoje, kurioje yra lentelė. `CREATE UNIQUE INDEX
 * public.x ON t (...)` duoda `syntax error at or near "."`. Išmatuota CI
 * (run 35567237647): 11 kritimų būtent dėl to.
 *
 * Todėl simetrija čia klaidinga, o ne patogi: `DROP` taikinį reikia kvalifikuoti,
 * nes jis ieško pagal `search_path`; `CREATE` jo kvalifikuoti NEGALIMA, nes jis
 * paveldi lentelės schemą. Kvalifikuojama LENTELĖ, ne indeksas.
 */
async function kvalifikuotasVardas(vykdytojas, vardas) {
  const { rows } = await vykdytojas.query(
    "SELECT quote_ident(current_schema()) AS schema, quote_ident($1) AS objektas",
    [vardas]
  );
  return `${rows[0].schema}.${rows[0].objektas}`;
}

/**
 * Schema plius lentelė — `CREATE INDEX ... ON <čia>` taikiniui.
 *
 * ⚠️ Būtent lentelės kvalifikacija ir nulemia, kurioje schemoje atsiras indeksas,
 * tad ji yra vienintelis būdas `CREATE` pusėje taikyti tą patį objektą, kurį
 * `DROP` pusėje nurodo kvalifikuotas indekso vardas.
 */
async function kvalifikuotaLentele(vykdytojas, lentele) {
  return kvalifikuotasVardas(vykdytojas, lentele);
}

module.exports = { rastiIndeksa, kvalifikuotasVardas, kvalifikuotaLentele };
