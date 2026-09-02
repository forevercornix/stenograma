const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Client } = require("pg");

const {
  skipWithoutPostgres,
  testDatabaseUrl,
  adminDatabaseUrl,
  REQUIRED,
} = require("./helpers/postgresGuard");

const pgDumpBackup = require("../utils/pgDumpBackup");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * ŠIFRUOTA PostgreSQL KOPIJA IR ATKŪRIMAS (#155, 7.6a / #248).
 *
 * ⚠️ TIKRAS PostgreSQL IR TIKRI `pg_dump`/`psql` BINARAI BŪTINI.
 *
 * Testas eina per TĄ PATĮ `utils/pgDumpBackup.js` kelią, kurį vykdo operatoriaus
 * `scripts/pg-backup.mjs`. Savo orkestracijos jis nekuria: testas, kuris pats
 * sudėliotų `pg_dump` → šifravimas → `psql`, tikrintų savo imitaciją, ne
 * procedūrą (D2, AGENTS.md §9.2).
 *
 * ⚠️ IZOLIACIJA YRA KOREKTIŠKUMO SĄLYGA, NE HIGIENA (§9.3). Restore trina ir
 * kuria schemą, tad bendroje `DATABASE_URL` bazėje jis sugriautų lygiagrečiai
 * vykdomus testus. Naudojami ESAMI `testDatabaseUrl()` / `adminDatabaseUrl()`
 * helperiai — antro provisioning framework'o nekuriama (D3).
 */

/**
 * ⚠️ ATSKIRA PRALEIDIMO AŠIS: „nėra `pg_dump` binaro" (D7).
 *
 * `skipWithoutPostgres()` tikrina tik `DATABASE_URL`. Bet CI serveris yra
 * `postgres:16-alpine`, o klientas diegiamas atskirai; be jo testas kristų NE
 * dėl logikos.
 *
 * ⚠️ SU `REQUIRE_POSTGRES=1` TRŪKSTAMAS KLIENTAS YRA KLAIDA, ne praleidimas.
 * Tyliai praleistas failas apeitų `verify-postgres-suite-ran.mjs` prasmę: tas
 * skriptas reikalauja bent vieno NEPRALEISTO `ok` kiekviename rinkinio faile.
 */
function trukstaKliento() {
  for (const binaras of ["pg_dump", "psql"]) {
    try {
      execFileSync(binaras, ["--version"], { stdio: "ignore" });
    } catch {
      if (REQUIRED) {
        throw new Error(
          `REQUIRE_POSTGRES=1, bet \`${binaras}\` nerastas. ` +
            "CI privalo įdiegti pririštos versijos PostgreSQL klientą (žr. ci.yml)."
        );
      }
      return `reikia \`${binaras}\` binaro (CI: postgresql-client-16)`;
    }
  }
  return false;
}

function praleisti() {
  return skipWithoutPostgres() || trukstaKliento();
}

const SALTINIO_URL = testDatabaseUrl("dumpsrc");
const TIKSLO_URL = testDatabaseUrl("dumpdst");

/**
 * Raktas TIK šiam testui — produkcinio env neliečiam.
 *
 * ⚠️ HEX, NE BASE64 (CI radinys). `backupEncryption._readKey()` reikalauja
 * `^[0-9a-fA-F]{64}$`; base64 eilutė atmetama. Naudojamas pats modulio
 * `generateKey()`, kad formatas negalėtų išsiskirti su tuo, ko modulis laukia.
 */
const backupEncryptionModulis = require("../utils/backupEncryption");
const TESTO_ENV = {
  ...process.env,
  BACKUP_ENCRYPTION_KEY: backupEncryptionModulis.generateKey(),
  /**
   * ⚠️ `BACKUP_ENABLED` BŪTINAS NUO #262 PERŽIŪROS. `backupPolicy.isEnabled()`
   * dabar tikrinamas pirmas, tad be šios reikšmės kiekvienas kopijos kūrimas
   * kristų `BACKUP_DISABLED` - t. y. testas tikrintų jungiklį, ne procedūrą.
   */
  BACKUP_ENABLED: "true",
};

async function vykdyti(url, sql) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await c.query(sql);
  } finally {
    await c.end();
  }
}

