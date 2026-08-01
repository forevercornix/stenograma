const { createLogger } = require("../utils/logger");
const log = createLogger("errors");
/**
 * Tiekėjų (LLM/ASR) klaidos gali atskleisti per daug (API endpoint'us, vidines
 * struktūras, kartais net raktų fragmentus klaidos tekste). Kliento pusei
 * skirtingai nei serverio logui - klientas mato NEUTRALŲ pranešimą, o pilnas
 * `error` objektas logguojamas serveryje (console.error), kad būtų galima
 * derinti (debug) neatskleidžiant nieko išorėje. Su PRIVACY_MODE=true ir šis
 * serverio logas sanitizuojamas (žr. utils/auditLog.js sanitizeForLogging).
 *
 * Naudojimas: kviečiama TIK 5xx (serverio/tiekėjo) klaidoms. 4xx klaidos
 * (validacija, autentifikacija, "nežinomas provideris" ir pan.) NĖRA
 * sanitizuojamos, nes tai saugūs, vartotojui naudingi pranešimai apie JO
 * užklausos problemą, ne apie vidinę sistemos būseną.
 */
function sanitizeServerError(error, context = "") {
  // PRIVACY_MODE=true: net serverio logas praeina pro audito sanitizaciją
  // (el. paštai, telefonai, keliai, raktai). Pagal nutylėjimą - NE, nes pilnas
  // stack trace yra pagrindinė derinimo priemonė; įjungiama sąmoningai tiems
  // diegimams, kur logai patenka į išorinę saugyklą.
  const { isPrivacyModeEnabled, sanitizeForLogging } = require("./auditLog");
  const loggable = isPrivacyModeEnabled() ? sanitizeForLogging(error) : error;

  log.error(`Vidinė klaida${context ? ` (${context})` : ""}:`, loggable);
  return "Vidinė serverio klaida apdorojant užklausą. Pabandykite vėliau arba susisiekite su administratoriumi.";
}

module.exports = { sanitizeServerError };
