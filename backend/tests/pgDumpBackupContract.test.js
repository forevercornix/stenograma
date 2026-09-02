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
 * ⚠️ SĄMONINGAI NEPASIEKIAMA. Fail-closed patikros privalo kristi PRIEŠ bet kokį
 * prisijungimą; jei testas kada nors kris su prisijungimo klaida, tai reikš, kad
 * tvarka pasikeitė ir patikra nukeliavo po `psql`.
 */
const NEPASIEKIAMA_DB = "postgres://nera:nera@127.0.0.1:1/nera";

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

test("#248: `pg_dump` argumentai NELAUŽO nuoseklaus snapshot'o", () => {
  /**
   * ⚠️ NUOSEKLUS SNAPSHOT'AS YRA PRIELAIDA, KURIA REMIASI ATKŪRIMO TESTAS.
   *
   * `pg_dump` visą kopiją ima vienu `REPEATABLE READ` snapshot'u, tad `jobs` ir
   * susiję `job_results` negali būti paimti iš skirtingų loginių momentų.
   * `pgDumpBackup.integration` tuo REMIASI: jis tikrina, kad atkurtoje bazėje
   * nėra `job_results` be `jobs` ir atvirkščiai.
   *
   * ⚠️ VIENA NETYČIA PRIDĖTA VĖLIAVA TĄ GARANTIJĄ PANAIKINTŲ TYLIAI —
   * `--no-synchronized-snapshots` ar `--jobs` neduotų klaidos, tik nenuoseklią
   * kopiją. Todėl argumentų sąrašas yra eksportuojamas ir tikrinamas.
   *
   * Statinė forma čia tinkama (§9.2): klausimas yra „ar sąraše nėra draudžiamos
   * vėliavos", ne „ką `pg_dump` daro".
   */
  const argumentai = pgDumpBackup.PG_DUMP_ARGUMENTAI("postgres://x/y");

  for (const veliava of pgDumpBackup.SNAPSHOTA_LAUZANCIOS_VELIAVOS) {
    assert.equal(
      argumentai.some((a) => a === veliava || String(a).startsWith(`${veliava}=`)),
      false,
      `⚠️ \`${veliava}\` sulaužytų nuoseklų snapshot'ą, kuriuo remiasi atkūrimo testas`
    );
  }

  /** Auditas neimamas - ta pati 7.4d taisyklė, kurią aprašo runbook'as. */
  assert.ok(
    argumentai.includes("--exclude-table-data=audit_log"),
    "`audit_log` privalo likti neimamas"
  );
});

/* ══════════════════════════════════════════════════════════════════════════
 * KRIPTOGRAFINIS RATAS BE DUOMENŲ BAZĖS
 * ══════════════════════════════════════════════════════════════════════════ */

const backupEncryption = require("../utils/backupEncryption");
const backupManifest = require("../utils/backupManifest");

/** Artefaktas, identiškas tam, kurį gamina `sukurtiSifruotaKopija()`. */
function artefaktas(sql, env) {
  const plaintext = `${pgDumpBackup.ANTRASTE}\n${pgDumpBackup.ANTRASTES_VERSIJA}\n${pgDumpBackup.DUMP_FORMATAS}\n\n${sql}`;
  const checksum = crypto.createHash("sha256").update(plaintext, "utf8").digest("hex");

  const manifest = backupManifest.createManifest({ contents: [], checksum, env });
  manifest.encrypted = true;
  manifest.encryptionAlgorithm = `${backupEncryption.ALGORITHM}-${backupEncryption.FORMAT}`;
  manifest.snapshotTime = new Date().toISOString();
  manifest.excludedInFlightJobs = 0;

  return { plaintext, manifest, envelope: backupEncryption.encrypt(plaintext, { env, manifest }) };
}

