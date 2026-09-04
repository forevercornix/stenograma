const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const { Client } = require("pg");

const { skipWithoutPostgres, testDatabaseUrl, adminDatabaseUrl } = require("./helpers/postgresGuard");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * `job_results` EXTERNAL REPREZENTACIJOS INVARIANTAS (#157, PR-1).
 *
 * ⚠️ ŠIS FAILAS VIETINĖJE APLINKOJE NEVYKDOMAS. Jam reikia tikros PostgreSQL;
 * registracija `postgres` rinkinyje išvedama iš `postgresGuard` importo, tad
 * `verify-postgres-suite-ran.mjs` reikalaus neprapleisto `ok`.
 *
 * ⚠️ KODĖL ATSKIRAS FAILAS, O NE `migrations.integration`.
 *
 * Tas failas tikrina migracijų KARKASĄ (tvarką, atnaujinimo kelią, kad senos
 * migracijos nekeičiamos). Čia tikrinamas VIENAS duomenų invariantas, ir jis
 * gyvuos ilgiau nei jį įvedusi migracija: po #157 kiekvienas naujas rezultatų
 * saugojimo kelias privalo jį atlaikyti.
 *
 * ⚠️ KĄ ŠIS FAILAS ĮRODO.
 *
 * Kad DB PATI atmeta negaliojančias `job_results` formas — ne aplikacija, ne
 * kodo peržiūra. #157 body: „Integrity metaduomenys tampa DB invariantu, ne
 * aplikacijos susitarimu."
 *
 * ⚠️ KETURI SARGAI TIKRINAMI ATSKIRAI, IR TAI SĄMONINGA.
 *
 * Bendras testas „external forma galioja" praeitų padengęs vieną iš keturių, o
 * ataskaitoje atrodytų kaip keturi. Ta pati klaida, kurią 7.6c padarė su trimis
 * `deleteJobArtefacts` trumpaisiais keliais (#250).
 */

const ŠAKNIS = path.resolve(__dirname, "..");
const DB_URL = testDatabaseUrl("extshape");
const JOB_ID = "aaaaaaaa-0000-4000-8000-000000000001";

/**
 * ⚠️ `skip:` OPCIJA, NE `if (...) return` (Codex, #289).
 *
 * Ankstesnė redakcija be DB grąžindavo tyliai, ir Node išvesdavo įprastą `ok` —
 * `verify-postgres-suite-ran.mjs` tokį failą skaičiuotų kaip ĮVYKDYTĄ, nors
 * nebuvo nei migracijos, nei nė vieno tvirtinimo. PostgreSQL kriterijai atrodytų
 * patikrinti be jokios patikros (AGENTS.md §9.3, §14.1).
 *
 * `postRestoreReconcile.integration` naudoja būtent šią formą; ji ir yra
 * griežtesnis repo precedentas.
 */
const PRALEISTI = skipWithoutPostgres();

async function pg(url, sql, params = []) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await c.query(sql, params);
  } finally {
    await c.end();
  }
}

