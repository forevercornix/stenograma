const crypto = require("node:crypto");

const {
  ArtifactStoreError,
  KLAIDA,
  patikrintiRakta,
  paruostiReiksme,
  atkurtiReiksme,
} = require("./validation");

/**
 * `S3ArtifactStore` - artefaktai S3-compatible objektų saugykloje (#157, PR-2).
 *
 * ⚠️ TAIKINYS YRA S3-COMPATIBLE, NE AWS, IR TAI KEIČIA KONFIGŪRACIJĄ.
 *
 * Naujesnis AWS SDK įvedė privalomus integrity checksum'us ir tuo sulaužė
 * suderinamumą su daugeliu S3-compatible saugyklų: `PutObject` grąžina klaidą dėl
 * trūkstamos `Content-Md5` antraštės, o numatytoji `responseChecksumValidation`
 * reikšmė `WHEN_SUPPORTED` verčia SDK į kiekvieną `GetObject` dėti pasirašytą
 * `x-amz-checksum-mode` antraštę, dėl kurios trečiųjų šalių tiekėjai atsako
 * `SignatureDoesNotMatch`.
 *
 * ⚠️ ABI REIKŠMĖS NUSTATOMOS EKSPLICITIŠKAI, IR TAI NE STILIUS. Be šio komentaro
 * kitas žmogus jas „supaprastins" atgal į numatytąsias, o CI liks žalias tol, kol
 * kas nors paleis tai prieš tikrą taikinį. Mutacija (grąžinus numatytąsias) yra
 * dalis MinIO testo - žr. `artifactStoreS3.integration`.
 *
 * ⚠️ RAŠYMO IR SKAITYMO KELIAI LŪŽTA ATSKIRAI. `PutObject` klaida ateina dėl
 * `Content-Md5`, `GetObject` - dėl pasirašytos checksum-mode antraštės. Testas,
 * dengiantis tik `put`, praleistų pusę klasės.
 */

const CHECKSUM_REZIMAS = "WHEN_REQUIRED";

