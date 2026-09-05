const crypto = require("node:crypto");

const {
  ArtifactStoreError,
  KLAIDA,
  patikrintiRakta,
  paruostiReiksme,
  atkurtiReiksme,
  nesancioVerdiktas,
  vientisumoVerdiktas,
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

/**
 * ⚠️ „OBJEKTO NĖRA" ATPAŽĮSTAMA PAGAL TAPATYBĘ, NE PAGAL HTTP STATUSĄ
 * (Codex, #290).
 *
 * 404 grąžina ir neegzistuojantis KIBIRAS, ir blogas maršrutas, ir politika,
 * slepianti resurso egzistavimą. Suplakus juos su „nėra objekto", konfigūracijos
 * gedimas nueitų MISSING-OBJECT keliu — tuo pačiu, kurį #157 apibrėžia kaip
 * fail-closed remonto signalą. Klaidingai sukonfigūruota saugykla atrodytų kaip
 * dingęs artefaktas, ir orphan patikra imtų „taisyti" tai, kas nesugedę.
 *
 * ⚠️ EKSPORTUOJAMA TESTUI SĄMONINGAI: predikatą reikia tikrinti su klaidomis,
 * kurių tikra saugykla neduoda pagal užsakymą (`NoSuchBucket`, autorizacija).
 */
function arObjektoNera(klaida) {
  const kodas = klaida && (klaida.name || klaida.Code);
  return kodas === "NoSuchKey" || kodas === "NotFound";
}

/**
 * VERSIJUOTAS KIBIRAS — FAIL-CLOSED STARTAS (Codex P1, #290).
 *
 * ⚠️ `DeleteObject` versijuotame kibire sukuria tik DELETE MARKER: ankstesnė
 * versija lieka pasiekiama ir apmokestinama, o `delete()` grąžina `true`.
 * Autoritetingam erasure keliui tai reiškia PATVIRTINTĄ ištrynimą su išlikusia
 * transkripcija — tiksliai tai, ko 7.5a/7.6c grandinė neleidžia.
 *
 * ⚠️ KODĖL NE VISŲ VERSIJŲ ŠALINIMAS. Tam reikėtų `ListObjectVersions`, `delete()`
 * taptų neapibrėžtos trukmės operacija, o rezultatas vis tiek priklausytų nuo
 * bucket lifecycle politikos, kurios mes NEVALDOME. Fail-closed startas yra
 * sąžiningesnis: garantija arba įrodoma, arba diegimas nepakyla.
 */
async function patikrintiVersijavima(klientas, bucket) {
  const { GetBucketVersioningCommand } = require("@aws-sdk/client-s3");

  const atsakymas = await klientas.send(new GetBucketVersioningCommand({ Bucket: bucket }));
  const busena = atsakymas && atsakymas.Status;

  if (busena === "Enabled" || busena === "Suspended") {
    throw new ArtifactStoreError(
      `S3ArtifactStore: kibiras "${bucket}" yra versijuotas (${busena}). ` +
        "Ištrynimo garantija versijuotame kibire NEĮRODOMA: `DeleteObject` palieka " +
        "ankstesnę versiją, o erasure kelias praneštų sėkmę su išlikusia transkripcija. " +
        "Naudokite neversijuotą kibirą arba lifecycle politiką, kuri versijas šalina " +
        "(už #157 apimties — žr. `docs/deletion-guarantees.md`).",
      "ARTIFACT_CONFIG_INVALID"
    );
  }

  return { versijavimas: busena || "Disabled" };
}

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

  function arNera(klaida) {
    return arObjektoNera(klaida);
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
      if (klaida.code === KLAIDA.NERASTA) return nesancioVerdiktas(true);
      throw klaida;
    }

    /**
     * ⚠️ SKAITOMAS VISAS OBJEKTAS, IR TAI SĄMONINGA KAINA. `ETag` netinka (žr.
     * `head()`), tad vientisumą galima patvirtinti tik perskaičius. Būtent dėl
     * to `verify()` metadata-only keliuose DRAUDŽIAMAS.
     */
    const checksum = crypto.createHash("sha256").update(buferis).digest("hex");
    const bytes = buferis.byteLength;

    return vientisumoVerdiktas({ laukiama, bytes, checksum, nepriklausomas: true });
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

  /**
   * STARTO PATIKRA — kviečiama prieš pirmą naudojimą.
   *
   * ⚠️ ATSKIRA NUO KONSTRUKTORIAUS, nes reikalauja tinklo. Konstruktorius lieka
   * sinchroninis ir tikrina tik konfigūracijos pilnumą; tinklinė patikra gyvena
   * čia, kad startas galėtų ją paleisti fail-closed tvarka.
   */
  async function patikrintiSaugykla() {
    return patikrintiVersijavima(klientas, bucket);
  }

  /**
   * ⚠️ TESTO SEAMAS, IR JIS UŽRAŠYTAS.
   *
   * Checksum nustatymai yra TIKRINAMA sąlyga, bet pririšta MinIO versija juos
   * jau palaiko ir be mūsų (išmatuota, CI 33946366087), tad mutacija prieš ją
   * nieko nesulaužo. Vienintelis vietoje įvykdomas enforcement — patvirtinti,
   * kad KLIENTAS realiai neša tas reikšmes: pašalinus jas iš konstruktoriaus,
   * SDK grąžina `WHEN_SUPPORTED`, ir testas krenta be jokio tinklo.
   */
  async function klientoNustatymai() {
    const skaityti = async (laukas) => {
      const reiksme = klientas.config[laukas];
      return typeof reiksme === "function" ? reiksme() : reiksme;
    };

    return {
      requestChecksumCalculation: await skaityti("requestChecksumCalculation"),
      responseChecksumValidation: await skaityti("responseChecksumValidation"),
    };
  }

  async function uzdaryti() {
    await klientas.destroy();
  }

  return {
    backend: "s3",
    bucket,
    put,
    read,
    readStream,
    head,
    verify,
    delete: del,
    patikrintiSaugykla,
    klientoNustatymai,
    uzdaryti,
  };
}

module.exports = { createS3ArtifactStore, CHECKSUM_REZIMAS, arObjektoNera, patikrintiVersijavima };
