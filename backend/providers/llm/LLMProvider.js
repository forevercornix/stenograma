/**
 * Bazinė sąsaja visiems LLM tiekėjams, naudojamiems protokolui generuoti.
 * Kontraktas vienodas nepriklausomai nuo tiekėjo:
 *
 *   generateProtocol(prompt: string) => Promise<{
 *     rawText: string,
 *     usage: { inputTokens: number, outputTokens: number } | null,
 *     provider: string,
 *     model: string,
 *   }>
 */
class LLMProvider {
  constructor(config = {}) {
    if (this.constructor === LLMProvider) {
      throw new Error("LLMProvider yra abstrakti klasė, naudokite konkretų providerį");
    }
    this.config = config;
  }

  // eslint-disable-next-line no-unused-vars
  async generateProtocol(prompt) {
    throw new Error(`${this.constructor.name} turi implementuoti generateProtocol()`);
  }

  get name() {
    return this.constructor.name;
  }
}

module.exports = LLMProvider;
