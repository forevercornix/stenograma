/**
 * PROTOKOLO VERTINIMO RUBRIKA (#24.1).
 *
 * Šis modulis nieko nevertina — jis apibrėžia, KĄ ir KAIP vertiname. Realus
 * vertinimas yra #24.2, sprendimas dėl piloto — #24.3.
 *
 * KODĖL RUBRIKA, O NE AUTOMATINĖ METRIKA.
 *
 * #23 WER matuojamas mechaniškai: tekstas arba sutampa, arba ne. Protokolo
 * kokybė tokia nėra — „Jonas parengs ataskaitą iki penktadienio" ir „Jonas
 * pažadėjo ataskaitą savaitės gale" gali reikšti tą patį arba visai kitką,
 * priklausomai nuo to, kas pasakyta įraše.
 *
 * Todėl vertina ŽMOGUS, bet pagal IŠ ANKSTO APIBRĖŽTUS kriterijus. Skirtumas
 * esminis: „man atrodo neblogai" nėra vertinimas, o rubrika be žmogaus
 * neaptiktų prasmės iškraipymo.
 */

/**
 * VERTINIMO DIMENSIJOS.
 *
 * Kiekviena atsako į atskirą klausimą. Sujungus jas į vieną „kokybės balą"
 * dingtų svarbiausia informacija: protokolas su viena išgalvota užduotimi ir
 * protokolas su praleista pastraipa yra visiškai skirtingos problemos.
 */
const DIMENSIONS = Object.freeze({
  /** Ar teiginiai atitinka tai, kas pasakyta? */
  FACTUAL_CORRECTNESS: "factual_correctness",
  /** Ar nepraleisti sprendimai ir užduotys? */
  COMPLETENESS: "completeness",
  /** Ar nėra pridėta to, ko įraše nebuvo? */
  NO_UNSUPPORTED_ADDITIONS: "no_unsupported_additions",
  /** Ar užduotys priskirtos teisingiems žmonėms? */
  ATTRIBUTION: "attribution",
  /** Ar terminai ir datos teisingi? */
  TEMPORAL_ACCURACY: "temporal_accuracy",
  /** Ar svarbius teiginius galima atsekti iki įrašo? */
  TRACEABILITY: "traceability",
});

/**
 * KLAIDŲ SUNKUMAS.
 *
 * ⚠️ NE VISOS KLAIDOS LYGIOS.
 *
 * Neteisingai užrašytas pavadinimas ir išgalvotas nutarimas abu yra „klaidos",
 * bet pirmoji taisoma per sekundę, o antroji gali lemti sprendimą, kurio
 * niekas nepriėmė.
 *
 * Sunkumas nustatomas pagal POVEIKĮ, ne pagal klaidos dydį tekste.
 */
const SEVERITY = Object.freeze({
  /**
   * Keičia susitikimo prasmę arba sukuria neįvykusį faktą.
   * Pavyzdžiai: išgalvotas nutarimas, užduotis ne tam žmogui, priešinga
   * sprendimo prasmė.
   */
  CRITICAL: "critical",
  /**
   * Praleista arba iškraipyta reikšminga informacija, bet prasmė išlieka.
   * Pavyzdžiai: praleista viena iš trijų užduočių, netikslus terminas.
   */
  MAJOR: "major",
  /**
   * Netikslumas, kurį skaitytojas pastebi, bet kuris neklaidina.
   * Pavyzdžiai: netiksli formuluotė, praleista antraeilė detalė.
   */
  MINOR: "minor",
  /**
   * Stiliaus ar formatavimo pastaba.
   */
  COSMETIC: "cosmetic",
});

/**
 * Sunkumo svoriai bendram balui.
 *
 * ⚠️ Netiesiniai sąmoningai: dešimt kosmetinių klaidų NĖRA lygu vienai
 * kritinei. Tiesinė skalė leistų „kompensuoti" išgalvotą nutarimą tvarkingu
 * formatavimu.
 */
const SEVERITY_WEIGHTS = Object.freeze({
  [SEVERITY.CRITICAL]: 100,
  [SEVERITY.MAJOR]: 10,
  [SEVERITY.MINOR]: 2,
  [SEVERITY.COSMETIC]: 0.5,
});

/**
 * TEIGINIŲ KILMĖ.
 *
 * #24 reikalauja atskirti tai, kas kyla iš transkripcijos, nuo to, ką modelis
 * išvedė pats. Skirtumas praktinis: išvestas teiginys gali būti teisingas, bet
 * jo negalima patikrinti prieš įrašą.
 */
const CLAIM_ORIGIN = Object.freeze({
  /** Tiesiogiai atsekamas iki transkripcijos fragmento. */
  TRANSCRIPT_DERIVED: "transcript_derived",
  /** Modelio išvada iš konteksto – logiška, bet nepasakyta tiesiogiai. */
  MODEL_INFERENCE: "model_inference",
  /** Nepagrįstas: įraše atitikmens nėra. */
  UNSUPPORTED: "unsupported",
});

