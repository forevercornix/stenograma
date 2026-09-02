const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const pgDumpBackup = require("../utils/pgDumpBackup");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const SAKNIS = path.resolve(__dirname, "..");

/**
 * 7.6a KONTRAKTAS BE PostgreSQL (#155, #248).
 *
 * ⚠️ KĄ ŠIS FAILAS ĮRODO IR KO NE.
 *
 * Įrodo: dydžio ribą, rūšies antraštės fail-closed elgesį ir tai, kad
 * operatoriaus kelias neturi savo orkestracijos.
 *
 * NEĮRODO: `pg_dump`/`psql` elgesio, atkūrimo atomiškumo ar to, kad kopija
 * realiai atkuriama — visa tai reikalauja tikros DB ir gyvena
 * `pgDumpBackup.integration`, kuris vietinėje aplinkoje NEVYKDOMAS.
 */

test("#248 D2: operatoriaus kelias NETURI savo orkestracijos", () => {
  /**
   * ⚠️ DVI REALIZACIJOS YRA BLOGIAU NEI VIENA BLOGA.
   *
   * D2 reikalauja VIENO kelio, kurį naudoja ir operatorius, ir testas. Jei CLI
   * imtų kviesti `pg_dump`/`psql` pats, dokumentuota procedūra ir testuojama
   * procedūra imtų skirtis — ir integracinis testas įrodinėtų nebe tai, ką
   * vykdo operatorius.
   *
   * ⚠️ STATINĖ PATIKRA ČIA YRA TINKAMA FORMA (§9.2): klausimas yra „ar nėra
   * antros realizacijos", ne „ką ji daro". Elgesį tikrina integracinis testas.
   */
  const cli = fs
    .readFileSync(path.join(SAKNIS, "scripts", "pg-backup.mjs"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  for (const draudziama of ["pg_dump", "psql", "spawn", "execFile", "createCipheriv"]) {
    assert.equal(
      cli.includes(draudziama),
      false,
      `CLI negali turėti \`${draudziama}\` - orkestracija gyvena utils/pgDumpBackup.js`
    );
  }

  assert.match(cli, /pgDumpBackup/, "CLI privalo kviesti bendrą modulį");
});

test("#248 D6: dydžio riba yra ĮVARDYTA ir tikrinama PRIEŠ šifravimą", () => {
  /**
   * ⚠️ RIBA TIKRA, IR JI ŽEMESNĖ UŽ NOMINALIAS 2 GB.
   *
   * `backupEncryption.MAX_CIPHERTEXT_BYTES` yra 2 GB, bet envelope laukai yra
   * BASE64 EILUTĖS ATMINTYJE, o V8 eilutės ilgis ribotas (~512 MB). Base64
   * pailgina 4/3, tad ~512 MB eilutė atitinka ~384 MB ciphertext'o — ir tai dar
   * prieš `JSON.stringify`, kuris envelope padvigubina.
   *
   * ⚠️ 7.6a SRAUTINIO ŠIFRAVIMO NEĮVEDA. Riba yra ŽINOMA RIBA, ne sprendimas.
   */
  const backupEncryption = require("../utils/backupEncryption");

  assert.ok(
    pgDumpBackup.MAX_DUMP_BYTES < backupEncryption.MAX_CIPHERTEXT_BYTES,
    "7.6a riba privalo būti ŽEMESNĖ už nominalią ciphertext lubą"
  );
  assert.ok(pgDumpBackup.MAX_DUMP_BYTES > 0);

  /** Riba paminėta runbook'e - kitaip dokumentas teigtų daugiau, nei kodas gali. */
  const runbook = fs.readFileSync(path.join(SAKNIS, "..", "docs", "backup-runbook.md"), "utf8");
  assert.match(runbook, /MAX_DUMP_BYTES|256 MB/, "dydžio riba privalo būti runbook'e");
});

test("#248 D1: rūšies antraštė yra ŠIFRUOJAMAME turinyje, ne manifeste", () => {
  /**
   * ⚠️ KODĖL NE `ARTEFACT_TYPES` (D1 variantas „a").
   *
   * Registras maitina GDPR ištrynimo inventorių: `isIncluded()` išvedamas iš
   * `persistence`, tad persistentinis tipas automatiškai patektų ir į
   * aplikacijos JSON kopiją; o pažymėtas `EXCLUDED_DESPITE_PERSISTENT` jis
   * priverstų `createManifest()` savo paties `contents` įrašą ATMESTI.
   * Variantas prieštarauja pats sau.
   *
   * Šis testas gina pasirinkimą: registras NELIEČIAMAS.
   */
  const backupPolicy = require("../utils/backupPolicy");
  const { ARTEFACT_TYPES } = require("../utils/artefactInventory");

  const tipai = Object.values(ARTEFACT_TYPES).map((t) => t.id || t);
  assert.equal(
    tipai.some((t) => String(t).toLowerCase().includes("dump")),
    false,
    "⚠️ DB dump'as NEGALI atsirasti ARTEFACT_TYPES - tai ištrynimo inventorius"
  );
  assert.equal(
    backupPolicy.isIncluded("postgres-dump"),
    false,
    "nežinomas tipas politikos nepraeina - manifestas jo ir neturi"
  );

  /** Antraštė yra modulio kontraktas, ne atsitiktinė eilutė. */
  assert.equal(pgDumpBackup.ANTRASTE, "STENOGRAMA-PG-DUMP");
  assert.equal(pgDumpBackup.DUMP_FORMATAS, "plain");
});

test("#248: manifestas dump'ui turi TUŠČIĄ `contents`", () => {
  /**
   * ⚠️ TUŠČIAS `contents` YRA SPRENDIMAS, NE PRALEIDIMAS.
   *
   * DB dump'as nėra aplikacijos artefaktų inventorius. Bet koks įrašas ten
   * privalėtų praeiti `backupPolicy.isIncluded()` (`backupManifest.js:82`), o
   * DB dump'as jo netenkina; melagingas įrašas būtų blogesnis už tuščią.
   */
  const backupManifest = require("../utils/backupManifest");
  const checksum = crypto.createHash("sha256").update("x").digest("hex");

  const manifest = backupManifest.createManifest({ contents: [], checksum });
  assert.deepEqual(manifest.contents, []);
  assert.equal(backupManifest.validateManifest({ ...manifest, encrypted: true }).valid, true);

  /** O melagingas įrašas atmetamas - tai ir yra priežastis, kodėl `contents` tuščias. */
  assert.throws(
    () => backupManifest.createManifest({ contents: [{ type: "postgres-dump", count: 1, bytes: 1 }], checksum }),
    /politika neleidžia/
  );
});
