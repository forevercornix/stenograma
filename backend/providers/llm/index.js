const ClaudeProvider = require("./ClaudeProvider");
const GPTProvider = require("./GPTProvider");
const GeminiProvider = require("./GeminiProvider");
const MockLLMProvider = require("./MockLLMProvider");
const { RedactingLLMProvider, RedactionError } = require("./RedactingLLMProvider");
const { isExternal } = require("../../utils/providerPrivacy");
const { getPrivacyPolicy } = require("../../utils/privacyPolicy");
const { probeRedactionComponent } = require("../../utils/redactionComponent");
const { assertProviderAllowed } = require("../../utils/providerGovernance");

const REGISTRY = {
  claude: ClaudeProvider,
  gpt: GPTProvider,
  gemini: GeminiProvider,
  mock: MockLLMProvider,
};

/**
 *   LLM_PROVIDER=claude node server.js
 *   LLM_PROVIDER=gpt node server.js
 *   LLM_PROVIDER=mock node server.js   (numatytoji, veikia be raktų)
 */

function getLLMProvider(nameOverride, config = {}) {
  const name = (nameOverride || process.env.LLM_PROVIDER || "mock").toLowerCase();
  // hasOwnProperty, o NE `REGISTRY[name]` tiesiogiai: objekto literalas paveldi
  // prototipą, tad "constructor"/"toString" praeidavo kaip "žinomi" tiekėjai ir
  // grąžindavo Object vietoj providerio (CodeQL: unvalidated dynamic method call).
  if (!Object.prototype.hasOwnProperty.call(REGISTRY, name)) {
    throw new Error(`Nežinomas LLM_PROVIDER: "${name}". Galimi: ${Object.keys(REGISTRY).join(", ")}`);
  }

  /**
   * VALDYSENA tikrinama PO registro patikros.
   *
   * Tvarka svarbi diagnostikai: rašybos klaida („clade") turi duoti
   * „nežinomas tiekėjas", ne „nėra valdysenos įrašo". Antrasis pranešimas
   * siųstų operatorių taisyti valdysenos failo, nors problema – įvestyje.
   */
  assertProviderAllowed("llm", name);

  const ProviderClass = REGISTRY[name];
  if (typeof ProviderClass !== "function") {
    throw new Error(`Nekorektiška LLM tiekėjo registracija: "${name}" nėra konstruktorius.`);
  }
  const provider = new ProviderClass(config);

  return _enforceRedaction(provider, name);
}

/**
 * VIENINTELIS redakcijos vykdymo taškas (GDPR #5).
 *
 * Čia, o ne kvietimo vietose: pro šią fabriką praeina IR inline
 * (routes/generate.js), IR BullMQ (queues/processors.js) keliai, tad naujas
 * kelias apsaugą gauna automatiškai.
 *
 * Lokalūs tiekėjai (mock ir kt.) neliečiami - duomenys neišeina iš mašinos, tad
 * redaguoti nėra ko saugoti, o redakcija be reikalo blogintų protokolo kokybę.
 */
function _enforceRedaction(provider, name) {
  const privacy = getPrivacyPolicy();

  if (!privacy.requireRedactionBeforeExternal) return provider;
  if (!isExternal("llm", name)) return provider;

  const probe = probeRedactionComponent();

  // Startup validacija tokį derinį jau turi būti sustabdžiusi. Jei atsidūrėm čia
  // (pvz. env pakeista veikiant, ar tiekėjas perjungtas per override), fail-closed
  // kartojam: geriau kristi, negu išsiųsti neredaguotus duomenis.
  if (probe.state !== "ok") {
    throw new RedactionError(
      `REQUIRE_REDACTION_BEFORE_EXTERNAL=true, bet PII redakcijos komponentas nepasiekiamas ` +
        `(${probe.state}${probe.detail ? `: ${probe.detail}` : ""}). Išorinis tiekėjas "${name}" nekviečiamas.`
    );
  }

  return new RedactingLLMProvider(provider, probe.redact, probe.module);
}


module.exports = { getLLMProvider, REGISTRY, RedactionError };