/**
 * KILMĖS NUSTATYMO TAISYKLĖ.
 *
 * ⚠️ Be jos du vertintojai tą patį teiginį klasifikuotų skirtingai, ir
 * rezultatai taptų nepalyginami.
 *
 * Klausimai užduodami TA TVARKA:
 *
 *   1. Ar galiu nurodyti segmentą (-us), iš kurių teiginys kyla?
 *      NE  → `unsupported`
 *
 *   2. Ar teiginys tuose segmentuose PASAKYTAS (leidžiamas perfrazavimas,
 *      jei prasmė ta pati)?
 *      TAIP → `transcript_derived`
 *
 *   3. Ar teiginys IŠPLAUKIA iš tų segmentų taip, kad kitas skaitytojas
 *      padarytų tą pačią išvadą?
 *      TAIP → `model_inference` (privaloma pažymėti kaip neapibrėžtą)
 *      NE   → `unsupported`
 *
 * ⚠️ LEMIAMAS SKIRTUMAS tarp `model_inference` ir `unsupported` yra ne
 * tikėtinumas, o **ar galima nurodyti pagrindą**. Išvada be nuorodos į
 * segmentus praktiškai neatskiriama nuo prasimanymo — todėl kodas jos
 * nepriima.
 */
function classifyClaimOrigin({ hasEvidence, statedExplicitly, followsFromEvidence }) {
  if (!hasEvidence) return CLAIM_ORIGIN.UNSUPPORTED;
  if (statedExplicitly) return CLAIM_ORIGIN.TRANSCRIPT_DERIVED;
  if (followsFromEvidence) return CLAIM_ORIGIN.MODEL_INFERENCE;

  return CLAIM_ORIGIN.UNSUPPORTED;
}

/**
 * VERTINTOJŲ NESUTARIMŲ SPRENDIMAS.
 *
 * ⚠️ Metodika, remiantis žmogaus vertinimu, privalo atsakyti, kas nutinka, kai
 * du vertintojai nesutaria. Priešingu atveju rezultatas priklauso nuo to, kurio
 * vertinimas pateko į ataskaitą.
 *
 * Taisyklės parinktos KONSERVATYVIAI: abejonė sprendžiama griežtesnės
 * reikšmės naudai. Piloto kontekste per griežtas vertinimas kainuoja papildomą
 * peržiūrą, o per švelnus — netikrą pasitikėjimą.
 */
const SEVERITY_ORDER = [SEVERITY.COSMETIC, SEVERITY.MINOR, SEVERITY.MAJOR, SEVERITY.CRITICAL];

const ORIGIN_ORDER = [CLAIM_ORIGIN.TRANSCRIPT_DERIVED, CLAIM_ORIGIN.MODEL_INFERENCE, CLAIM_ORIGIN.UNSUPPORTED];

/**
 * Sujungia du vertinimus į vieną.
 *
 * @returns {{severity: string, origin: string, disagreed: boolean, notes: string[]}}
 */
function resolveDisagreement(reviewerA, reviewerB) {
  const notes = [];

  const severityIndex = Math.max(
    SEVERITY_ORDER.indexOf(reviewerA.severity),
    SEVERITY_ORDER.indexOf(reviewerB.severity)
  );

  if (severityIndex === -1) {
    const error = new Error("Nežinomas sunkumas vertintojo įraše.");
    error.code = "UNKNOWN_SEVERITY";
    throw error;
  }

  const severityDisagreement = reviewerA.severity !== reviewerB.severity;
  if (severityDisagreement) {
    notes.push(`sunkumas: ${reviewerA.severity} vs ${reviewerB.severity} → imamas griežtesnis`);
  }

  let origin;
  let originDisagreement = false;

  if (reviewerA.origin || reviewerB.origin) {
    const originIndex = Math.max(ORIGIN_ORDER.indexOf(reviewerA.origin), ORIGIN_ORDER.indexOf(reviewerB.origin));
    origin = ORIGIN_ORDER[originIndex];

    originDisagreement = reviewerA.origin !== reviewerB.origin;
    if (originDisagreement) {
      notes.push(`kilmė: ${reviewerA.origin} vs ${reviewerB.origin} → imama konservatyvesnė`);
    }
  }

  return {
    severity: SEVERITY_ORDER[severityIndex],
    ...(origin ? { origin } : {}),
    disagreed: severityDisagreement || originDisagreement,
    notes,
  };
}

/**
 * Vertintojų sutarimo dalis.
 *
 * ⚠️ Tai NĖRA kokybės matas — tai METODIKOS matas. Žemas sutarimas reiškia,
 * kad rubrika neaiški, o ne kad protokolas blogas.
 *
 * Jei sutarimas žemas, taisyti reikia rubriką, ne rezultatus.
 */
