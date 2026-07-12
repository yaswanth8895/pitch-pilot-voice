/**
 * Stage-2 Worker-side webhook logic, tested without real ElevenLabs creds by
 * signing payloads locally (node:crypto) and checking the Worker's Web-Crypto
 * HMAC verification, transcript flattening, and forwarding to Convex.
 *
 *   node test/webhook.mjs
 */
import crypto from "node:crypto";
import worker from "../src/index.ts";
import { startMock } from "../mock/convex-mock.mjs";

const SECRET = "dev-shared-secret";
const WEBHOOK_SECRET = "whsec_test_123";
const ctx = { waitUntil() {} };

function signedRequest(body, { secret = WEBHOOK_SECRET, ts = 1720000000 } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const hex = crypto.createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex");
  return new Request("http://worker/webhooks/elevenlabs", {
    method: "POST",
    headers: { "content-type": "application/json", "elevenlabs-signature": `t=${ts},v0=${hex}` },
    body: raw,
  });
}

let failures = 0;
function check(name, condition) {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}

const mock = await startMock({ port: 8789, secret: SECRET });
const env = {
  VOICE_SHARED_SECRET: SECRET,
  CONVEX_SITE_URL: mock.url,
  ELEVENLABS_WEBHOOK_SECRET: WEBHOOK_SECRET,
};

const transcriptEvent = {
  type: "post_call_transcription",
  event_timestamp: 1720000000,
  data: {
    conversation_id: "conv_abc123",
    transcript: [
      { role: "agent", message: "Hi Jane, quick question about your outreach." },
      { role: "user", message: "Sure, go ahead." },
      { role: "agent", message: "Would a demo next week work?" },
      { role: "user", message: "Yes, send details." },
    ],
    metadata: { termination_reason: "customer-ended-call" },
    conversation_initiation_client_data: { dynamic_variables: { lead_id: "lead_synthetic_1" } },
  },
};

try {
  console.log("Stage-2 webhook logic:");

  {
    const res = await worker.fetch(signedRequest(transcriptEvent), env, ctx);
    check("valid signature + post_call_transcription -> 200", res.status === 200);
    check("forwarded exactly one /voice/completed", mock.received.completed.length === 1);
    const c = mock.received.completed[0] || {};
    check("forwarded leadId from dynamic_variables", c.leadId === "lead_synthetic_1");
    check("callId is the conversation_id", c.callId === "conv_abc123");
    check("endedReason mapped from metadata", c.endedReason === "customer-ended-call");
    check("transcript flattened with roles", typeof c.transcript === "string" && c.transcript.includes("Agent: Hi Jane") && c.transcript.includes("Prospect: Sure, go ahead."));
  }

  {
    // Tampered body → signature must fail.
    const bad = new Request("http://worker/webhooks/elevenlabs", {
      method: "POST",
      headers: { "content-type": "application/json", "elevenlabs-signature": "t=1720000000,v0=deadbeef" },
      body: JSON.stringify(transcriptEvent),
    });
    const before = mock.received.completed.length;
    const res = await worker.fetch(bad, env, ctx);
    check("invalid signature -> 401", res.status === 401);
    check("nothing forwarded on invalid signature", mock.received.completed.length === before);
  }

  {
    const failEvent = {
      type: "call_initiation_failure",
      data: {
        conversation_id: "conv_fail_1",
        reason: "Twilio rejected destination number",
        conversation_initiation_client_data: { dynamic_variables: { lead_id: "lead_synthetic_1" } },
      },
    };
    const res = await worker.fetch(signedRequest(failEvent), env, ctx);
    check("call_initiation_failure -> 200", res.status === 200);
    check("forwarded one /voice/failed", mock.received.failed.length === 1);
    check("failure reason relayed", (mock.received.failed[0] || {}).reason === "Twilio rejected destination number");
  }
} finally {
  await mock.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll Stage-2 webhook checks passed ✓");
