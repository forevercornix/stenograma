const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * ⚠️ PER MODULIO ĮĖJIMĄ, NE per `backendSelection.js` tiesiogiai: vartotojai
 * (PR-3+) kvies `require("../utils/artifactStore")`, ir testas privalo eiti tuo
 * pačiu keliu — kitaip įėjimas galėtų nustoti eksportuoti parinkimą, o rinkinys
 * liktų žalias.
 */
const { parinktiBackenda, sukurtiSaugykla, LEISTINI, BUTINI } = require("../utils/artifactStore");

/**
 * ARTEFAKTŲ SAUGYKLOS PARINKIMAS (#157, PR-2).
 *
 * ⚠️ CENTRINIS KLAUSIMAS: `inline` yra TEISĖTAS REŽIMAS, BET NE FALLBACK.
 *
 * Diegimas be external konfigūracijos startuoja `inline` - tai normalu. Bet
 * pasirinkus `fs` ar `s3` su netinkama konfigūracija, grįžimas į `inline`
 * DRAUDŽIAMAS: dalis rezultatų atsidurtų kitoje saugykloje, nei mano
 * operatorius, ir tai paaiškėtų tik tada, kai jų prireiktų.
 */

test("be konfigūracijos - `inline`, ir tai NĖRA degradacija", () => {
  assert.deepEqual(parinktiBackenda({}), { backend: "inline", eksplicitinis: false });
});

test("eksplicitinis backend'as be priklausomybės KRENTA, o NEGRĮŽTA į `inline`", () => {
  for (const backend of ["fs", "s3"]) {
    for (const truksta of BUTINI[backend]) {
      /** Visi BŪTINI kintamieji, išskyrus vieną - tikrinamas KIEKVIENAS atskirai. */
      const env = { ARTIFACT_STORE_BACKEND: backend };
      for (const raktas of BUTINI[backend]) {
        if (raktas !== truksta) env[raktas] = "reikšmė";
      }

      let klaida = null;
      try {
        parinktiBackenda(env);
      } catch (e) {
        klaida = e;
      }

      assert.ok(klaida, `${backend}: be \`${truksta}\` privalo kristi`);
      assert.equal(klaida.code, "ARTIFACT_CONFIG_INVALID");
      assert.match(klaida.message, new RegExp(truksta), "žinutėje privalo būti TRŪKSTAMAS kintamasis");
      assert.match(klaida.message, /inline.*NEGALIMAS|NEGALIMAS/i, "ir priežastis, kodėl negrįžtama");
    }
  }
});

test("KONTROLĖ: su pilna konfigūracija tas pats backend'as PARENKAMAS", () => {
  /**
   * Be jos ankstesnis testas praeitų ir tada, jei parinkimas atmestų VISKĄ -
   * tada „fail-closed" būtų tiesiog neveikianti funkcija.
   */
  assert.deepEqual(
    parinktiBackenda({ ARTIFACT_STORE_BACKEND: "fs", ARTIFACT_FS_ROOT: "/tmp/artefaktai" }),
    { backend: "fs", eksplicitinis: true }
  );

  assert.deepEqual(
    parinktiBackenda({
      ARTIFACT_STORE_BACKEND: "s3",
      ARTIFACT_S3_BUCKET: "kibiras",
      ARTIFACT_S3_REGION: "us-east-1",
      ARTIFACT_S3_ACCESS_KEY: "raktas",
      ARTIFACT_S3_SECRET_KEY: "paslaptis",
    }),
    { backend: "s3", eksplicitinis: true }
  );
});

test("VIETA NEKEIČIAMA NUMANANT: likęs `ARTIFACT_S3_BUCKET` neperjungia backend'o", () => {
  /**
   * ⚠️ Būtų patogu „atspėti" `s3`, jei nustatytas kibiras. Bet tada likęs nuo
   * bandymų kintamasis TYLIAI perjungtų rezultatų saugojimo vietą - ir dalis
   * rezultatų atsidurtų ten, kur jų niekas neieškos.
   */
  assert.deepEqual(
    parinktiBackenda({ ARTIFACT_S3_BUCKET: "b", ARTIFACT_S3_REGION: "us-east-1" }),
    { backend: "inline", eksplicitinis: false }
  );
});

test("nežinomas backend'as KRENTA su galimų sąrašu", () => {
  let klaida = null;
  try {
    parinktiBackenda({ ARTIFACT_STORE_BACKEND: "gcs" });
  } catch (e) {
    klaida = e;
  }

  assert.ok(klaida);
  for (const leistinas of LEISTINI) {
    assert.match(klaida.message, new RegExp(leistinas), "operatoriui parodomi GALIMI variantai");
  }
});