function agreementRate(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) return null;

  const agreed = pairs.filter((pair) => !resolveDisagreement(pair.a, pair.b).disagreed).length;

  return agreed / pairs.length;
}

/**
 * PROTOKOLO LAUKAI, KURIEMS PRIVALOMA ATSEKAMUMO NUORODA.
 *
 * ⚠️ Ne visiems. Reikalauti nuorodos „santraukai" būtų beprasmiška — ji pagal
 * apibrėžimą apibendrina visą įrašą.
 *
 * Bet nutarimas ar užduotis be atsekamumo yra teiginys, kurio niekas negali
 * patikrinti — o būtent jie lemia veiksmus po susitikimo.
 *
 * Laukai atitinka realią protokolo struktūrą (`prompts/meeting_v3.js`).
 */
const EVIDENCE_REQUIRED_FIELDS = Object.freeze(["nutarimai", "uzduotis", "atsakingas", "terminas"]);

/**
 * Apskaičiuoja svertą klaidų balą.
 *
 * ⚠️ MAŽESNIS BALAS = GERIAU. Tai ne „kokybės procentai": balas rodo klaidų
 * svorį, ne teisingumo dalį.
 *
 * Procentinė skalė čia klaidintų — ji sukurtų įspūdį, kad 90% yra gerai, nors
 * viena kritinė klaida gali padaryti protokolą netinkamą.
 */
function weightedErrorScore(findings) {
  if (!Array.isArray(findings)) return null;

  return findings.reduce((total, finding) => {
    const weight = SEVERITY_WEIGHTS[finding.severity];

    if (weight === undefined) {
      const error = new Error(`Nežinomas klaidos sunkumas: "${finding.severity}"`);
      error.code = "UNKNOWN_SEVERITY";
      throw error;
    }

    return total + weight;
  }, 0);
}

/**
 * Ar protokolas atitinka priėmimo kriterijus?
 *
 * ⚠️ KRITINĖ KLAIDA YRA VETO.
 *
 * Ji negali būti kompensuota jokiu kiekiu gerų dalykų: protokolas su išgalvotu
 * nutarimu netinkamas, net jei visa kita nepriekaištinga.
 *
 * Tai sąmoningai griežčiau nei balų riba — balas leistų vienai kritinei klaidai
 * „prasprūsti", jei protokolas ilgas ir kitur tvarkingas.
 */
function evaluateAcceptance(findings, { maxWeightedScore = 20 } = {}) {
  const critical = findings.filter((finding) => finding.severity === SEVERITY.CRITICAL);

  if (critical.length > 0) {
    return {
      accepted: false,
      reason: `kritinių klaidų: ${critical.length}`,
      criticalCount: critical.length,
      score: weightedErrorScore(findings),
      vetoed: true,
    };
  }

  const score = weightedErrorScore(findings);

  return {
    accepted: score <= maxWeightedScore,
    reason: score <= maxWeightedScore ? undefined : `klaidų balas ${score} viršija ribą ${maxWeightedScore}`,
    criticalCount: 0,
    score,
    vetoed: false,
  };
}

/**
 * Patikrina, ar radinys aprašytas pilnai.
 *
 * FAIL-CLOSED: nepilnas radinys nepriimamas. Radinys be dimensijos ar sunkumo
 * negali būti nei suskaičiuotas, nei palygintas su kitu vertinimu.
 */
function validateFinding(finding) {
  const errors = [];

  if (!finding || typeof finding !== "object") return { valid: false, errors: ["radinys nėra objektas"] };

  if (!Object.values(DIMENSIONS).includes(finding.dimension)) {
    errors.push(`nežinoma dimensija: "${finding.dimension}"`);
  }

  if (!Object.values(SEVERITY).includes(finding.severity)) {
    errors.push(`nežinomas sunkumas: "${finding.severity}"`);
  }

  if (!finding.protocolField || typeof finding.protocolField !== "string") {
    errors.push("trūksta `protocolField` – be jo neaišku, kur klaida");
  }

  /**
   * ⚠️ RADINIO APRAŠYME NEGALI BŪTI SUSITIKIMO TURINIO.
   *
   * Vertinimo rezultatai keliauja į ataskaitas ir repozitoriją, tad
   * „modelis parašė, kad Jonas atleidžiamas" būtų nutekėjimas.
   *
   * Aprašymas turi būti KATEGORINIS: „išgalvotas nutarimas", ne jo turinys.
   */
  if (finding.excerpt || finding.quote || finding.text) {
    errors.push("radinyje negali būti citatų ar turinio – naudokite kategorinį aprašymą");
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  DIMENSIONS,
  SEVERITY,
  SEVERITY_WEIGHTS,
  CLAIM_ORIGIN,
  EVIDENCE_REQUIRED_FIELDS,
  classifyClaimOrigin,
  resolveDisagreement,
  agreementRate,
  SEVERITY_ORDER,
  ORIGIN_ORDER,
  weightedErrorScore,
  evaluateAcceptance,
  validateFinding,
};
