const ClaudeProvider = require("./ClaudeProvider");
const GPTProvider = require("./GPTProvider");
const GeminiProvider = require("./GeminiProvider");
const MockLLMProvider = require("./MockLLMProvider");

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
  const ProviderClass = REGISTRY[name];
  if (!ProviderClass) {
    throw new Error(`Nežinomas LLM_PROVIDER: "${name}". Galimi: ${Object.keys(REGISTRY).join(", ")}`);
  }
  return new ProviderClass(config);
}

module.exports = { getLLMProvider, REGISTRY };