test("sukurtiSaugykla ATMETA nežinomą backend'ą — allowlist'as neapeinamas", async () => {
  /**
   * ⚠️ FACTORY NETURI SAVO NUMATYTOJO KELIO (Codex, #290).
   *
   * Anksčiau paskutinė šaka buvo besąlyginė S3: `sukurtiSaugykla({ backend: "gcs" })`
   * su galiojančiais S3 kintamaisiais TYLIAI sukurdavo S3 saugyklą ir apeidavo
   * `parinktiBackenda()` allowlist'ą — rezultatai iškeliautų ne ten, kur mano
   * operatorius. Aibė viena (`LEISTINI`), ir abu keliai remiasi ja.
   */
  const s3Aplinka = {
    ARTIFACT_S3_BUCKET: "b",
    ARTIFACT_S3_REGION: "us-east-1",
    ARTIFACT_S3_ACCESS_KEY: "a",
    ARTIFACT_S3_SECRET_KEY: "s",
  };

  for (const backend of ["gcs", "S3", "", null, undefined, "fs "]) {
    await assert.rejects(
      () => sukurtiSaugykla({ backend, env: s3Aplinka }),
      (klaida) => klaida.code === "ARTIFACT_CONFIG_INVALID",
      `${JSON.stringify(backend)}: privalo būti atmestas, o ne tyliai tapti S3`
    );
  }
});

test("sukurtiSaugykla grąžina TĄ PATĮ paviršių visiems backend'ams", async () => {
  /**
   * ⚠️ PAVIRŠIAUS PARITETAS TIKRINAMAS ČIA, o elgesys - kontrakto rinkinyje.
   * Be šito trūkstamas metodas paaiškėtų tik pirmo kvietimo metu produkcijoje.
   */
  const { PRIVALOMI_METODAI } = require("./helpers/artifactStoreScenarios");
  const butini = PRIVALOMI_METODAI;

  /**
   * ⚠️ S3 ČIA KURIAMAS TIESIOGIAI, NE PER FACTORY.
   *
   * Factory S3 atveju LAUKIA versijavimo patikros (fail-closed startas), o ji
   * reikalauja tinklo. Paviršiaus paritetas yra formos klausimas, tad tinklo
   * priklausomybė čia būtų netikras testas; startą tikrina
   * `artifactStoreS3Protocol` ir MinIO rinkinys.
   */
  const { createS3ArtifactStore } = require("../utils/artifactStore/s3Store");

  const saugyklos = [
    await sukurtiSaugykla({ backend: "inline", vykdytojas: { query: async () => ({ rows: [] }) } }),
    await sukurtiSaugykla({
      backend: "fs",
      env: { ARTIFACT_FS_ROOT: path.join(os.tmpdir(), "artefaktai") },
    }),
    createS3ArtifactStore({
      bucket: "b",
      region: "us-east-1",
      accessKeyId: "a",
      secretAccessKey: "s",
      endpoint: "http://127.0.0.1:9000",
    }),
  ];

  for (const saugykla of saugyklos) {
    for (const metodas of butini) {
      assert.equal(
        typeof saugykla[metodas],
        "function",
        `${saugykla.backend}: trūksta \`${metodas}\``
      );
    }
  }

  assert.deepEqual(
    saugyklos.map((s) => s.backend),
    ["inline", "fs", "s3"]
  );
});

test("factory LAUKIA starto patikros VISIEMS backend'ams", async (t) => {
  /**
   * ⚠️ SĄLYGINIS LAUKIMAS ATKURTŲ TĄ PAČIĄ SPRAGĄ.
   *
   * Anksčiau laukta tik S3 šakoje, tad netinkamas `ARTIFACT_FS_ROOT` paaiškėdavo
   * per pirmą operaciją — jau po brangaus tiekėjo darbo. Todėl `patikrintiSaugykla()`
   * yra PRIVALOMAS visų backend'ų metodas, o factory kviečia jį be sąlygų: naujas
   * backend'as be starto patikros nebeatsiras tyliai.
   */
  const fsp = require("node:fs/promises");
  const failas = path.join(os.tmpdir(), `stenograma-parinkimas-failas-${process.pid}`);
  await fsp.writeFile(failas, "ne katalogas", "utf8");
  t.after(() => fsp.rm(failas, { force: true }));

  await assert.rejects(
    () => sukurtiSaugykla({ backend: "fs", env: { ARTIFACT_FS_ROOT: failas } }),
    (klaida) => klaida.code === "ARTIFACT_CONFIG_INVALID",
    "netinkama `fs` šaknis privalo sustabdyti STARTĄ, ne pirmą rašymą"
  );

  /** Kiekvienas backend'as PRIVALO turėti metodą — kitaip factory kvietimas kristų. */
  const saknis = await fsp.mkdtemp(path.join(os.tmpdir(), "stenograma-parinkimas-"));
  t.after(() => fsp.rm(saknis, { recursive: true, force: true }));

  const saugyklos = [
    await sukurtiSaugykla({ backend: "inline", vykdytojas: { query: async () => ({ rows: [], rowCount: 0 }) } }),
    await sukurtiSaugykla({ backend: "fs", env: { ARTIFACT_FS_ROOT: saknis } }),
  ];

  for (const saugykla of saugyklos) {
    assert.equal(
      typeof saugykla.patikrintiSaugykla,
      "function",
      `${saugykla.backend}: starto patikra privaloma visiems`
    );
  }
});