async function perkurtiDb(url) {
  const vardas = new URL(url).pathname.replace(/^\//, "");
  await vykdyti(adminDatabaseUrl(), `DROP DATABASE IF EXISTS "${vardas}" WITH (FORCE)`);
  await vykdyti(adminDatabaseUrl(), `CREATE DATABASE "${vardas}"`);
}

async function pasalintiDb(url) {
  const vardas = new URL(url).pathname.replace(/^\//, "");
  await vykdyti(adminDatabaseUrl(), `DROP DATABASE IF EXISTS "${vardas}" WITH (FORCE)`).catch(() => {});
}

/** Reprezentatyvus turinys: job'as, jo rezultatas ir audito eilutė su sentinel'iu. */
async function uzpildytiSaltini(auditoSentinelis) {
  const saknis = path.resolve(__dirname, "..");
  execFileSync("npx", ["node-pg-migrate", "up"], {
    cwd: saknis,
    env: { ...process.env, DATABASE_URL: SALTINIO_URL },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const c = new Client({ connectionString: SALTINIO_URL });
  await c.connect();
  try {
    const { rows } = await c.query(
      `INSERT INTO jobs (id, type, status, created_at, updated_at)
       VALUES (gen_random_uuid(), 'transcription', 'completed', now(), now())
       RETURNING id`
    );
    const jobId = rows[0].id;

    await c.query(
      `INSERT INTO job_results (job_id, storage_type, payload, created_at)
       VALUES ($1, 'inline', $2::jsonb, now())`,
      [jobId, JSON.stringify({ text: "reprezentatyvi transkripcija", segments: [{ t: 1 }] })]
    );

    /**
     * ⚠️ SCHEMA TIKRINTA, NE SPĖTA (CI radinys).
     *
     * Pirmoji redakcija rašė `(event, result, meta, created_at)` — bet
     * `audit_log` `created_at` NETURI (laiko žyma vadinasi `timestamp`), o
     * `event` turi CHECK `^[A-Z][A-Z0-9_]{1,63}$`, tad mažosiomis raidėmis ir su
     * tašku sudarytas sentinel'is būtų atmestas ir su teisingu stulpeliu.
     *
     * `id` ir `hash_key_id` yra `NOT NULL` be numatytosios reikšmės, tad
     * perduodami eksplicitiškai.
     */
    await c.query(
      `INSERT INTO audit_log (id, event, result, hash_key_id, meta)
       VALUES (gen_random_uuid(), $1, 'success', 'test-key', '{}'::jsonb)`,
      [auditoSentinelis]
    );

    return jobId;
  } finally {
    await c.end();
  }
}

test("7.6a: šifruota kopija ir atkūrimas", { skip: praleisti() }, async (t) => {
  /** ⚠️ Atitinka `audit_log` CHECK `^[A-Z][A-Z0-9_]{1,63}$`. */
  const auditoSentinelis = `SENTINEL_${crypto.randomUUID().replace(/-/g, "").toUpperCase()}`;
  let jobId;
  let kopija;

  t.after(async () => {
    await pasalintiDb(SALTINIO_URL);
    await pasalintiDb(TIKSLO_URL);
  });

  await perkurtiDb(SALTINIO_URL);
  jobId = await uzpildytiSaltini(auditoSentinelis);

  await t.test("kopija sukuriama ir yra ŠIFRUOTA", { timeout: 120000 }, async () => {
    kopija = await suZymuAplinka(SALTINIO_URL, () =>
      pgDumpBackup.sukurtiSifruotaKopija({
        databaseUrl: SALTINIO_URL,
        actor: "operatorius-testas",
        env: TESTO_ENV,
      })
    );

    assert.equal(kopija.manifest.encrypted, true);
    assert.match(kopija.manifest.encryptionAlgorithm, /aes-256-gcm/);
    assert.ok(kopija.envelope.ciphertext, "turinys užšifruotas");

    /**
     * ⚠️ ESMINĖ PATIKRA: transkripcija NĖRA matoma artefakte. Paprastas
     * `pg_dump` be šifravimo kriterijaus NETENKINA — `job_results` turi
     * transkripcijas.
     */
    const zalias = JSON.stringify(kopija);
    assert.equal(
      zalias.includes("reprezentatyvi transkripcija"),
      false,
      "⚠️ transkripcija NEGALI būti matoma šifruotame artefakte"
    );
  });

  await t.test("šifravimas IŠJUNGTAS → procedūra atsisako dirbti", { timeout: 60000 }, async () => {
    /** Paprastas `pg_dump` be AES-256-GCM netenkina 7.6a kriterijaus. */
    await assert.rejects(
      () =>
        pgDumpBackup.sukurtiSifruotaKopija({
          databaseUrl: SALTINIO_URL,
          env: { ...process.env, BACKUP_ENABLED: "true", BACKUP_ENCRYPTION_KEY: "" },
        }),
      /BACKUP_ENCRYPTION_DISABLED|šifravimas neįjungtas/i
    );
  });

  await t.test("atkūrimas į TUŠČIĄ DB: `jobs` IR `job_results` sutampa", { timeout: 120000 }, async () => {
    await perkurtiDb(TIKSLO_URL);

    await pgDumpBackup.atkurtiSifruotaKopija({
      envelope: kopija.envelope,
      manifest: kopija.manifest,
      targetUrl: TIKSLO_URL,
      env: TESTO_ENV,
    });

    /**
     * ⚠️ SCHEMOS VERSIJA TIKRINAMA TUO PAČIU PALYGINIMU KAIP `make doctor` (D5).
     *
     * `count(*) > 0` nepakaktų: bazė, į kurią pritaikyta tik SENESNĖ migracija,
     * jį praeitų, o pirmas `INSERT` kristų gyvame sraute. Repo „schemos versija"
     * yra būtent PRITAIKYTŲ `pgmigrations` aibė, lyginama su
     * `backend/migrations/` katalogu (`startupChecks.postgresReachability()`).
     *
     * ⚠️ NAUDOJAMAS TAS PATS KODAS, ne atkartotas palyginimas — kitaip testas
     * įrodytų savo kopiją, o runbook'o post-restore žingsnis liktų neįrodytas.
     */
    /**
     * ⚠️ NAUDOJAMAS VIEŠAS `runSelfChecks()`, NE VIDINĖ FUNKCIJA (CI radinys).
     *
     * `startupChecks` eksportuoja tik `{ validateConfig, runSelfChecks }` —
     * `postgresReachability` yra vidinė. Pirmoji redakcija ją kvietė tiesiogiai
     * ir krito su „is not a function".
     *
     * Viešas kelias net geresnis: `make doctor` eina būtent per `runSelfChecks()`,
     * tad testas tikrina TĄ PAČIĄ išvestį, kurią mato operatorius, o ne vidinę
     * detalę.
     */
    const startupChecks = require("../utils/startupChecks");
    const patikros = await startupChecks.runSelfChecks({ ...process.env, DATABASE_URL: TIKSLO_URL });
    const pg = patikros.find((c) => /PostgreSQL/.test(c.name));

    assert.ok(pg, "prielaida: `runSelfChecks()` turi PostgreSQL patikrą");
    assert.equal(
      pg.ok,
      true,
      `⚠️ atkurta schema privalo atitikti kodą: ${JSON.stringify(pg.detail || pg)}`
    );

    const { rows: migracijos } = await vykdyti(TIKSLO_URL, "SELECT count(*)::int AS n FROM pgmigrations");
    assert.ok(migracijos[0].n > 0, "prielaida: `pgmigrations` apskritai atkurta");

    /**
     * ⚠️ PALYGINIMAS NĖRA `COUNT(*)` (#248).
     *
     * Procedūra, neatkurianti `job_results`, `COUNT(*)` patikrą praeitų, nors
     * kiekvienas baigtas job'as būtų praradęs VARTOTOJUI MATOMĄ rezultatą.
     * Todėl tikrinami konkretūs `id`, statusas ir payload turinys.
     */
    const { rows } = await vykdyti(
      TIKSLO_URL,
      `SELECT j.id, j.status, r.storage_type, r.payload
         FROM jobs j LEFT JOIN job_results r ON r.job_id = j.id
        WHERE j.id = '${jobId}'`
    );

    assert.equal(rows.length, 1, "job'as atkurtas");
    assert.equal(rows[0].status, "completed");
    assert.equal(rows[0].storage_type, "inline", "⚠️ `job_results` eilutė TIKRAI atkurta");
    assert.deepEqual(
      rows[0].payload,
      { text: "reprezentatyvi transkripcija", segments: [{ t: 1 }] },
      "⚠️ rezultato TURINYS sutampa, ne tik eilučių skaičius"
    );

    /**
     * ⚠️ ŠALTINIO NUOSEKLUMAS: `jobs` ir `job_results` iš TO PATIES loginio momento.
     *
     * `pg_dump` visą kopiją ima vienu nuosekliu snapshot'u (REPEATABLE READ
     * transakcija), tad lentelės negali būti paimtos iš skirtingų momentų. Šis
     * testas tuo REMIASI: tikrina, kad atkurtoje bazėje nėra nė vieno
     * `job_results` be savo `jobs` eilutės ir atvirkščiai.
     *
     * Be snapshot semantikos toks ryšys galėtų lūžti net esant teisingam
     * atkūrimui: `job_results` paimtas vėliau nei `jobs` turėtų eilučių, kurių
     * `jobs` pusėje nėra. Procedūra jokių snapshot'ą laužančių vėliavų
     * neperduoda — tai gina `pgDumpBackupContract`.
     */
    const { rows: naslaiciai } = await vykdyti(
      TIKSLO_URL,
      `SELECT
         (SELECT count(*)::int FROM job_results r LEFT JOIN jobs j ON j.id = r.job_id WHERE j.id IS NULL) AS be_jobo,
         (SELECT count(*)::int FROM jobs j WHERE j.status = 'completed'
            AND NOT EXISTS (SELECT 1 FROM job_results r WHERE r.job_id = j.id)) AS be_rezultato`
    );
    assert.equal(naslaiciai[0].be_jobo, 0, "⚠️ `job_results` be `jobs` - snapshot'ai išsiskyrė");
    assert.equal(naslaiciai[0].be_rezultato, 0, "⚠️ baigtas job'as be rezultato - snapshot'ai išsiskyrė");
  });

  await t.test("⚠️ `audit_log` NEATKURIAMAS (unikalus sentinel'is)", { timeout: 60000 }, async () => {
    /**
     * ⚠️ „NESUTAMPA SU DUMP'U" NEPAKANKA. Atkūrimas ir pats sistemos darbas
     * įrašo naujų audito įvykių, tad nesutapimas atsiranda savaime. Tikrinama
     * KONKRETI eilutė, kurios buvimas šaltinyje įrodytas.
     */
    const { rows: saltinyje } = await vykdyti(
      SALTINIO_URL,
      `SELECT count(*)::int AS n FROM audit_log WHERE event = '${auditoSentinelis}'`
    );
    assert.equal(saltinyje[0].n, 1, "prielaida: sentinel'is TIKRAI buvo šaltinyje");

    const { rows: tiksle } = await vykdyti(
      TIKSLO_URL,
      `SELECT count(*)::int AS n FROM audit_log WHERE event = '${auditoSentinelis}'`
    );
    assert.equal(tiksle[0].n, 0, "⚠️ audito eilutė NEGALI atsirasti atkurtoje bazėje");
  });
});

test("7.6a FAIL-CLOSED: sugadinta kopija NELIEČIA tikslinės bazės", { skip: praleisti() }, async (t) => {
  /**
   * ⚠️ KLAIDOS GRĄŽINIMAS NĖRA FAIL-CLOSED ĮRODYMAS (#248).
   *
   * „Metė klaidą" suderinama ir su tuo, kad dalis SQL jau įvykdyta. Todėl po
   * KIEKVIENO bandymo tikrinama, kad tikslinė bazė liko SEMANTIŠKAI NEPALIESTA:
   * jokių lentelių, jokių įrašų.
   */
  const auditoSentinelis = `SENTINEL_${crypto.randomUUID().replace(/-/g, "").toUpperCase()}`;

  t.after(async () => {
    await pasalintiDb(SALTINIO_URL);
    await pasalintiDb(TIKSLO_URL);
  });

  await perkurtiDb(SALTINIO_URL);
  await uzpildytiSaltini(auditoSentinelis);

  const kopija = await suZymuAplinka(SALTINIO_URL, () =>
    pgDumpBackup.sukurtiSifruotaKopija({
      databaseUrl: SALTINIO_URL,
      actor: "operatorius-testas",
      env: TESTO_ENV,
    })
  );

  /** Kiek lentelių yra tikslinėje bazėje? Tuščioje - nulis. */
  async function lenteliuSkaicius() {
    const { rows } = await vykdyti(
      TIKSLO_URL,
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'"
    );
    return rows[0].n;
  }

  const scenarijai = [
    {
      vardas: "sugadintas ciphertext",
      kodas: "BACKUP_DECRYPTION_FAILED",
      paruosti: () => {
        const sugadintas = { ...kopija.envelope };
        const b = Buffer.from(sugadintas.ciphertext, "base64");
        b[Math.floor(b.length / 2)] ^= 0xff;
        sugadintas.ciphertext = b.toString("base64");
        return { envelope: sugadintas, manifest: kopija.manifest, env: TESTO_ENV };
      },
    },
    {
      vardas: "blogas raktas",
      kodas: "BACKUP_DECRYPTION_FAILED",
      paruosti: () => ({
        envelope: kopija.envelope,
        manifest: kopija.manifest,
        env: { ...process.env, BACKUP_ENCRYPTION_KEY: backupEncryptionModulis.generateKey() },
      }),
    },
    {
      vardas: "suklastotas manifestas (AAD)",
      kodas: "BACKUP_DECRYPTION_FAILED",
      paruosti: () => ({
        envelope: kopija.envelope,
        /** `snapshotTime` yra AAD lauke - pakeitus jį, GCM žyma nebesutampa. */
        manifest: { ...kopija.manifest, snapshotTime: new Date(0).toISOString() },
        env: TESTO_ENV,
      }),
    },
    {
      vardas: "nesutampanti kontrolinė suma",
      kodas: "BACKUP_CHECKSUM_MISMATCH",
      paruosti: () => ({
        envelope: kopija.envelope,
        manifest: { ...kopija.manifest, checksum: "0".repeat(64) },
        env: TESTO_ENV,
      }),
    },
    {
      vardas: "negaliojantis manifestas",
      kodas: "BACKUP_MANIFEST_INVALID",
      paruosti: () => ({
        envelope: kopija.envelope,
        manifest: { ...kopija.manifest, formatVersion: undefined },
        env: TESTO_ENV,
      }),
    },
  ];

  for (const scenarijus of scenarijai) {
    await t.test(`⚠️ ${scenarijus.vardas} → hard fail PRIEŠ restore`, { timeout: 60000 }, async () => {
      await perkurtiDb(TIKSLO_URL);
      assert.equal(await lenteliuSkaicius(), 0, "prielaida: tikslinė bazė TUŠČIA");

      /**
       * ⚠️ TIKRINAMAS `code`, NE ŽINUTĖS ŠABLONAS (CI radinys gretimame teste).
       *
       * `assert.rejects()` su `RegExp` lygina `err.message`, o žinutės yra
       * lietuviškos. Laisvas šablonas (`/Nepavyko|autent/i`) sutaptų ir su
       * PRISIJUNGIMO klaida — testas praeitų dėl neteisingos priežasties, o
       * „DB liko nepaliesta" patikra tą užmaskuotų.
       */
      await assert.rejects(
        () => pgDumpBackup.atkurtiSifruotaKopija({ ...scenarijus.paruosti(), targetUrl: TIKSLO_URL }),
        (err) => {
          assert.equal(
            err.code,
            scenarijus.kodas,
            `${scenarijus.vardas}: laukta ${scenarijus.kodas}, gauta ${err.code} (${err.message})`
          );
          return true;
        }
      );

      /** ⚠️ ESMINĖ PATIKRA: ne „metė klaidą", o „nieko nepadarė". */
      assert.equal(
        await lenteliuSkaicius(),
        0,
        `⚠️ ${scenarijus.vardas}: tikslinė bazė privalo likti SEMANTIŠKAI NEPALIESTA`
      );
    });
  }
});

test("7.6a FAIL-CLOSED: SQL klaida JAU PRADĖJUS nepalieka dalinės būsenos", { skip: praleisti() }, async (t) => {
  /**
   * ⚠️ TAI ANTRAS, ATSKIRAS REIKALAVIMAS (D4).
   *
   * „Hard fail PRIEŠ restore" (sugadintas ciphertext, blogas raktas) ir „SQL
   * klaida jau pradėjus vykdyti autentifikuotą dump'ą" yra skirtingi dalykai:
   * pirmasis niekada neprisiliečia prie DB, antrasis jau vykdo sakinius.
   *
   * `--single-transaction` + `ON_ERROR_STOP=1` reiškia, kad antruoju atveju
   * įvyksta `ROLLBACK`, o ne „sėkmingai užbaigtas" dalinis restore.
   */
  t.after(async () => {
    await pasalintiDb(TIKSLO_URL);
  });

  await perkurtiDb(TIKSLO_URL);

  /**
   * Turinys, kuris pradeda TEISĖTAI (sukuria lentelę ir įrašo eilutę), o po to
   * krenta. Be `--single-transaction` lentelė liktų.
   */
  const sql =
    "CREATE TABLE dalinis (id int);\n" +
    "INSERT INTO dalinis VALUES (1);\n" +
    "SELECT * FROM nera_tokios_lenteles;\n";

  const plaintext = `${pgDumpBackup.ANTRASTE}\n${pgDumpBackup.ANTRASTES_VERSIJA}\n${pgDumpBackup.DUMP_FORMATAS}\n\n${sql}`;
  const checksum = crypto.createHash("sha256").update(plaintext, "utf8").digest("hex");

  const backupManifest = require("../utils/backupManifest");
  const backupEncryption = require("../utils/backupEncryption");

  const manifest = backupManifest.createManifest({ contents: [], checksum, env: TESTO_ENV });
  manifest.encrypted = true;
  manifest.encryptionAlgorithm = `${backupEncryption.ALGORITHM}-${backupEncryption.FORMAT}`;
  manifest.snapshotTime = new Date().toISOString();
  manifest.excludedInFlightJobs = 0;

  const envelope = backupEncryption.encrypt(plaintext, { env: TESTO_ENV, manifest });

  await assert.rejects(
    () => pgDumpBackup.atkurtiSifruotaKopija({ envelope, manifest, targetUrl: TIKSLO_URL, env: TESTO_ENV }),
    /PG_RESTORE_FAILED|psql grąžino/
  );

  /** ⚠️ ESMINĖ PATIKRA: pirmieji du sakiniai ATSUKTI. */
  const { rows } = await vykdyti(
    TIKSLO_URL,
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'dalinis'"
  );
  assert.equal(rows[0].n, 0, "⚠️ `--single-transaction` privalo atsukti jau įvykdytus sakinius");
});

test("7.6a: rūšies antraštė yra FAIL-CLOSED (ne pg_dump artefaktas)", { skip: praleisti() }, async (t) => {
  /**
   * ⚠️ RŪŠIS GYVENA ŠIFRUOTAME TURINYJE, NE MANIFESTE (D1).
   *
   * Manifestas naudojamas toks, koks yra (`contents: []`), tad manifesto lygmenyje
   * DB dump'as nesiskiria nuo tuščios aplikacijos kopijos. Skirtumą neša
   * antraštė ŠIFRUOTAME turinyje — ją autentifikuoja GCM, ir jokio AAD ar
   * kriptografijos keitimo tam nereikėjo.
   *
   * Be šios patikros aplikacijos JSON kopija būtų paduota tiesiai į `psql`.
   */
  t.after(async () => {
    await pasalintiDb(TIKSLO_URL);
  });

  await perkurtiDb(TIKSLO_URL);

  const backupManifest = require("../utils/backupManifest");
  const backupEncryption = require("../utils/backupEncryption");

  /** Aplikacijos JSON kopijos turinys - teisėtas artefaktas, bet NE dump'as. */
  const plaintext = JSON.stringify({ jobs: [], sessions: [] });
  const checksum = crypto.createHash("sha256").update(plaintext, "utf8").digest("hex");

  const manifest = backupManifest.createManifest({ contents: [], checksum, env: TESTO_ENV });
  manifest.encrypted = true;
  manifest.encryptionAlgorithm = `${backupEncryption.ALGORITHM}-${backupEncryption.FORMAT}`;
  manifest.snapshotTime = new Date().toISOString();
  manifest.excludedInFlightJobs = 0;

  const envelope = backupEncryption.encrypt(plaintext, { env: TESTO_ENV, manifest });

  /**
   * ⚠️ TIKRINAMAS `code`, NE ŽINUTĖ (CI radinys).
   *
   * `assert.rejects()` su `RegExp` lygina `err.message`, o žinutės yra
   * lietuviškos ir kodo jose nėra. Pirmoji redakcija metė TEISINGĄ klaidą, bet
   * testas vis tiek krito — patikra tikrino ne tą lauką.
   */
  await assert.rejects(
    () => pgDumpBackup.atkurtiSifruotaKopija({ envelope, manifest, targetUrl: TIKSLO_URL, env: TESTO_ENV }),
    (err) => {
      assert.match(String(err.code), /PG_DUMP_HEADER_MISSING|PG_DUMP_KIND_MISMATCH/, `gauta: ${err.code}`);
      return true;
    }
  );

  const { rows } = await vykdyti(
    TIKSLO_URL,
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'"
  );
  assert.equal(rows[0].n, 0, "svetimas artefaktas NELIEČIA tikslinės bazės");
});

/**
 * #262 CODEX PERŽIŪRA — KAS ĮRODOMA TIK SU TIKRA DB.
 *
 * ⚠️ RIBA BRĖŽIAMA PAGAL TAI, KO TESTUI REIKIA. Šakos (netinkamas `expiresAt`,
 * mesta saugyklos klaida, redagavimo funkcijos) tikrinamos vietiniame
 * `pgDumpBackupContract`. Čia lieka tik tai, kam reikia veikiančio `pg_dump`:
 * kad horizontas ir auditas realiai ĮJUNGTI į kopijos kūrimą, ir kad tikra
 * `pg_dump` klaida neišneša slaptažodžio.
 */
const { mock } = require("node:test");
const tombstones = require("../utils/deletionTombstones");
const auditWrite = require("../utils/auditWrite");

/**
 * ŽYMŲ SAUGYKLA PRIRIŠAMA PRIE DUMP'INAMOS BAZĖS (#262 Codex P1).
 *
 * ⚠️ DVI PRIEŽASTYS, IR ABI SVARBIOS.
 *
 * 1. Nuo #262 kopijos kūrimas REIKALAUJA, kad žymų saugykla gyventų TOJE PAČIOJE
 *    bazėje, kurią dump'iname. Horizontas kitoje bazėje reikštų, kad #250 D4
 *    prielaida netiesa nuo pat pradžių.
 * 2. Atmintinė saugykla įrodytų tik tai, kad funkcija IŠKVIESTA. Prisirišus prie
 *    `dumpsrc` gaunama tikra `backup_horizon` EILUTĖ - t. y. įrodymas, kad
 *    horizontas atsidūrė toje bazėje, kurios žymas jis privalo saugoti.
 *
 * ⚠️ CI RADINYS, DĖL KURIO ŠIS KELIAS APSKRITAI ATSIRADO: `DATABASE_URL` rodė į
 * bazę be `erasure_marks`, ir visas failas krito su „relation "erasure_marks"
 * does not exist". Tai ne testo triukšmas, o tikra kelio savybė - bazė be
 * ištrynimo žymų infrastruktūros kopijos nebeišduoda.
 *
 * ⚠️ `process.env`, NE INJEKTUOTAS `env`: saugykla jungiasi iš globalios
 * aplinkos, ir tapatumo patikra lygina būtent ją.
 */
async function suZymuAplinka(url, veiksmas, { prijungti = true } = {}) {
  const senas = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url;

  await tombstones.shutdown().catch(() => {});
  if (prijungti) await tombstones.init(process.env);

  try {
    return await veiksmas();
  } finally {
    await tombstones.shutdown().catch(() => {});
    if (senas === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = senas;
  }
}

test("#262: horizontas ir auditas ĮJUNGTI į kopijos kūrimą", { skip: praleisti() }, async (t) => {
  t.after(async () => {
    await pasalintiDb(SALTINIO_URL);
  });

  await perkurtiDb(SALTINIO_URL);
  await uzpildytiSaltini(`SENTINEL_${crypto.randomUUID().replace(/-/g, "").toUpperCase()}`);

  const auditas = mock.method(auditWrite, "rasytiAudita", async () => {});

  try {
    /**
     * ⚠️ HORIZONTAS TIKRINAMAS PER `backup_horizon` EILUTĘ TOJE BAZĖJE, KURIĄ
     * DUMP'INOME - ne per mock'ą ir ne per atmintinę saugyklą.
     *
     * Mock'as įrodytų tik tai, kad funkcija kviečiama; atmintinė saugykla - kad
     * reikšmė kažkur atsidūrė. #250 D4 remiasi tuo, kad ji atsidūrė BŪTENT ten,
     * kur gyvena tos bazės ištrynimo žymos, ir tik SQL užklausa tai parodo.
     */
    const kopija = await suZymuAplinka(SALTINIO_URL, () =>
      pgDumpBackup.sukurtiSifruotaKopija({
        databaseUrl: SALTINIO_URL,
        actor: "operatorius-testas",
        env: TESTO_ENV,
      })
    );

    const { rows } = await vykdyti(SALTINIO_URL, "SELECT expires_at FROM backup_horizon");
    assert.equal(rows.length, 1, "horizontas privalo gulėti dump'intos bazės lentelėje");
    assert.equal(
      new Date(rows[0].expires_at).getTime(),
      Date.parse(kopija.manifest.expiresAt),
      "eilutėje privalo būti TO PATIES manifesto galiojimas, ne apytikslis laikas"
    );

    assert.equal(auditas.mock.callCount(), 1);
    const irasas = auditas.mock.calls[0].arguments[0];
    assert.equal(irasas.event, "PG_DUMP_BACKUP_CREATED");
    assert.equal(irasas.actor, "operatorius-testas", "§11 reikalauja aktoriaus, ne vien įvykio");
    assert.equal(/[0-9a-f]{64}/i.test(JSON.stringify(irasas)), false, "audite - tik metaduomenys, jokių raktų");
  } finally {
    auditas.mock.restore();
  }
});

test("#262: horizonto NEUŽFIKSAVUS kopija NEIŠDUODAMA", { skip: praleisti() }, async (t) => {
  t.after(async () => {
    await pasalintiDb(SALTINIO_URL);
  });

  await perkurtiDb(SALTINIO_URL);
  await uzpildytiSaltini(`SENTINEL_${crypto.randomUUID().replace(/-/g, "").toUpperCase()}`);

  const luztantis = mock.method(tombstones, "recordBackupHorizon", async () => {
    throw new Error("saugykla neprieinama");
  });
  const auditas = mock.method(auditWrite, "rasytiAudita", async () => {});

  try {
    await assert.rejects(
      () =>
        suZymuAplinka(SALTINIO_URL, () =>
          pgDumpBackup.sukurtiSifruotaKopija({ databaseUrl: SALTINIO_URL, actor: "operatorius-testas", env: TESTO_ENV })
        ),
      (err) => {
        assert.equal(err.code, "PG_BACKUP_HORIZON_UNRECORDED");
        return true;
      }
    );

    /**
     * ⚠️ NEUŽTENKA „metė klaidą": kopija neturi būti nei užšifruota, nei
     * užaudituota. Auditas po nesėkmės reikštų įrašą apie neegzistuojantį
     * artefaktą.
     */
    assert.equal(auditas.mock.callCount(), 0, "neišduotos kopijos auditas fiksuoti negali");
  } finally {
    luztantis.mock.restore();
    auditas.mock.restore();
  }
});

test("#262: tikra `pg_dump` klaida NEIŠNEŠA slaptažodžio", { skip: praleisti() }, async () => {
  /**
   * ⚠️ TAI CI-ONLY ĮRODYMAS, IR SĄMONINGAI. Be įdiegto `pg_dump` procesas krinta
   * ties `ENOENT`, o tokioje žinutėje argumentų eilutės nėra — testas praeitų
   * nieko neįrodęs. Su realiu klientu žinutė turi VISĄ argumentų eilutę:
   *
   *   Command failed: pg_dump ... postgres://vartotojas:SLAPTAS123@...
   */
  const nesamaDb = new URL(SALTINIO_URL);
  nesamaDb.password = "SLAPTAZODIS123";
  nesamaDb.pathname = "/nera_tokios_bazes_248";

  /**
   * ⚠️ ŽYMŲ APLINKA RIŠAMA PRIE TOS PAČIOS NESAMOS BAZĖS, BET SAUGYKLA
   * NEJUNGIAMA: tapatumo patikra lygina konfigūraciją ir praeina, o kelias
   * krinta ten, kur ir turi - ties `pg_dump`. Kitaip testas įrodytų tapatumo
   * patikrą, ne redagavimą.
   */
  await assert.rejects(
    () =>
      suZymuAplinka(
        nesamaDb.toString(),
        () => pgDumpBackup.sukurtiSifruotaKopija({ databaseUrl: nesamaDb.toString(), actor: "operatorius-testas", env: TESTO_ENV }),
        { prijungti: false }
      ),
    (err) => {
      assert.equal(err.code, "PG_DUMP_FAILED");
      assert.equal(err.message.includes("SLAPTAZODIS123"), false, "slaptažodis negali patekti į klaidos žinutę");
      assert.equal(String(err.stack).includes("SLAPTAZODIS123"), false, "nei į stack'ą per `cause`");
      return true;
    }
  );
});

test("#262: NETUŠČIA tikslinė bazė atmetama PRIEŠ pirmą SQL sakinį", { skip: praleisti() }, async (t) => {
  /**
   * ⚠️ ŠIS TESTAS GINA NE 7.6a, O #249 IR #250.
   *
   * Abu remsis šiuo restore keliu ir abu prasideda nuo „restore pavyko".
   * Atkūrimas į bazę su svetimu turiniu duotų dviejų bazių SĄJUNGĄ, o jų testai
   * to nepagautų - jie tikrintų suderinimą ir replay ant jau užterštos būsenos.
   */
  t.after(async () => {
    await pasalintiDb(SALTINIO_URL);
    await pasalintiDb(TIKSLO_URL);
  });

  await perkurtiDb(SALTINIO_URL);
  await uzpildytiSaltini(`SENTINEL_${crypto.randomUUID().replace(/-/g, "").toUpperCase()}`);

  const kopija = await suZymuAplinka(SALTINIO_URL, () =>
    pgDumpBackup.sukurtiSifruotaKopija({
      databaseUrl: SALTINIO_URL,
      actor: "operatorius-testas",
      env: TESTO_ENV,
    })
  );

  await perkurtiDb(TIKSLO_URL);
  await vykdyti(TIKSLO_URL, "CREATE TABLE svetimas (id int); INSERT INTO svetimas VALUES (7);");

  await assert.rejects(
    () =>
      pgDumpBackup.atkurtiSifruotaKopija({
        envelope: kopija.envelope,
        manifest: kopija.manifest,
        targetUrl: TIKSLO_URL,
        env: TESTO_ENV,
      }),
    (err) => {
      assert.equal(err.code, "PG_RESTORE_TARGET_NOT_EMPTY");
      return true;
    }
  );

  /**
   * ⚠️ NEUŽTENKA „metė klaidą": svetimas turinys privalo likti NEPALIESTAS, o
   * kopijos lentelių - neatsirasti. Kitaip patikra būtų įvykusi jau po to, kai
   * `psql` pradėjo darbą.
   */
  const { rows: svetimas } = await vykdyti(TIKSLO_URL, "SELECT id FROM svetimas");
  assert.deepEqual(svetimas.map((r) => r.id), [7], "esamas turinys negali būti paliestas");

  const { rows: jobs } = await vykdyti(
    TIKSLO_URL,
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'jobs'"
  );
  assert.equal(jobs[0].n, 0, "⚠️ nė vienas kopijos sakinys negalėjo būti įvykdytas");
});

test("#262: SVETIMOS bazės dump'as atmetamas — horizontas negali gulėti ne ten", { skip: praleisti() }, async (t) => {
  /**
   * ⚠️ ŠIS TESTAS SAUGO #250 D4, NE 7.6a ERGONOMIKĄ.
   *
   * Su svetima baze kopija būtų sukurta sėkmingai, o jos galiojimas užfiksuotas
   * KITOS bazės `backup_horizon` lentelėje. 7.6c tai rastų kaip „kodėl žymos
   * pasibaigė anksčiau nei kopija" — jau turėdamas tris judančias dalis.
   *
   * ⚠️ Tikrinama ir tai, kad atsisakoma PRIEŠ `pg_dump`: `dumpdst` bazė net
   * nesukurta, tad pasiekus `pg_dump` klaida būtų kita.
   */
  t.after(async () => {
    await pasalintiDb(SALTINIO_URL);
  });

  await perkurtiDb(SALTINIO_URL);
  await uzpildytiSaltini(`SENTINEL_${crypto.randomUUID().replace(/-/g, "").toUpperCase()}`);

  await assert.rejects(
    () =>
      suZymuAplinka(SALTINIO_URL, () =>
        pgDumpBackup.sukurtiSifruotaKopija({
          databaseUrl: TIKSLO_URL,
          actor: "operatorius-testas",
          env: TESTO_ENV,
        })
      ),
    (err) => {
      assert.equal(err.code, "PG_BACKUP_SOURCE_MISMATCH");
      assert.equal(err.message.includes("dumpdst"), true, "klaida privalo įvardyti, KAS nesutampa");
      return true;
    }
  );

  const { rows } = await vykdyti(SALTINIO_URL, "SELECT count(*)::int AS n FROM backup_horizon");
  assert.equal(rows[0].n, 0, "neišduotos kopijos horizontas fiksuoti negali");
});

test("#262: preflight mato NE TIK lenteles (seka, matview, funkcija, schema)", { skip: praleisti() }, async (t) => {
  /**
   * ⚠️ `information_schema.tables` ŠIŲ OBJEKTŲ NEMATO.
   *
   * Pirmoji preflight redakcija skaičiavo būtent tą rodinį, o runbook'as žadėjo
   * „objektus ne sisteminėse schemose" — dokumentas buvo stipresnis už kodą
   * (§12.1). Praktinė pasekmė: tikslinė bazė su likusia seka ar matview'u
   * laikoma tuščia, ir po atkūrimo joje gulėtų dviejų bazių sąjunga — tiksliai
   * tai, ko preflight neleidžia. #249 ir #250 dirbtų ant tokios bazės
   * nieko neįtardami.
   */
  t.after(async () => {
    await pasalintiDb(SALTINIO_URL);
    await pasalintiDb(TIKSLO_URL);
  });

  await perkurtiDb(SALTINIO_URL);
  await uzpildytiSaltini(`SENTINEL_${crypto.randomUUID().replace(/-/g, "").toUpperCase()}`);

  const kopija = await suZymuAplinka(SALTINIO_URL, () =>
    pgDumpBackup.sukurtiSifruotaKopija({
      databaseUrl: SALTINIO_URL,
      actor: "operatorius-testas",
      env: TESTO_ENV,
    })
  );

  const likuciai = [
    ["seka", "CREATE SEQUENCE likusi_seka"],
    ["matview", "CREATE MATERIALIZED VIEW likes_mv AS SELECT 1 AS x"],
    ["funkcija", "CREATE FUNCTION likusi_f() RETURNS int LANGUAGE sql AS 'SELECT 1'"],
    ["schema", "CREATE SCHEMA likusi_schema"],
    /**
     * ⚠️ ENUM: `pg_class` jo NETURI, tad be `pg_type` subužklausos bazė su
     * likusiu tipu atrodė tuščia (#262 IV raundas). Domenas — ta pati klasė.
     */
    ["enum tipas", "CREATE TYPE likes_enum AS ENUM ('a', 'b')"],
    ["domenas", "CREATE DOMAIN likes_domenas AS int CHECK (VALUE > 0)"],
  ];

  for (const [vardas, sql] of likuciai) {
    await perkurtiDb(TIKSLO_URL);
    await vykdyti(TIKSLO_URL, sql);

    await assert.rejects(
      () =>
        pgDumpBackup.atkurtiSifruotaKopija({
          envelope: kopija.envelope,
          manifest: kopija.manifest,
          targetUrl: TIKSLO_URL,
          env: TESTO_ENV,
        }),
      (err) => {
        assert.equal(err.code, "PG_RESTORE_TARGET_NOT_EMPTY", `${vardas} privalo būti pastebėtas`);
        return true;
      },
      `likutis „${vardas}" praėjo preflight'ą`
    );

    const { rows } = await vykdyti(
      TIKSLO_URL,
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'jobs'"
    );
    assert.equal(rows[0].n, 0, `⚠️ po atmesto „${vardas}" atkūrimo kopijos lentelių atsirasti negali`);
  }

  /** ⚠️ TIKRAI TUŠČIA bazė privalo PRAEITI — kitaip patikra būtų tiesiog visada „ne". */
  await perkurtiDb(TIKSLO_URL);
  await pgDumpBackup.atkurtiSifruotaKopija({
    envelope: kopija.envelope,
    manifest: kopija.manifest,
    targetUrl: TIKSLO_URL,
    env: TESTO_ENV,
  });

  const { rows } = await vykdyti(TIKSLO_URL, "SELECT count(*)::int AS n FROM jobs");
  assert.ok(rows[0].n > 0, "tuščia bazė privalo būti atkuriama");
});
