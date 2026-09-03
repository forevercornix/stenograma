const test = require("node:test");
const assert = require("node:assert/strict");
const { Pool } = require("pg");

const { testoAplinka } = require("./helpers/drRestoreEnv");
const { pasetiKeturisStatusus } = require("./helpers/postRestoreFixtures");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * 7.6c E2E APLINKOS PRIELAIDOS — VIETOJE, BE DUOMENŲ BAZĖS (#155, #250).
 *
 * ⚠️ KLAUSIMAS, Į KURĮ ŠIS FAILAS ATSAKO.
 *
 * Ne „ar DR procedūra veikia" (tai `drRestore.integration`), o „ar
 * `drRestore.integration` aplinka apskritai PILNA". Kiekvienas sargas paleidžiamas
 * su TA PAČIA `testoAplinka()` prieš NEPASIEKIAMĄ bazę, ir reikalaujama, kad jis
 * kristų dėl RYŠIO, ne dėl konfigūracijos.
 *
 * ⚠️ KODĖL TAI VERTA ATSKIRO FAILO.
 *
 * Trys CI raundai iš eilės krito ties aplinka: trūkstamas `AUDIT_ID_SALT`,
 * netinkama sesijos forma, base64 raktas vietoj hex. Visi trys atsako į klausimą,
 * kurį galima užduoti vietoje per sekundes — ir visi trys užėmė po ~4 minutes
 * CI, nė karto nepriartėję prie tikrinamo elgesio.
 *
 * ⚠️ NAUDOJAMA TA PATI `testoAplinka()`, NE JOS KOPIJA. Kopija ilgainiui gintų
 * nebe tą aplinką, kurią naudoja integracinis testas — ir patikra taptų
 * dekoracija.
 */

const NEPASIEKIAMA = "postgres://u:p@127.0.0.1:1/nera";

/** Ryšio gedimas = prielaida įvykdyta, kelias nuėjo iki bazės. */
const RYSIO_POZYMIAI = [
  /ECONNREFUSED/,
  /ENOTFOUND/,
  /EAI_AGAIN/,
  /connection to server/i,
  /nepasiekiama/i,
  /DEPLOYMENT_IDENTITY_MISSING/,
  /**
   * ⚠️ `ENOENT` PRIIMAMAS TIK `pg_dump` ŽINGSNIUI: jis reiškia, kad kelias
   * nuėjo iki binaro, t. y. aplinkos validacija PRAĖJO. Kitiems žingsniams
   * `ENOENT` neatsiranda.
   */
  /ENOENT/,
];

function arRysioGedimas(klaida) {
  const tekstas = `${klaida.code || ""} ${klaida.name || ""} ${klaida.message || ""}`;
  return RYSIO_POZYMIAI.some((p) => p.test(tekstas));
}

const A = "11111111-1111-4111-8111-111111111111";

async function tikRysys(vardas, veiksmas) {
  try {
    await veiksmas();
  } catch (klaida) {
    assert.ok(
      arRysioGedimas(klaida),
      `${vardas}: kelias krito dėl KONFIGŪRACIJOS, ne dėl ryšio — ` +
        `aplinka nepilna, ir CI tai parodytų tik po kelių minučių.\n  ` +
        `${klaida.code || klaida.name}: ${klaida.message}`
    );
  }
}

test("PRIELAIDOS: kiekvienas DR sargas krenta dėl RYŠIO, ne dėl konfigūracijos", async () => {
  const env = testoAplinka(NEPASIEKIAMA);
  const senas = { ...process.env };
  Object.assign(process.env, env);

  const auditStore = require("../utils/auditStore");
  const tombstones = require("../utils/deletionTombstones");
  const sesijuPg = require("../utils/sessionStore/postgresStore");
  const { createPostgresStore } = require("../utils/jobStore/postgresStore");
  const deploymentIdentity = require("../utils/deploymentIdentity");
  const restoredJobStore = require("../utils/restoredJobStore");
  const erasureExport = require("../utils/erasureExport");
  const pgDumpBackup = require("../utils/pgDumpBackup");
  const drCoordinator = require("../utils/drCoordinator");

  const pool = new Pool({ connectionString: NEPASIEKIAMA, connectionTimeoutMillis: 1500 });

  try {
    await tikRysys("auditStore.init", () => auditStore.init(process.env));
    await tikRysys("tombstones.init", () => tombstones.init(process.env));

    await tikRysys("sesijos.create", () =>
      sesijuPg
        .createPostgresStore(pool)
        .create({ id: A, role: "administrator", username: "admin" }, process.env)
    );

    await tikRysys("jobų sėjimas", () =>
      pasetiKeturisStatusus(createPostgresStore(pool), {
        ownerId: A,
        storageKey: (k) => `audio/${k}.wav`,
      })
    );

    await tikRysys("deploymentIdentity.skaitytiTapatybe", () =>
      deploymentIdentity.skaitytiTapatybe(pool)
    );

    /** Šie du DB neliečia — jie privalo PRAEITI, kitaip patikra būtų visada „ne". */
    assert.ok(restoredJobStore.sukurti(pool).system.remove, "adapteris sudaromas");
    assert.ok(erasureExport.saltinioTapatybe(process.env), "šaltinio tapatybė išvedama");

    const artefaktas = erasureExport.sudarytiArtefakta({
      zymos: [],
      horizontas: null,
      saltinis: erasureExport.saltinioTapatybe(process.env),
      deploymentId: A,
      env: process.env,
    });
    assert.ok(artefaktas.envelope.ciphertext, "artefaktas šifruojamas su ŠIA aplinka");

    await tikRysys("pgDumpBackup.sukurtiSifruotaKopija", () =>
      pgDumpBackup.sukurtiSifruotaKopija({
        databaseUrl: NEPASIEKIAMA,
        actor: "prielaidu-testas",
        env: process.env,
      })
    );

    await tikRysys("drCoordinator.patikrintiSargus", () =>
      drCoordinator.patikrintiSargus({
        targetUrl: NEPASIEKIAMA,
        artefaktas,
        vykdytojas: pool,
        env: process.env,
      })
    );
  } finally {
    await pool.end().catch(() => {});
    await tombstones.shutdown().catch(() => {});
    await auditStore.shutdown().catch(() => {});
    for (const raktas of Object.keys(env)) {
      if (senas[raktas] === undefined) delete process.env[raktas];
      else process.env[raktas] = senas[raktas];
    }
  }
});

test("KONTROLĖ: nepilna aplinka PAGAUNAMA (kitaip patikra būtų visada žalia)", async () => {
  /**
   * ⚠️ BE ŠIOS EILUTĖS ankstesnis testas praeitų ir tada, jei `arRysioGedimas()`
   * sakytų „taip" bet kam. Čia sąmoningai sugadinama viena reikšmė — tiksliai ta,
   * kuri realiai kainavo CI raundą.
   */
  const env = testoAplinka(NEPASIEKIAMA, { BACKUP_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64") });
  const erasureExport = require("../utils/erasureExport");

  assert.throws(
    () =>
      erasureExport.sudarytiArtefakta({
        zymos: [],
        horizontas: null,
        saltinis: "x",
        deploymentId: A,
        env,
      }),
    (klaida) => klaida.code === "BACKUP_KEY_INVALID" && !arRysioGedimas(klaida),
    "base64 raktas privalo būti atpažintas kaip KONFIGŪRACIJOS, ne ryšio gedimas"
  );
});

test("AUDITO LAUKAI: SQL išraiška išvedama iš saugyklos autoriteto", () => {
  /**
   * ⚠️ ŠI KLASĖ CI'UI KAINAVO DU RAUNDUS — 7.6a ir 7.6c.
   *
   * `audit_log` stulpeliai yra tik FILTRUOJAMI laukai; visa kita gyvena `meta`
   * JSONB. `SELECT outcome` krito su `42703: column "outcome" does not exist`.
   * Todėl E2E išraiška imama iš `auditStore/fields.js`, o ne rašoma ranka —
   * ir čia įrodoma, kad išvedimas tikrai skiria abu atvejus.
   */
  const { auditoLaukas } = require("./helpers/drRestoreEnv");
  const laukai = require("../utils/auditStore/fields");

  assert.equal(auditoLaukas("event"), "event", "stulpelis lieka stulpeliu");
  assert.equal(auditoLaukas("subjectId"), "subject_id", "camelCase → stulpelio vardas");
  assert.equal(auditoLaukas("outcome"), "meta->>'outcome'", "meta laukas → JSONB išraiška");

  /** KONTROLĖ: nežinomas laukas KRENTA, o ne virsta neegzistuojančiu stulpeliu. */
  assert.throws(() => auditoLaukas("nera_tokio"), /Nežinomas audito laukas/);

  /**
   * ⚠️ TIKRINAMA IR PRIELAIDA, ANT KURIOS STOVI VISKAS: kad `outcome` apskritai
   * yra `META_LAUKAI`, ne stulpeliuose. Perkėlus jį į stulpelius ši eilutė
   * kris — ir tai teisinga, nes tada pasikeis ir užklausa.
   */
  assert.ok(laukai.META_LAUKAI.includes("outcome"));
  assert.equal(laukai.STULPELIAI.outcome, undefined);
});
