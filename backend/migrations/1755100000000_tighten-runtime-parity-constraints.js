/**
 * DB ↔ RUNTIME AIBIŲ SUGRIEŽTINIMAS (#155, 7.2a follow-up).
 *
 * ⚠️ ATSKIRA MIGRACIJA, NE `1755000000000` REDAGAVIMAS.
 *
 * `node-pg-migrate` praleidžia failą pagal VARDĄ (`pgmigrations` lentelė), tad
 * jau migruotoje DB pakeistas senas failas NEBŪTŲ pritaikytas. Švarios DB
 * testai praeitų, o egzistuojančios liktų su laisvesne schema - tyliai, nes
 * antras `migrate:up` teisėtai yra no-op (`migrations.integration.test.js`).
 *
 * Keičiami du dalykai:
 *
 * 1. `schema_version` aibė `{NULL, 1, 2}` → `{NULL, 2}`.
 *    `assertSupportedSchemaVersion()` (`jobAuthorization.js:65`) atmeta
 *    KIEKVIENĄ ne-`null` reikšmę, kuri nėra `2` - įskaitant `1`. Constraint'as,
 *    priimantis `1`, tik perkeldavo gedimą iš atkūrimo į vykdymą: restore
 *    praneštų SĖKMĘ, o job'as niekada nepasileistų.
 *
 * 2. Nauja uždara `type` aibė. `assertConsistentJobRecord()` tipą tikrina TIK
 *    `processing` eilutėse (`jobPhase.js:161`), tad `queued` ar terminalus
 *    įrašas su `type: "bogus"` praeidavo iki pirmos gyvavimo ciklo operacijos,
 *    kuri mestų `UNKNOWN_JOB_TYPE`.
 *
 * ⚠️ EILUTĖS, KURIŲ NAUJI CONSTRAINT'AI NEPRIIMTŲ.
 *
 * `ALTER TABLE ... ADD CONSTRAINT` numatytai VALIDUOJA esamas eilutes, tad
 * migracija kristų, jei DB jau turėtų `schema_version = 1` ar nežinomą tipą.
 * Tai SĄMONINGA: tylus tokių eilučių palikimas (`NOT VALID`) reikštų, kad
 * constraint'as galioja tik naujiems įrašams, o seni liktų nepaleidžiami ir
 * nepastebimi. Kritimas su aiškiu pranešimu yra teisingas elgesys - operatorius
 * turi nuspręsti, ką su jomis daryti.
 *
 * Praktikoje tokių eilučių būti neturėtų: `newJob()` visada nustato `2`, o
 * PostgreSQL dar neaktyvuotas (aktyvavimo barjeras), tad produkcinių `jobs`
 * eilučių dar nėra.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.dropConstraint("jobs", "jobs_schema_version_supported");
  pgm.addConstraint("jobs", "jobs_schema_version_supported", {
    check: "schema_version IS NULL OR schema_version = 2",
  });

  pgm.addConstraint("jobs", "jobs_type_values", {
    check: "type IN ('transcription', 'protocol')",
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint("jobs", "jobs_type_values");

  pgm.dropConstraint("jobs", "jobs_schema_version_supported");
  pgm.addConstraint("jobs", "jobs_schema_version_supported", {
    check: "schema_version IS NULL OR schema_version IN (1, 2)",
  });
};
