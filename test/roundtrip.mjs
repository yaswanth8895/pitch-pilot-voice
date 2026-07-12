/**
 * Stage-1 contract round-trip (no ElevenLabs / Twilio).
 * Drives the Worker's fetch handler directly against the local Convex mock.
 *
 *   node test/roundtrip.mjs
 */
import worker from "../src/index.ts";
import { startMock } from "../mock/convex-mock.mjs";

const SECRET = "dev-shared-secret";
const ctx = { waitUntil() {} };

function request(path, { method = "GET", secret, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (secret) headers["x-shared-secret"] = secret;
  return new Request(`http://worker${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

let failures = 0;
function check(name, condition) {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}

const mock = await startMock({ port: 8788, secret: SECRET });
const env = { VOICE_SHARED_SECRET: SECRET, CONVEX_SITE_URL: mock.url, FAKE_CALL: "true" };

try {
  console.log("Stage-1 contract round-trip (FAKE_CALL=true):");

  {
    const res = await worker.fetch(request("/health"), env, ctx);
    const body = await res.json();
    check("GET /health -> 200 { ok: true }", res.status === 200 && body.ok === true);
  }
  {
    const res = await worker.fetch(request("/start-call", { method: "POST", body: { leadId: "lead_synthetic_1" } }), env, ctx);
    check("POST /start-call without secret -> 401", res.status === 401);
  }
  {
    const res = await worker.fetch(request("/start-call", { method: "POST", secret: SECRET, body: {} }), env, ctx);
    check("POST /start-call missing leadId -> 400", res.status === 400);
  }
  {
    const res = await worker.fetch(request("/start-call", { method: "POST", secret: SECRET, body: { leadId: "does_not_exist" } }), env, ctx);
    check("POST /start-call unknown lead -> 404", res.status === 404);
  }
  {
    const res = await worker.fetch(request("/start-call", { method: "POST", secret: SECRET, body: { leadId: "lead_synthetic_1" } }), env, ctx);
    const body = await res.json();
    check("POST /start-call valid -> 202 accepted", res.status === 202 && body.accepted === true);
    check("returns a callId string", typeof body.callId === "string" && body.callId.length > 0);
  }

  check("mock received /voice/context for the lead", mock.received.context.some((c) => c.leadId === "lead_synthetic_1"));
  check("mock received exactly one /voice/completed", mock.received.completed.length === 1);

  const completed = mock.received.completed[0] || {};
  check("completed.leadId matches", completed.leadId === "lead_synthetic_1");
  check("completed.transcriptProvider === 'elevenlabs'", completed.transcriptProvider === "elevenlabs");
  check("completed.transcript is non-empty", typeof completed.transcript === "string" && completed.transcript.length > 0);
} finally {
  await mock.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll Stage-1 checks passed ✓");
