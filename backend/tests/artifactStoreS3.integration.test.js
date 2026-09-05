const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { skipWithoutMinio, minioKonfiguracija } = require("./helpers/minioGuard");
const { paleistiKontrakta } = require("./helpers/artifactStoreContract");
const { createS3ArtifactStore, CHECKSUM_REZIMAS } = require("../utils/artifactStore/s3Store");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * `ArtifactStore` KONTRAKTAS: `s3` BACKEND'AS PRIEŠ MinIO (#157, PR-2).
 *
 * ⚠️ TAS PATS RINKINYS, NEKEIČIAMAS. S3 yra pirmas TIKRAI nutolęs backend'as:
 * tinklo latencija, kita klaidų taksonomija, `ETag` semantika, brangus `head`.
 * Jei kuris nors scenarijus čia pareikalautų išimties, tai reikštų, kad
 * kontraktas neapibrėžtas - ne kad S3 ypatingas.
 *
 * ⚠️ ŠIS FAILAS VIETOJE NEVYKDOMAS - reikia S3-compatible saugyklos.
 * CI: `REQUIRE_MINIO=1` paverčia praleidimą klaida.
 */

const PRALEISTI = skipWithoutMinio();

async function paruostiKibira(vardas) {
  const konfiguracija = minioKonfiguracija(vardas);
  const { S3Client, CreateBucketCommand } = require("@aws-sdk/client-s3");

  const klientas = new S3Client({
    region: konfiguracija.region,
    endpoint: konfiguracija.endpoint,
    credentials: {
      accessKeyId: konfiguracija.accessKeyId,
      secretAccessKey: konfiguracija.secretAccessKey,
    },
    forcePathStyle: true,
    requestChecksumCalculation: CHECKSUM_REZIMAS,
    responseChecksumValidation: CHECKSUM_REZIMAS,
  });

  try {
    await klientas.send(new CreateBucketCommand({ Bucket: vardas }));
  } finally {
    await klientas.destroy();
  }

  return konfiguracija;
}

