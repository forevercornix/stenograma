const { ArtifactStoreError, KLAIDA, atkurtiReiksme } = require("./validation");

/**
 * RIBOTAS SKAITYMAS — HIDRATACIJA NEGALI BŪTI NERIBOTA (#157, PR-3).
 *
 * ⚠️ KODĖL NEUŽTENKA PERSISTINTO `bytes` (Codex P2, #289).
 *
 * Pigi patikra „persistintas dydis > riba" taupo I/O, bet nieko negarantuoja: jei
 * objektas saugykloje perrašytas ar sugadintas iki didesnio, pasenusi maža reikšmė
 * patikrą PRAEINA, ir į atmintį vis tiek patenka savavališkai didelis turinys.
 * Ribotumą duoda TIK skaitiklis skaitymo metu.
 *
 * ⚠️ DVI RIBOS — DVI SKIRTINGOS PRASMĖS, TAD IR DVI KLAIDOS.
 *
 *   · viršytas `MAX_RESULT_BYTES` → `ResultLimitError`: rezultatas per didelis
 *     šiam diegimui, ir tai konfigūracijos bei politikos klausimas;
 *   · viršytas PERSISTINTAS dydis → `ARTIFACT_CORRUPT`: objektas nebeatitinka to,
 *     kas apie jį įrašyta, t. y. saugykloje guli ne tas turinys. Tylus priėmimas
 *     čia reikštų, kad hidratacija grąžina duomenis, kurių vientisumas paneigtas.
 *
 * ⚠️ ŠIS KELIAS NEPAKEIČIA `readStream()`. Žalių baitų kelias (download, backup,
 * artefakto kopijavimas) lieka srautinis; čia baitai kaupiami sąmoningai, nes
 * loginis `job.result` galiausiai vis tiek tampa objektu atmintyje. Ribotumas
 * reiškia „ne daugiau nei riba", ne „be atminties".
 */

/**
 * @param {object} saugykla `ArtifactStore`
 * @param {string} raktas
 * @param {{maxBaitai: number, deklaruotiBaitai?: number|null}} ribos
 * @returns {Promise<{reiksme: *, bytes: number}>}
 */
async function skaitytiRibotai(saugykla, raktas, { maxBaitai, deklaruotiBaitai = null } = {}) {
  if (!Number.isInteger(maxBaitai) || maxBaitai <= 0) {
    throw new TypeError("skaitytiRibotai: `maxBaitai` privalo būti teigiamas sveikasis skaičius.");
  }

  const { ResultLimitError, LIMIT_KIND } = require("../resultLimits");

  /**
   * ⚠️ STABDIS YRA MAŽESNYSIS IŠ DVIEJŲ. Deklaruotas dydis dažniausiai griežtesnis,
   * ir jo viršijimas pasimato anksčiau nei bendra riba — tad sugadinimas aptinkamas
   * nepertempus atminties iki `MAX_RESULT_BYTES`.
   */
  const deklaruotas =
    Number.isInteger(deklaruotiBaitai) && deklaruotiBaitai >= 0 ? deklaruotiBaitai : null;
  const stabdis = deklaruotas === null ? maxBaitai : Math.min(deklaruotas, maxBaitai);

  const srautas = await saugykla.readStream(raktas);
  const gabalai = [];
  let bytes = 0;

  for await (const gabalas of srautas) {
    const dalis = Buffer.from(gabalas);
    bytes += dalis.byteLength;

    if (bytes > stabdis) {
      /** Nutraukiame skaitymą: likusi objekto dalis mūsų atminties nebeliečia. */
      if (typeof srautas.destroy === "function") srautas.destroy();

      if (deklaruotas !== null && bytes > deklaruotas) {
        throw new ArtifactStoreError(
          `ArtifactStore: objektas "${raktas}" didesnis, nei apie jį įrašyta ` +
            `(deklaruota ${deklaruotas} B). Turinys neatitinka metaduomenų.`,
          KLAIDA.SUGADINTAS
        );
      }

      throw new ResultLimitError({ kind: LIMIT_KIND.RESULT_BYTES, limit: maxBaitai, actual: bytes });
    }

    gabalai.push(dalis);
  }

  /**
   * ⚠️ MAŽESNIS UŽ DEKLARUOTĄ IRGI YRA NEATITIKIMAS. Nupjautas objektas dažniausiai
   * nebus galiojantis JSON, bet remtis tuo būtų prielaida: patikrinama tiesiogiai,
   * kad hidratacija negrąžintų dalies turinio kaip viso.
   */
  if (deklaruotas !== null && bytes !== deklaruotas) {
    throw new ArtifactStoreError(
      `ArtifactStore: objekto "${raktas}" dydis (${bytes} B) nesutampa su įrašytu ` +
        `(${deklaruotas} B). Turinys neatitinka metaduomenų.`,
      KLAIDA.SUGADINTAS
    );
  }

  return { reiksme: atkurtiReiksme(Buffer.concat(gabalai), raktas), bytes };
}

module.exports = { skaitytiRibotai };
