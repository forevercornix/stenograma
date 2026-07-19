const LLMProvider = require("./LLMProvider");
const { fetchWithRetry } = require("../../utils/httpClient");

/**
 * STATUS: implemented and verified - functional with a real ANTHROPIC_API_KEY
 * (uses the standard /v1/messages endpoint).
 */
class ClaudeProvider extends LLMProvider {
  constructor(config = {}) {
    super(config);
    this.apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
    this.model = config.model || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
    // RASTA REALIAI NAUDOJANT (4 val. posėdžio protokolas): anksčiau čia buvo
    // hardcoded max_tokens: 1500 - pakako trumpiems demo protokolams, bet ilgo
    // susitikimo protokolo JSON NUTRŪKDAVO viduryje, schema validacija žlugdavo,
    // o repair retry (su tuo pačiu limitu) nutrūkdavo lygiai taip pat. Klaidos
    // pranešimas ("Nepavyko gauti validaus protokolo") neatskleisdavo priežasties.
    // Dabar: konfigūruojama per env, numatyta 8000, o stop_reason perduodamas
    // aukštyn, kad protocolService galėtų aiškiai pranešti apie nukirpimą.
    this.maxTokens = config.maxTokens || parseInt(process.env.ANTHROPIC_MAX_TOKENS || "8000", 10);
    if (!this.apiKey) throw new Error("ClaudeProvider: trūksta ANTHROPIC_API_KEY");
  }

  async generateProtocol(prompt) {
    const res = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Claude API klaida (${res.status}): ${await res.text()}`);
    const data = await res.json();
    const rawText = (data.content || [])
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n")
      .trim();

    return {
      rawText,
      // "max_tokens" čia reiškia, kad atsakymas NUKIRPTAS - žr. protocolService,
      // kuris šį atvejį paverčia aiškia, veiksminga klaida vietoj kriptinės.
      truncated: data.stop_reason === "max_tokens",
      maxTokensUsed: this.maxTokens,
      usage: data.usage
        ? { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens }
        : null,
      provider: "claude",
      model: this.model,
    };
  }
}

module.exports = ClaudeProvider;