function createS3ArtifactStore({ bucket, endpoint, region, accessKeyId, secretAccessKey, forcePathStyle = true } = {}) {
  const truksta = Object.entries({ bucket, region, accessKeyId, secretAccessKey })
    .filter(([, reiksme]) => typeof reiksme !== "string" || reiksme.trim() === "")
    .map(([vardas]) => vardas);

  if (truksta.length > 0) {
    throw new ArtifactStoreError(
      `S3ArtifactStore: trūksta konfigūracijos: ${truksta.join(", ")}.`,
      "ARTIFACT_CONFIG_INVALID"
    );
  }

  const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } =
    require("@aws-sdk/client-s3");

  const klientas = new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
    /** `endpoint` neprivalomas: be jo klientas eina į tikrą AWS. */
    ...(endpoint ? { endpoint } : {}),
    /**
     * ⚠️ PATH-STYLE: S3-compatible saugyklos dažniausiai neturi virtual-host
     * DNS įrašų kiekvienam kibirui, tad numatytasis virtual-host stilius jose
     * duotų neišsprendžiamą vardą.
     */
    forcePathStyle,
    requestChecksumCalculation: CHECKSUM_REZIMAS,
    responseChecksumValidation: CHECKSUM_REZIMAS,
  });

  async function put(raktas, reiksme) {
    patikrintiRakta(raktas);
    const paruosta = paruostiReiksme(reiksme);

    await klientas.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: raktas,
        Body: paruosta.buferis,
        ContentType: "application/json",
      })
    );

    return { key: raktas, reference: raktas, bytes: paruosta.bytes, checksum: paruosta.checksum };
  }

  /** `NoSuchKey`/`NotFound` yra „objekto nėra", visa kita - tikras gedimas. */
  function arNera(klaida) {
    const kodas = klaida && (klaida.name || klaida.Code);
    return kodas === "NoSuchKey" || kodas === "NotFound" || klaida?.$metadata?.httpStatusCode === 404;
  }

  async function head(raktas) {
    patikrintiRakta(raktas);

    try {
      const atsakymas = await klientas.send(new HeadObjectCommand({ Bucket: bucket, Key: raktas }));

      /**
       * ⚠️ `checksum` NEGRĄŽINAMAS NET TADA, KAI SAUGYKLA TURI `ETag`.
       *
       * `ETag` nėra turinio suma: daugiadalio įkėlimo atveju tai dalių sumų
       * santrauka, o šifruotuose kibiruose - visai kita reikšmė. Grąžinus jį kaip
       * `checksum`, `verify()` lygintų dvi skirtingas prasmes ir kartais
       * „patvirtintų" nesutampantį objektą.
       */
      return { exists: true, bytes: Number(atsakymas.ContentLength) };
    } catch (klaida) {
      if (arNera(klaida)) return null;
      throw klaida;
    }
  }

  async function read(raktas) {
    const srautas = await readStream(raktas);
    const gabalai = [];
    for await (const gabalas of srautas) gabalai.push(Buffer.from(gabalas));

    return atkurtiReiksme(Buffer.concat(gabalai), raktas);
  }

  async function readStream(raktas) {
    patikrintiRakta(raktas);

    try {
      const atsakymas = await klientas.send(new GetObjectCommand({ Bucket: bucket, Key: raktas }));
      return atsakymas.Body;
    } catch (klaida) {
      if (arNera(klaida)) {
        throw new ArtifactStoreError(`S3ArtifactStore: objekto "${raktas}" nėra.`, KLAIDA.NERASTA);
      }
      throw klaida;
    }
  }

  async function verify(raktas, laukiama = {}) {
    let buferis;
    try {
      const srautas = await readStream(raktas);
      const gabalai = [];
      for await (const gabalas of srautas) gabalai.push(Buffer.from(gabalas));
      buferis = Buffer.concat(gabalai);
    } catch (klaida) {
      if (klaida.code === KLAIDA.NERASTA) {
        return { ok: false, exists: false, bytes: null, checksum: null, nepriklausomas: true };
      }
      throw klaida;
    }

    /**
     * ⚠️ SKAITOMAS VISAS OBJEKTAS, IR TAI SĄMONINGA KAINA. `ETag` netinka (žr.
     * `head()`), tad vientisumą galima patvirtinti tik perskaičius. Būtent dėl
     * to `verify()` metadata-only keliuose DRAUDŽIAMAS.
     */
    const checksum = crypto.createHash("sha256").update(buferis).digest("hex");
    const bytes = buferis.byteLength;

    return {
      ok: laukiama.bytes === bytes && laukiama.checksum === checksum,
      exists: true,
      bytes,
      checksum,
      nepriklausomas: true,
    };
  }

  async function del(raktas) {
    patikrintiRakta(raktas);

    /**
     * ⚠️ S3 `DeleteObject` NESANČIAM RAKTUI GRĄŽINA SĖKMĘ, tad „ar buvo" reikia
     * klausti atskirai. Kontraktas žada `false`, kai objekto nebuvo, ir šis
     * skirtumas yra 7.6c pamoka: tylus `true` atrodytų kaip ištrynimas.
     *
     * ⚠️ LANGAS LIEKA: tarp `head()` ir `delete()` objektą gali pašalinti kas
     * nors kitas, ir tada grąžinsime `true` už svetimą darbą. Užrašoma, o ne
     * nutylima - S3 atominės „ištrink ir pasakyk, ar buvo" operacijos neturi.
     */
    const buvo = (await head(raktas)) !== null;
    await klientas.send(new DeleteObjectCommand({ Bucket: bucket, Key: raktas }));
    return buvo;
  }

  async function uzdaryti() {
    await klientas.destroy();
  }

  return { backend: "s3", bucket, put, read, readStream, head, verify, delete: del, uzdaryti };
}

module.exports = { createS3ArtifactStore, CHECKSUM_REZIMAS };
