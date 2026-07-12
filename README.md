# pitch-pilot-voice

The PitchPilot **voice adapter** — a small TypeScript Cloudflare Worker that sits
between the colleague's Convex backend and **ElevenLabs Agents** (with a native
Twilio phone number). It places one outbound call and relays the final transcript
back to Convex.

Binding contract: [`../pitch-pilot/contracts/voice-api.md`](../pitch-pilot/contracts/voice-api.md).
The Worker **never** decides CRM state — Convex + Hermes own that. It only relays.

## Endpoints

| Method + path | Purpose |
|---|---|
| `GET /health` | Deployment check → `{ "ok": true }` |
| `POST /start-call` | Validate `X-Shared-Secret` + `{ leadId }`, fetch context from Convex, create one ElevenLabs call. Returns `202 { accepted, callId }`. Codes: `400/401/404/409/502`. |
| `POST /webhooks/elevenlabs` | Verify `ElevenLabs-Signature` HMAC, flatten the `post_call_transcription`, forward to Convex `/voice/completed`; `call_initiation_failure` → `/voice/failed`. |

## Flow

```text
Convex startCall → POST /start-call { leadId }
  → GET  {CONVEX_SITE_URL}/voice/context?leadId=…      (X-Shared-Secret)
  → POST https://api.elevenlabs.io/v1/convai/twilio/outbound-call
         (dynamic_variables: lead_name, company, product_summary, strategy,
          objections, call_goal, lead_id)
  → ElevenLabs dials via Twilio, runs the agent (LLM = OpenAI via Custom LLM)
  → call ends → post_call_transcription webhook → POST /webhooks/elevenlabs
  → POST {CONVEX_SITE_URL}/voice/completed
         { leadId, callId, transcript, transcriptProvider:"elevenlabs", endedReason }
```

## Local development & tests (no cloud accounts needed)

Node 20+ runs the TypeScript directly (native type-stripping); the tests drive the
Worker's `fetch` handler against an in-process mock of Convex.

```bash
npm install
npm test            # Stage-1 round-trip + Stage-2 webhook HMAC/flatten/forward
npm run typecheck   # tsc --noEmit against @cloudflare/workers-types
```

Run the mock standalone and hit the Worker with `wrangler dev`:

```bash
node mock/convex-mock.mjs         # Convex stand-in on http://127.0.0.1:8788
cp .dev.vars.example .dev.vars    # FAKE_CALL=true, CONVEX_SITE_URL=…8788
npm run dev                       # wrangler dev (Worker on http://127.0.0.1:8787)

curl http://127.0.0.1:8787/health
curl -X POST http://127.0.0.1:8787/start-call \
  -H 'Content-Type: application/json' -H 'X-Shared-Secret: dev-shared-secret' \
  -d '{"leadId":"lead_synthetic_1"}'
```

`FAKE_CALL=true` skips ElevenLabs entirely and posts a canned transcript to
`/voice/completed` — this is the **Stage-1** contract test. Set `FAKE_CALL=false`
for real calls.

## ElevenLabs agent setup (one-time, dashboard) — for Stage 2

1. **Create a Conversational AI agent.**
2. **LLM → Custom LLM = OpenAI:** set an OpenAI-compatible endpoint + a
   tool-calling-capable model, and store the `OPENAI_API_KEY` as an ElevenLabs
   secret. (The key lives in ElevenLabs, never in this repo.)
3. **System prompt** references the dynamic variables the Worker sends:
   ```
   You are an AI sales assistant for {{company}} calling {{lead_name}}.
   Product: {{product_summary}}
   Strategy: {{strategy}}
   Likely objections: {{objections}}
   Goal: {{call_goal}}. Identify yourself as an AI assistant. Keep replies short.
   ```
4. **Phone number:** add a **native Twilio** outbound-capable number to the agent;
   note its `phone_number_id`.
5. **Webhook:** enable `post_call_transcription` → `POST https://<worker-url>/webhooks/elevenlabs`;
   copy the signing secret into `ELEVENLABS_WEBHOOK_SECRET`.

## Secrets & deploy

```bash
# One value per secret (never committed):
wrangler secret put VOICE_SHARED_SECRET       # same value as Convex
wrangler secret put CONVEX_SITE_URL           # https://<deployment>.convex.site
wrangler secret put ELEVENLABS_API_KEY
wrangler secret put ELEVENLABS_AGENT_ID
wrangler secret put ELEVENLABS_PHONE_NUMBER_ID
wrangler secret put ELEVENLABS_WEBHOOK_SECRET

wrangler deploy      # then give the Worker URL to the colleague as VOICE_SERVICE_URL
```

Set `FAKE_CALL=false` in `wrangler.jsonc` (or as a var) for production.

## Environment variables

See [`.env.example`](.env.example) (deployed secrets) and
[`.dev.vars.example`](.dev.vars.example) (local `wrangler dev`). Names only —
no real values in Git.

## Staged plan

- **Stage 1 — contract round-trip (done, tested):** `/health`, `/start-call`
  validation, context fetch, fake transcript → `/voice/completed`.
- **Stage 2 — real call:** wire ElevenLabs creds + the agent above; the webhook
  path (HMAC verify, flatten, forward) is already implemented and tested.
- **Stage 3 — hardening:** invalid number, provider failure, duplicate call,
  second simultaneous call; record a fallback video.
