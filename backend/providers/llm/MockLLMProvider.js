const LLMProvider = require("./LLMProvider");

/**
 * Mock providerio tikslas - leisti visai sistemai (schema validacijai, redagavimui,
 * eksportams, audit log'ui) veikti be jokio apmokamo API rakto. Kad demo neklaidintų
 * (rodydamas tą patį protokolą nepriklausomai nuo įvesties), ši klasė ištraukia
 * pavadinimą/datą/dalyvius/transkripciją iš gauto prompt teksto ir sudaro protokolą
 * iš JŲ - ne iš statinio pavyzdžio.
 *
 * Tai NĖRA tikra kalbos analizė (jokio LLM čia nėra) - tai paprastos regex/heuristikos,
 * pakankamos demo/testavimo tikslams, kad rezultatas atspindėtų realiai įvestus duomenis.
 */
class MockLLMProvider extends LLMProvider {
  async generateProtocol(prompt) {
    // TESTAVIMUI: jei transkripcijoje yra __FORCE_ERROR__ žymė, mock meta klaidą.
    // Leidžia E2E/integraciniams testams patikrinti jobo NESĖKMĖS kelią (UI klaida,
    // job status=failed) be tikros LLM klaidos. Produkcijoje ši žymė natūraliai
    // neatsiranda.
    if (prompt.includes("__FORCE_ERROR__")) {
      throw new Error("Mock priverstinė klaida (E2E testui) - ANTHROPIC_API_KEY neturi patekti");
    }

    const pavadinimas = extractField(prompt, /Pavadinimas:\s*(.+)/) || "Nenurodyta";
    const data = extractField(prompt, /Data:\s*(.+)/) || "Nenurodyta";
    const dalyviaiRaw = extractField(prompt, /Dalyviai \(jei nurodyti rankomis\):\s*(.+)/) || "";
    const transcript = extractTranscript(prompt);

    const dalyviai = parseDalyviai(dalyviaiRaw, transcript);
    const sentences = splitSentences(transcript);

    const darbotvarke = sentences.slice(0, Math.min(2, sentences.length)).map((s) => truncate(s, 60));

    const aptarti_klausimai = sentences.slice(0, 3).map((s, i) => ({
      klausimas: `Klausimas Nr. ${i + 1}`,
      santrauka: truncate(s, 140),
    }));

    const nutarimai = sentences
      .filter((s) => /nutar|sutar|patvirtin|nusprend/i.test(s))
      .map((s) => truncate(s, 140));

    const veiksmai = extractActions(transcript, dalyviai);

    const protocol = {
      pavadinimas,
      data,
      dalyviai,
      darbotvarke: darbotvarke.length ? darbotvarke : ["Nenurodyta"],
      aptarti_klausimai,
      nutarimai: nutarimai.length ? nutarimai : ["Nenurodyta"],
      veiksmai,
    };

    return {
      rawText: JSON.stringify(protocol),
      usage: { inputTokens: 0, outputTokens: 0 },
      provider: "mock",
      model: "mock-heuristic-v1",
    };
  }
}

function extractField(prompt, regex) {
  const m = prompt.match(regex);
  if (!m) return null;
  const val = m[1].trim();
  if (/^nenurodyta/i.test(val)) return null;
  return val;
}

function extractTranscript(prompt) {
  // SVARBU: negalima tiesiog imti pirmo """ ... """ ATITIKIMO regexu - meeting_v2.js
  // prompt injection apsaugos tekstas PATS mini '"""' kaip pavyzdį (aiškindamas
  // taisyklę), todėl toks naivus regex pagautų neteisingą (instrukcijų, ne
  // transkripcijos) bloką. Vietoj to sujungiame su "Transkripcija" žyme IR imame
  // PASKUTINĮ """ ... """ bloką promptE (transkripcija visada yra paskutinė).
  const blocks = [...prompt.matchAll(/"""\s*([\s\S]*?)\s*"""/g)];
  if (blocks.length === 0) return "";
  return blocks[blocks.length - 1][1].trim();
}

function parseDalyviai(dalyviaiRaw, transcript) {
  if (dalyviaiRaw && !/nenurodyta|nustatyk/i.test(dalyviaiRaw)) {
    return dalyviaiRaw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const speakerMatches = [...transcript.matchAll(/^([A-ZĄČĘĖĮŠŲŪŽ][a-ząčęėįšųūž]+):/gm)];
  return [...new Set(speakerMatches.map((m) => m[1]))];
}

function splitSentences(text) {
  return text
    .replace(/^[A-ZĄČĘĖĮŠŲŪŽ][a-ząčęėįšųūž]+:\s*/gm, "")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1).trim() + "…" : s;
}

function extractActions(transcript, dalyviai) {
  const sentences = splitSentences(transcript);
  const actionSentences = sentences.filter((s) => /parengt|padaryt|iki\s|atlikt|paruoš/i.test(s));
  return actionSentences.map((s) => {
    const deadlineMatch = s.match(/iki\s+([^\s,.;]+(?:\s+[^\s,.;]+)?)/i);
    const responsible = dalyviai.find((d) => s.includes(d)) || "Nenurodyta";
    return {
      uzduotis: truncate(s, 100),
      atsakingas: responsible,
      terminas: deadlineMatch ? deadlineMatch[1] : "Nenurodyta",
    };
  });
}

module.exports = MockLLMProvider;
