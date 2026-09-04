/**
 * `job_results` VIENTISUMO METADUOMENYS (#157, PR-1, 1 iš 2).
 *
 * ⚠️ KODĖL DVI MIGRACIJOS, O NE VIENA.
 *
 * Ši prideda KOLONAS, kita — praplečia leistinas `storage_type` reikšmes IR
 * sustiprina formos invariantą. Tvarka yra fail-closed: `fs` tampa teisėta
 * reikšme TIK tuo pačiu momentu, kai pradeda galioti pilna external forma.
 * Sujungus atvirkščiai (reikšmė anksčiau, forma vėliau) atsirastų langas, kuriame
 * DB priimtų `fs` eilutę BE `bytes`/`checksum` — t. y. tiksliai tą spragą, kurią
 * #157 ir uždaro.
 *
 * ⚠️ KOLONOS NULLABLE, IR TAI NE PRALEIDIMAS.
 *
 * `inline` eilutės vientisumo metaduomenų neturi ir neturės: jų turinys guli
 * `payload` stulpelyje, o jo vientisumą saugo pati DB. Privalomumas galioja TIK
 * external reprezentacijai, tad jis išreiškiamas `CHECK` sąlyga (kita migracija),
 * ne kolonos apibrėžimu. Taip pat elgiasi `payload` ir `storage_key`.
 *
 * ⚠️ `checksum` YRA `sha256(kanoninisRezultatas(result))`, NE OBJEKTO BAITŲ SUMA.
 *
 * Jis skaičiuojamas iš kanoninės eilutės PRIEŠ rašymą ir persistinamas kartu su
 * reference'u. Skaičiuojamas iš saugykloje gulinčių baitų tikrinimo metu, jis
 * įrodytų tik tai, kad objektas skaitomas — ne kad jis tas pats (#157 D3).
 * Dėl tos pačios priežasties jis NIEKADA neišvedamas iš `storage_key`.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns("job_results", {
    /** Objekto dydis baitais — hidratacijos riba tikrinama PRIEŠ turinio įkėlimą. */
    bytes: { type: "bigint" },
    /** `sha256` hex iš kanoninės eilutės. */
    checksum: { type: "text" },
  });

  /**
   * ⚠️ FORMOS SARGAS PAČIOMS REIKŠMĖMS.
   *
   * Be jo `checksum` galėtų būti bet kokia eilutė, o restore verifikacija lygintų
   * su šiukšlėmis ir vis tiek „praeitų". `bytes` neigiamas dydis irgi nėra
   * teisėta būsena.
   */
  pgm.addConstraint("job_results", "job_results_integrity_shape", {
    check: `
      (bytes IS NULL OR bytes >= 0)
      AND (checksum IS NULL OR checksum ~ '^[0-9a-f]{64}$')
    `,
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint("job_results", "job_results_integrity_shape");
  pgm.dropColumns("job_results", ["bytes", "checksum"]);
};
