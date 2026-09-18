const crypto = require("node:crypto");

const { skipWithoutPostgres } = require("./helpers/postgresGuard");
const { skipWithoutMinio, minioKonfiguracija } = require("./helpers/minioGuard");
const { createS3ArtifactStore, CHECKSUM_REZIMAS } = require("../utils/artifactStore/s3Store");
const { paleistiMigracijosScenarijus } = require("./helpers/artifactMigrationScenarios");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * `inline` → external MIGRACIJA prieš `s3` (#157, PR-6).
 *
 * ⚠️ KĄ ŠIS FAILAS ĮRODO, IR KODĖL KONTRAKTO NEPAKAKO.
 *
 * Ne „migracija veikia", o kad TA PATI SEKA — `registras → put() → verify() →
 * atominis switch` — galioja ir prieš TINKLINĘ saugyklą.
 *
 * `ArtifactStore` kontraktas (PR-2) dengia SEMANTIKĄ ir ją dengia gerai. Bet jis
 * nedengia trijų dalykų, kuriais `s3` skiriasi nuo `fs` ne kontrakto, o KAINOS ir
 * LAIKO prasme, ir visi trys yra migracijos kelyje:
 *
 *   1. `verify()` per tinklą — po P1 taisymo jis PERSKAITO visą objektą, tad
 *      kiekviena eilutė reiškia parsisiuntimą to, ką ką tik įkėlėm;
 *   2. `put()` latencija partijoje — `--limit` grandinė prieš tinklą elgiasi
 *      kitaip nei prieš diską;
 *   3. klaidų taksonomija — `s3` klaidos ateina kaip atsakymai, ne kaip `errno`.
 *
 * ⚠️ ARGUMENTAS „KONTRAKTAS JAU DENGIA" ŠIAME REPO TRIS KARTUS PASIRODĖ NETIESA:
 * rinkinys, rašytas prieš `fs`, tyliai perimdavo jo savybes, ir tai pasimatydavo
 * TIK prieš antrą backend'ą. Todėl scenarijai ne kopijuojami, o paleidžiami tie
 * patys.
 *
 * ⚠️ REIKIA ABIEJŲ SERVISŲ. Failas importuoja ABU sargus, tad `suites.js` išveda
 * jį į ATSKIRĄ `postgresS3` rinkinį — ne į `postgres` ir ne į `s3`. Kitaip jis
 * praleistų save žingsnyje, kuriame trūksta svetimo serviso, ir sulaužytų TO
 * rinkinio „tikrai vykdytas" sargą (žr. `suites.js` komentarą).
 */

const PRALEISTI = skipWithoutPostgres() || skipWithoutMinio();

let klientas = null;
let kibiras = null;

/** S3 klientas TESTUI — atskiras nuo saugyklos, kad sugadinimas ją aplenktų. */
function s3Klientas(konfiguracija) {
  const { S3Client } = require("@aws-sdk/client-s3");

  return new S3Client({
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
}

paleistiMigracijosScenarijus("s3", {
  dbSuffix: "artifactmigrations3",
  praleisti: PRALEISTI,

  async paruostiSaugykla() {
    const { CreateBucketCommand, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } =
      require("@aws-sdk/client-s3");

    /** ⚠️ KIEKVIENAM PALEIDIMUI — SAVAS KIBIRAS (`minioGuard` taisyklė). */
    kibiras = `migracija-${crypto.randomUUID()}`;
    const konfiguracija = minioKonfiguracija(kibiras);

    klientas = s3Klientas(konfiguracija);
    await klientas.send(new CreateBucketCommand({ Bucket: kibiras }));

    return {
      saugykla: createS3ArtifactStore(konfiguracija),

      /**
       * ⚠️ RAŠOMA TIESIAI PER S3 KLIENTĄ, APLENKIANT SAUGYKLĄ.
       *
       * Per `put()` sugadinti neįmanoma — jis perskaičiuotų `checksum`. Objektas
       * privalo atrodyti taip, lyg pasikeitė PO mūsų rašymo, kaip ir `fs` pusėje.
       */
      async sugadinti(raktas) {
        const atsakymas = await klientas.send(
          new GetObjectCommand({ Bucket: kibiras, Key: raktas })
        );
        const baitai = Buffer.from(await atsakymas.Body.transformToByteArray());
        const priesIlgis = baitai.length;

        const i = baitai.findIndex((b, idx) => idx > 10 && b >= 0x61 && b <= 0x7a);
        if (i < 0) throw new Error("s3 fixture: kanoninėje eilutėje nerasta mažoji raidė");
        baitai[i] = baitai[i] === 0x7a ? 0x79 : baitai[i] + 1;

        await klientas.send(
          new PutObjectCommand({ Bucket: kibiras, Key: raktas, Body: baitai })
        );

        return priesIlgis;
      },

      async objektuKiekis() {
        const atsakymas = await klientas.send(new ListObjectsV2Command({ Bucket: kibiras }));
        return atsakymas.KeyCount || 0;
      },

      async isvalyti() {
        /**
         * ⚠️ KIBIRAS NENAIKINAMAS, IR TAI SĄMONINGA. MinIO konteineris gyvuoja
         * tik CI žingsnio trukmę, o `DeleteBucket` reikalautų prieš tai ištrinti
         * kiekvieną objektą — tai antras šalinimo kelias teste, kurio klaidos
         * maskuotų tikrus radinius. Vietoj to kiekvienas paleidimas ima SAVĄ
         * kibirą (`minioGuard` taisyklė), tad tarpusavio įtakos nėra.
         */
        if (klientas) await klientas.destroy();
        klientas = null;
      },
    };
  },
});
