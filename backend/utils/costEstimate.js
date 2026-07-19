/**
 * Apytikslis kainos skaičiavimas audit log'ui. Kainos KEIČIASI - laikykite jas
 * konfigūruojamas per env, o ne "kietai" kode. Numatytosios reikšmės yra
 * apytikslės orientacinės (USD už 1M tokenų) - PATIKRINKITE aktualius tiekėjo
 * įkainius prieš naudodami šiuos skaičius realiam biudžeto planavimui.
 */
const PRICING_PER_MTOK = {
  claude: {
    input: parseFloat(process.env.PRICE_CLAUDE_INPUT_PER_MTOK || "3"),
    output: parseFloat(process.env.PRICE_CLAUDE_OUTPUT_PER_MTOK || "15"),
  },
  gpt: {
    input: parseFloat(process.env.PRICE_GPT_INPUT_PER_MTOK || "2.5"),
    output: parseFloat(process.env.PRICE_GPT_OUTPUT_PER_MTOK || "10"),
  },
  gemini: {
    input: parseFloat(process.env.PRICE_GEMINI_INPUT_PER_MTOK || "1.25"),
    output: parseFloat(process.env.PRICE_GEMINI_OUTPUT_PER_MTOK || "5"),
  },
  mock: { input: 0, output: 0 },
};

function estimateCost(provider, usage) {
  if (!usage) return null;
  const pricing = PRICING_PER_MTOK[provider] || PRICING_PER_MTOK.mock;
  const inputCost = (usage.inputTokens / 1_000_000) * pricing.input;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.output;
  return Math.round((inputCost + outputCost) * 10000) / 10000;
}

module.exports = { estimateCost, PRICING_PER_MTOK };