test("#248 ⚠️ šifravimo ratas ir antraštė tikrinami BE duomenų bazės", () => {
  /**
   * ⚠️ ŠIS TESTAS ATSIRADO IŠ CI RADINIO, IR JO NEBUVIMAS BUVO KLAIDA.
   *
   * `decrypt()` grąžina `{ plaintext: Buffer, usedPreviousKey }`, NE eilutę.
   * Pirmoji `atkurtiSifruotaKopija()` redakcija reikšmę naudojo tiesiogiai, ir
   * `createHash().update()` gaudavo objektą. Vietinis rinkinys to nepagavo,
   * nes VISAS kriptografinis ratas buvo pasiekiamas tik per integracinį testą su
   * tikra DB.
   *
   * Bet ratui duomenų bazės NEREIKIA: šifravimas, dešifravimas, kontrolinė suma
   * ir antraštės perskaitymas yra grynas darbas su baitais. Palikus jį už NOT RUN
   * ribos, trys svarbiausios patikros liko be vietinio įrodymo be jokios
   * priežasties.
   */
  const env = { ...process.env, BACKUP_ENCRYPTION_KEY: backupEncryption.generateKey() };
  const { plaintext, manifest, envelope } = artefaktas("CREATE TABLE t (id int);", env);

  const { plaintext: grazintas } = backupEncryption.decrypt(envelope, { env, manifest });
  assert.ok(Buffer.isBuffer(grazintas), "⚠️ `decrypt()` grąžina Buffer - kontraktas, ne detalė");
  assert.equal(grazintas.toString("utf8"), plaintext, "ratas grąžina tą patį turinį");

  const suma = crypto.createHash("sha256").update(grazintas.toString("utf8"), "utf8").digest("hex");
  assert.equal(suma, manifest.checksum, "kontrolinė suma skaičiuojama nuo TO PATIES atvaizdo");
});

test("#248 ⚠️ sugadintas ciphertext ir blogas raktas krinta BE duomenų bazės", () => {
  /**
   * ⚠️ MF/ME MUTACIJOS DABAR PAGAUNAMOS VIETOJE.
   *
   * Anksčiau kontrolinės sumos ir rūšies antraštės patikros buvo tikrinamos tik
   * per `psql` kelią, tad jų mutacijos vietoje nekrisdavo. Tai buvo per plati
   * NOT RUN riba: patikros yra apie BAITUS, ne apie duomenų bazę.
   */
  const env = { ...process.env, BACKUP_ENCRYPTION_KEY: backupEncryption.generateKey() };
  const { manifest, envelope } = artefaktas("SELECT 1;", env);

  /** Sugadintas ciphertext - GCM žyma nebesutampa. */
  const sugadintas = { ...envelope };
  const b = Buffer.from(sugadintas.ciphertext, "base64");
  b[Math.floor(b.length / 2)] ^= 0xff;
  sugadintas.ciphertext = b.toString("base64");
  assert.throws(() => backupEncryption.decrypt(sugadintas, { env, manifest }));

  /** Blogas raktas. */
  const kitasEnv = { ...process.env, BACKUP_ENCRYPTION_KEY: backupEncryption.generateKey() };
  assert.throws(() => backupEncryption.decrypt(envelope, { env: kitasEnv, manifest }));

  /** Suklastotas AAD laukas. */
  assert.throws(() =>
    backupEncryption.decrypt(envelope, {
      env,
      manifest: { ...manifest, snapshotTime: new Date(0).toISOString() },
    })
  );
});

test("#248 ⚠️ svetimas artefaktas atmetamas dėl RŪŠIES, be duomenų bazės", async () => {
  /**
   * ⚠️ RŪŠIES ANTRAŠTĖ YRA D1 SPRENDIMO ŠERDIS, ir jos mutacija (ME) iki šiol
   * vietoje nekrisdavo.
   *
   * Aplikacijos JSON kopija yra TEISĖTAS artefaktas su galiojančiu manifestu ir
   * galiojančia GCM žyma — nuo dump'o ją skiria TIK antraštė šifruotame
   * turinyje. Be tos patikros JSON būtų paduotas tiesiai į `psql`.
   *
   * ⚠️ `targetUrl` nurodomas, bet DB nepasiekiama IR NETURI BŪTI: patikra krinta
   * PRIEŠ bet kokį prisijungimą. Jei kada nors kris su prisijungimo klaida, tai
   * reikš, kad tvarka pasikeitė.
   */
  const env = { ...process.env, BACKUP_ENCRYPTION_KEY: backupEncryption.generateKey() };

  const plaintext = JSON.stringify({ jobs: [], sessions: [] });
  const checksum = crypto.createHash("sha256").update(plaintext, "utf8").digest("hex");
  const manifest = backupManifest.createManifest({ contents: [], checksum, env });
  manifest.encrypted = true;
  manifest.encryptionAlgorithm = `${backupEncryption.ALGORITHM}-${backupEncryption.FORMAT}`;
  manifest.snapshotTime = new Date().toISOString();
  manifest.excludedInFlightJobs = 0;

  const envelope = backupEncryption.encrypt(plaintext, { env, manifest });

  await assert.rejects(
    () =>
      pgDumpBackup.atkurtiSifruotaKopija({
        envelope,
        manifest,
        targetUrl: NEPASIEKIAMA_DB,
        env,
      }),
    (err) => {
      assert.equal(
        err.code,
        "PG_DUMP_HEADER_MISSING",
        `⚠️ privalo kristi dėl RŪŠIES, ne dėl prisijungimo. Gauta: ${err.code}`
      );
      return true;
    }
  );
});

