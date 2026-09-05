const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const {
  createS3ArtifactStore,
  CHECKSUM_REZIMAS,
  arObjektoNera,
} = require("../utils/artifactStore/s3Store");

/**
 * `S3ArtifactStore` SPRENDIMAI, TIKRINAMI BE TINKLO (#157, PR-2).
 *
 * ⚠️ KODĖL VIETOJE, O NE PRIEŠ MinIO.
 *
 * Trys dalykai čia neįrodomi prieš tikrą saugyklą: `NoSuchBucket` klaidos ji
 * pagal užsakymą neduoda, versijuoto kibiro CI'uje nekuriame, o checksum
 * nustatymų mutacijos pririšta MinIO versija NESULAUŽO (išmatuota, CI
 * 33946366087). Vietinis testas juos padengia deterministiškai.
 */

test("404 NESUPLAKAMAS su nesančiu objektu", () => {
  /**
   * ⚠️ 404 grąžina ir neegzistuojantis KIBIRAS, ir blogas maršrutas. Suplakus
   * juos, konfigūracijos gedimas nueitų MISSING-OBJECT keliu — tuo pačiu, kurį
   * #157 apibrėžia kaip fail-closed remonto signalą.
   */
  const klaida = (name, statusas) => {
    const e = new Error(name);
    e.name = name;
    e.$metadata = { httpStatusCode: statusas };
    return e;
  };

  assert.equal(arObjektoNera(klaida("NoSuchKey", 404)), true);
  assert.equal(arObjektoNera(klaida("NotFound", 404)), true);

  for (const [vardas, statusas] of [
    ["NoSuchBucket", 404],
    ["AccessDenied", 403],
    ["PermanentRedirect", 301],
    ["InvalidAccessKeyId", 403],
  ]) {
    assert.equal(
      arObjektoNera(klaida(vardas, statusas)),
      false,
      `${vardas} yra TIKRAS gedimas, ne dingęs objektas`
    );
  }
});

/**
 * ⚠️ VERSIJAVIMO BŪSENŲ MATRICA GYVENA `artifactStoreS3Protocol`.
 *
 * Ji ten praplėsta iki visos klasės (`Enabled`, `Suspended`, nežinoma būsena,
 * tuščias atsakymas, ne objektas) ir papildyta tikrinimu, kad NĖ VIENA operacija
 * nevyksta, kol politika nepatikrinta. Dvi to paties sargo namų vietos reikštų, kad
 * pakeitus taisyklę reikia atsiminti abi.
 */

test("CHECKSUM nustatymai realiai PATENKA į klientą", async () => {
  /**
   * ⚠️ TAI VIENINTELIS VIETOJE ĮVYKDOMAS ENFORCEMENT.
   *
   * Pririšta MinIO versija numatytuosius nustatymus jau palaiko (išmatuota), tad
   * mutacija prieš ją nieko nesulaužo. Bet pašalinus juos iš konstruktoriaus,
   * SDK grąžina `WHEN_SUPPORTED` — ir šis testas krenta BE JOKIO tinklo.
   *
   * Be jo matricos eilutė teigtų garantiją, kurios niekas negina (§9.1, §12.1).
   */
  const saugykla = createS3ArtifactStore({
    bucket: "b",
    region: "us-east-1",
    accessKeyId: "a",
    secretAccessKey: "s",
    endpoint: "http://127.0.0.1:9000",
  });

  try {
    assert.deepEqual(await saugykla.klientoNustatymai(), {
      requestChecksumCalculation: CHECKSUM_REZIMAS,
      responseChecksumValidation: CHECKSUM_REZIMAS,
    });
  } finally {
    await saugykla.uzdaryti();
  }
});

test("KONTROLĖ: be nustatymų SDK grąžina KITĄ reikšmę", async () => {
  /**
   * Be šios pusės ankstesnis testas praeitų ir tada, jei `WHEN_REQUIRED` būtų
   * SDK numatytoji reikšmė — tada tvirtinimas nieko neįrodytų apie mūsų
   * konstruktorių.
   */
  const { S3Client } = require("@aws-sdk/client-s3");
  const klientas = new S3Client({
    region: "us-east-1",
    credentials: { accessKeyId: "a", secretAccessKey: "s" },
  });

  try {
    const reiksme = klientas.config.requestChecksumCalculation;
    const numatytoji = typeof reiksme === "function" ? await reiksme() : reiksme;

    assert.notEqual(
      numatytoji,
      CHECKSUM_REZIMAS,
      "SDK numatytoji reikšmė privalo SKIRTIS — kitaip mūsų nustatymas nieko nekeičia"
    );
  } finally {
    await klientas.destroy();
  }
});
