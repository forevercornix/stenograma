/**
 * KOKYBĖS METRIKOS (#23.1).
 *
 * Šis modulis nieko nevertina — jis tik MATUOJA. Vertinimo paleidimas ir
 * rezultatai yra #23.2, sprendimas „ar pilotas gali startuoti" — #23.3.
 *
 * KODĖL SAVA IMPLEMENTACIJA, o ne biblioteka.
 *
 * WER skaičiavimas yra ~60 eilučių Levenšteino atstumo su atsekamumu.
 * Priklausomybė čia kainuotų daugiau, nei duotų: naują tiekimo grandinės
 * elementą (#16 blokuojantis auditas), versijų valdymą ir riziką, kad
 * normalizavimo taisyklės skirsis nuo mūsų lietuviškų.
 *
 * Svarbiau: metrikos rezultatas turi būti PAAIŠKINAMAS. Kai WER yra 18%,
 * reikia matyti, kurie žodžiai suklysti — o tam reikia savo atsekamumo.
 */

/**
 * NORMALIZAVIMAS PRIEŠ LYGINIMĄ.
 *
 * ⚠️ Normalizavimas TIESIOGIAI keičia WER reikšmę, tad jis yra metodologijos
 * dalis, ne techninė smulkmena. Dvi sistemos, skaičiuojančios WER skirtingai
 * normalizuotam tekstui, duoda nepalyginamus skaičius.
 *
 * Mūsų taisyklės ir jų pagrindimas:
 *
 * - **Mažosios raidės.** Didžiosios raidės sakinio pradžioje nėra
 *   transkribavimo kokybės klausimas.
 * - **Skyryba pašalinama.** Whisper ją deda pagal savo taisykles, o žmogaus
 *   referencinė transkripcija — pagal kitas. Lyginti jas reikštų matuoti
 *   skyrybos stilių, ne atpažinimą.
 * - **Skaitmenys NEKEIČIAMI į žodžius.** „2026" ir „du tūkstančiai dvidešimt
 *   šeši" liks skirtingi. Tai sąmoninga: protokole data turi būti teisinga,
 *   ir klaida čia yra tikra klaida.
 * - **Lietuviški diakritikai IŠLAIKOMI.** „Šalis" ir „salis" yra skirtingi
 *   žodžiai. Jų sulyginimas dirbtinai pagerintų WER ir paslėptų realų
 *   trūkumą, kuris protokole matomas.
 */
const NORMALIZATION_RULES = Object.freeze({
  lowercase: true,
  stripPunctuation: true,
  collapseWhitespace: true,
  normalizeNumbers: false,
  stripDiacritics: false,
});

/**
 * SKYRYBA, ŠALINAMA PRIEŠ LYGINIMĄ.
 *
 * ⚠️ Pirmoji versija buvo NEPILNA: ji nepašalindavo tipografinių kabučių ir
 * brūkšnių variantų. Vizualiai identiškas tekstas
 * („\u201cSprendimas\u201d" vs „Sprendimas") gaudavo 100% WER — dokumentacija
 * skelbė „skyryba pašalinama", o kodas šalino tik dalį jos.
 *
 * Naudojama Unicode kategorijų klasė, ne rankinis sąrašas: naujas kabučių ar
 * brūkšnio variantas nebeturi būti pastebėtas ir pridėtas rankomis.
 *
 * KAS PALIEKAMA ŽODYJE – EKSPLICITINIS, SIAURAS SĄRAŠAS:
 *
 * - **brūkšnelis** („penkiasdešimt-šeši");
 * - **apostrofas** („d'Artanjanas").
 *
 * Šie du yra žodžio DALIS lietuvių kalboje, ir jų pašalinimas sujungtų žodį į
 * kitą formą, iškreipdamas žodžių skaičių.
 *
 * ⚠️ Visa kita – įskaitant pasvirąjį brūkšnį – yra SKIRTUKAS, net tarp raidžių.
 * „taip/ne" yra du žodžiai, ne vienas: bendra Unicode taisyklė („palikti viską
 * tarp raidžių") jį klaidingai laikytų vienu ir duotų dvi klaidas vizualiai
 * tvarkingam tekstui.
 *
 * ⚠️ ŽINOMA RIBA: šalinami ir MATEMATINIAI/TECHNINIAI simboliai, tad „C++"
 * tampa „c", o „C#" – „c". Techniniame posėdyje tai gali sulieti skirtingus
 * terminus į vieną.
 *
 * Palikta sąmoningai: išimtis šiems atvejams reikštų sąrašą, kurį reikėtų
 * pildyti rankomis, o klaida būtų vienoda abiem pusėms (ir referencinei, ir
 * hipotezei), tad WER ji nekreipia. Jei vertinsite techninius posėdžius, tai
 * reikia žinoti interpretuojant rezultatą.
 */

