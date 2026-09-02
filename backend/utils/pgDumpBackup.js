const crypto = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");

const backupEncryption = require("./backupEncryption");
const backupManifest = require("./backupManifest");
const { createLogger } = require("./logger");

const vykdyti = promisify(execFile);
const log = createLogger("pg-dump-backup");

/**
 * ŠIFRUOTA PostgreSQL KOPIJA IR JOS ATKŪRIMAS (#155, 7.6a / #248).
 *
 * ⚠️ VIENAS KELIAS OPERATORIUI IR TESTUI (D2).
 *
 * Visa orkestracija — `pg_dump`, manifesto sudarymas, AES-256-GCM šifravimas,
 * patikros prieš atkūrimą ir `psql` iškvietimas — gyvena ČIA. `scripts/pg-backup.mjs`
 * yra plonas apvalkalas, o integracinis testas kviečia tas pačias funkcijas.
 *
 * Testas, kuris pats sudėliotų `pg_dump` → šifravimas → `psql`, tikrintų savo
 * imitaciją, ne procedūrą, kurią vykdo operatorius (§9.2).
 *
 * ⚠️ ARTEFAKTO RŪŠIS GYVENA ŠIFRUOTAME TURINYJE, NE MANIFESTE (D1).
 *
 * Svarstyti trys variantai:
 *
 *   (a) naujas kanoninis `ARTEFACT_TYPES` tipas — ATMESTA. Registras maitina
 *       GDPR ištrynimo inventorių, ne kopijų politiką. `isIncluded()` išvedamas
 *       iš `persistence`, tad persistentinis tipas AUTOMATIŠKAI patektų ir į
 *       aplikacijos JSON kopiją, kur jo semantika netinka; pažymėjus jį
 *       `EXCLUDED_DESPITE_PERSISTENT`, `isIncluded()` grąžintų `false`, o
 *       `createManifest()` tokį `contents` įrašą ATMESTŲ (`backupManifest.js:82`) —
 *       t. y. variantas prieštarauja pats sau. Be to `artefactScanner` reikalauja
 *       skenavimo strategijos KIEKVIENAM registro tipui (gina
 *       `lifecycleE2E.test.js`), o DB dump'as nėra susietas su subjektu, tad
 *       tokios strategijos prasmingai parašyti nėra kaip.
 *
 *   (b) atskira ašis — PASIRINKTA. `ARTEFACT_TYPES` neliečiamas, ištrynimo
 *       inventorius nepajudinamas, `isIncluded()` nekeičiamas. Manifestas
 *       naudojamas toks, koks yra, su TUŠČIU `contents`: DB dump'as nėra
 *       aplikacijos artefaktų inventorius, ir melagingas įrašas ten būtų
 *       blogesnis už tuščią.
 *
 *   (c) naujas manifesto laukas — ATMESTA kaip nepakankamas. Laukas, kurio nėra
 *       `AUTHENTICATED_MANIFEST_FIELDS` sąraše, nėra apsaugotas GCM žyma, o to
 *       sąrašo keitimas reikštų v2 AAD formato keitimą, kurio šis darbas
 *       nedaro.
 *
 * Todėl rūšis ir dump'o formatas rašomi į PATĮ ŠIFRUOJAMĄ TURINĮ — GCM juos
 * autentifikuoja kartu su SQL, ir jokio AAD ar kriptografijos keitimo nereikia.
 */

/** Antraštė, kurią GCM autentifikuoja kartu su SQL. */
const ANTRASTE = "STENOGRAMA-PG-DUMP";
const ANTRASTES_VERSIJA = "v1";

/**
 * ⚠️ `plain` FORMATAS PASIRINKTAS DĖL D4 (atomiškumo).
 *
 * `psql --single-transaction` visą atkūrimą vykdo vienoje transakcijoje: SQL
 * klaida viduryje reiškia `ROLLBACK`, ne pusiau atkurtą bazę. `custom` formatas
 * su `pg_restore` tokios garantijos be papildomų prielaidų neduoda.
 */
const DUMP_FORMATAS = "plain";

class PgDumpBackupError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "PgDumpBackupError";
    this.code = code;
  }
}

/** Ar `pg_dump`/`psql` apskritai pasiekiami? Grąžina versijos eilutę arba `null`. */
async function klientoVersija(binaras = "pg_dump") {
  try {
    const { stdout } = await vykdyti(binaras, ["--version"], { encoding: "utf8" });
    return stdout.trim();
  } catch {
    return null;
  }
}

function _antrasteBaitais(dumpFormatas) {
  return Buffer.from(`${ANTRASTE}\n${ANTRASTES_VERSIJA}\n${dumpFormatas}\n\n`, "utf8");
}

/**
 * Išskiria antraštę iš dešifruoto turinio.
 *
 * ⚠️ FAIL-CLOSED: antraštės nebuvimas ar kita rūšis reiškia, kad tai NE šios
 * procedūros artefaktas, ir SQL vykdyti negalima. Be šios patikros aplikacijos
 * JSON kopija būtų paduota į `psql`.
 */
