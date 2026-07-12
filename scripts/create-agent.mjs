/**
 * Provision the PitchPilot outbound ElevenLabs agent (reproducible).
 * Requires ELEVENLABS_API_KEY. Prints the new agent_id.
 *
 *   ELEVENLABS_API_KEY=sk_… node scripts/create-agent.mjs
 *
 * Optional env:
 *   AGENT_LLM       LLM id (default "gpt-4o"). Native OpenAI ids are accepted
 *                   directly (gpt-4o, gpt-4o-mini, gpt-5, gpt-5-mini, gpt-5.4-mini…).
 *                   Use "custom-llm" only to bring your own endpoint/key.
 *   AGENT_VOICE_ID  TTS voice (default George).
 *   AGENT_NAME      Agent name (default "PitchPilot Outbound").
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
        // Recommended for outbound calling.
        built_in_tools: { end_call: {}, voicemail_detection: {} },
      },
    },
    tts: { voice_id: voiceId },
  },
};

const res = await fetch(`${base}/v1/convai/agents/create`, {
  method: "POST",
  headers: { "xi-api-key": apiKey, "content-type": "application/json" },
  body: JSON.stringify(body),
});
const data = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Create failed (HTTP ${res.status}):`, JSON.stringify(data));
  process.exit(1);
}

console.log(`✓ Agent created (llm=${llm}, voice=${voiceId})`);
console.log(`  agent_id: ${data.agent_id}`);
console.log(`\nNext: wrangler secret put ELEVENLABS_AGENT_ID   # paste the id above`);
