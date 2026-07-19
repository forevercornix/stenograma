/**
 * Prompt v1 — bazinė versija (naudota pirminiame MVP).
 * Nekeisti šio failo po to, kai jis naudotas gamyboje — kurkite meeting_v2.js ir t.t.,
 * kad audit log'e būtų atsekama, kuri prompt versija sugeneravo kurį protokolą.
 */
module.exports = function meetingPromptV1({ title, date, participants, transcript, segments }) {
  const hasTimestamps = Array.isArray(segments) && segments.length > 0;
  const transcriptBlock = hasTimestamps
    ? segments
        .map(
          (s) =>
            `[${formatTime(s.start)}] ${s.speaker ? s.speaker + ": " : ""}${s.text}`
        )
        .join("\n")
    : transcript;

  return `Tu gauni susirinkimo / susitikimo garso transkripciją (galimai su kalbos klaidomis, pasikartojimais, šnekamosios kalbos elementais). Tavo užduotis – iš jos parengti tvarkingą, oficialų susitikimo protokolą lietuvių kalba.

Susitikimo informacija:
- Pavadinimas: ${title || "Nenurodyta"}
- Data: ${date || "Nenurodyta"}
- Dalyviai (jei nurodyti rankomis): ${participants?.length ? participants.join(", ") : "nenurodyta rankomis - nustatyk iš transkripcijos, jei įmanoma"}

Transkripcija${hasTimestamps ? " (su laiko žymomis ir kalbėtojais)" : ""}:
"""
${transcriptBlock.trim()}
"""

Grąžink GRIEŽTAI TIK JSON objektą (be markdown, be paaiškinimų, be \`\`\` žymų) su tokia struktūra:
{
  "pavadinimas": string,
  "data": string,
  "dalyviai": string[],
  "darbotvarke": string[],
  "aptarti_klausimai": [{"klausimas": string, "santrauka": string, "laikas": string | null}],
  "nutarimai": string[],
  "veiksmai": [{"uzduotis": string, "atsakingas": string, "terminas": string}]
}

Taisyklės:
- Rašyk taisyklinga lietuvių kalba, be šnekamosios kalbos triukšmo.
- Jei kokios nors informacijos transkripcijoje trūksta (pvz. terminas, atsakingas asmuo), įrašyk "Nenurodyta", NIEKADA nesugalvok faktų, kurių transkripcijoje nėra.
- "santrauka" - 1-3 sakinių esmė, ne pažodinis perrašymas.
- "laikas" - jei transkripcijoje yra laiko žymos, nurodyk kada klausimas pradėtas aptarti (formatu MM:SS arba HH:MM:SS), kitaip null.
- Kiekvienas "veiksmai" įrašas turi būti aiškiai paremtas transkripcijos tekstu - jei neaišku, kas atsakingas ar koks terminas, rašyk "Nenurodyta", nespėlok.
- Jei dalyviai nenurodyti rankomis, identifikuok juos iš kalbėtojų žymų transkripcijoje; jei neįmanoma - tuščias masyvas.`;
};

function formatTime(seconds) {
  if (seconds == null) return "00:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
