/**
 * `job_results` EXTERNAL FORMOS INVARIANTAS (#157, PR-1, 2 iš 2).
 *
 * ⚠️ KĄ TAISO.
 *
 * Pradinė migracija (`1755000000000`) paliko dvi spragas, ir abi yra pasiekiamos
 * ESAMU kodu:
 *
 *   1. `storage_type IN ('inline','s3')` — `FsArtifactStore` reference apskritai
 *      neįsirašytų, tad `fs` tektų reprezentuoti per `s3`, t. y. meluoti schemoje;
 *   2. `ELSE storage_key IS NOT NULL` — external eilutė su LIKUSIU `payload` yra
 *      teisėta. Tai ne teorija: `upsertResult()` (`postgresStore.js:739-745`) daro
 *      `ON CONFLICT (job_id) DO UPDATE SET payload = EXCLUDED.payload` ir
 *      `storage_type`/`storage_key` NELIEČIA — būtent tokią hibridinę eilutę jis
 *      sugeneruotų pirmu inline rašymu ant external eilutės.
 *
 * ⚠️ SENA MIGRACIJA NEREDAGUOJAMA (#157 riba). Invariantas pakeičiamas nauju
 * `DROP` + `ADD`, tad jau pritaikytos DB gauna jį atnaujinimo keliu.
 *
 * ⚠️ REIKŠMĖ IR FORMA KEIČIAMOS KARTU. `fs` tampa teisėta TIK kartu su pilna
 * external forma — kitaip liktų langas, kuriame DB priimtų `fs` be vientisumo
 * metaduomenų.
 */

exports.shorthands = undefined;

/**
 * ⚠️ PREFLIGHT: MIGRACIJA KRENTA, O NE „PATAISO".
 *
 * Jei DB jau turi eilutę, pažeidžiančią naują formą (schema ją leido), tylus
 * `UPDATE ... SET payload = NULL` sunaikintų vienintelę rezultato kopiją —
 * duomenų praradimas be operatoriaus sprendimo. Todėl radus tokias eilutes
 * migracija sustoja su tiksliu jų sąrašu.
 */
exports.up = (pgm) => {
  pgm.sql(`
    DO $$
    DECLARE
      pazeidzia bigint;
    BEGIN
      SELECT count(*) INTO pazeidzia
        FROM job_results
       WHERE storage_type <> 'inline'
         AND (storage_key IS NULL OR payload IS NOT NULL
              OR bytes IS NULL OR checksum IS NULL);

      IF pazeidzia > 0 THEN
        RAISE EXCEPTION
          'job_results turi % eilutes(-ių), pažeidžiančias naują external formą. '
          'Migracija sustabdyta: automatinis taisymas galėtų sunaikinti vienintelę '
          'rezultato kopiją. Peržiūrėkite: SELECT job_id, storage_type, storage_key IS NULL AS be_rakto, '
          'payload IS NOT NULL AS su_payload, bytes IS NULL AS be_dydzio, checksum IS NULL AS be_sumos '
          'FROM job_results WHERE storage_type <> ''inline'';', pazeidzia;
      END IF;
    END $$;
  `);

  pgm.dropConstraint("job_results", "job_results_storage_type_values");
  pgm.addConstraint("job_results", "job_results_storage_type_values", {
    check: "storage_type IN ('inline', 'fs', 's3')",
  });

  /**
   * `inline` reikalauja turinio, išorinė saugykla — rakto IR vientisumo
   * metaduomenų. Be pastarųjų restore verifikacija neturėtų ko palyginti
   * (#157 D3), tad jie yra DB invariantas, ne aplikacijos susitarimas.
   */
  pgm.dropConstraint("job_results", "job_results_storage_shape");
  pgm.addConstraint("job_results", "job_results_storage_shape", {
    check: `
      CASE storage_type
        WHEN 'inline' THEN payload IS NOT NULL AND storage_key IS NULL
        ELSE storage_key IS NOT NULL
             AND payload IS NULL
             AND bytes IS NOT NULL
             AND checksum IS NOT NULL
      END
    `,
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint("job_results", "job_results_storage_shape");
  pgm.addConstraint("job_results", "job_results_storage_shape", {
    check: `
      CASE storage_type
        WHEN 'inline' THEN payload IS NOT NULL AND storage_key IS NULL
        ELSE storage_key IS NOT NULL
      END
    `,
  });

  pgm.dropConstraint("job_results", "job_results_storage_type_values");
  pgm.addConstraint("job_results", "job_results_storage_type_values", {
    check: "storage_type IN ('inline', 's3')",
  });
};