/** Žodyje leidžiami ne raidiniai simboliai. */
const IN_WORD_CHARACTERS = "\\-'\u2019";

const PUNCTUATION = new RegExp(
  `(?<![\\p{L}\\p{N}])[\\p{P}\\p{S}]+|[\\p{P}\\p{S}]+(?![\\p{L}\\p{N}])|[^\\p{L}\\p{N}\\s${IN_WORD_CHARACTERS}]+`,
  "gu"
);

/**
 * Normalizuoja tekstą pagal `NORMALIZATION_RULES`.
 *
 * Grąžina žodžių masyvą — ne eilutę: tolesnis lyginimas vyksta žodžių lygiu,
 * ir tarpų klausimas turi būti išspręstas čia, o ne kiekvienoje metrikoje.
 */
function normalize(text) {
  if (typeof text !== "string") return [];

  let result = text;

  if (NORMALIZATION_RULES.lowercase) result = result.toLowerCase();
  if (NORMALIZATION_RULES.stripPunctuation) result = result.replace(PUNCTUATION, " ");

  return result.split(/\s+/).filter(Boolean);
}

/**
 * Levenšteino atstumas žodžių lygiu SU OPERACIJŲ SKAIDYMU.
 *
 * Grąžinamas ne tik atstumas, bet ir kiek buvo pakeitimų, įterpimų ir
 * praleidimų — be to nebūtų galima atsakyti, KOKIA klaida vyrauja, o tai yra
 * #23.2 gedimų analizės pagrindas.
 */
function alignWords(reference, hypothesis) {
  const rows = reference.length + 1;
  const cols = hypothesis.length + 1;

  /** `matrix[i][j]` – minimalus atstumas tarp pirmų `i` ir `j` žodžių. */
  const matrix = Array.from({ length: rows }, () => new Array(cols).fill(0));

  for (let i = 0; i < rows; i++) matrix[i][0] = i;
  for (let j = 0; j < cols; j++) matrix[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = reference[i - 1] === hypothesis[j - 1] ? 0 : 1;

      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1, // praleidimas
        matrix[i][j - 1] + 1, // įterpimas
        matrix[i - 1][j - 1] + cost // pakeitimas arba sutapimas
      );
    }
  }

  // Atsekimas atgal – kad žinotume, KOKIŲ operacijų buvo.
  let i = reference.length;
  let j = hypothesis.length;

  const counts = { substitutions: 0, insertions: 0, deletions: 0, correct: 0 };

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && reference[i - 1] === hypothesis[j - 1] && matrix[i][j] === matrix[i - 1][j - 1]) {
      counts.correct += 1;
      i -= 1;
      j -= 1;
    } else if (i > 0 && j > 0 && matrix[i][j] === matrix[i - 1][j - 1] + 1) {
      counts.substitutions += 1;
      i -= 1;
      j -= 1;
    } else if (j > 0 && matrix[i][j] === matrix[i][j - 1] + 1) {
      counts.insertions += 1;
      j -= 1;
    } else {
      counts.deletions += 1;
      i -= 1;
    }
  }

  return counts;
}

/**
 * Word Error Rate.
 *
 * WER = (S + I + D) / N, kur N — žodžių skaičius REFERENCINIAME tekste.
 *
 * ⚠️ WER GALI VIRŠYTI 100%. Tai ne klaida: jei sistema prigeneravo daugiau
 * žodžių, nei jų buvo, įterpimų skaičius viršija referencinį ilgį. Reikšmė
 * neribojama sąmoningai — apkirpus ją iki 100% dingtų informacija apie tai,
 * kaip stipriai modelis haliucinuoja.
 */
function wordErrorRate(referenceText, hypothesisText) {
  const reference = normalize(referenceText);
  const hypothesis = normalize(hypothesisText);

  /**
   * Tuščias referencinis tekstas.
   *
   * Dalyba iš nulio negalima, o „0% klaidų" būtų melas: jei sistema kažką
   * grąžino, o referencinis tuščias, tai 100% įterpimų.
   */
  if (reference.length === 0) {
    return {
      wer: hypothesis.length === 0 ? 0 : null,
      referenceWords: 0,
      substitutions: 0,
      insertions: hypothesis.length,
      deletions: 0,
      correct: 0,
      note: hypothesis.length === 0 ? "abu tušti" : "referencinis tekstas tuščias – WER neapibrėžtas",
    };
  }

  const counts = alignWords(reference, hypothesis);
  const errors = counts.substitutions + counts.insertions + counts.deletions;

  return {
    wer: errors / reference.length,
    referenceWords: reference.length,
    hypothesisWords: hypothesis.length,
    ...counts,
  };
}

