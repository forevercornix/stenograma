/**
 * MinIO (S3-compatible) integracinių testų sargas (#157, PR-2).
 *
 * Simetriškas `postgresGuard.js`: be `MINIO_ENDPOINT` testai praleidžiami, o
 * `REQUIRE_MINIO=1` paverčia praleidimą KLAIDA.
 *
 * ⚠️ KODĖL `REQUIRE_MINIO`. Be jo pirmas nepakilęs konteineris paverstų CI žalią
 * į „nebuvo ko tikrinti" - ir tai būtų blogiausias derinys: infrastruktūros kaina
 * sumokėta, garantijos nulis. Tyliai praleisti integraciniai testai kuria
 * padengimo iliuziją, o čia jie yra VIENINTELIS būdas patikrinti checksum
 * konfigūraciją, kuri prieš AWS veiktų ir be jos.
 *
 * ⚠️ KIEKVIENAS TESTAS - SAVAS KIBIRAS. `node --test` failus vykdo lygiagrečiai,
 * tad bendras kibiras reikštų tą patį gedimo šaltinį, kurį Redis pusėje jau
 * turėjome su `flushdb` (žr. `redisGuard.js`).
 */

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT;

/**
 * ⚠️ PRIIMAMI ABU VARDAI, IR TAI NE PATOGUMAS (Codex, #290).
 *
 * Planas dokumentavo `REQUIRE_S3=1`, o implementacija tikrino `REQUIRE_MINIO` —
 * dokumentuota patikros komanda praleisdavo VIENINTELĮ S3 rinkinį ir vis tiek
 * baigdavosi sėkme. Sargas, kurio vardas priklauso nuo to, kurį dokumentą skaitei,
 * nėra sargas.
 *
 * Autoritetingas vardas yra `REQUIRE_MINIO` (jį naudoja CI), bet `REQUIRE_S3` irgi
 * priimamas: klysti privalo SAUGIA kryptimi — geriau papildomas gedimas, nei tylus
 * praleidimas.
 */
const REQUIRED = process.env.REQUIRE_MINIO === "1" || process.env.REQUIRE_S3 === "1";

if (REQUIRED && !MINIO_ENDPOINT) {
  throw new Error(
    "REQUIRE_MINIO=1 (arba REQUIRE_S3=1) nustatytas, bet MINIO_ENDPOINT nėra. " +
      "S3 integraciniai testai būtų praleisti tyliai, o CI liktų žalias jų nepaleidęs. " +
      "Nustatykite MINIO_ENDPOINT arba nuimkite vėliavą."
  );
}

/**
 * @returns {false | string} `false` - vykdyti; eilutė - praleidimo priežastis.
 */
function skipWithoutMinio() {
  return MINIO_ENDPOINT
    ? false
    : "reikia MINIO_ENDPOINT su tikra S3-compatible saugykla (CI: REQUIRE_MINIO=1)";
}

/** Konfigūracija `createS3ArtifactStore()` - viena vieta, kad testai nesiskirtų. */
function minioKonfiguracija(bucket) {
  if (!MINIO_ENDPOINT) return null;

  return {
    bucket,
    endpoint: MINIO_ENDPOINT,
    region: process.env.MINIO_REGION || "us-east-1",
    accessKeyId: process.env.MINIO_ACCESS_KEY || "minioadmin",
    secretAccessKey: process.env.MINIO_SECRET_KEY || "minioadmin",
    forcePathStyle: true,
  };
}

module.exports = { skipWithoutMinio, minioKonfiguracija, MINIO_ENDPOINT };
