/**
 * S3-suderinamos saugyklos integracinių testų sargas (#157, PR-2; #405).
 *
 * Simetriškas `postgresGuard.js`: be `S3_ENDPOINT` testai praleidžiami, o
 * `REQUIRE_S3=1` paverčia praleidimą KLAIDA.
 *
 * ⚠️ KODĖL `REQUIRE_S3`. Be jo pirmas nepakilęs konteineris paverstų CI žalią
 * į „nebuvo ko tikrinti" - ir tai būtų blogiausias derinys: infrastruktūros kaina
 * sumokėta, garantijos nulis. Tyliai praleisti integraciniai testai kuria
 * padengimo iliuziją.
 *
 * ⚠️ VARDUOSE NEBĖRA `MINIO`, IR TAI NE KOSMETIKA (#405).
 *
 * Iki #405 sargas vadinosi `minioGuard`, o kintamieji - `MINIO_*`. Išmatuota,
 * kad serverio pasirinkimas NĖRA testuojama sąlyga: keturios skirtingos
 * S3-suderinamos realizacijos (seaweedfs, garage, adobe/s3mock, localstack)
 * praėjo ESAMUS rinkinius identiškai, be nė vieno testo pakeitimo. Vardas,
 * įvardijantis vieną tiekėją, teigė daugiau, nei repo tikrina.
 *
 * ⚠️ SENŲJŲ VARDŲ NEBEPRIIMAME. `REQUIRE_MINIO` alias'as būtų tyli spraga:
 * senas CI kintamasis praeitų, o naujas sargas liktų neįjungtas.
 *
 * ⚠️ KIEKVIENAS TESTAS - SAVAS KIBIRAS. `node --test` failus vykdo lygiagrečiai,
 * tad bendras kibiras reikštų tą patį gedimo šaltinį, kurį Redis pusėje jau
 * turėjome su `flushdb` (žr. `redisGuard.js`).
 */

/**
 * ⚠️ SENI VARDAI META KLAIDĄ, O NE TYLI (#405, P2).
 *
 * Alias'o čia NĖRA ir nebus: du priimami vardai reiškia CI, kuris atrodo
 * apsaugotas ir nėra (#290 pamoka). Bet ir TYLĖJIMAS netinka — iki šios
 * patikros `REQUIRE_MINIO=1` be `S3_ENDPOINT` praeidavo, rinkinys tyliai
 * praleisdavo save, o job'as likdavo ŽALIAS. Tai tiksliai tas gedimas, dėl
 * kurio `REQUIRE_*` sargai apskritai egzistuoja, tik persikėlęs į vardą.
 *
 * Todėl senas vardas nebeveikia kaip TRIGERIS, bet veikia kaip STABDIS:
 * aplinka, kurioje jis yra, sustabdoma su migracijos nurodymu.
 *
 * ⚠️ TIKRINAMI TIKSLIAI DU VARDAI — tie, kurie anksčiau ką nors LEMDAVO:
 * `REQUIRE_MINIO` (įjungdavo sargą) ir `MINIO_ENDPOINT` (nurodydavo saugyklą).
 * `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY`/`MINIO_REGION` niekada nebuvo trigeriai
 * ir be pirmųjų dviejų nieko nekeisdavo.
 */
const MIGRACIJOS_VARDAI = ["REQUIRE_MINIO", "MINIO_ENDPOINT"];
const rastiSeni = MIGRACIJOS_VARDAI.filter((v) => process.env[v] !== undefined);

if (rastiSeni.length > 0) {
  throw new Error(
    `S3 sargas: aplinkoje rasti PASENĘ vardai (${rastiSeni.join(", ")}). ` +
      "Nuo #405 jie NEBEVEIKIA - nei kaip įjungimo trigeris, nei kaip adresas, " +
      "ir NĖRA alias'ai. Palikti tyliai reikštų, kad rinkinys praleidžia save, " +
      "o CI lieka žalias. Eksportuokite naujus vardus ir nuimkite senuosius:\n" +
      "  REQUIRE_S3=1              (vienintelis įjungimo vardas; buvo REQUIRE_MINIO)\n" +
      "  S3_ENDPOINT=http://...    (privalomas kartu su REQUIRE_S3; buvo MINIO_ENDPOINT)\n" +
      "  S3_ACCESS_KEY / S3_SECRET_KEY / S3_REGION   (neprivalomi; numatytieji >=16 simbolių)"
  );
}

const S3_ENDPOINT = process.env.S3_ENDPOINT;

const REQUIRED = process.env.REQUIRE_S3 === "1";

if (REQUIRED && !S3_ENDPOINT) {
  throw new Error(
    "REQUIRE_S3=1 nustatytas, bet S3_ENDPOINT nėra. " +
      "S3 integraciniai testai būtų praleisti tyliai, o CI liktų žalias jų nepaleidęs. " +
      "Nustatykite S3_ENDPOINT arba nuimkite vėliavą."
  );
}

/**
 * ⚠️ NUMATYTIEJI KREDENCIALAI - NE TRUMPESNI KAIP 16 SIMBOLIŲ (#405).
 *
 * Išmatuota `garage` zonde: 10 simbolių slaptasis raktas (`minioadmin`) atmetamas
 * jau importuojant („Secret keys should be at least 16 characters long"), raktas
 * NESUKURIAMAS, ir visos S3 užklausos keliauja be autorizacijos. Serveris atsako
 * klaidomis, kurios atrodo kaip mūsų kodo defektas.
 */
const NUMATYTAS_RAKTAS = "stenogramatestaccess";
const NUMATYTA_PASLAPTIS = "stenogramatestsecret0123456789";

/**
 * @returns {false | string} `false` - vykdyti; eilutė - praleidimo priežastis.
 */
function skipWithoutS3() {
  return S3_ENDPOINT
    ? false
    : "reikia S3_ENDPOINT su tikra S3-suderinama saugykla (CI: REQUIRE_S3=1)";
}

/** Konfigūracija `createS3ArtifactStore()` - viena vieta, kad testai nesiskirtų. */
function s3Konfiguracija(bucket) {
  if (!S3_ENDPOINT) return null;

  return {
    bucket,
    endpoint: S3_ENDPOINT,
    region: process.env.S3_REGION || "us-east-1",
    accessKeyId: process.env.S3_ACCESS_KEY || NUMATYTAS_RAKTAS,
    secretAccessKey: process.env.S3_SECRET_KEY || NUMATYTA_PASLAPTIS,
    forcePathStyle: true,
  };
}

module.exports = { skipWithoutS3, s3Konfiguracija, S3_ENDPOINT };