/**
 * Character Error Rate.
 *
 * Naudinga lietuvių kalbai: WER laiko „posėdyje" ir „posėdyj" visiškai
 * skirtingais, nors klaida yra viena raidė. CER parodo, ar modelis nesupranta
 * žodžio, ar tik linksniuoja kitaip.
 */
function characterErrorRate(referenceText, hypothesisText) {
  const reference = normalize(referenceText).join(" ").split("");
  const hypothesis = normalize(hypothesisText).join(" ").split("");

  if (reference.length === 0) {
    return { cer: hypothesis.length === 0 ? 0 : null, referenceChars: 0 };
  }

  const counts = alignWords(reference, hypothesis);
  const errors = counts.substitutions + counts.insertions + counts.deletions;

  return { cer: errors / reference.length, referenceChars: reference.length };
}

/**
 * DIARIZATION ERROR RATE (supaprastinta).
 *
 * ⚠️ SĄŽININGAI: tai NĖRA standartinis DER.
 *
 * Kanoninis DER (NIST) matuoja LAIKO proporcijas su „forgiveness collar"
 * riba ir optimaliu kalbėtojų susiejimu per Vengrijos algoritmą. Jis
 * reikalauja tikslių laiko žymų abiejose pusėse.
 *
 * Mūsų atveju referencinė transkripcija turi kalbėtojų etiketes SEGMENTAMS, ne
 * milisekundžių ribas — todėl matuojame SEGMENTŲ priskyrimo tikslumą.
 *
 * Tai silpnesnė, bet sąžininga metrika: ji atsako „kiek segmentų priskirta ne
 * tam kalbėtojui", ne „kiek laiko sekundžių suklysta". Rezultatas
 * NEPALYGINAMAS su publikuojamais DER skaičiais, ir taip turi būti
 * suprantamas.
 */
/**
 * Visos permutacijos – OPTIMALIAM susiejimui, kai kalbėtojų nedaug.
 *
 * Godus algoritmas gali paimti didžiausią individualią porą ir taip užblokuoti
 * dvi kitas, kurių bendra suma būtų geresnė. Posėdyje kalbėtojų retai būna
 * daugiau nei keli, tad optimalų atsakymą galima rasti be papildomos
 * priklausomybės ar Vengrijos algoritmo.
 */
function _permutations(items) {
  if (items.length <= 1) return [items];

  const result = [];

  for (let index = 0; index < items.length; index++) {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const permutation of _permutations(rest)) result.push([items[index], ...permutation]);
  }

  return result;
}

/**
 * Riba, iki kurios pilna permutacijų paieška pigi.
 *
 * Faktorialas auga staigiai:
 *
 *   5! =     120
 *   6! =     720   ← riba
 *   7! =   5 040
 *   8! =  40 320
 *   9! = 362 880
 *
 * Ties 6 paieška lieka momentinė (<1 ms), o 8+ jau juntama kiekvienam
 * vertinamam įrašui. Posėdyje aktyvių kalbėtojų daugiau nei 6 pasitaiko
 * retai, tad riba parinkta ten, kur kaina dar nulinė.
 */
const MAX_SPEAKERS_FOR_OPTIMAL_MAPPING = 6;

/**
 * KALBĖTOJŲ PRISKYRIMO TIKSLUMAS.
 *
 * ⚠️ SĄŽININGAI: tai NĖRA standartinis DER.
 *
 * Kanoninis DER (NIST) matuoja LAIKO proporcijas su „forgiveness collar" riba
 * ir optimaliu kalbėtojų susiejimu. Jis reikalauja tikslių laiko žymų abiejose
 * pusėse.
 *
 * Mūsų referencinės transkripcijos turi kalbėtojų etiketes SEGMENTAMS, ne
 * milisekundžių ribas — todėl matuojame segmentų priskyrimo tikslumą.
 * Rezultatas NEPALYGINAMAS su publikuojamais DER skaičiais.
 *
 * ⚠️ ATEIČIAI: metrika lygina segmentus PAGAL INDEKSĄ, tad ji prasminga tik
 * tol, kol referencinės transkripcijos turi segmentų etiketes. Atsiradus
 * tikroms laiko žymoms, šią funkciją reikės pakeisti tikru DER — ne
 * papildyti.
 *
 * ⚠️ ATEIČIAI: metrika lygina segmentus PAGAL INDEKSĄ, ne pagal laiką. Tai
 * atitinka mūsų referencinių duomenų formatą, bet jei kada nors atsiras tikros
 * laiko žymos, šią metriką reikės pakeisti kanoniniu DER — ne papildyti.
 *
 * ⚠️ VARDIKLIS – DIDESNIS iš dviejų segmentų skaičių.
 *
 * Pirmoji versija lygino tik `min(ref, hyp)` segmentų ir dalijo iš palygintų.
 * Sistema, praradusi PUSĘ segmentų, gaudavo 100% tikslumą — pagrindinė
 * metrika sakė „tobula", o pusė kalbos buvo dingusi. `segmentCountMismatch`
 * vėliavos nepakako: niekas negarantuoja, kad kokybės vartai ją įtrauks.
 *
 * Dabar trūkstami ir pertekliniai segmentai yra KLAIDOS, ne nutylėjimas.
 */
