/**
 * REZULTATŲ POROS — VIENAS SĄRAŠAS, TRYS KELIAI (#157, PR-4).
 *
 * ⚠️ KLAUSIMAS, Į KURĮ ATSAKO ŠIS SĄRAŠAS: ar `inline` ir `external` verdiktai
 * SUTAMPA toms pačioms poroms.
 *
 * `inline` kelias lygina kanonines eilutes (`kanoninisRezultatas()`), external —
 * persistintą `checksum`. Tai ta pati išvestis dviem pavidalais, bet „ta pati" yra
 * TEIGINYS, kol jo niekas nepatikrino. Sąrašas gyvena atskirai, kad abu keliai gautų
 * TIKSLIAI tą pačią įvestį; įrašius jį į vieną testą, antrasis anksčiau ar vėliau gautų
 * savo variantą, ir paritetas taptų nepatikrinamas.
 *
 * ⚠️ CHECKSUM YRA FAST-PATH, NE SEMANTIKA. Nesutapus verdiktams, laimi
 * `kanoninisRezultatas()`, o nesutapimas yra DEFEKTAS, ne toleruojama riba — todėl
 * testas jį fiksuoja kaip kritimą, ne kaip diagnostiką.
 */

/**
 * `tapatus: true` — antras `finish()` privalo būti no-op;
 * `tapatus: false` — antras `finish()` privalo duoti `RESULT_CONFLICT`.
 */
const POROS = Object.freeze([
  {
    vardas: "identiškas objektas",
    pirmas: { text: "labas", segments: [1, 2] },
    antras: { text: "labas", segments: [1, 2] },
    tapatus: true,
  },
  {
    /** ⚠️ `jsonb` raktų tvarkos nesaugo, ir kanoninis autoritetas ją rūšiuoja. */
    vardas: "kita raktų tvarka",
    pirmas: { b: 1, a: 2 },
    antras: { a: 2, b: 1 },
    tapatus: true,
  },
  {
    /** ⚠️ MASYVO TVARKA YRA SEMANTIKA: segmentų eilė nėra aibė. */
    vardas: "kita masyvo tvarka",
    pirmas: { segments: [1, 2] },
    antras: { segments: [2, 1] },
    tapatus: false,
  },
  {
    vardas: "skaičių normalizacija",
    pirmas: { n: 1 },
    antras: { n: 1.0 },
    tapatus: true,
  },
  {
    vardas: "papildomas laukas",
    pirmas: { text: "x" },
    antras: { text: "x", extra: null },
    tapatus: false,
  },
  {
    /** `undefined` laukas kanoninėje formoje dingsta — abi pusės privalo tai matyti. */
    vardas: "undefined laukas dingsta",
    pirmas: { text: "x" },
    antras: { text: "x", nera: undefined },
    tapatus: true,
  },
  {
    vardas: "gilus skirtumas",
    pirmas: { a: { b: { c: 1 } } },
    antras: { a: { b: { c: 2 } } },
    tapatus: false,
  },
  {
    vardas: "lietuviški rašmenys",
    pirmas: { text: "ąčęėįšųūž" },
    antras: { text: "ąčęėįšųūž" },
    tapatus: true,
  },
]);

module.exports = { POROS };
