const { ArtifactStoreError } = require("./validation");

/**
 * ARTEFAKTŲ SAUGYKLOS PARINKIMAS (#157, PR-2).
 *
 * ⚠️ TA PATI FORMA KAIP `jobStore/backendSelection.js`, IR TAI NE ATSITIKTINUMAS.
 * Eksplicitinis backend'as be savo priklausomybės ten yra KLAIDA, ne įspėjimas;
 * čia galioja tas pats. Dvi skirtingos parinkimo semantikos viename repo reikštų,
 * kad operatorius turi atsiminti, kuri kur.
 *
 * ⚠️ `inline` NĖRA FALLBACK.
 *
 * Diegimuose be external konfigūracijos `inline` yra normalus, teisėtas ir po
 * #157 toliau palaikomas režimas - startas tokiu atveju yra TEISINGAS elgesys,
 * ne tyli degradacija. Draudžiamas kitas dalykas: pasirinkus `fs` ar `s3` ir jų
 * konfigūracijai esant netinkamai, GRĮŽTI į `inline` ir tęsti darbą. Tada dalis
 * rezultatų atsidurtų kitoje saugykloje, nei mano operatorius - ir tai paaiškėtų
 * tik tada, kai jų prireiktų.
 */

const LEISTINI = ["inline", "fs", "s3"];

/** Kiekvieno backend'o BŪTINI aplinkos kintamieji - vienas sąrašas, ne if'ai. */
const BUTINI = Object.freeze({
  inline: [],
  fs: ["ARTIFACT_FS_ROOT"],
  s3: ["ARTIFACT_S3_BUCKET", "ARTIFACT_S3_REGION", "ARTIFACT_S3_ACCESS_KEY", "ARTIFACT_S3_SECRET_KEY"],
});

/**
 * @returns {{backend: string, eksplicitinis: boolean}}
 */
function parinktiBackenda(env = process.env) {
  const eksplicitinis = env.ARTIFACT_STORE_BACKEND;

  if (!eksplicitinis) {
    /**
     * ⚠️ NENUMANOMA IŠ KITŲ KINTAMŲJŲ. Būtų patogu „atspėti" `s3`, jei nustatytas
     * `ARTIFACT_S3_BUCKET` - bet tada likęs nuo bandymų kintamasis tyliai
     * perjungtų rezultatų saugojimo vietą. Vieta keičiama TIK eksplicitiškai.
     */
    return { backend: "inline", eksplicitinis: false };
  }

  if (!LEISTINI.includes(eksplicitinis)) {
    throw new ArtifactStoreError(
      `ARTIFACT_STORE_BACKEND="${eksplicitinis}" nežinomas. Galimi: ${LEISTINI.join(", ")}.`,
      "ARTIFACT_CONFIG_INVALID"
    );
  }

  const truksta = BUTINI[eksplicitinis].filter((raktas) => {
    const reiksme = env[raktas];
    return typeof reiksme !== "string" || reiksme.trim() === "";
  });

  if (truksta.length > 0) {
    throw new ArtifactStoreError(
      `ARTIFACT_STORE_BACKEND="${eksplicitinis}", bet trūksta: ${truksta.join(", ")}. ` +
        "Grįžimas į `inline` NEGALIMAS: dalis rezultatų atsidurtų kitoje saugykloje, " +
        "nei mano operatorius, ir tai paaiškėtų tik tada, kai jų prireiktų.",
      "ARTIFACT_CONFIG_INVALID"
    );
  }

  return { backend: eksplicitinis, eksplicitinis: true };
}

/**
 * Sukuria saugyklą pagal parinktą backend'ą.
 *
 * ⚠️ `inline` REIKALAUJA VYKDYTOJO, ir jo čia negaminame: DB pool'ą valdo
 * `jobStore`/`postgresStore` sluoksnis. Antras pool'as tam pačiam procesui
 * reikštų antrą jungčių biudžetą, kurio niekas neskaičiuoja.
 */
function sukurtiSaugykla({ backend, env = process.env, vykdytojas = null } = {}) {
  if (backend === "inline") {
    const { createInlineArtifactStore } = require("./inlineStore");
    return createInlineArtifactStore({ vykdytojas });
  }

  if (backend === "fs") {
    const { createFsArtifactStore } = require("./fsStore");
    return createFsArtifactStore({ root: env.ARTIFACT_FS_ROOT });
  }

  const { createS3ArtifactStore } = require("./s3Store");
  return createS3ArtifactStore({
    bucket: env.ARTIFACT_S3_BUCKET,
    region: env.ARTIFACT_S3_REGION,
    accessKeyId: env.ARTIFACT_S3_ACCESS_KEY,
    secretAccessKey: env.ARTIFACT_S3_SECRET_KEY,
    endpoint: env.ARTIFACT_S3_ENDPOINT,
  });
}

module.exports = { LEISTINI, BUTINI, parinktiBackenda, sukurtiSaugykla };
