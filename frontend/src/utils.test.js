import { describe, it, expect } from "vitest";
import { todayISO, formatDateLT, completeness, escapeHtml, formatSecondsToMMSS, formatTranscribeProgress } from "./utils.js";

describe("formatDateLT", () => {
  it("konvertuoja ISO datą (YYYY-MM-DD) į lietuvišką formatą (DD-MM-YYYY)", () => {
    expect(formatDateLT("2026-07-09")).toBe("09-07-2026");
  });

  it("grąžina tuščią eilutę, kai įvestis tuščia/undefined", () => {
    expect(formatDateLT("")).toBe("");
    expect(formatDateLT(undefined)).toBe("");
  });
});

describe("todayISO", () => {
  it("grąžina datą ISO formatu (YYYY-MM-DD), 10 simbolių", () => {
    const result = todayISO();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("completeness", () => {
  it("grąžina 0, kai protokolo nėra", () => {
    expect(completeness(null)).toBe(0);
  });

  it("grąžina 100, kai visi laukai užpildyti", () => {
    const protocol = {
      pavadinimas: "Susitikimas",
      data: "2026-07-09",
      dalyviai: ["Jonas"],
      darbotvarke: ["Punktas 1"],
      nutarimai: ["Nutarimas 1"],
      veiksmai: [{ uzduotis: "Užduotis", atsakingas: "Jonas", terminas: "rytoj" }],
    };
    expect(completeness(protocol)).toBe(100);
  });

  it('"Nenurodyta" reikšmė neskaičiuojama kaip užpildyta', () => {
    const protocol = {
      pavadinimas: "Susitikimas",
      data: "Nenurodyta",
      dalyviai: [],
      darbotvarke: [],
      nutarimai: ["Nenurodyta"],
      veiksmai: [],
    };
    const score = completeness(protocol);
    expect(score).toBeLessThan(100);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it('REGRESIJOS TESTAS (rastas testuojant su tikru audio): masyvas su VIENINTELIU "Nenurodyta" elementu NESISKAIČIUOJA kaip užpildytas laukas, net jei masyvas netuščias', () => {
    // Prieš pataisymą ši funkcija tikrindavo tik `array.length > 0`, tad
    // `["Nenurodyta"]` būdavo laikomas "užpildytu" lygiai taip pat, kaip
    // `["Padidinti biudžetą"]` - protokolas be jokio realaus nutarimo rodydavo
    // klaidinamai aukštą pilnumo procentą.
    const withPlaceholderArray = {
      pavadinimas: "Susitikimas",
      data: "2026-07-09",
      dalyviai: [],
      darbotvarke: ["Realus punktas"],
      nutarimai: ["Nenurodyta"], // <- turėtų būti traktuojamas TAIP PAT kaip tuščias []
      veiksmai: [],
    };
    const withEmptyArray = {
      ...withPlaceholderArray,
      nutarimai: [],
    };
    // Abu variantai (["Nenurodyta"] ir []) semantiškai reiškia "nieko nėra" -
    // tad turi grąžinti TIKSLIAI tą patį pilnumo procentą.
    expect(completeness(withPlaceholderArray)).toBe(completeness(withEmptyArray));
  });

  it("masyvas su bent vienu PRASMINGU elementu SKAIČIUOJASI kaip užpildytas, net jei kiti elementai yra Nenurodyta", () => {
    const protocol = {
      pavadinimas: "Susitikimas",
      data: "2026-07-09",
      dalyviai: [],
      darbotvarke: [],
      nutarimai: ["Nenurodyta", "Padidinti biudžetą 20%"],
      veiksmai: [],
    };
    const withOnlyPlaceholder = { ...protocol, nutarimai: ["Nenurodyta"] };
    expect(completeness(protocol)).toBeGreaterThan(completeness(withOnlyPlaceholder));
  });

  it("dalinis užpildymas grąžina tarpinį procentą", () => {
    const protocol = {
      pavadinimas: "Susitikimas",
      data: "2026-07-09",
      dalyviai: [],
      darbotvarke: [],
      nutarimai: [],
      veiksmai: [],
    };
    const score = completeness(protocol);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(100);
  });
});

describe("escapeHtml", () => {
  it("escape'ina <, >, & simbolius (XSS/HTML injection apsauga .doc eksporte)", () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe("&lt;script&gt;alert(\"x\")&lt;/script&gt;");
    expect(escapeHtml("Tom & Jerry")).toBe("Tom &amp; Jerry");
  });

  it("grąžina tuščią eilutę su null/undefined įvestimi", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });

  it("skaičius/kitus tipus konvertuoja į string prieš escape'inant", () => {
    expect(escapeHtml(42)).toBe("42");
  });
});

describe("formatSecondsToMMSS", () => {
  it("formatuoja sekundes kaip M:SS", () => {
    expect(formatSecondsToMMSS(65)).toBe("1:05");
    expect(formatSecondsToMMSS(600)).toBe("10:00");
    expect(formatSecondsToMMSS(5)).toBe("0:05");
  });

  it("tvarko null/NaN gracingai", () => {
    expect(formatSecondsToMMSS(null)).toBe("0:00");
    expect(formatSecondsToMMSS(undefined)).toBe("0:00");
  });
});

describe("formatTranscribeProgress", () => {
  it('grąžina "eilėje..." kai jobas dar queued', () => {
    expect(formatTranscribeProgress({ status: "queued" })).toBe("eilėje...");
  });

  it("queued NERODO vykdymo fazės teksto", () => {
    // `queued` job'as fazės neturi (#154) – net jei laukas kažkaip atsirastų.
    const r = formatTranscribeProgress({ status: "queued", phase: "transcribing" });
    expect(r).toBe("eilėje...");
    expect(r).not.toContain("Transkribuojama");
  });

  it("terminaliuose statusuose progreso UI nebėra", () => {
    for (const status of ["completed", "failed", "cancelled"]) {
      expect(formatTranscribeProgress({ status })).toBe("");
    }
  });

  it("REGRESIJA: progresas NĖRA sekundės – rodomas TIK procentas", () => {
    /**
     * ⚠️ Ankstesnė versija formatavo `progress` kaip laiką
     * (`formatSecondsToMMSS`), nors backend siunčia procentinę skalę
     * `{current: 42, total: 100}`. Vartotojas būtų matęs „00:42 / 01:40" –
     * IŠGALVOTĄ trukmę.
     *
     * `progress` yra fazei lokalūs darbo vienetai (#154); UI jų
     * neinterpretuoja.
     */
    const r = formatTranscribeProgress({
      status: "processing",
      phase: "transcribing",
      progressKnown: true,
      progress: { current: 42, total: 100 },
    });

    expect(r).toBe("Transkribuojama... 42 %");
    expect(r).not.toContain("00:42");
    expect(r).not.toContain("01:40");
    expect(r).not.toContain(":");
  });

  it("progressKnown=false NERODO procento NET kai progress yra", () => {
    /**
     * ⚠️ ESMINIS ATVEJIS. Jei testas duotų `progress: null`, jis praeitų ir
     * tada, kai `progressKnown` visai ignoruojamas – užtektų, kad duomenų nėra.
     *
     * Čia duomenys YRA, bet `progressKnown=false` sako, kad jie nebegalioja
     * (pvz. pasenę iš ankstesnės fazės). Procento rodyti negalima.
     */
    const r = formatTranscribeProgress({
      status: "processing",
      phase: "diarizing",
      progressKnown: false,
      progress: { current: 4420, total: 4420 },
    });

    expect(r).toBe("Atliekama diarizacija...");
    expect(r).not.toContain("%");
    expect(r).not.toContain("100");
  });

  it("progressKnown=false su tuščiu progresu – tas pats rezultatas", () => {
    /**
     * Būtent „užstrigęs 100 %" ir buvo #154 pradinė problema: transkripcija
     * baigėsi, diarizacija progreso neteikia, ir vartotojui atrodė, kad darbas
     * pakibo.
     */
    const r = formatTranscribeProgress({
      status: "processing",
      phase: "diarizing",
      progressKnown: false,
      progress: null,
    });

    expect(r).toBe("Atliekama diarizacija...");
    expect(r).not.toContain("%");
  });

  it("procentas rodomas TIK kai progressKnown yra boolean true", () => {
    /**
     * FAIL-CLOSED riba (#154, Step 7).
     *
     * ⚠️ Truthiness patikra (`!job.progressKnown`) praleistų `"false"`, kuris
     * yra truthy. Frontend gauna HTTP JSON, ne Redis reikšmes – bet jei backend
     * normalizavimo riba regresuotų ir tokia reikšmė pasiektų UI,
     * `progressKnown: "false"` duotų „Atliekama diarizacija... 100 %", t. y.
     * būtent tą klaidingą būseną, nuo kurios #154 saugo.
     *
     * Backend riba fail-fast'ina (Step 6), UI – fail-closed'ina. Abi turi
     * reikšti tą patį.
     */
    for (const progressKnown of [false, null, undefined, 0, 1, "false", "true", "1"]) {
      const r = formatTranscribeProgress({
        status: "processing",
        phase: "diarizing",
        progressKnown,
        progress: { current: 100, total: 100 },
      });

      expect(r).toBe("Atliekama diarizacija...");
      expect(r).not.toContain("%");
    }

    // Tik eksplicitinis boolean `true` leidžia procentą.
    expect(
      formatTranscribeProgress({
        status: "processing",
        phase: "diarizing",
        progressKnown: true,
        progress: { current: 100, total: 100 },
      })
    ).toBe("Atliekama diarizacija... 100 %");
  });

  it("VISOS penkios fazės turi savo tekstą", () => {
    const atvejai = [
      ["validating", "Tikrinami duomenys..."],
      ["transcribing", "Transkribuojama..."],
      ["diarizing", "Atliekama diarizacija..."],
      ["merging", "Jungiami kalbėtojai su transkripcija..."],
      ["generating_protocol", "Generuojamas protokolas..."],
    ];

    for (const [phase, laukiama] of atvejai) {
      expect(
        formatTranscribeProgress({ status: "processing", phase, progressKnown: false })
      ).toBe(laukiama);
    }
  });

  it("nežinoma fazė duoda saugų fallback, ne crash", () => {
    /**
     * Backend gali pridėti fazę anksčiau nei frontend'as bus įdiegtas.
     * Vartotojas tada turi matyti bendrą tekstą, ne `undefined`.
     */
    expect(
      formatTranscribeProgress({ status: "processing", phase: "nauja_faze", progressKnown: false })
    ).toBe("Apdorojama...");

    expect(formatTranscribeProgress({ status: "processing" })).toBe("Apdorojama...");
  });

  it("netinkami progreso duomenys NESUGRIAUNA rodymo", () => {
    // `progressKnown: true`, bet duomenys sugadinti – rodom fazę be procento.
    const blogi = [
      { current: 5 },
      { current: NaN, total: 10 },
      { current: 1, total: 0 },
      null,
    ];

    for (const progress of blogi) {
      expect(
        formatTranscribeProgress({
          status: "processing",
          phase: "transcribing",
          progressKnown: true,
          progress,
        })
      ).toBe("Transkribuojama...");
    }
  });

  it("procentas apribojamas 0–100 ribose", () => {
    const virs = formatTranscribeProgress({
      status: "processing",
      phase: "transcribing",
      progressKnown: true,
      progress: { current: 601, total: 600 },
    });
    expect(virs).toContain("100 %");

    const zemiau = formatTranscribeProgress({
      status: "processing",
      phase: "transcribing",
      progressKnown: true,
      progress: { current: -5, total: 600 },
    });
    expect(zemiau).toContain("0 %");
  });
});
