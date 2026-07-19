/**
 * RASTA SU REALIAIS DUOMENIMIS (4 val. posėdžio įrašas, žr. backend README
 * "Realaus audio testas"): Whisper tylos/triukšmo vietose kartais įeina į
 * haliucinacinę kilpą - TA PATI frazė kartojama dešimtis ar šimtus kartų iš
 * eilės (realiame įraše viena frazė kartojosi ~280 kartų per ~2.3 val. tylos
 * po posėdžio pabaigos). Tai:
 *   1) išpučia LLM promptą tūkstančiais token'ų (tiesioginė pinigų kaina),
 *   2) gali išstumti realų turinį iš konteksto lango,
 *   3) klaidina modelį ("kodėl tas sakinys toks svarbus?").
 *
 * Sprendimas: sutraukiame TIK ilgas (>= minRun) IŠ EILĖS einančių IDENTIŠKŲ
 * fragmentų serijas į vieną egzempliorių + žymę "[kartojosi N kartų...]".
 * Žymė SĄMONINGAI paliekama, nes kartojimasis kartais neša prasmę - pvz. tame
 * pačiame įraše "Taip." kartojosi ~30 kartų balsavimo metu; žymė leidžia LLM
 * suprasti, kad balsavo daug žmonių, neprarandant šios informacijos.
 *
 * SAUGUMO RIBA: trumpos serijos (< minRun, numatyta 3) NELIEČIAMOS - realioje
 * kalboje du kartus pakartotas sakinys yra normalu, o štai 3+ identiškų iš
 * eilės beveik visada yra transkripcijos artefaktas.
 */

function normalize(s) {
  return s.trim().replace(/\s+/g, " ");
}

/**
 * @param {string} text - transkripcijos tekstas (eilutėmis arba vientisas)
 * @param {{minRun?: number}} opts
 * @returns {{text: string, collapsedRuns: number, removedItems: number, originalLength: number, dedupedLength: number}}
 */
function dedupTranscriptText(text, { minRun = 3 } = {}) {
  if (!text || typeof text !== "string") {
    return { text: text || "", collapsedRuns: 0, removedItems: 0, originalLength: 0, dedupedLength: 0 };
  }

  // Jei tekstas turi eilučių pertraukas (pvz. iš segmentų sujungtas) - skaidome
  // eilutėmis; kitaip - sakiniais (pagal .!? ribas). Abu atvejai realūs:
  // frontend'as siunčia "\n"-jungtą segmentų tekstą, API klientai gali siųsti vientisą.
  const hasNewlines = text.includes("\n");
  const parts = hasNewlines ? text.split("\n") : text.split(/(?<=[.!?])\s+/);
  const joiner = hasNewlines ? "\n" : " ";

  const out = [];
  let collapsedRuns = 0;
  let removedItems = 0;

  let i = 0;
  while (i < parts.length) {
    const current = parts[i];
    const key = normalize(current);
    let runLength = 1;
    while (i + runLength < parts.length && normalize(parts[i + runLength]) === key && key !== "") {
      runLength++;
    }
    if (runLength >= minRun) {
      out.push(current);
      out.push(`[ta pati frazė kartojosi ${runLength} kartus iš eilės - tikėtina transkripcijos artefaktas arba daugkartinis pasikartojimas, pvz. balsavimas]`);
      collapsedRuns++;
      removedItems += runLength - 1;
    } else {
      for (let k = 0; k < runLength; k++) out.push(parts[i + k]);
    }
    i += runLength;
  }

  const deduped = out.join(joiner);
  return {
    text: deduped,
    collapsedRuns,
    removedItems,
    originalLength: text.length,
    dedupedLength: deduped.length,
  };
}

/**
 * Tas pats principas segmentų masyvui (kai promptas formuojamas su laiko žymomis).
 * Sutraukta serija išlaiko PIRMO segmento start ir PASKUTINIO end - laiko
 * aprėptis neprarandama.
 */
function dedupSegments(segments, { minRun = 3 } = {}) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return { segments: segments || [], collapsedRuns: 0, removedItems: 0 };
  }
  const out = [];
  let collapsedRuns = 0;
  let removedItems = 0;
  let i = 0;
  while (i < segments.length) {
    const key = normalize(segments[i].text || "");
    let runLength = 1;
    while (i + runLength < segments.length && normalize(segments[i + runLength].text || "") === key && key !== "") {
      runLength++;
    }
    if (runLength >= minRun) {
      const first = segments[i];
      const last = segments[i + runLength - 1];
      out.push({
        ...first,
        end: last.end,
        text: `${first.text} [ta pati frazė kartojosi ${runLength} kartus iš eilės šiame laiko intervale]`,
      });
      collapsedRuns++;
      removedItems += runLength - 1;
    } else {
      for (let k = 0; k < runLength; k++) out.push(segments[i + k]);
    }
    i += runLength;
  }
  return { segments: out, collapsedRuns, removedItems };
}

module.exports = { dedupTranscriptText, dedupSegments };
