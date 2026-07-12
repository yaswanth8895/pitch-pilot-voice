/**
 * Provision the PitchPilot outbound ElevenLabs agent (reproducible).
 * Requires ELEVENLABS_API_KEY. Prints the new agent_id.
 *
 *   ELEVENLABS_API_KEY=sk_… node scripts/create-agent.mjs
 *
 * Optional env:
 *   AGENT_LLM         LLM id (default "gpt-4o"). Native OpenAI ids work directly
 *                     (gpt-4o, gpt-4o-mini, gpt-5, gpt-5-mini, gpt-5.4-mini, gpt-5.5…).
 *                     Use "custom-llm" only to bring your own endpoint/key.
 *   AGENT_VOICE_ID    TTS voice (default George).
 *   AGENT_NAME        Agent name (default "PitchPilot Outbound").
 *   AGENT_MAX_TOKENS  Max LLM tokens per reply (default 150 — keep phone replies short).
 *   AGENT_MAX_DURATION Max call seconds (default 300 — demo safety cap).
 *   AGENT_GUARDRAILS  "false" to skip focus + prompt_injection guardrails.
 *   ELEVENLABS_API_BASE  Override API origin (default https://api.elevenlabs.io).
 *
 * The system prompt uses {{dynamic variables}} the Worker sends at call time:
 * lead_name, company, product_summary, strategy, objections, call_goal.
 */
const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey) {
  console.error("Set ELEVENLABS_API_KEY (get it from the ElevenLabs dashboard).");
  process.exit(1);
}

const base = (process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io").replace(/\/+$/, "");
const llm = process.env.AGENT_LLM || "gpt-4o";
const voiceId = process.env.AGENT_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb"; // George
const name = process.env.AGENT_NAME || "PitchPilot Outbound";
const maxTokens = Number(process.env.AGENT_MAX_TOKENS || 150);
const maxDuration = Number(process.env.AGENT_MAX_DURATION || 300);
const withGuardrails = process.env.AGENT_GUARDRAILS !== "false";

const systemPrompt = `# Personality
You are Pat, a concise, friendly AI sales assistant for {{company}}.

# Environment
You are on an outbound phone call with {{lead_name}} at {{company}}.

# Tone
- Warm and natural; one or two short sentences per turn.
- Ask one question at a time.
- Never invent pricing, discounts, availability, or claims beyond what you are given.

# Goal
Product: {{product_summary}}
Strategy: {{strategy}}
Likely objections: {{objections}}
1. Identify yourself as an AI assistant. This step is important: never claim to be human.
2. {{call_goal}}.
3. If they are interested, propose a concrete next step (a demo or a follow-up).
4. If they ask not to be contacted, apologize briefly and end the call.`;

const firstMessage =
  "Hi {{lead_name}}, this is an AI assistant calling from {{company}} — is now a quick moment to chat?";

const body = {
  name,
  conversation_config: {
    agent: {
      first_message: firstMessage,
      language: "en",
      prompt: {
        prompt: systemPrompt,
        llm,
        temperature: 0.5,
        max_tokens: maxTokens, // keep phone replies short + fast
        // NOTE: built-in tools (end_call, voicemail_detection) use a name/params
        // schema the create endpoint validates strictly — configure them in the
        // ElevenLabs dashboard after creation to avoid brittle inline schemas.
      },
    },
    // English agents require the English flash/turbo v2 models. flash_v2 = ~75ms.
    // Override with AGENT_TTS_MODEL (e.g. eleven_flash_v2_5) for multilingual.
    tts: { voice_id: voiceId, model_id: process.env.AGENT_TTS_MODEL || "eleven_flash_v2", optimize_streaming_latency: 3 },
    conversation: { max_duration_seconds: maxDuration },
  },
};

if (withGuardrails) {
  // Basic safety for a sales agent (all agents benefit from these two).
  body.platform_settings = {
    guardrails: {
      version: "1",
      focus: { is_enabled: true },
      prompt_injection: { is_enabled: true },
    },
  };
}

const res = await fetch(`${base}/v1/convai/agents/create`, {
  method: "POST",
  headers: { "xi-api-key": apiKey, "content-type": "application/json" },
  body: JSON.stringify(body),
});
const data = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Create failed (HTTP ${res.status}):`, JSON.stringify(data));
  if (withGuardrails) console.error("Tip: retry with AGENT_GUARDRAILS=false if the guardrails schema is rejected.");
  process.exit(1);
}

console.log(`✓ Agent created (llm=${llm}, voice=${voiceId}, max_tokens=${maxTokens})`);
console.log(`  agent_id: ${data.agent_id}`);
console.log(`\nNext: wrangler secret put ELEVENLABS_AGENT_ID   # paste the id above`);
