const test = require("node:test");
const assert = require("node:assert/strict");
const { validateConfig } = require("../utils/startupChecks");

test("validateConfig: mock provideriai be raktų - jokių klaidų (demo režimas veikia iš karto)", () => {
  const { errors } = validateConfig({ LLM_PROVIDER: "mock", TRANSCRIPTION_PROVIDER: "mock", DIARIZATION_PROVIDER: "none" });
  assert.deepEqual(errors, []);
});

test("validateConfig: claude be ANTHROPIC_API_KEY - AIŠKI klaida startup metu, ne kritimas pirmoje užklausoje", () => {
  const { errors } = validateConfig({ LLM_PROVIDER: "claude" });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /ANTHROPIC_API_KEY/);
});

test("validateConfig: nežinomas provideris - klaida su galimų sąrašu", () => {
  const { errors } = validateConfig({ LLM_PROVIDER: "chatgpt5000" });
  assert.match(errors[0], /nežinomas/);
  assert.match(errors[0], /claude/);
});

test("validateConfig: FASTER_WHISPER_MODEL kaip neegzistuojantis kelias - klaida; kaip HF pavadinimas - ne", () => {
  const bad = validateConfig({ TRANSCRIPTION_PROVIDER: "faster-whisper-embedded", FASTER_WHISPER_MODEL: "/toks/kelias/neegzistuoja" });
  assert.ok(bad.errors.some((e) => e.includes("neegzistuoja")));
  const good = validateConfig({ TRANSCRIPTION_PROVIDER: "faster-whisper-embedded", FASTER_WHISPER_MODEL: "small" });
  assert.ok(!good.errors.some((e) => e.includes("FASTER_WHISPER_MODEL")));
});

test("validateConfig: ne-skaičius skaitiniame kintamajame - klaida", () => {
  const { errors } = validateConfig({ MAX_UPLOAD_MB: "daug" });
  assert.ok(errors.some((e) => e.includes("MAX_UPLOAD_MB")));
});

test("ClaudeProvider: max_tokens konfigūruojamas per ANTHROPIC_MAX_TOKENS (REGRESIJA: buvo hardcoded 1500, dėl ko 4 val. protokolas nutrūkdavo)", () => {
  const ClaudeProvider = require("../providers/llm/ClaudeProvider");
  const prev = { key: process.env.ANTHROPIC_API_KEY, max: process.env.ANTHROPIC_MAX_TOKENS };
  process.env.ANTHROPIC_API_KEY = "sk-test-fake";
  process.env.ANTHROPIC_MAX_TOKENS = "16000";
  try {
    const p = new ClaudeProvider();
    assert.equal(p.maxTokens, 16000);
    delete process.env.ANTHROPIC_MAX_TOKENS;
    const p2 = new ClaudeProvider();
    assert.equal(p2.maxTokens, 8000, "numatytoji reikšmė turi būti 8000, ne senoji 1500");
  } finally {
    if (prev.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev.key;
    if (prev.max === undefined) delete process.env.ANTHROPIC_MAX_TOKENS; else process.env.ANTHROPIC_MAX_TOKENS = prev.max;
  }
});
