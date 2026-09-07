/**
 * DAUGIAUSIA VIENAS ĮSIPAREIGOTAS BANDYMAS — DB INVARIANTAS (#157, PR-4).
 *
 * ⚠️ KODĖL ATSKIRA MIGRACIJA, O NE TAISYMAS `1756300000000` VIETOJE.
 *
 * Migracija yra istorijos įrašas. Šaka jau paleista lokaliai ir CI, tad redagavus
 * ankstesnę, jau migruota bazė indekso NEGAUTŲ, o šviežia gautų — dvi bazės,
 * praeinančios tuos pačius testus, turėtų SKIRTINGAS garantijas.
 *
 * ⚠️ KODĖL INVARIANTAS PERKELIAMAS Į DB, NORS `isipareigoti()` JAU JĮ LAIKO.
 *
 * Spragą „du įsipareigoti bandymai" rado testas (du lygiagretūs remontai), ne
 * konstrukcija; ji buvo uždaryta `f1d7cba` taikant taisyklę modulyje. Testas įrodo
 * nebuvimą tik ten, kur nuėjo. Šlavėjas (PR-5) trins objektus PAGAL REGISTRĄ ir
 * rems būtent šia prielaida: du `committed` bandymai reikštų arba naudojamo objekto
 * ištrynimą, arba nebenaudojamo palikimą — abu blogi ir abu tylūs.
 *
 * Tai tas pats precedentas kaip PR-1: vientisumo metaduomenys ten tapo DB
 * invariantu, ne susitarimu tarp kvietėjų.
 *
 * ⚠️ INDEKSAS DALINIS, IR TODĖL NEATIDEDAMAS.
 *
 * PostgreSQL `UNIQUE ... DEFERRABLE` reikalauja CONSTRAINT'o, o constraint'as negali
 * būti dalinis. Vadinasi, unikalumas tikrinamas KIEKVIENAM sakiniui, ir perėjimas
 * „naujas tampa committed, senas — abandoned" NEGALI vykti vienu `CASE` sakiniu:
 * eilučių atnaujinimo tvarka viename sakinyje neapibrėžta, tad pažeidimas kiltų
 * atsitiktinai. Todėl `attemptRegistry.isipareigoti()` skaido perėjimą į DU sakinius
 * (pirma nuvertinimas, tada įsipareigojimas) TOJE PAČIOJE transakcijoje.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createIndex("job_result_attempts", "job_id", {
    name: "job_result_attempts_vienas_isipareigotas",
    unique: true,
    where: "busena = 'committed'",
  });
};

exports.down = (pgm) => {
  pgm.dropIndex("job_result_attempts", "job_id", {
    name: "job_result_attempts_vienas_isipareigotas",
  });
};
