/**
 * TERMINOLOGIJOS PASTABA: šis modulis anksčiau vadinosi "factCheck.js" - tai buvo
 * per stiprus terminas. Tai, ką jis daro, tiksliau vadinasi "grounding check"
 * (transcript grounding / lexical grounding validation) - patikrina, ar sugeneruoto
 * teksto žodžiai realiai "įsišakniję" (grounded) šaltinio transkripcijoje, NE
 * pilnas semantinis faktų tikrinimas (fact-checking klasikine prasme reikalautų
 * NLI/embedding modelio ar antro LLM validacijos žingsnio).
 *
 * "AI reliability" klausimas: promptas (meeting_v2.js) draudžia LLM spėlioti, bet
 * niekas TECHNIŠKAI netikrina, ar sugalvotas "veiksmas"/"terminas" iš tikrųjų
 * paminėtas transkripcijoje. Šis modulis prideda PAPILDOMĄ, nepriklausomą nuo LLM
 * patikrinimo sluoksnį - paprastą leksinio persidengimo (lexical overlap)
 * heuristiką, NE pilną NLI/embedding-based fact-checking.
 *
 * Kiekvienam "veiksmai" įrašui skaičiuojame, kiek jo reikšmingų žodžių (>3 raidžių,
 * be stop-words) realiai pasirodo transkripcijoje. Žemas persidengimas =>
 * `_grounding.verified = false` - NEATMETAME automatiškai (heuristika netobula,
 * false positive rizika), bet PAŽYMIME, kad frontend galėtų parodyti įspėjimą ir
 * žmogus galėtų peržiūrėti prieš pasitikėdamas.
 *
 * SĄŽININGAS APRIBOJIMAS: tai lexical/substring lygio patikra, ne semantinė. Ji
 * NEPAGAUS atvejo, kai LLM perfrazuoja teisingą teiginį kitais žodžiais (false
 * negative - pažymės kaip "nepatvirtinta", nors iš tikrųjų teisinga), ir
 * TEORIŠKAI gali praleisti sugalvotą teiginį, jei jame atsitiktinai daug žodžių,
 * pasitaikančių transkripcijoje kitame kontekste (false positive - pažymės kaip
 * "patvirtinta", nors faktas sugalvotas). Tikram production naudojimui
 * rekomenduojama embedding-based similarity arba antras LLM validacijos
 * kvietimas (žr. backend/README.md Roadmap).
 */

const STOP_WORDS = new Set([
  "kad", "yra", "bus", "buvo", "turi", "reikia", "apie", "prie", "nuo", "per",
  "tai", "šis", "šie", "toks", "kaip", "arba", "taip", "jog", "dar", "jau",
  "tik", "gali", "galima", "visi", "visą", "visi", "kiek", "kada", "kur",
]);

function significantWords(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
}

/**
 * @param {string} fieldText - tikrinamas laukas (pvz. veiksmo "uzduotis")
 * @param {string} transcriptLower - jau į lowercase paverstas pilnas transkripcijos tekstas
 * @returns {{ overlapRatio: number, verified: boolean }}
 */
function checkOverlap(fieldText, transcriptLower, threshold = 0.5) {
  const words = significantWords(fieldText);
  if (words.length === 0) return { overlapRatio: 1, verified: true }; // nėra ką tikrinti (tuščias/labai trumpas laukas)
  const matched = words.filter((w) => transcriptLower.includes(w));
  const overlapRatio = Math.round((matched.length / words.length) * 100) / 100;
  return { overlapRatio, verified: overlapRatio >= threshold };
}

/**
 * Prideda `_grounding` lauką kiekvienam protocol.veiksmai įrašui (leksinio
 * persidengimo su transkripcija patikrinimas - "transcript grounding check",
 * NE pilnas semantinis fact-checking). Negriauna schema validacijos
 * (schema/protocolSchema.js validate() nežino apie šį lauką, bet tai nekliudo,
 * nes _grounding pridedamas PO validacijos).
 */
function groundingCheck(protocol, transcript) {
  if (!protocol || !Array.isArray(protocol.veiksmai) || !transcript) return protocol;
  const transcriptLower = transcript.toLowerCase();

  const veiksmai = protocol.veiksmai.map((v) => {
    if (!v || typeof v !== "object") return v;
    const uzduotisCheck = checkOverlap(v.uzduotis, transcriptLower);
    return { ...v, _grounding: uzduotisCheck };
  });

  return { ...protocol, veiksmai };
}

module.exports = { groundingCheck, checkOverlap, significantWords };