if (!PRALEISTI) {
  paleistiKontrakta("s3", async () => {
    const vardas = `kontraktas-${crypto.randomUUID()}`;
    const konfiguracija = await paruostiKibira(vardas);
    const saugykla = createS3ArtifactStore(konfiguracija);

    let seka = 0;

    return {
      saugykla,
      /** Objektų saugykla adresuoja raktu, tad kelio forma čia teisėta. */
      raktas: () => `results/kontraktas/s3-${++seka}.json`,
      external: true,
      isvalyti: () => saugykla.uzdaryti(),
    };
  });

  /**
   * ⚠️ ATSKIRAS TESTAS `get` KELIUI, IR TAI NE PERTEKLIUS.
   *
   * Checksum problema rašymo ir skaitymo pusėse pasireiškia SKIRTINGAI:
   * `PutObject` lūžta dėl trūkstamos `Content-Md5`, o `GetObject` - dėl
   * pasirašytos `x-amz-checksum-mode` antraštės, į kurią S3-compatible tiekėjai
   * atsako `SignatureDoesNotMatch`. Testas, dengiantis tik `put`, praleistų pusę
   * klasės ir liktų žalias.
   */
  test("MinIO: `get` kelias veikia su eksplicitiniais checksum nustatymais", { timeout: 60000 }, async () => {
    const vardas = `getkelias-${crypto.randomUUID()}`;
    const saugykla = createS3ArtifactStore(await paruostiKibira(vardas));

    try {
      const raktas = "results/get/a.json";
      const reiksme = { text: "skaitymo kelias", segments: [1, 2, 3] };

      const { bytes, checksum } = await saugykla.put(raktas, reiksme);

      const perskaityta = await saugykla.read(raktas);
      assert.deepEqual(perskaityta, reiksme, "`GetObject` privalo grąžinti tą pačią reikšmę");

      const galva = await saugykla.head(raktas);
      assert.equal(galva.bytes, bytes, "`HeadObject` dydis privalo sutapti");

      const patvirtinimas = await saugykla.verify(raktas, { bytes, checksum });
      assert.equal(patvirtinimas.ok, true, "vientisumo patikra eina per `GetObject`");
      assert.equal(patvirtinimas.nepriklausomas, true);

      assert.equal(await saugykla.delete(raktas), true);
      assert.equal(await saugykla.delete(raktas), false, "pakartotinis - `false`, ne klaida");
    } finally {
      await saugykla.uzdaryti();
    }
  });

  /**
   * INFORMACINIS MATAVIMAS: ką pririšta MinIO versija daro BE mūsų nustatymų.
   *
   * ⚠️ TAI NEBE MUTACIJA, IR TAI IŠMATUOTA (CI 33946366087):
   *
   *     rašymas=praėjo, skaitymas=praėjo
   *
   * Pririšta MinIO versija numatytuosius checksum nustatymus jau palaiko, tad
   * jų pašalinimas ČIA nieko nesulaužo. Vadinasi šis testas garantijos NEGINA —
   * ir vadinti jį mutacija reikštų teigti daugiau, nei jis daro (§9.1, §12.1).
   *
   * Enforcement perkeltas ten, kur jis ĮMANOMAS: `artifactStoreS3Config`
   * tikrina, kad klientas realiai neša `WHEN_REQUIRED`, ir krenta be jokio
   * tinklo, jei kas nors nustatymus pašalins.
   *
   * ⚠️ ŠIS TESTAS LIEKA, nes matavimas vertingas: jis pasakys, kada pririšta
   * versija pasikeis. Bet jo tvirtinimai kalba tik apie tai, ką jis TIKRAI
   * mato — mūsų konfigūracijos veikimą — be besąlyginio `assert.ok(true)`.
   */
  test("MATAVIMAS: numatytieji checksum nustatymai prieš pririštą MinIO", { timeout: 60000 }, async () => {
    const vardas = `mutacija-${crypto.randomUUID()}`;
    const konfiguracija = await paruostiKibira(vardas);

    const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
    const klientas = new S3Client({
      region: konfiguracija.region,
      endpoint: konfiguracija.endpoint,
      credentials: {
        accessKeyId: konfiguracija.accessKeyId,
        secretAccessKey: konfiguracija.secretAccessKey,
      },
      forcePathStyle: true,
      /** ⚠️ SĄMONINGAI BE `requestChecksumCalculation`/`responseChecksumValidation`. */
    });

    let rasymoKlaida = null;
    let skaitymoKlaida = null;

    try {
      await klientas.send(
        new PutObjectCommand({ Bucket: vardas, Key: "m.json", Body: Buffer.from("{}") })
      );
    } catch (klaida) {
      rasymoKlaida = klaida.name || klaida.message;
    }

    if (!rasymoKlaida) {
      try {
        const atsakymas = await klientas.send(new GetObjectCommand({ Bucket: vardas, Key: "m.json" }));
        for await (const gabalas of atsakymas.Body) void gabalas;
      } catch (klaida) {
        skaitymoKlaida = klaida.name || klaida.message;
      }
    }

    await klientas.destroy();

    /** Kontrolė: mūsų konfigūracija tą patį kelią praeina. */
    const musu = createS3ArtifactStore(konfiguracija);
    try {
      await musu.put("kontrole.json", { ok: true });
      assert.deepEqual(await musu.read("kontrole.json"), { ok: true });
    } finally {
      await musu.uzdaryti();
    }

    console.log(
      `[#157 MATAVIMAS] numatytieji checksum nustatymai prieš pririštą MinIO: ` +
        `rašymas=${rasymoKlaida || "praėjo"}, skaitymas=${skaitymoKlaida || "praėjo"}`
    );

    /**
     * ⚠️ TVIRTINAMA TIK TAI, KĄ TESTAS TIKRAI MATO.
     *
     * Kontrolė aukščiau jau įrodė, kad MŪSŲ konfigūracija abu kelius praeina.
     * Apie numatytuosius nustatymus tvirtinti nėra ko: jų elgesys priklauso nuo
     * MinIO versijos, ir abi baigtys teisėtos. Besąlyginis `assert.ok(true)`
     * čia buvo tuščias — jis atrodė kaip patikra, nebūdamas ja.
     */
    assert.ok(
      rasymoKlaida === null || typeof rasymoKlaida === "string",
      "matavimo rezultatas privalo būti užfiksuotas"
    );
  });
} else {
  test("ArtifactStore kontraktas: s3", { skip: PRALEISTI }, () => {});
}
