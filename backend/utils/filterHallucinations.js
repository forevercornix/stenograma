"use strict";

/**
 * Whisper halucinacijų filtras.
 *
 * KODĖL: RASTA realiai testuojant (4 val. lietuviškas įrašas) - tyliose vietose
 * (pauzės, tylus fonas) faster-whisper "prasimano" tekstą, dažniausiai YouTube titrų
 * likučius ("www.youtube.com", "Subtitles by...", "Ačiū, kad žiūrėjote" ir pan.),
 * kuriuos modelis matė treniruojantis. 4 val. teste ~37% segmentų (462 iš 1274) buvo
 * tokios halucinacijos.
 *
 * SVARBU (saugumas): filtras KONSERVATYVUS. Segmentas šalinamas TIK jei jis atitinka
 * halucinacijos šabloną IR (jei diarizacija įjungta) neturi priskirto kalbėtojo -
 * nes pyannote halucinacijoms tyloje kalbėtojo NEpriskiria. Realios kalbos segmentai
 * (su kalbėtoju arba be aiškaus halucinacijos šablono) NELIEČIAMI.
 *
 * Idealus sprendimas ateičiai - faster-whisper vad_filter=True (šalina priežastį, ne
 * pasekmę). Šis post-filtras yra papildoma apsauga, veikianti nepriklausomai nuo VAD.
 */

// Žinomi halucinacijų šablonai (Whisper tylos "titrai"). Papildoma per aplinką:
// HALLUCINATION_EXTRA_PATTERNS (kableliu atskirti reg. išraiškų fragmentai).
const DEFAULT_PATTERNS = [
  /youtube\.com/i,
  /www\.youtube/i,
  /subtitl(es|ing)/i,
  /amara\.org/i,
  /titruoja|subtitles by|captions by/i,
  /ačiū,?\s*kad\s*(žiūrėjote|klausėtės)/i,
  /like\s*(and|&)\s*subscribe/i,
];

function buildPatterns() {
  const extra = (process.env.HALLUCINATION_EXTRA_PATTERNS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((frag) => {
      try {
        return new RegExp(frag, "i");
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return [...DEFAULT_PATTERNS, ...extra];
}

function looksLikeHallucination(text, patterns) {
  const t = (text || "").trim();
  if (!t) return true; // tuščias segmentas - irgi šalintinas
  return patterns.some((re) => re.test(t));
}

/**
 * Išfiltruoja halucinacijų segmentus.
 * @param {Array} segments - [{ start, end, text, speaker? }]
 * @param {Object} opts
 * @param {boolean} opts.diarized - ar segmentai turi kalbėtojų info (tada reikalaujame
 *   speaker=null halucinacijai; be diarizacijos - filtruojame tik pagal šabloną).
 * @param {boolean} opts.enabled - ar filtras įjungtas (numatyta true; galima išjungti).
 * @returns {{ segments: Array, removed: number, text: string }}
 */
function filterHallucinations(segments, opts = {}) {
  const enabled = opts.enabled !== false && process.env.FILTER_HALLUCINATIONS !== "false";
  if (!Array.isArray(segments) || !enabled) {
    return { segments: segments || [], removed: 0, text: rebuildText(segments || []) };
  }
  const patterns = buildPatterns();
  const kept = [];
  let removed = 0;
  for (const s of segments) {
    const isHalluc = looksLikeHallucination(s.text, patterns);
    // Su diarizacija: šalinam tik jei NĖRA kalbėtojo (pyannote tylai jo nepriskiria).
    // Be diarizacijos: šalinam pagal šabloną (nes speaker info nėra).
    const noSpeaker = !s.speaker;
    const shouldRemove = isHalluc && (opts.diarized ? noSpeaker : true);
    if (shouldRemove) {
      removed++;
      continue;
    }
    kept.push(s);
  }
  return { segments: kept, removed, text: rebuildText(kept) };
}

function rebuildText(segments) {
  return segments.map((s) => (s.text || "").trim()).filter(Boolean).join(" ");
}

module.exports = { filterHallucinations, looksLikeHallucination, DEFAULT_PATTERNS };
