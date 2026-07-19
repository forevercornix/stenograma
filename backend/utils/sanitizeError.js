/**
 * Tiekėjų (LLM/ASR) klaidos gali atskleisti per daug (API endpoint'us, vidines
 * struktūras, kartais net raktų fragmentus klaidos tekste). Kliento pusei
 * skirtingai nei serverio logui - klientas mato NEUTRALŲ pranešimą, o pilnas
 * `error` objektas visada logguojamas serveryje (console.error), kad būtų
 * galima derinti (debug) neatskleidžiant nieko išorėje.
 *
 * Naudojimas: kviečiama TIK 5xx (serverio/tiekėjo) klaidoms. 4xx klaidos
 * (validacija, autentifikacija, "nežinomas provideris" ir pan.) NĖRA
 * sanitizuojamos, nes tai saugūs, vartotojui naudingi pranešimai apie JO
 * užklausos problemą, ne apie vidinę sistemos būseną.
 */
function sanitizeServerError(error, context = "") {
  console.error(`[stenograma] Vidinė klaida${context ? ` (${context})` : ""}:`, error);
  return "Vidinė serverio klaida apdorojant užklausą. Pabandykite vėliau arba susisiekite su administratoriumi.";
}

module.exports = { sanitizeServerError };
