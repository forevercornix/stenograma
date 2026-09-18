/**
 * DIEGIMO TAPATYBĖ: `deployment_identity` (#155, 7.6c / #250).
 *
 * ⚠️ KODĖL VIETOS NEPAKANKA.
 *
 * Ištrynimo žurnalo (7.6c) importas privalo atsakyti į klausimą „ar šis žurnalas
 * IŠ ŠIO diegimo". Natūralus kandidatas — `host:port/database` — yra VIETA, ne
 * tapatybė: DR pagal apibrėžimą atkuria į kitą vietą, tad vietos palyginimas
 * kristų KIEKVIENOJE tikroje avarijoje. Sargas, kurio apėjimas yra normalus
 * kelias, nustoja būti sargu ir tampa ceremonija: operatorius, patvirtinantis
 * nesutapimą kas kartą, patvirtins ir svetimą žurnalą.
 *
 * ⚠️ SPRENDIMAS REMIASI TUO, KAD IDENTIFIKATORIUS KELIAUJA SU DUMP'U.
 *
 * `pg_dump` neša visas eilutes, tad po atkūrimo tikslinėje bazėje guli ŠALTINIO
 * diegimo identifikatorius. Vadinasi:
 *
 *   · tikra DR (kitas hostas, tie patys duomenys) - sutampa, praeina TYLIAI;
 *   · svetimas žurnalas - nesutampa, krenta GARSIAI.
 *
 * ⚠️ KLONAS PAVELDI TAPATYBĘ SĄMONINGAI. Staging, atkurtas iš produkcijos
 * dump'o, gauna produkcijos identifikatorių - ir tai teisinga: produkcijos
 * žurnalas jam tinka, nes ten guli tie patys `job_id`.
 *
 * ⚠️ `gen_random_uuid()` BE `pgcrypto`: PostgreSQL 13+ turi jį įtaisytą, o CI
 * naudoja 16 (`.github/workflows/ci.yml` - `postgresql-client-16`).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable("deployment_identity", {
    /**
     * VIENA eilutė — ta pati forma kaip `backup_horizon`. Dvi tapatybės reikštų,
     * kad skaitytojas turi rinktis, o rinkimasis čia yra klaida.
     */
    id: { type: "boolean", primaryKey: true, default: true, notNull: true },
    deployment_id: { type: "uuid", notNull: true, default: pgm.func("gen_random_uuid()") },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("deployment_identity", "deployment_identity_single_row", {
    check: "id",
  });

  /**
   * ⚠️ EILUTĖ SUKURIAMA MIGRACIJOS METU, NE PIRMO SKAITYMO.
   *
   * Lazy sukūrimas reikštų, kad tapatybė gimsta PO restore - t. y. atkurta bazė
   * gautų naują ID ir savo pačios žurnalą laikytų svetimu. Migracija tai daro
   * vieną kartą, dar prieš pirmą kopiją.
   */
  pgm.sql("INSERT INTO deployment_identity (id) VALUES (true) ON CONFLICT (id) DO NOTHING");
};

exports.down = (pgm) => {
  pgm.dropTable("deployment_identity");
};
