/**
 * PitchPilot voice adapter (Cloudflare Worker).
 *
 * Contract: ../pitch-pilot/contracts/voice-api.md
 *
 * Responsibilities (voice developer):
 *   - GET  /health                → deployment check
 *   - POST /start-call            → validate, fetch lead context from Convex,
 *                                    create ONE ElevenLabs outbound call
 *   - POST /webhooks/elevenlabs   → verify HMAC, flatten transcript, forward the
 *                                    final result (or failure) to Convex
 *
 * The Worker never decides CRM state — Convex + Hermes own that. It only relays.
 */

export interface Env {
  // Convex↔Worker shared secret (both directions).
  VOICE_SHARED_SECRET: string;
  // Convex HTTP-actions origin, e.g. https://<deployment>.convex.site
  CONVEX_SITE_URL: string;
  // ElevenLabs (Stage 2). Optional so Stage 1 can run without them.
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_AGENT_ID?: string;
  ELEVENLABS_PHONE_NUMBER_ID?: string;
  ELEVENLABS_WEBHOOK_SECRET?: string;
  // "true" → Stage-1 fake path (skip ElevenLabs, post a canned transcript).
  FAKE_CALL?: string;
}

interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

const ELEVENLABS_OUTBOUND_CALL_URL =
  "https://api.elevenlabs.io/v1/convai/twilio/outbound-call";

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    if (method === "GET" && path === "/health") {
      return json({ ok: true });
    }
    if (method === "POST" && path === "/start-call") {
      return handleStartCall(request, env, ctx);
    }
    if (method === "POST" && path === "/webhooks/elevenlabs") {
      return handleElevenLabsWebhook(request, env);
    }
    return json({ error: "Not found" }, 404);
  },
};

// ---------------------------------------------------------------------------
// POST /start-call
// ---------------------------------------------------------------------------

async function handleStartCall(request: Request, env: Env, ctx: Ctx): Promise<Response> {
  if (!hasValidSecret(request, env)) {
    return json({ accepted: false, error: "Missing or invalid shared secret" }, 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ accepted: false, error: "Invalid JSON" }, 400);
  }

  const leadId = (body as { leadId?: unknown })?.leadId;
  if (typeof leadId !== "string" || leadId.length === 0) {
    return json({ accepted: false, error: "Missing leadId" }, 400);
  }

  // Fetch immutable lead context from Convex. It owns eligibility (404) and
  // duplicate/active-call detection (409); the Worker just relays those.
  const context = await fetchLeadContext(env, leadId);
  if (context.status === 404) {
    return json({ accepted: false, error: "Lead not found" }, 404);
  }
  if (context.status === 409) {
    return json({ accepted: false, error: "Lead already called or another call is active" }, 409);
  }
  if (!context.ok || !context.data) {
    return json({ accepted: false, error: `Could not load lead context (${context.status})` }, 502);
  }

  const phone = context.data.phone;
  if (typeof phone !== "string" || phone.length === 0) {
    return json({ accepted: false, error: "Lead has no phone number" }, 502);
  }
  const dynamicVariables = toDynamicVariables(leadId, context.data);

  // Stage 1: prove the Convex round-trip without touching ElevenLabs/Twilio.
  if (env.FAKE_CALL === "true") {
    const callId = `fake_${leadId}`;
    const transcript = buildFakeTranscript(dynamicVariables);
    await forwardToConvex(env, "/voice/completed", {
      leadId,
      callId,
      transcript,
      transcriptProvider: "elevenlabs",
      endedReason: "fake-stage1",
    });
    return json({ accepted: true, callId }, 202);
  }

  // Stage 2: one real ElevenLabs outbound call over its native Twilio number.
  try {
    const callId = await createElevenLabsCall(env, phone, dynamicVariables);
    return json({ accepted: true, callId }, 202);
  } catch (err) {
    return json({ accepted: false, error: `ElevenLabs/Twilio rejected the request: ${errorMessage(err)}` }, 502);
  }
}

// ---------------------------------------------------------------------------
// POST /webhooks/elevenlabs  (post_call_transcription | call_initiation_failure)
// ---------------------------------------------------------------------------

