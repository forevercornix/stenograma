/**
 * BANDYMŲ REGISTRAS — ORPHAN'AS TAMPA MATOMAS DB KRYPTIMI (#157, PR-4).
 *
 * ⚠️ KODĖL ŠI LENTELĖ APSKRITAI EGZISTUOJA.
 *
 * Su attempt-unique raktu (`results/<jobId>/<attemptId>.json`) kiekvienas kritęs
 * bandymas palieka UNIKALIAI pavadintą objektą, o procesas, kritęs tarp `put()` ir
 * cleanup, palieka objektą, kurio nerodo nė viena `job_results` eilutė. Erasure eina
 * per `job_results.storage_key`: nuorodos nėra, tad nėra ko trinti — o objekte guli
 * transkripcija. Tai nebe šiukšlė, o BDAR klausimas.
 *
 * Registras tą klasę pašalina KONSTRUKCIŠKAI: `attemptId` įrašomas PRIEŠ `put()`,
 * tad kiekvienas objektas, kurį parašė mūsų kodas, turi savininką ir adresą DB
 * pusėje. „Objektas yra, DB nerodo" nustoja egzistuoti, ir `list(prefix)` tampa
 * nereikalingas ne dėl susitarimo, o dėl konstrukcijos (A3 riba lieka nepakeista).
 *
 * ⚠️ FK Į `jobs` NĖRA — TA PATI PRIEŽASTIS KAIP `erasure_marks`.
 *
 * `ON DELETE CASCADE` pašalintų eilutę BŪTENT tuo momentu, kai ji reikalinga:
 * registro paskirtis — atsakyti, KURIUOS objektus reikia pašalinti trinant job'ą, ir
 * likti įrodymu, jei trynimas nutrūko po `jobs` eilutės pašalinimo. Kaina: eilutė gali
 * nurodyti neegzistuojantį `job_id`, ir tai TEISINGA būsena, ne našlaitė.
 *
 * ⚠️ `job_id` YRA `text`, NE `uuid` — tas pats nukrypimas ir ta pati priežastis kaip
 * `erasure_marks`: registras aktyvus visuose diegimuose, o ne tik ten, kur `jobStore`
 * yra PostgreSQL, tad ID forma `uuid` negarantuota.
 *
 * ⚠️ ASMENS DUOMENŲ ČIA NĖRA. Saugomas objekto ADRESAS ir jo būsena; nei turinio, nei
 * savininko. Lentelė pergyvena job'ą, tad plikas `ownerId` joje taptų asmens duomenimis
 * lentelėje, kurios paskirtis — įrodyti, kad asmens duomenys pašalinti.
 */

/**
 * ⚠️ AIBĖ UŽŠALDYTA SĄMONINGAI — NEIMPORTUOJAMA.
 *
 * Ta pati priežastis kaip `erasure_marks`: migracija yra ISTORIJOS ĮRAŠAS. Importavus
 * konstantą, šviežia DB gautų naują constraint'ą, o atnaujinta liktų su senu — abi
 * startuotų, bet priimtų SKIRTINGAS aibes.
 */
const BUSENOS_FROZEN = ["pending", "committed", "abandoned"];
const SAUGYKLOS_FROZEN = ["fs", "s3"];

const sarasas = (reiksmes) => reiksmes.map((r) => `'${r}'`).join(", ");

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable("job_result_attempts", {
    /** Objekto vardo dalis: `results/<job_id>/<attempt_id>.json`. */
    attempt_id: { type: "uuid", primaryKey: true },
    job_id: { type: "text", notNull: true },
    storage_type: { type: "text", notNull: true },
    /** Pilnas raktas — kad valymui nereikėtų jo ATSTATINĖTI iš dalių. */
    storage_key: { type: "text", notNull: true },
    /**
     * ⚠️ BŪSENA YRA VIENINTELIS SKIRTUMAS TARP „GALIMA TRINTI" IR „NAUDOJAMAS".
     *
     * `pending`   — registruota prieš `put()`; objektas gali egzistuoti arba ne;
     * `committed` — nuoroda įsipareigota `job_results` eilutėje;
     * `abandoned` — bandymas pralaimėjo arba buvo remontuotas; objektas šalintinas.
     */
    busena: { type: "text", notNull: true, default: "pending" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("job_result_attempts", "job_result_attempts_busena_allowed", {
    check: `busena IN (${sarasas(BUSENOS_FROZEN)})`,
  });

  /**
   * ⚠️ `inline` ČIA NEGALIMAS, IR TAI NE PRALEIDIMAS.
   *
   * Registras egzistuoja IŠORINIAMS objektams: inline rezultatas gyvena toje pačioje
   * eilutėje ir dingsta kartu su ja, tad registruoti nėra ko. Leidus `inline`,
   * atsirastų eilutės, kurių valymas neturi ką daryti, o „ar yra ką trinti" nustotų
   * būti atsakomas pagal pačią lentelę.
   */
  pgm.addConstraint("job_result_attempts", "job_result_attempts_storage_type_values", {
    check: `storage_type IN (${sarasas(SAUGYKLOS_FROZEN)})`,
  });

  /**
   * Valymo kelias klausia „kurie šio job'o bandymai dar neišvalyti" — tad indeksas
   * yra pagal `job_id`, o ne pagal `attempt_id` (jis jau pirminis raktas).
   */
  pgm.createIndex("job_result_attempts", "job_id");

  /**
   * ⚠️ RETENCIJOS SKENAVIMAS EINA PAGAL BŪSENĄ IR AMŽIŲ.
   *
   * Dalinis indeksas: `committed` eilutės valymo kelio nedomina, o jų dauguma.
   */
  pgm.createIndex("job_result_attempts", ["busena", "created_at"], {
    name: "job_result_attempts_valytini",
    where: "busena <> 'committed'",
  });
};

exports.down = (pgm) => {
  pgm.dropTable("job_result_attempts");
};