function _perskaitytiAntraste(plaintext) {
  const riba = plaintext.indexOf("\n\n");
  if (riba === -1) {
    throw new PgDumpBackupError(
      "Dešifruotas turinys neturi dump'o antraštės - tai ne PostgreSQL kopijos artefaktas.",
      "PG_DUMP_HEADER_MISSING"
    );
  }

  const eilutes = plaintext.slice(0, riba).split("\n");
  if (eilutes[0] !== ANTRASTE) {
    throw new PgDumpBackupError(
      `Netikėta artefakto rūšis: ${JSON.stringify(eilutes[0])}.`,
      "PG_DUMP_KIND_MISMATCH"
    );
  }
  if (eilutes[1] !== ANTRASTES_VERSIJA) {
    throw new PgDumpBackupError(
      `Nepalaikoma dump'o antraštės versija: ${JSON.stringify(eilutes[1])}.`,
      "PG_DUMP_HEADER_VERSION"
    );
  }

  return { dumpFormatas: eilutes[2], sql: plaintext.slice(riba + 2) };
}

/**
 * Sukuria ŠIFRUOTĄ `pg_dump` kopiją.
 *
 * ⚠️ `--exclude-table-data=audit_log` (7.4d) — auditas į kopiją NEPATENKA
 * sąmoningai; ta pati taisyklė, kurią jau aprašo runbook'as.
 *
 * @returns {{ manifest: object, envelope: object, dumpBytes: number }}
 */
async function sukurtiSifruotaKopija({ databaseUrl, env = process.env } = {}) {
  if (!databaseUrl) {
    throw new PgDumpBackupError("Nenurodytas `databaseUrl`.", "PG_DUMP_NO_URL");
  }
  if (!backupEncryption.isEnabled(env)) {
    /**
     * ⚠️ NEŠIFRUOTA KOPIJA NĖRA ŠIOS PROCEDŪROS BAIGTIS. `job_results` turi
     * transkripcijas; paprastas `pg_dump` kriterijaus NETENKINA (#248 DoD).
     */
    throw new PgDumpBackupError(
      "Šifravimas neįjungtas: `pg_dump` be AES-256-GCM netenkina 7.6a kriterijaus.",
      "BACKUP_ENCRYPTION_DISABLED"
    );
  }

  const snapshotTime = Date.now();
  const { stdout: sql } = await vykdyti(
    "pg_dump",
    ["--exclude-table-data=audit_log", "--no-owner", "--no-privileges", databaseUrl],
    { encoding: "utf8", maxBuffer: MAX_DUMP_BYTES }
  );

  const plaintext = Buffer.concat([_antrasteBaitais(DUMP_FORMATAS), Buffer.from(sql, "utf8")]).toString("utf8");
  _assertDydis(plaintext);

  const checksum = crypto.createHash("sha256").update(plaintext, "utf8").digest("hex");

  /**
   * ⚠️ `contents: []` — SĄMONINGAI (D1). DB dump'as nėra aplikacijos artefaktų
   * inventorius; melagingas įrašas čia būtų blogesnis už tuščią, o bet koks
   * įrašas privalėtų praeiti `isIncluded()`, kurio DB dump'as netenkina.
   */
  const manifest = backupManifest.createManifest({ contents: [], checksum, env });
  manifest.encrypted = true;
  manifest.encryptionAlgorithm = `${backupEncryption.ALGORITHM}-${backupEncryption.FORMAT}`;
  manifest.snapshotTime = new Date(snapshotTime).toISOString();
  manifest.excludedInFlightJobs = 0;

  const envelope = backupEncryption.encrypt(plaintext, { env, manifest });

  log.info("PostgreSQL kopija sukurta ir užšifruota", {
    stage: "pg_dump_encrypted",
    dumpBytes: Buffer.byteLength(sql, "utf8"),
  });

  return { manifest, envelope, dumpBytes: Buffer.byteLength(sql, "utf8") };
}

/**
 * ⚠️ PRAKTINĖ DYDŽIO RIBA YRA ŽEMESNĖ NEI `MAX_CIPHERTEXT_BYTES` (D6).
 *
 * `MAX_CIPHERTEXT_BYTES` yra 2 GB, bet envelope laukai (`iv`, `authTag`,
 * `ciphertext`) yra BASE64 EILUTĖS ATMINTYJE, o V8 eilutės ilgis ribotas
 * (~512 MB 64-bit V8; `String::kMaxLength`). Base64 pailgina 4/3, tad ~512 MB
 * eilutė atitinka ~384 MB ciphertext'o — ir tai dar prieš `JSON.stringify`,
 * kuris envelope padvigubina.
 *
 * Riba čia nustatoma KONSERVATYVIAI ir tikrinama PRIEŠ šifravimą, kad
 * operatorius gautų aiškią klaidą, o ne neaiškų V8 kritimą viduryje.
 *
 * ⚠️ SRAUTINIO ŠIFRAVIMO 7.6a NEĮVEDA. Riba yra ŽINOMA RIBA, ne sprendimas;
 * ji užrašyta runbook'e.
 */
