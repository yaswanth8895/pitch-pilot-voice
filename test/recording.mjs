/**
 * Recording flow: on post_call_transcription the Worker pulls the call audio
 * from ElevenLabs and forwards the bytes to Convex /voice/recording.
 *
 *   node test/recording.mjs
 */
import crypto from "node:crypto";
import worker from "../src/index.ts";
import { startMock } from "../mock/convex-mock.mjs";

const SECRET = "dev-shared-secret";
const WEBHOOK_SECRET = "whsec_recording";

const mock = await startMock({ port: 8791, secret: SECRET });
const env = {
  VOICE_SHARED_SECRET: SECRET,
  CONVEX_SITE_URL: mock.url,
  ELEVENLABS_API_KEY: "test-key",
  ELEVENLABS_API_BASE: mock.url, // fake conversation-audio endpoint
  ELEVENLABS_WEBHOOK_SECRET: WEBHOOK_SECRET,
  // CALL_RECORDING_ENABLED defaults to on
};

function signed(body, { ts = 1720000000 } = {}) {
  const raw = JSON.stringify(body);
  const hex = crypto.createHmac("sha256", WEBHOOK_SECRET).update(`${ts}.${raw}`).digest("hex");
  return new Request("http://worker/webhooks/elevenlabs", {
    method: "POST",
    headers: { "content-type": "application/json", "elevenlabs-signature": `t=${ts},v0=${hex}` },
    body: raw,
  });
}

function transcriptEvent(conversationId) {
  return {
    type: "post_call_transcription",
    data: {
      conversation_id: conversationId,
      transcript: [{ role: "agent", message: "hi" }, { role: "user", message: "hello" }],
      metadata: { termination_reason: "customer-ended-call" },
      conversation_initiation_client_data: { dynamic_variables: { lead_id: "lead_synthetic_1" } },
    },
  };
}

let failures = 0;
function check(name, condition) {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}

try {
  console.log("Recording flow:");

  // Upload ENABLED: webhook -> pull audio -> save to Convex.
  {
    const pending = [];
    const ctx = { waitUntil: (p) => pending.push(p) };
    const res = await worker.fetch(signed(transcriptEvent("conv_rec_1")), { ...env, RECORDING_UPLOAD_ENABLED: "true" }, ctx);
    check("webhook -> 200", res.status === 200);
    check("transcript forwarded to /voice/completed", mock.received.completed.length === 1);
    await Promise.all(pending); // let the background recording save finish
    check("recording uploaded to Convex /voice/recording", mock.received.recordings.length === 1);
    const rec = mock.received.recordings[0] || {};
    check("recording carries leadId", rec.leadId === "lead_synthetic_1");
    check("recording carries callId", rec.callId === "conv_rec_1");
    check("recording has audio bytes", rec.bytes > 0);
    check("recording content-type is audio", String(rec.contentType).startsWith("audio/"));
  }

  // Upload DEFERRED (default, per contract): transcript still forwarded, no upload.
  {
    const pending = [];
    const ctx = { waitUntil: (p) => pending.push(p) };
    const before = mock.received.recordings.length;
    const res = await worker.fetch(signed(transcriptEvent("conv_rec_2")), env, ctx);
    await Promise.all(pending);
    check("upload deferred by default -> nothing uploaded", res.status === 200 && mock.received.recordings.length === before);
  }
} finally {
  await mock.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll recording checks passed ✓");