test("#248 ⚠️ TEISINGOS FORMOS, bet SVETIMOS rūšies artefaktas atmetamas", async () => {
  /**
   * ⚠️ ATSKIRAS ATVEJIS NUO „NĖRA ANTRAŠTĖS" (mutacija ME).
   *
   * Aplikacijos JSON neturi `\n\n`, tad jis krinta jau ties
   * `PG_DUMP_HEADER_MISSING` ir RŪŠIES patikros nepasiekia. Pirmoji šio failo
   * redakcija to nepastebėjo: ME mutacija (rūšies palyginimo išjungimas)
   * nekrisdavo, nors testas atrodė ją dengiantis.
   *
   * Todėl čia artefaktas turi TEISINGĄ formą — antraštės bloką ir `\n\n` — bet
   * svetimą rūšies eilutę. Tokį galėtų pagaminti kita to paties formato
   * procedūra.
   */
  const env = { ...process.env, BACKUP_ENCRYPTION_KEY: backupEncryption.generateKey() };

  const plaintext = `KITA-SISTEMA-DUMP\n${pgDumpBackup.ANTRASTES_VERSIJA}\n${pgDumpBackup.DUMP_FORMATAS}\n\nSELECT 1;`;
  const checksum = crypto.createHash("sha256").update(plaintext, "utf8").digest("hex");
  const manifest = backupManifest.createManifest({ contents: [], checksum, env });
  manifest.encrypted = true;
  manifest.encryptionAlgorithm = `${backupEncryption.ALGORITHM}-${backupEncryption.FORMAT}`;
  manifest.snapshotTime = new Date().toISOString();
  manifest.excludedInFlightJobs = 0;

  const envelope = backupEncryption.encrypt(plaintext, { env, manifest });

  await assert.rejects(
    () => pgDumpBackup.atkurtiSifruotaKopija({ envelope, manifest, targetUrl: NEPASIEKIAMA_DB, env }),
    (err) => {
      assert.equal(err.code, "PG_DUMP_KIND_MISMATCH", `gauta: ${err.code}`);
      return true;
    }
  );
});

test("#248 ⚠️ nesutampanti kontrolinė suma krinta PRIEŠ prisijungimą", async () => {
  /**
   * ⚠️ MUTACIJA MF IKI ŠIOL VIETOJE NEKRISDAVO.
   *
   * Kontrolinės sumos palyginimas yra darbas su baitais — duomenų bazės jam
   * nereikia. Palikus jį tik integraciniame teste, patikra liko be vietinio
   * įrodymo be jokios priežasties.
   *
   * ⚠️ `targetUrl` nurodo NEPASIEKIAMĄ bazę sąmoningai: jei kada nors kris su
   * prisijungimo klaida, tai reikš, kad patikra nukeliavo PO `psql`, ir
   * fail-closed tvarka lūžo.
   */
  const env = { ...process.env, BACKUP_ENCRYPTION_KEY: backupEncryption.generateKey() };
  const { manifest, envelope } = artefaktas("SELECT 1;", env);

  await assert.rejects(
    () =>
      pgDumpBackup.atkurtiSifruotaKopija({
        envelope,
        manifest: { ...manifest, checksum: "0".repeat(64) },
        targetUrl: NEPASIEKIAMA_DB,
        env,
      }),
    (err) => {
      assert.equal(err.code, "BACKUP_CHECKSUM_MISMATCH", `gauta: ${err.code}`);
      return true;
    }
  );
});
