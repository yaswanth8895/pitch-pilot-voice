/**
 * Stage-3 hardening. Exercises the real (non-fake) call path against a fake
 * ElevenLabs, plus failure/edge cases the demo must survive.
 *
 *   node test/hardening.mjs
 */
import crypto from "node:crypto";
import worker from "../src/index.ts";
import { startMock } from "../mock/convex-mock.mjs";

const SECRET = "dev-shared-secret";
const WEBHOOK_SECRET = "whsec_hardening";
const ctx = { waitUntil() {} };

const mock = await startMock({ port: 8790, secret: SECRET });

// Real call path: ElevenLabs base points at the mock; FAKE_CALL unset.
const env = {
  VOICE_SHARED_SECRET: SECRET,
  CONVEX_SITE_URL: mock.url,
  ELEVENLABS_API_KEY: "test-key",
  ELEVENLABS_AGENT_ID: "test-agent",
  ELEVENLABS_PHONE_NUMBER_ID: "test-phone",
  ELEVENLABS_API_BASE: mock.url,
  ELEVENLABS_WEBHOOK_SECRET: WEBHOOK_SECRET,
};

function startCall(leadId, envOverride) {
  return worker.fetch(
    new Request("http://worker/start-call", {
      method: "POST",
      headers: { "content-type": "application/json", "x-shared-secret": SECRET },
      body: JSON.stringify({ leadId }),
    }),
    { ...env, ...envOverride },
    ctx,
  );
}

function signedWebhook(body, { secret = WEBHOOK_SECRET, ts = 1720000000 } = {}) {
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

try {
  console.log("Stage-3 hardening:");

  // Real successful call through the fake ElevenLabs.
  {
    const res = await startCall("lead_synthetic_1");
    const body = await res.json();
    check("valid lead -> 202 with ElevenLabs conversation id", res.status === 202 && body.callId === "conv_mock_+15551234567");
    const sent = mock.received.elevenCalls.at(-1) || {};
    const vars = sent?.conversation_initiation_client_data?.dynamic_variables || {};
    check("dynamic_variables carry lead_id for webhook recovery", vars.lead_id === "lead_synthetic_1");
    check("dynamic_variables include strategy + objections", Boolean(vars.strategy) && Boolean(vars.objections));
    check("recording enabled by default", sent.call_recording_enabled === true);
  }

  // Recording opt-out + ringing timeout.
  {
    const res = await startCall("lead_synthetic_1", { CALL_RECORDING_ENABLED: "false", RINGING_TIMEOUT_SECS: "25" });
    const sent = mock.received.elevenCalls.at(-1) || {};
    check("recording opt-out -> no call_recording_enabled", res.status === 202 && sent.call_recording_enabled === undefined);
    check("ringing_timeout_secs forwarded in telephony_call_config", sent.telephony_call_config?.ringing_timeout_secs === 25);
  }

  // Provider rejects the destination number -> 502.
  {
    const before = mock.received.elevenCalls.length;
    const res = await startCall("lead_provider_fail");
    check("provider failure -> 502", res.status === 502);
    check("provider failure did attempt the call", mock.received.elevenCalls.length === before + 1);
  }

  // Invalid phone is caught before any provider call -> 502, no call attempted.
  {
    const before = mock.received.elevenCalls.length;
    const res = await startCall("lead_bad_phone");
    check("invalid phone -> 502", res.status === 502);
    check("invalid phone never calls ElevenLabs", mock.received.elevenCalls.length === before);
  }

  // Duplicate / second simultaneous call: Convex returns 409, Worker relays it.
  {
    const res = await startCall("lead_active_call");
    check("active/duplicate call (Convex 409) -> 409", res.status === 409);
  }

  // Timeout: slow provider + tiny timeout -> 502.
  {
    const res = await startCall("lead_slow", { REQUEST_TIMEOUT_MS: "50" });
    check("slow provider beyond timeout -> 502", res.status === 502);
  }

  // Routing.
  {
    const notFound = await worker.fetch(new Request("http://worker/nope"), env, ctx);
    check("unknown route -> 404", notFound.status === 404);
    const wrongMethod = await worker.fetch(new Request("http://worker/start-call"), env, ctx);
    check("GET /start-call -> 404", wrongMethod.status === 404);
  }

  // Webhook edges.
  {
    const noSig = await worker.fetch(
      new Request("http://worker/webhooks/elevenlabs", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      env,
      ctx,
    );
    check("webhook missing signature -> 401", noSig.status === 401);

    const beforeC = mock.received.completed.length;
    const unknownType = await worker.fetch(signedWebhook({ type: "call_status", data: {} }), env, ctx);
    check("webhook unknown event type -> 200, no forward", unknownType.status === 200 && mock.received.completed.length === beforeC);

    const noLead = await worker.fetch(
      signedWebhook({ type: "post_call_transcription", data: { conversation_id: "c1", transcript: [{ role: "agent", message: "hi" }] } }),
      env,
      ctx,
    );
    check("webhook post_call with no leadId -> 200, no forward", noLead.status === 200 && mock.received.completed.length === beforeC);
  }
} finally {
  await mock.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll Stage-3 hardening checks passed ✓");
