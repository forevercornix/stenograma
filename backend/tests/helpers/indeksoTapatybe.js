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
            (SELECT array_agg(a.attname ORDER BY k.ord)
               FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
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
 */
async function kvalifikuotasVardas(vykdytojas, vardas) {
  const { rows } = await vykdytojas.query(
    "SELECT quote_ident(current_schema()) AS schema, quote_ident($1) AS objektas",
    [vardas]
  );
  return `${rows[0].schema}.${rows[0].objektas}`;
}

module.exports = { rastiIndeksa, kvalifikuotasVardas };
