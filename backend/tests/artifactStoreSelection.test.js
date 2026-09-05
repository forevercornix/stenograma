const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { parinktiBackenda, sukurtiSaugykla, LEISTINI, BUTINI } = require("../utils/artifactStore/backendSelection");

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

test("sukurtiSaugykla grąžina TĄ PATĮ paviršių visiems backend'ams", () => {
  /**
   * ⚠️ PAVIRŠIAUS PARITETAS TIKRINAMAS ČIA, o elgesys - kontrakto rinkinyje.
   * Be šito trūkstamas metodas paaiškėtų tik pirmo kvietimo metu produkcijoje.
   */
  const butini = ["put", "read", "readStream", "head", "verify", "delete"];

  const saugyklos = [
    sukurtiSaugykla({ backend: "inline", vykdytojas: { query: async () => ({ rows: [] }) } }),
    sukurtiSaugykla({ backend: "fs", env: { ARTIFACT_FS_ROOT: path.join(os.tmpdir(), "artefaktai") } }),
    sukurtiSaugykla({
      backend: "s3",
      env: {
        ARTIFACT_S3_BUCKET: "b",
        ARTIFACT_S3_REGION: "us-east-1",
        ARTIFACT_S3_ACCESS_KEY: "a",
        ARTIFACT_S3_SECRET_KEY: "s",
        ARTIFACT_S3_ENDPOINT: "http://127.0.0.1:9000",
      },
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
