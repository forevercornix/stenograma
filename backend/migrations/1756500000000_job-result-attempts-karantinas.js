/**
 * KARANTINO ŽYMA BANDYMŲ REGISTRE (#157, PR-5).
 *
 * ⚠️ KODĖL JOS REIKIA. Šlavėjo verdiktas `pazeidimas` (rastas IR laikinas, IR galutinis
 * objektas tuo pačiu raktu) su attempt-unique raktais yra NEĮMANOMAS, tad jis yra
 * vienintelis signalas, jei kada nors pasikeis rakto schema. Be žymos kiekvienas ciklas
 * aptiktų tą patį objektą iš naujo ir vėl rašytų `log.error`: per savaitę tai triukšmas
 * apie vieną failą, o triukšmas virsta ignoravimu — ir signalas praranda paskirtį.
 *
 * ⚠️ ŽYMA TURI PABAIGĄ, IR TAI SĄLYGOS DALIS. Karantinas be išėjimo būtų ta pati forma
 * kaip 4b `pending` fail-closed: tyliai kaupiasi. Todėl:
 *   - eilutė NEBEŠLUOJAMA (kandidatų predikatas ją praleidžia), tad veiksmas nekartojamas;
 *   - bet ji SKAIČIUOJAMA kiekvienoje retencijos suvestinėje, kol egzistuoja;
 *   - operatorius ją uždaro pašalindamas eilutę arba nunulindamas `karantinas_nuo`, kai
 *     objektas ištirtas.
 *
 * ⚠️ NAUJAS STULPELIS, NE NAUJA `busena` REIKŠMĖ. `busena` aibė užšaldyta migracijoje
 * `1756300000000` ir atspindi bandymo GYVAVIMO CIKLĄ; karantinas yra ORTOGONALUS faktas
 * apie saugyklą, ir sulieti juos reikštų, kad karantinuota eilutė praranda informaciją,
 * ar ji buvo `pending`, ar `abandoned`.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn("job_result_attempts", {
    karantinas_nuo: { type: "timestamptz" },
  });

  /** Suvestinei reikia rasti karantinuotas eilutes pigiai; jų turi būti vienetai. */
  pgm.createIndex("job_result_attempts", "karantinas_nuo", {
    name: "job_result_attempts_karantinas",
    where: "karantinas_nuo IS NOT NULL",
  });
};

exports.down = (pgm) => {
  pgm.dropIndex("job_result_attempts", "karantinas_nuo", { name: "job_result_attempts_karantinas" });
  pgm.dropColumn("job_result_attempts", "karantinas_nuo");
};
