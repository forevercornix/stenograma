/**
 * Sujungia transkripcijos segmentus ({start,end,text}) su NEPRIKLAUSOMAI gautais
 * diarizacijos intervalais ({start,end,speaker}) pagal laiko persidengimą.
 *
 * Kiekvienam transkripcijos segmentui priskiriamas kalbėtojas iš to diarizacijos
 * intervalo, su kuriuo persidengimas (sekundėmis) didžiausias. Jei nė vienas
 * intervalas nepersidengia, paliekamas segmento originalus `speaker` (jei buvo)
 * arba `null`.
 */
function mergeDiarization(segments, turns) {
  if (!Array.isArray(segments)) return segments;
  if (!Array.isArray(turns) || turns.length === 0) return segments;

  return segments.map((seg) => {
    let bestTurn = null;
    let bestOverlap = 0;

    for (const turn of turns) {
      const overlap = Math.max(0, Math.min(seg.end, turn.end) - Math.max(seg.start, turn.start));
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestTurn = turn;
      }
    }

    return { ...seg, speaker: bestTurn ? bestTurn.speaker : seg.speaker ?? null };
  });
}

module.exports = { mergeDiarization };
