const { CLAIM_ORIGIN, EVIDENCE_REQUIRED_FIELDS } = require("./protocolRubric");

/**
 * ATSEKAMUMAS (#24.1).
 *
 * ⚠️ SKLANDUS PROTOKOLAS GALI BŪTI VISIŠKAI NETEISINGAS.
 *
 * Kalbos modelis generuoja tekstą, kuris skamba įtikinamai, nepriklausomai nuo
 * to, ar jis pagrįstas įrašu. Todėl vertinimo klausimas yra ne „ar skamba
 * gerai", o „ar galima atsekti".
 *
 * Šis modulis apibrėžia, KAIP atsekamumas fiksuojamas ir tikrinamas.
 */

/**
 * NUORODOS FORMATAS.
 *
 * ⚠️ NUORODA YRA POZICIJA, NE TEKSTAS.
 *
 * Natūralu būtų saugoti citatą („modelis rėmėsi šiuo sakiniu"), bet tada
 * atsekamumo įrašas taptų transkripcijos kopija — su visais asmens duomenimis
 * ir jokia retencija.
 *
 * Vietoj to saugoma pozicija: segmento indeksas arba laiko intervalas.
 * Patikrinti galima turint transkripciją; be jos nuoroda nieko neatskleidžia.
 */
function createEvidenceReference({ segmentIndex, startMs, endMs }) {
  const hasSegment = Number.isInteger(segmentIndex) && segmentIndex >= 0;
  const hasTime = Number.isFinite(startMs) && Number.isFinite(endMs);

  if (!hasSegment && !hasTime) {
    const error = new Error("Nuoroda privalo turėti segmento indeksą arba laiko intervalą.");
    error.code = "EVIDENCE_REFERENCE_INVALID";
    throw error;
  }

  if (hasTime && endMs < startMs) {
    const error = new Error("Nuorodos pabaiga anksčiau nei pradžia.");
    error.code = "EVIDENCE_REFERENCE_INVALID";
    throw error;
  }

  return {
    ...(hasSegment ? { segmentIndex } : {}),
    ...(hasTime ? { startMs, endMs } : {}),
  };
}

/**
 * Ar teiginys turi pakankamą pagrindimą?
 *
 * @param {object} claim
 * @param {string} claim.protocolField - kuriame protokolo lauke teiginys
 * @param {string} claim.origin - `CLAIM_ORIGIN` reikšmė
 * @param {object[]} [claim.evidence] - nuorodos
 */
function assessClaim(claim) {
  const problems = [];

  if (!Object.values(CLAIM_ORIGIN).includes(claim.origin)) {
    problems.push(`nežinoma kilmė: "${claim.origin}"`);
    return { supported: false, problems };
  }

  /**
   * ⚠️ NEPAGRĮSTAS TEIGINYS YRA GEDIMAS, ne trūkumas.
   *
   * Jis reiškia, kad protokole yra tai, ko susitikime nebuvo — ir tai
   * pavojingiausia protokolo klaidų rūšis, nes atrodo lygiai taip pat
   * įtikinamai kaip teisingas teiginys.
   */
  if (claim.origin === CLAIM_ORIGIN.UNSUPPORTED) {
    return { supported: false, problems: ["teiginys neturi pagrindo įraše"] };
  }

  const requiresEvidence = EVIDENCE_REQUIRED_FIELDS.includes(claim.protocolField);
  const evidence = Array.isArray(claim.evidence) ? claim.evidence : [];

  /**
   * ⚠️ NUORODA PRIVALOMA IR IŠVADAI, ne tik tiesioginiam teiginiui.
   *
   * Pirmoji versija jos reikalavo tik `transcript_derived` atveju — tad
   * išvada be jokio pagrindo praeidavo, ir `model_inference` tapdavo
   * praktiškai neatskiriamas nuo `unsupported`.
   *
   * Išvada visada kyla IŠ KAŽKO: vertintojas privalo nurodyti segmentus, iš
   * kurių ji padaryta. Priešingu atveju ji yra prasimanymas, tik pavadintas
   * kitaip.
   */
  if (requiresEvidence && evidence.length === 0) {
    problems.push(
      claim.origin === CLAIM_ORIGIN.MODEL_INFERENCE
        ? `laukas "${claim.protocolField}" yra išvada, bet nenurodyti segmentai, iš kurių ji padaryta`
        : `laukas "${claim.protocolField}" reikalauja atsekamumo nuorodos, bet jos nėra`
    );
  }

  /**
   * MODELIO IŠVADA PRIVALO BŪTI PAŽYMĖTA.
   *
   * Ji gali būti teisinga — bet skaitytojas turi žinoti, kad tai išvada, ne
   * įraše nuskambėjęs teiginys. Priešingu atveju protokole atsiranda faktų,
   * kurių niekas nepasakė.
   */
  if (claim.origin === CLAIM_ORIGIN.MODEL_INFERENCE && requiresEvidence && !claim.markedAsInference) {
    problems.push(
      `laukas "${claim.protocolField}" yra modelio išvada, bet nepažymėtas kaip neapibrėžtas`
    );
  }

  return { supported: problems.length === 0, problems };
}