function speakerAttributionRate(referenceSegments, hypothesisSegments) {
  if (!Array.isArray(referenceSegments) || referenceSegments.length === 0) {
    return { accuracy: null, note: "nėra referencinių segmentų" };
  }

  const hypothesis = Array.isArray(hypothesisSegments) ? hypothesisSegments : [];

  const referenceSpeakers = [...new Set(referenceSegments.map((s) => s.speaker).filter(Boolean))];
  const hypothesisSpeakers = [...new Set(hypothesis.map((s) => s.speaker).filter(Boolean))];

  const overlap = Math.min(referenceSegments.length, hypothesis.length);

  /** Suskaičiuoja sutapimus konkrečiam susiejimui. */
  function countMatches(mapping) {
    let matched = 0;

    for (let index = 0; index < overlap; index++) {
      const referenceSpeaker = referenceSegments[index].speaker;
      if (!referenceSpeaker) continue;

      if (mapping.get(referenceSpeaker) === hypothesis[index].speaker) matched += 1;
    }

    return matched;
  }

  let bestMatches = 0;
  let mappingMethod;

  if (referenceSpeakers.length <= MAX_SPEAKERS_FOR_OPTIMAL_MAPPING && hypothesisSpeakers.length <= MAX_SPEAKERS_FOR_OPTIMAL_MAPPING) {
    /**
     * OPTIMALUS susiejimas: išbandomos visos hipotezės kalbėtojų permutacijos.
     */
    mappingMethod = "optimal";

    const padded = [...hypothesisSpeakers];
    while (padded.length < referenceSpeakers.length) padded.push(null);

    for (const permutation of _permutations(padded)) {
      const mapping = new Map();
      referenceSpeakers.forEach((speaker, index) => mapping.set(speaker, permutation[index]));

      bestMatches = Math.max(bestMatches, countMatches(mapping));
    }
  } else {
    /**
     * Per daug kalbėtojų pilnai paieškai – godus susiejimas.
     *
     * ⚠️ Rezultatas gali būti PESIMISTINIS. `mappingMethod` grąžinamas, kad
     * ataskaita galėtų tai įvardyti, o kokybės vartai — neremtis juo kaip
     * tiksliu skaičiumi.
     */
    mappingMethod = "greedy";

    const pairs = new Map();

    for (let index = 0; index < overlap; index++) {
      const referenceSpeaker = referenceSegments[index].speaker;
      const hypothesisSpeaker = hypothesis[index].speaker;
      if (!referenceSpeaker || !hypothesisSpeaker) continue;

      const key = `${referenceSpeaker}\u0000${hypothesisSpeaker}`;
      pairs.set(key, (pairs.get(key) || 0) + 1);
    }

    const mapping = new Map();
    const used = new Set();

    for (const [key] of [...pairs.entries()].sort((a, b) => b[1] - a[1])) {
      const [referenceSpeaker, hypothesisSpeaker] = key.split("\u0000");
      if (mapping.has(referenceSpeaker) || used.has(hypothesisSpeaker)) continue;

      mapping.set(referenceSpeaker, hypothesisSpeaker);
      used.add(hypothesisSpeaker);
    }

    bestMatches = countMatches(mapping);
  }

  /**
   * ⚠️ VARDIKLIS: didesnis iš dviejų. Trūkstami segmentai (sistema prarado
   * kalbą) ir pertekliniai (sistema suskaidė per smulkiai) yra klaidos.
   */
  const denominator = Math.max(referenceSegments.length, hypothesis.length);

  return {
    accuracy: denominator === 0 ? null : bestMatches / denominator,
    matchedSegments: bestMatches,
    referenceSegments: referenceSegments.length,
    hypothesisSegments: hypothesis.length,
    missedSegments: Math.max(0, referenceSegments.length - hypothesis.length),
    extraSegments: Math.max(0, hypothesis.length - referenceSegments.length),
    referenceSpeakers: referenceSpeakers.length,
    hypothesisSpeakers: hypothesisSpeakers.length,
    segmentCountMismatch: referenceSegments.length !== hypothesis.length,
    mappingMethod,
  };
}

module.exports = {
  NORMALIZATION_RULES,
  normalize,
  alignWords,
  wordErrorRate,
  characterErrorRate,
  speakerAttributionRate,
};
