const LLMProvider = require("./LLMProvider");
const { fetchWithRetry } = require("../../utils/httpClient");

/**
 * STATUS: interface implemented, integration not verified with a real API key
 * in this environment. Code follows Google's public generateContent contract.
 */
class GeminiProvider extends LLMProvider {
  constructor(config = {}) {
    super(config);
    this.apiKey = config.apiKey || process.env.GOOGLE_API_KEY;
    this.model = config.model || process.env.GEMINI_MODEL || "gemini-2.5-pro";
    // Žr. ClaudeProvider.js komentarą apie nukirpimo bug'ą - čia limitas nustatomas
    // eksplicitiškai, kad ilgi protokolai nebūtų nukirpti tyliai.
    this.maxTokens = config.maxTokens || parseInt(process.env.GEMINI_MAX_TOKENS || "8000", 10);
    if (!this.apiKey) throw new Error("GeminiProvider: trūksta GOOGLE_API_KEY");
  }

  async generateProtocol(prompt) {
    const res = await fetchWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: this.maxTokens },
        }),
      }
    );
    if (!res.ok) throw new Error(`Gemini API klaida (${res.status}): ${await res.text()}`);
    const data = await res.json();
    return {
      rawText: data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "",
      truncated: data.candidates?.[0]?.finishReason === "MAX_TOKENS",
      maxTokensUsed: this.maxTokens,
      usage: data.usageMetadata
        ? {
            inputTokens: data.usageMetadata.promptTokenCount,
            outputTokens: data.usageMetadata.candidatesTokenCount,
          }
        : null,
      provider: "gemini",
      model: this.model,
    };
  }
}

module.exports = GeminiProvider;