async function handleElevenLabsWebhook(request: Request, env: Env): Promise<Response> {
  const raw = await request.text();
  const signature = request.headers.get("elevenlabs-signature") ?? "";

  const verified = await verifyElevenLabsSignature(raw, signature, env.ELEVENLABS_WEBHOOK_SECRET);
  if (!verified) {
    return json({ error: "Invalid webhook signature" }, 401);
  }

  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const type: string = event?.type ?? "";
  const data = event?.data ?? {};
  const dynamicVariables =
    data?.conversation_initiation_client_data?.dynamic_variables ??
    data?.dynamic_variables ??
    {};
  const leadId: string | undefined = dynamicVariables?.lead_id ?? data?.metadata?.lead_id;
  const callId: string = data?.conversation_id ?? event?.conversation_id ?? "";

  if (type === "call_initiation_failure") {
    if (leadId) {
      await forwardToConvex(env, "/voice/failed", {
        leadId,
        callId,
        reason: data?.reason ?? "ElevenLabs reported a call initiation failure",
      });
    }
    return json({ ok: true });
  }

  if (type === "post_call_transcription") {
    if (leadId) {
      await forwardToConvex(env, "/voice/completed", {
        leadId,
        callId,
        transcript: flattenTranscript(data?.transcript),
        transcriptProvider: "elevenlabs",
        endedReason:
          data?.metadata?.termination_reason ??
          data?.metadata?.end_reason ??
          "completed",
      });
    }
    return json({ ok: true });
  }

  // Status / debug events are acknowledged but not forwarded.
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Convex helpers
// ---------------------------------------------------------------------------

interface LeadContext {
  leadId: string;
  name?: string;
  phone?: string;
  company?: string;
  strategy?: string;
  productKnowledge?: {
    summary?: string;
    features?: string[];
    pricing?: string[];
    objections?: string[];
    faq?: { question: string; answer: string }[];
    benefits?: string[];
  };
}

async function fetchLeadContext(
  env: Env,
  leadId: string,
): Promise<{ ok: boolean; status: number; data: LeadContext | null }> {
  const url = `${trimSlash(env.CONVEX_SITE_URL)}/voice/context?leadId=${encodeURIComponent(leadId)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { "X-Shared-Secret": env.VOICE_SHARED_SECRET } });
  } catch (err) {
    return { ok: false, status: 502, data: null };
  }
  if (res.status !== 200) {
    return { ok: false, status: res.status, data: null };
  }
  const data = (await res.json().catch(() => null)) as LeadContext | null;
  return { ok: data != null, status: 200, data };
}

async function forwardToConvex(env: Env, path: string, payload: unknown): Promise<boolean> {
  const url = `${trimSlash(env.CONVEX_SITE_URL)}${path}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shared-Secret": env.VOICE_SHARED_SECRET,
      },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// ElevenLabs helpers
// ---------------------------------------------------------------------------

async function createElevenLabsCall(
  env: Env,
  toNumber: string,
  dynamicVariables: Record<string, string>,
): Promise<string> {
  if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_AGENT_ID || !env.ELEVENLABS_PHONE_NUMBER_ID) {
    throw new Error("ElevenLabs credentials are not configured");
  }
  const res = await fetch(ELEVENLABS_OUTBOUND_CALL_URL, {
    method: "POST",
    headers: {
      "xi-api-key": env.ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      agent_id: env.ELEVENLABS_AGENT_ID,
      agent_phone_number_id: env.ELEVENLABS_PHONE_NUMBER_ID,
      to_number: toNumber,
      conversation_initiation_client_data: { dynamic_variables: dynamicVariables },
    }),
  });

  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.detail?.message ?? data?.message ?? `HTTP ${res.status}`);
  }
  const callId = data?.conversation_id ?? data?.callSid;
  if (!callId) {
    throw new Error("ElevenLabs response missing conversation_id");
  }
  return String(callId);
}

/** Concise, agent-facing variables (contract §"ElevenLabs behavior"). */
function toDynamicVariables(leadId: string, ctx: LeadContext): Record<string, string> {
  const pk = ctx.productKnowledge ?? {};
  return {
    lead_id: leadId, // so the post-call webhook can recover the lead
    lead_name: ctx.name ?? "",
    company: ctx.company ?? "",
    product_summary: pk.summary ?? "",
    strategy: ctx.strategy ?? "",
    objections: joinList(pk.objections),
    call_goal: "Qualify interest and book a meeting",
  };
}

/** ElevenLabs post_call_transcription turns → readable text. */
function flattenTranscript(turns: unknown): string {
  if (!Array.isArray(turns)) return "";
  return turns
    .map((turn) => {
      const role = turn?.role === "agent" ? "Agent" : turn?.role === "user" ? "Prospect" : (turn?.role ?? "Speaker");
      const message = turn?.message ?? turn?.text ?? "";
      return message ? `${role}: ${message}` : "";
    })
    .filter((line) => line.length > 0)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Security helpers
// ---------------------------------------------------------------------------

function hasValidSecret(request: Request, env: Env): boolean {
  const provided = request.headers.get("x-shared-secret");
  return (
    typeof provided === "string" &&
    provided.length > 0 &&
    typeof env.VOICE_SHARED_SECRET === "string" &&
    env.VOICE_SHARED_SECRET.length > 0 &&
    timingSafeEqual(provided, env.VOICE_SHARED_SECRET)
  );
}

/**
 * Verify the ElevenLabs webhook HMAC.
 * Header format: `t=<unix-seconds>,v0=<hex-hmac-sha256 of "t.body">`.
 */
async function verifyElevenLabsSignature(
  payload: string,
  header: string,
  secret: string | undefined,
): Promise<boolean> {
  if (!secret || !header) return false;
  const parts: Record<string, string> = {};
  for (const kv of header.split(",")) {
    const idx = kv.indexOf("=");
    if (idx === -1) continue;
    parts[kv.slice(0, idx).trim()] = kv.slice(idx + 1).trim();
  }
  const timestamp = parts["t"];
  const v0 = parts["v0"];
  if (!timestamp || !v0) return false;

  const expected = await hmacSha256Hex(secret, `${timestamp}.${payload}`);
  return timingSafeEqual(expected, v0);
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function joinList(value: unknown): string {
  if (Array.isArray(value)) return value.filter(Boolean).join("; ");
  return typeof value === "string" ? value : "";
}

function buildFakeTranscript(vars: Record<string, string>): string {
  return [
    `Agent: Hi ${vars.lead_name || "there"}, this is an AI assistant calling about ${vars.product_summary || "our product"}.`,
    `Prospect: Sure, tell me more.`,
    `Agent: ${vars.strategy || "Here is how it helps your team."} Would a quick demo next week work?`,
    `Prospect: Yes, send me the details.`,
  ].join("\n");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
