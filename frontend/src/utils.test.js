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

  it("grąžina tuščią eilutę, kai jobas completed/failed (progresas nebeaktualus)", () => {
    expect(formatTranscribeProgress({ status: "completed" })).toBe("");
    expect(formatTranscribeProgress({ status: "failed" })).toBe("");
  });

  it('grąžina "apdorojama..." kai processing, bet progreso duomenų dar nėra (pvz. tiekėjas jo neteikia)', () => {
    expect(formatTranscribeProgress({ status: "processing" })).toBe("apdorojama...");
    expect(formatTranscribeProgress({ status: "processing", progress: null })).toBe("apdorojama...");
  });

  it("REALIAI PATIKRINTA formatavimas: rodo laiko poziciją ir procentą, kai progreso duomenys yra", () => {
    const result = formatTranscribeProgress({ status: "processing", progress: { current: 90, total: 600 } });
    expect(result).toBe("1:30 / 10:00 · 15%");
  });

  it("apriboja procentą iki 100%, jei current viršija total (apsauga nuo paskutinio segmento zigzago)", () => {
    const result = formatTranscribeProgress({ status: "processing", progress: { current: 601, total: 600 } });
    expect(result).toContain("100%");
  });
});