/**
 * Suveda atsekamumo matricą visam protokolui.
 *
 * ⚠️ MATRICOJE NĖRA TEKSTO — tik laukai, kilmė ir nuorodų skaičius. Ji skirta
 * atsakyti „kiek teiginių atsekama", ne „ką modelis parašė".
 */
function buildTraceabilityMatrix(claims) {
  if (!Array.isArray(claims)) return { total: 0, byOrigin: {}, unsupported: 0, missingEvidence: 0 };

  const byOrigin = {};
  let unsupported = 0;
  let missingEvidence = 0;

  const rows = [];

  for (const claim of claims) {
    byOrigin[claim.origin] = (byOrigin[claim.origin] || 0) + 1;

    const assessment = assessClaim(claim);

    if (claim.origin === CLAIM_ORIGIN.UNSUPPORTED) unsupported += 1;
    else if (!assessment.supported) missingEvidence += 1;

    rows.push({
      protocolField: claim.protocolField,
      origin: claim.origin,
      evidenceCount: Array.isArray(claim.evidence) ? claim.evidence.length : 0,
      supported: assessment.supported,
    });
  }

  return {
    total: claims.length,
    byOrigin,
    unsupported,
    missingEvidence,

    /**
     * Atsekamumo dalis: kiek teiginių turi pagrindą.
     *
     * ⚠️ Tai NĖRA kokybės matas. Protokolas gali būti 100% atsekamas ir vis
     * tiek praleisti pusę sprendimų — pilnumas matuojamas atskirai (rubrikos
     * `COMPLETENESS` dimensija).
     */
    traceabilityRate: claims.length === 0 ? null : rows.filter((row) => row.supported).length / claims.length,

    rows,
  };
}

/**
 * Patikrina, ar atsekamumo įrašuose nėra turinio.
 *
 * Fail-closed sargyba: vienas neatsargus laukas paverstų vertinimo artefaktą
 * transkripcijos kopija.
 */
function assertNoContent(matrix) {
  const serialized = JSON.stringify(matrix);

  const forbidden = ["text", "quote", "excerpt", "content", "transcript"];
  const found = forbidden.filter((key) => new RegExp(`"${key}"\\s*:`).test(serialized));

  if (found.length > 0) {
    const error = new Error(`Atsekamumo matricoje aptikta turinio laukų: ${found.join(", ")}`);
    error.code = "TRACEABILITY_CONTAINS_CONTENT";
    throw error;
  }
}

module.exports = {
  createEvidenceReference,
  assessClaim,
  buildTraceabilityMatrix,
  assertNoContent,
};