function dbVardas() {
  return new URL(DB_URL).pathname.replace(/^\//, "");
}

/**
 * ⚠️ RIBA IŠVEDAMA IŠ KATALOGO, NE RAŠOMA SKAIČIUMI.
 *
 * `migrate("up 11")` būtų teisingas šiandien ir tylia klaida rytoj: įterpus
 * migraciją prieš #157, skaičius rodytų ne tą ribą, o testas vis tiek žaliuotų —
 * tik tikrintų kitą schemos būseną. Todėl skaičiuojama, kelinta yra pirmoji
 * #157 migracija.
 */
function migracijuIkiPR1() {
  /**
   * ⚠️ DOTFILE'AI IŠMETAMI TA PAČIA TAISYKLE, KURIĄ TAIKO BIBLIOTEKA (Codex #289).
   *
   * `node-pg-migrate` numatytai ignoruoja `^\..*`
   * (`node_modules/node-pg-migrate/dist/bundle/index.js:2559`), o
   * `migrations/.gitkeep` egzistuoja. `readdirSync` jį grąžina, tad indeksas
   * buvo per didelis vienetu: `up <N>` pritaikydavo IR pirmąją #157 migraciją,
   * ir „krentanti" liko tik antroji. Testas tvirtino „SCHEMA NEPALIESTA", nors
   * vientisumo kolonos tuo metu jau buvo įsipareigotos — t. y. jis TEIGĖ
   * daugiau, nei parodė.
   *
   * Ad-hoc `!== ".gitkeep"` uždarytų šį atvejį ir praleistų kitą dotfile'ą;
   * kartojama bibliotekos taisyklė, ne simptomas.
   */
  const IGNORUOJAMI = /^\..*/;

  const failai = fs
    .readdirSync(path.join(ŠAKNIS, "migrations"))
    .filter((f) => !IGNORUOJAMI.test(f))
    .sort();

  const indeksas = failai.findIndex((f) => f.startsWith("1756100000000_"));

  assert.ok(indeksas > 0, "#157 PR-1 migracija privalo egzistuoti ir nebūti pirmoji");
  return indeksas;
}

function migruoti(kryptis = "up") {
  return execFileSync("npx", ["node-pg-migrate", ...kryptis.split(/\s+/).filter(Boolean)], {
    cwd: ŠAKNIS,
    env: { ...process.env, DATABASE_URL: DB_URL },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function tuscaDb() {
  const admin = adminDatabaseUrl();
  await pg(admin, `DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`);
  await pg(admin, `CREATE DATABASE "${dbVardas()}"`);
}

async function perkurtiDb() {
  await tuscaDb();
  migruoti("up");

  await pg(
    DB_URL,
    `INSERT INTO jobs (id, type, status, created_at, updated_at)
     VALUES ($1, 'transcription', 'completed', now(), now())`,
    [JOB_ID]
  );
}

after(async () => {
  if (PRALEISTI) return;
  await pg(adminDatabaseUrl(), `DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`).catch(() => {});
});

/**
 * Bando įrašyti `job_results` eilutę ir grąžina SQLSTATE arba `null`.
 *
 * ⚠️ GRĄŽINAMAS KODAS, NE `boolean`. „Atmesta" gali reikšti ir `23514`
 * (invariantas suveikė), ir `42703` (stulpelio nėra) — o tai visai kitas
 * gedimas. Testas, tenkinęsis `boolean`, žaliuotų dėl neteisingos priežasties.
 */
async function ideti(laukai) {
  const stulpeliai = ["job_id", "created_at", ...Object.keys(laukai)];
  const reiksmes = ["$1", "now()", ...Object.keys(laukai).map((_, i) => `$${i + 2}`)];

  try {
    await pg(
      DB_URL,
      `INSERT INTO job_results (${stulpeliai.join(", ")}) VALUES (${reiksmes.join(", ")})`,
      [JOB_ID, ...Object.values(laukai)]
    );
    return null;
  } catch (klaida) {
    return klaida.code;
  } finally {
    await pg(DB_URL, "DELETE FROM job_results WHERE job_id = $1", [JOB_ID]).catch(() => {});
  }
}

const RAKTAS = "results/aaaaaaaa-0000-4000-8000-000000000001/abc.json";
const SUMA = "e".repeat(64);

test("#157 PR-1: `job_results` external forma yra DB invariantas", { skip: PRALEISTI, timeout: 180000 }, async (t) => {
  await perkurtiDb();

  /* ═══ SARGAS 1: `fs` yra teisėta reikšmė ═══ */

  await t.test("`fs` reference įrašomas BE schemos apėjimo", async () => {
    assert.equal(
      await ideti({ storage_type: "fs", storage_key: RAKTAS, bytes: 1024, checksum: SUMA }),
      null,
      "`fs` privalo būti leistina `storage_type` reikšmė (#157: `FsArtifactStore` reference įrašomas be schemos apėjimo)"
    );
  });

  /* ═══ SARGAS 2: `payload IS NULL` external atveju ═══ */

  await t.test("external + `payload` ATMETAMAS", async () => {
    assert.equal(
      await ideti({
        storage_type: "s3",
        storage_key: RAKTAS,
        payload: JSON.stringify({ text: "x" }),
        bytes: 1024,
        checksum: SUMA,
      }),
      "23514",
      "hibridinė eilutė (external + payload) yra būtent tai, ką dabartinis `upsertResult()` sugeneruotų"
    );
  });

  /* ═══ SARGAS 3: `bytes IS NOT NULL` external atveju ═══ */

  await t.test("external be `bytes` ATMETAMAS", async () => {
    assert.equal(
      await ideti({ storage_type: "fs", storage_key: RAKTAS, checksum: SUMA }),
      "23514",
      "be dydžio restore verifikacija neturėtų ko palyginti"
    );
  });

  /* ═══ SARGAS 4: `checksum IS NOT NULL` external atveju ═══ */

  await t.test("external be `checksum` ATMETAMAS", async () => {
    assert.equal(
      await ideti({ storage_type: "fs", storage_key: RAKTAS, bytes: 1024 }),
      "23514",
      "be kontrolinės sumos patikra įrodytų tik tai, kad objektas skaitomas, ne kad jis tas pats"
    );
  });

  /* ═══ KONTROLĖS ═══
   *
   * ⚠️ Be jų invariantas galėtų būti „viską atmesti", ir keturi sargai aukščiau
   * praeitų nieko neįrodydami.
   */

  await t.test("KONTROLĖ: `inline` + `payload` ir toliau PRAEINA", async () => {
    assert.equal(
      await ideti({ storage_type: "inline", payload: JSON.stringify({ text: "x" }) }),
      null,
      "esama inline forma nesugriauta"
    );
  });

  await t.test("KONTROLĖ: `inline` be `bytes`/`checksum` PRAEINA", async () => {
    assert.equal(
      await ideti({ storage_type: "inline", payload: JSON.stringify({ text: "x" }) }),
      null,
      "naujos kolonos inline eilučių NEAPKRAUNA — privalomumas galioja tik external šakai"
    );
  });

  await t.test("KONTROLĖ: `inline` + `storage_key` ATMETAMAS", async () => {
    assert.equal(
      await ideti({ storage_type: "inline", payload: JSON.stringify({ text: "x" }), storage_key: RAKTAS }),
      "23514",
      "sena šaka gyva: inline eilutė rakto neturi"
    );
  });

  /* ═══ SARGAS 5-6: VIENTISUMO REIKŠMĖS, NE TIK JŲ BUVIMAS ═══
   *
   * ⚠️ CODEX RADINYS (#289). Sargai 1-4 tikrina, ar `bytes`/`checksum` YRA — bet
   * kiekviena jų paduodama reikšmė buvo galiojanti. `job_results_integrity_shape`
   * pašalinimas ar susilpninimas būtų palikęs visus testus žalius, o DB priimtų
   * `bytes = 0` ir `checksum = "nesuma"`. Restore verifikacija tada lygintų su
   * šiukšlėmis ir „praeitų".
   */

  await t.test("`bytes = 0` ATMETAMAS", async () => {
    assert.equal(
      await ideti({ storage_type: "fs", storage_key: RAKTAS, bytes: 0, checksum: SUMA }),
      "23514",
      "kanoninė JSON eilutė niekada nėra 0 baitų — nulis reiškia nutrauktą rašymą"
    );
  });

  await t.test("neigiamas `bytes` ATMETAMAS", async () => {
    assert.equal(
      await ideti({ storage_type: "fs", storage_key: RAKTAS, bytes: -1, checksum: SUMA }),
      "23514"
    );
  });

  await t.test("netinkamo formato `checksum` ATMETAMAS", async () => {
    for (const bloga of ["nesuma", "A".repeat(64), "e".repeat(63), "e".repeat(65), "sha256:" + SUMA]) {
      assert.equal(
        await ideti({ storage_type: "fs", storage_key: RAKTAS, bytes: 10, checksum: bloga }),
        "23514",
        `netinkamas checksum praėjo: ${bloga.slice(0, 20)}`
      );
    }
  });

  await t.test("KONTROLĖ: galiojantis `s3` reference PRAEINA (atgalinis suderinamumas)", async () => {
    /**
     * ⚠️ CODEX RADINYS (#289): `s3` VISUR BUVO LAUKIAMAS KAIP ATMETAMAS.
     *
     * Visi ankstesni `s3` įrašai sąmoningai netaisyklingos formos, o teisėtos
     * external kontrolės naudoja `fs`. Vadinasi mutacija `IN ('inline','fs')` —
     * `s3` pašalinimas iš allowlist — būtų palikusi rinkinį ŽALIĄ, nors atgalinis
     * suderinamumas sulaužytas: `s3` yra reikšmė, egzistavusi NUO PAT pradinės
     * migracijos, ir #157 jos nešalina.
     */
    assert.equal(
      await ideti({ storage_type: "s3", storage_key: RAKTAS, bytes: 4096, checksum: SUMA }),
      null,
      "`s3` lieka teisėta reikšme — #157 aibę PRAPLEČIA, ne pakeičia"
    );
  });

  await t.test("KONTROLĖ: mažiausia teisėta reikšmė (`{}` = 2 baitai) PRAEINA", async () => {
    /** Be jos `bytes > 0` galėtų būti sugriežtintas iki nesamos ribos ir niekas to nepamatytų. */
    assert.equal(
      await ideti({ storage_type: "fs", storage_key: RAKTAS, bytes: 2, checksum: SUMA }),
      null
    );
  });

  await t.test("KONTROLĖ: nežinomas `storage_type` ATMETAMAS", async () => {
    assert.equal(
      await ideti({ storage_type: "gcs", storage_key: RAKTAS, bytes: 1, checksum: SUMA }),
      "23514",
      "reikšmių aibė praplėsta `fs`, ne atidaryta"
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * MUTACIJOS: KIEKVIENAS SARGAS JAUČIAMAS ATSKIRAI
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ KODĖL TO REIKIA, NORS TESTAS JAU KRITO PRIEŠ MIGRACIJĄ.
 *
 * Raudonas raundas (CI 33854194027) parodė, kad VISI keturi sargai krenta —
 * bet visi su `42703` (stulpelio nėra), ne su `23514`. Tai įrodo, kad testas
 * jaučia migracijos NEBUVIMĄ, o ne kiekvieną invarianto dalį atskirai.
 * Pašalinus vien `bytes IS NOT NULL` iš `CHECK`, ankstesni testai vis tiek
 * kristų — bet tik todėl, kad kita mutacija juos laužia.
 *
 * Todėl sargas pašalinamas ČIA, PAČIAME TESTE, ir grąžinamas: mutacija
 * vykdoma, ne teigiama (§9.1). Tai vienintelis būdas įrodyti, kad kiekviena
 * `CHECK` dalis yra nešanti, o ne dekoratyvi.
 *
 * ⚠️ IZOLIACIJA: dirbama nuosavoje `<bazė>_extshape` DB, kuri po rinkinio
 * sunaikinama. `DROP CONSTRAINT` bendroje bazėje būtų tiksliai tai, ką
 * AGENTS.md §9.3 draudžia.
 */

const PILNA_FORMA = `
  CASE storage_type
    WHEN 'inline' THEN payload IS NOT NULL AND storage_key IS NULL
    ELSE storage_key IS NOT NULL
         AND payload IS NULL
         AND bytes IS NOT NULL
         AND checksum IS NOT NULL
  END
`;

async function suSusilpnintaForma(salyga, veiksmas) {
  await pg(DB_URL, "ALTER TABLE job_results DROP CONSTRAINT job_results_storage_shape");
  await pg(DB_URL, `ALTER TABLE job_results ADD CONSTRAINT job_results_storage_shape CHECK (${salyga})`);

  try {
    return await veiksmas();
  } finally {
    await pg(DB_URL, "ALTER TABLE job_results DROP CONSTRAINT job_results_storage_shape");
    await pg(
      DB_URL,
      `ALTER TABLE job_results ADD CONSTRAINT job_results_storage_shape CHECK (${PILNA_FORMA})`
    );
  }
}

test("#157 PR-1: kiekviena `CHECK` dalis yra NEŠANTI", { skip: PRALEISTI, timeout: 180000 }, async (t) => {
  await perkurtiDb();

  await t.test("be `payload IS NULL` — hibridinė eilutė ĮSIRAŠO", async () => {
    const kodas = await suSusilpnintaForma(
      `CASE storage_type
         WHEN 'inline' THEN payload IS NOT NULL AND storage_key IS NULL
         ELSE storage_key IS NOT NULL AND bytes IS NOT NULL AND checksum IS NOT NULL
       END`,
      () =>
        ideti({
          storage_type: "s3",
          storage_key: RAKTAS,
          payload: JSON.stringify({ text: "x" }),
          bytes: 1024,
          checksum: SUMA,
        })
    );

    assert.equal(kodas, null, "sargas pašalintas → eilutė praeina, vadinasi jis buvo nešantis");
  });

  await t.test("be `bytes IS NOT NULL` — eilutė be dydžio ĮSIRAŠO", async () => {
    const kodas = await suSusilpnintaForma(
      `CASE storage_type
         WHEN 'inline' THEN payload IS NOT NULL AND storage_key IS NULL
         ELSE storage_key IS NOT NULL AND payload IS NULL AND checksum IS NOT NULL
       END`,
      () => ideti({ storage_type: "fs", storage_key: RAKTAS, checksum: SUMA })
    );

    assert.equal(kodas, null, "`bytes` sąlyga jaučiama ATSKIRAI nuo `checksum`");
  });

  await t.test("be `checksum IS NOT NULL` — eilutė be sumos ĮSIRAŠO", async () => {
    const kodas = await suSusilpnintaForma(
      `CASE storage_type
         WHEN 'inline' THEN payload IS NOT NULL AND storage_key IS NULL
         ELSE storage_key IS NOT NULL AND payload IS NULL AND bytes IS NOT NULL
       END`,
      () => ideti({ storage_type: "fs", storage_key: RAKTAS, bytes: 1024 })
    );

    assert.equal(kodas, null, "`checksum` sąlyga jaučiama ATSKIRAI nuo `bytes`");
  });

  await t.test("KONTROLĖ: grąžinus pilną formą, tos pačios eilutės vėl ATMETAMOS", async () => {
    /**
     * ⚠️ BE ŠIOS DALIES mutacijos nieko neįrodytų: jos rodytų, kad susilpninta
     * forma praleidžia, bet ne kad pilna — atmeta. Tikrinama, kad `finally`
     * blokas invariantą tikrai atstatė.
     */
    assert.equal(await ideti({ storage_type: "fs", storage_key: RAKTAS, checksum: SUMA }), "23514");
    assert.equal(await ideti({ storage_type: "fs", storage_key: RAKTAS, bytes: 1024 }), "23514");
    assert.equal(
      await ideti({
        storage_type: "s3",
        storage_key: RAKTAS,
        payload: JSON.stringify({ text: "x" }),
        bytes: 1024,
        checksum: SUMA,
      }),
      "23514"
    );
  });

  await t.test("be `job_results_integrity_shape` — `bytes = 0` ir bloga suma ĮSIRAŠO", async () => {
    /**
     * ⚠️ Šis sargas yra ATSKIRAS `CHECK`, ne `storage_shape` dalis, tad jam
     * reikia savo mutacijos: susilpninus formą jis liktų galioti, ir atvirkščiai.
     */
    await pg(DB_URL, "ALTER TABLE job_results DROP CONSTRAINT job_results_integrity_shape");

    try {
      assert.equal(
        await ideti({ storage_type: "fs", storage_key: RAKTAS, bytes: 0, checksum: "nesuma" }),
        null,
        "sargas pašalintas → šiukšlės įsirašo, vadinasi jis buvo nešantis"
      );
    } finally {
      await pg(
        DB_URL,
        `ALTER TABLE job_results ADD CONSTRAINT job_results_integrity_shape CHECK (
           (bytes IS NULL OR bytes > 0)
           AND (checksum IS NULL OR checksum ~ '^[0-9a-f]{64}$')
         )`
      );
    }

    assert.equal(
      await ideti({ storage_type: "fs", storage_key: RAKTAS, bytes: 0, checksum: "nesuma" }),
      "23514",
      "KONTROLĖ: atstačius sargą tos pačios šiukšlės vėl atmetamos"
    );
  });

  await t.test("`fs` reikšmės sargas jaučiamas atskirai nuo formos", async () => {
    /**
     * Reikšmių aibė ir forma yra DU sargai vienoje migracijoje. Susilpninus
     * TIK reikšmes, forma privalo likti galiojanti — kitaip vienas testas
     * dengtų abu ir nė vieno neįrodytų.
     */
    await pg(DB_URL, "ALTER TABLE job_results DROP CONSTRAINT job_results_storage_type_values");
    await pg(
      DB_URL,
      "ALTER TABLE job_results ADD CONSTRAINT job_results_storage_type_values CHECK (storage_type IN ('inline', 's3'))"
    );

    try {
      assert.equal(
        await ideti({ storage_type: "fs", storage_key: RAKTAS, bytes: 1024, checksum: SUMA }),
        "23514",
        "grąžinus senąją aibę, `fs` vėl neįrašomas"
      );

      /**
       * ⚠️ IR PRIEŠINGA KRYPTIS: `s3` pašalinimas iš allowlist privalo būti
       * jaučiamas. Be šios pusės mutacija `IN ('inline','fs')` liktų nepagauta.
       */
      await pg(DB_URL, "ALTER TABLE job_results DROP CONSTRAINT job_results_storage_type_values");
      await pg(
        DB_URL,
        "ALTER TABLE job_results ADD CONSTRAINT job_results_storage_type_values CHECK (storage_type IN ('inline', 'fs'))"
      );

      assert.equal(
        await ideti({ storage_type: "s3", storage_key: RAKTAS, bytes: 4096, checksum: SUMA }),
        "23514",
        "pašalinus `s3`, galiojantis jo reference nebeįrašomas — vadinasi allowlist yra nešantis abiem reikšmėm"
      );
    } finally {
      await pg(DB_URL, "ALTER TABLE job_results DROP CONSTRAINT job_results_storage_type_values");
      await pg(
        DB_URL,
        "ALTER TABLE job_results ADD CONSTRAINT job_results_storage_type_values CHECK (storage_type IN ('inline', 'fs', 's3'))"
      );
    }

    assert.equal(
      await ideti({ storage_type: "fs", storage_key: RAKTAS, bytes: 1024, checksum: SUMA }),
      null,
      "KONTROLĖ: atstačius aibę `fs` vėl praeina"
    );
    assert.equal(
      await ideti({ storage_type: "s3", storage_key: RAKTAS, bytes: 4096, checksum: SUMA }),
      null,
      "KONTROLĖ: ir `s3` vėl praeina — abi reikšmės atstatytos"
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * ATNAUJINIMO KELIAS: PREFLIGHT SU PAVELDĖTA EILUTE
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ CODEX RADINYS (#289): PREFLIGHT BUVO NEGYVAS KODAS.
 *
 * Abu ankstesni testai migruoja TUŠČIĄ bazę, tad `DO $$` bloko sąlyga niekada
 * netiesa — jį pašalinus (ar sulaužius diagnostiką) niekas nekristų. O jis gina
 * vienintelį realų scenarijų: atnaujinimą bazės, kurioje SENOJI schema jau
 * leido `s3` eilutę su likusiu `payload` arba be vientisumo metaduomenų.
 *
 * Todėl migruojama TIK iki tėvinės schemos, pasėjama paveldėta eilutė, ir tada
 * paleidžiamos likusios migracijos.
 *
 * ⚠️ TIKRINAMA IR TAI, KAD BAZĖ LIEKA NEPALIESTA. Migracija, kuri krenta, bet
 * spėja pakeisti invariantą, būtų blogesnė už tą, kuri nekrenta: operatorius
 * gautų klaidą ir pusiau pakeistą schemą.
 */
test("#157 PR-1: paveldėta eilutė SUSTABDO migraciją, o ne pataisoma tyliai", { skip: PRALEISTI, timeout: 180000 }, async (t) => {
  await tuscaDb();
  migruoti(`up ${migracijuIkiPR1()}`);

  /** Prielaida: iki #157 tokia eilutė yra TEISĖTA — kitaip testas tikrintų ne tai. */
  await pg(
    DB_URL,
    `INSERT INTO jobs (id, type, status, created_at, updated_at)
     VALUES ($1, 'transcription', 'completed', now(), now())`,
    [JOB_ID]
  );
  await pg(
    DB_URL,
    `INSERT INTO job_results (job_id, storage_type, storage_key, payload, created_at)
     VALUES ($1, 's3', $2, $3::jsonb, now())`,
    [JOB_ID, RAKTAS, JSON.stringify({ text: "senas hibridas" })]
  );

  await t.test("migracija KRENTA su diagnostika", () => {
    let klaida = null;
    try {
      migruoti("up");
    } catch (e) {
      klaida = e;
    }

    assert.ok(klaida, "paveldėta pažeidžianti eilutė privalo sustabdyti migraciją");

    const tekstas = `${klaida.stdout || ""}${klaida.stderr || ""}${klaida.message || ""}`;
    assert.match(tekstas, /pažeidžiančias naują external formą/, "operatorius turi gauti PRIEŽASTĮ");
    assert.match(tekstas, /SELECT job_id/, "ir užklausą, kuria pamatys, kurias eilutes");
  });

  await t.test("DUOMENYS NEPALIESTI: `payload` tebėra", async () => {
    /**
     * ⚠️ ŠERDIS. Automatinis `UPDATE ... SET payload = NULL` būtų sunaikinęs
     * VIENINTELĘ rezultato kopiją — duomenų praradimas be operatoriaus sprendimo.
     */
    const { rows } = await pg(DB_URL, "SELECT payload, storage_type FROM job_results WHERE job_id = $1", [
      JOB_ID,
    ]);

    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].payload, null, "vienintelė rezultato kopija privalo išlikti");
    assert.equal(rows[0].storage_type, "s3");
  });

  await t.test("SCHEMA NEPALIESTA: ABI migracijos atšauktos viena transakcija", async () => {
    /**
     * ⚠️ TIKRINAMOS ABI, NE VIENA.
     *
     * `node-pg-migrate` numatytai visą paleidimą vykdo VIENOJE transakcijoje, tad
     * antrosios migracijos kritimas privalo atsukti ir pirmąją. Iki `.gitkeep`
     * pataisymo šis tvirtinimas buvo neįmanomas: pirmoji migracija būdavo
     * pritaikyta ATSKIRU ankstesniu paleidimu, tad kolonos likdavo.
     */
    const { rows: apribojimai } = await pg(
      DB_URL,
      `SELECT pg_get_constraintdef(c.oid) AS apibrezimas
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'job_results' AND c.conname = 'job_results_storage_type_values'`
    );

    assert.equal(apribojimai.length, 1);
    assert.equal(
      /'fs'/.test(apribojimai[0].apibrezimas),
      false,
      "antroji migracija (reikšmės ir forma) NEPRITAIKYTA"
    );

    const { rows: kolonos } = await pg(
      DB_URL,
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'job_results' AND column_name IN ('bytes', 'checksum')`
    );

    assert.deepEqual(
      kolonos.map((r) => r.column_name).sort(),
      [],
      "pirmoji migracija (vientisumo kolonos) TAIP PAT atšaukta — kritimas negali palikti pusiau pakeistos schemos"
    );
  });

  await t.test("KONTROLĖ: pašalinus pažeidžiančią eilutę migracija PRAEINA", async () => {
    /**
     * Be jos testas įrodytų tik tiek, kad migracija krenta — bet ne kad ji
     * krenta BŪTENT dėl tos eilutės. Praeitų ir visiškai sugedusi migracija.
     */
    await pg(DB_URL, "DELETE FROM job_results WHERE job_id = $1", [JOB_ID]);

    assert.doesNotThrow(() => migruoti("up"), "be paveldėtos eilutės kelias švarus");

    const { rows } = await pg(
      DB_URL,
      `SELECT pg_get_constraintdef(c.oid) AS apibrezimas
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'job_results' AND c.conname = 'job_results_storage_type_values'`
    );
    assert.match(rows[0].apibrezimas, /'fs'/, "dabar invariantas pritaikytas");
  });
});
