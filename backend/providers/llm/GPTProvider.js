const LLMProvider = require("./LLMProvider");
const { fetchWithRetry } = require("../../utils/httpClient");

/**
 * STATUS: interface implemented, integration not verified with a real API key
 * in this environment. Code follows OpenAI's public chat completions contract.
 */
class GPTProvider extends LLMProvider {
  constructor(config = {}) {
    super(config);
    this.apiKey = config.apiKey || process.env.OPENAI_API_KEY;
    this.model = config.model || process.env.OPENAI_MODEL || "gpt-4o";
    // Žr. ClaudeProvider.js komentarą - tas pats nukirpimo bug'as galiojo ir čia.
    this.maxTokens = config.maxTokens || parseInt(process.env.OPENAI_MAX_TOKENS || "8000", 10);
    if (!this.apiKey) throw new Error("GPTProvider: trūksta OPENAI_API_KEY");
  }

  async generateProtocol(prompt) {
    const res = await fetchWithRetry("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: this.maxTokens,
      }),
    });
    if (!res.ok) throw new Error(`OpenAI API klaida (${res.status}): ${await res.text()}`);
    const data = await res.json();
    return {
      rawText: data.choices?.[0]?.message?.content?.trim() || "",
      truncated: data.choices?.[0]?.finish_reason === "length",
      maxTokensUsed: this.maxTokens,
      usage: data.usage
        ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
        : null,
      provider: "gpt",
      model: this.model,
    };
  }
}

module.exports = GPTProvider;
