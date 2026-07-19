const meetingPromptV1 = require("./meeting_v1");
const meetingPromptV2 = require("./meeting_v2");
const meetingPromptV3 = require("./meeting_v3");

const PROMPTS = {
  "meeting_v1": meetingPromptV1,
  "meeting_v2": meetingPromptV2,
  "meeting_v3": meetingPromptV3,
  // "meeting_v4": require("./meeting_v4"),  // pridėkite ateityje, senos versijos NEIŠTRINAMOS
};

const ACTIVE_PROMPT_VERSION = process.env.PROMPT_VERSION || "meeting_v3";

function buildPrompt(vars, versionOverride) {
  const version = versionOverride || ACTIVE_PROMPT_VERSION;
  const builder = PROMPTS[version];
  if (!builder) throw new Error(`Nežinoma prompt versija: "${version}". Galimos: ${Object.keys(PROMPTS).join(", ")}`);
  return { prompt: builder(vars), promptVersion: version };
}

module.exports = { buildPrompt, PROMPTS, ACTIVE_PROMPT_VERSION };