const MAX_DUMP_BYTES = 256 * 1024 * 1024;

function _assertDydis(plaintext) {
  const baitai = Buffer.byteLength(plaintext, "utf8");
  if (baitai > MAX_DUMP_BYTES) {
    throw new PgDumpBackupError(
      `Dump'as per didelis: ${baitai} B > ${MAX_DUMP_BYTES} B. ` +
        "7.6a nešifruoja srautu; žr. docs/backup-runbook.md ribų skyrių.",
      "PG_DUMP_TOO_LARGE"
    );
  }
}

/**
 * Atkuria šifruotą kopiją į TUŠČIĄ tikslinę bazę.
 *
 * ⚠️ VISOS KRIPTOGRAFINĖS IR MANIFESTO PATIKROS ĮVYKSTA PRIEŠ PIRMĄ SQL
 * MUTACIJĄ (D4). `psql` kviečiamas tik po to, kai manifestas galioja, GCM žyma
 * patvirtinta ir kontrolinė suma sutampa.
 *
 * ⚠️ `--single-transaction`: SQL klaida viduryje duoda `ROLLBACK`, ne pusiau
 * atkurtą bazę. „Sėkmingai užbaigto" dalinio atkūrimo būti negali.
 */
async function atkurtiSifruotaKopija({ envelope, manifest, targetUrl, env = process.env } = {}) {
  if (!targetUrl) {
    throw new PgDumpBackupError("Nenurodytas `targetUrl`.", "PG_RESTORE_NO_URL");
  }

  const patikra = backupManifest.validateManifest(manifest);
  if (!patikra.valid) {
    throw new PgDumpBackupError(
      `Manifestas negalioja: ${patikra.errors.join("; ")}.`,
      "BACKUP_MANIFEST_INVALID"
    );
  }

  /** GCM žyma ir AAD — krinta čia, PRIEŠ bet kokį SQL. */
  const plaintext = backupEncryption.decrypt(envelope, { env, manifest });

  const suma = crypto.createHash("sha256").update(plaintext, "utf8").digest("hex");
  if (suma !== manifest.checksum) {
    throw new PgDumpBackupError(
      "Kontrolinė suma nesutampa - kopija sugadinta.",
      "BACKUP_CHECKSUM_MISMATCH"
    );
  }

  const { sql, dumpFormatas } = _perskaitytiAntraste(plaintext);
  if (dumpFormatas !== DUMP_FORMATAS) {
    throw new PgDumpBackupError(
      `Nepalaikomas dump'o formatas: ${JSON.stringify(dumpFormatas)}.`,
      "PG_DUMP_FORMAT_UNSUPPORTED"
    );
  }

  /**
   * ⚠️ `spawn`, NE `execFile`: SQL paduodamas per STDIN.
   *
   * `execFile` `input` parametro neturi (tai `spawnSync` savybė), o rašyti
   * dump'ą į laikiną failą reikštų dešifruotą turinį diske — būtent tai, ko
   * šifravimas ir vengia.
   */
  await _psqlSuStdin(targetUrl, sql);

  log.info("PostgreSQL kopija atkurta", { stage: "pg_restore_done" });
  return { restoredBytes: Buffer.byteLength(sql, "utf8") };
}

/**
 * `psql --single-transaction` su SQL per STDIN.
 *
 * ⚠️ `ON_ERROR_STOP=1` BŪTINAS. Be jo `psql` klaidas praneša, bet tęsia ir
 * grąžina 0 — atkūrimas „pavyktų" praleidęs sakinius, ir `--single-transaction`
 * neturėtų ko atsukti.
 */
function _psqlSuStdin(targetUrl, sql) {
  return new Promise((resolve, reject) => {
    const p = spawn(
      "psql",
      ["--single-transaction", "--set", "ON_ERROR_STOP=1", "--quiet", "--no-psqlrc", targetUrl],
      { stdio: ["pipe", "pipe", "pipe"] }
    );

    let stderr = "";
    p.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) return resolve();
      reject(
        new PgDumpBackupError(
          `psql grąžino ${code}: ${stderr.trim().slice(0, 500)}`,
          "PG_RESTORE_FAILED"
        )
      );
    });

    p.stdin.on("error", reject);
    p.stdin.end(sql, "utf8");
  });
}

module.exports = {
  ANTRASTE,
  ANTRASTES_VERSIJA,
  DUMP_FORMATAS,
  MAX_DUMP_BYTES,
  PgDumpBackupError,
  klientoVersija,
  sukurtiSifruotaKopija,
  atkurtiSifruotaKopija,
};
