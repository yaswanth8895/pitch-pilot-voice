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
         (call_recording_enabled: true by default)
  → ElevenLabs dials via Twilio, runs the agent (LLM = OpenAI via Custom LLM)
  → call ends → post_call_transcription webhook → POST /webhooks/elevenlabs
  → POST {CONVEX_SITE_URL}/voice/completed
         { leadId, callId, transcript, transcriptProvider:"elevenlabs", endedReason }
  → (background) GET /v1/convai/conversations/{callId}/audio
  → POST {CONVEX_SITE_URL}/voice/recording?leadId=…&callId=…   (raw audio body)
```

## Recordings

Calls are recorded by default (`CALL_RECORDING_ENABLED=true`; set `"false"` to
disable — recording needs disclosure/consent). After the transcript webhook, the
Worker pulls the call audio from ElevenLabs and POSTs the raw bytes to Convex
`POST /voice/recording?leadId=…&callId=…` (Content-Type `audio/mpeg`,
`X-Shared-Secret`). **Convex (Agency side) stores it in Convex file storage and
links it to the run** — see the recording section in `contracts/voice-api.md`.
The audio fetch/upload runs in `ctx.waitUntil` so the webhook still acks fast, and
it is best-effort: a missing recording never blocks the transcript/CRM result.

## Local development & tests (no cloud accounts needed)

Node 20+ runs the TypeScript directly (native type-stripping); the tests drive the
Worker's `fetch` handler against an in-process mock of Convex.

```bash
npm install
npm test            # 37 checks: Stage-1 round-trip + Stage-2 webhook + Stage-3 hardening
npm run typecheck   # tsc --noEmit against @cloudflare/workers-types
```

`test/hardening.mjs` drives the **real (non-fake) call path** against a fake
ElevenLabs (via `ELEVENLABS_API_BASE`) and covers provider failure (502),
invalid phone (502), duplicate/active call relayed as 409, request timeout
(502), routing (404), and webhook edge cases.

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

## ElevenLabs agent setup — for Stage 2

**Fastest: provision the agent from code** (reproducible; uses the system prompt
with the `{{dynamic variables}}` the Worker sends):

```bash
ELEVENLABS_API_KEY=sk_… npm run agent:create   # prints agent_id
# optional: AGENT_LLM=gpt-4o AGENT_VOICE_ID=… AGENT_NAME=…
```

**LLM choice — native OpenAI is available directly.** Per the ElevenLabs model
catalog, OpenAI models (`gpt-4o`, `gpt-4o-mini`, `gpt-5`, `gpt-5-mini`,
`gpt-5.4-mini`, …) are selectable as the agent `llm` with **no Custom-LLM setup**
— ElevenLabs runs and bills them. Use `AGENT_LLM=custom-llm` (+ a custom_llm
endpoint/key) **only** if you want your own OpenAI account/billing or a model
not in the catalog. For a low-latency phone call, `gpt-4o` is a good default.

Then finish in the dashboard:
1. **Phone number:** add a **native Twilio** outbound-capable number to the agent;
   note its `phone_number_id`.
2. **Webhook:** enable `post_call_transcription` → `POST https://<worker-url>/webhooks/elevenlabs`;
   copy the signing secret into `ELEVENLABS_WEBHOOK_SECRET`.
3. The script already enables the `end_call` and `voicemail_detection` built-in
   tools (recommended for outbound).

Prefer the dashboard instead? Create a Conversational AI agent, set the `llm`,
paste the same `{{var}}` system prompt (`scripts/create-agent.mjs` has it), then
do steps 1–2 above.

## Secrets & deploy

> **Going live?** [`GO-LIVE.md`](GO-LIVE.md) is the exact step-by-step sequence
> for making the first real call once credentials are in hand.

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
- **Stage 2 — real call (Worker side done, tested):** the outbound-call and
  webhook paths (HMAC verify, flatten, forward) are implemented and covered
  against a mock ElevenLabs. Remaining: plug in real ElevenLabs creds + the agent
  above and make one live call to an approved number.
- **Stage 3 — hardening (done, tested):** bounded timeouts on every outbound
  call, phone validation, and coverage for provider failure, invalid number,
  duplicate/second-simultaneous call (409), timeouts, routing, and webhook edge
  cases. Remaining: record a fallback video of a real successful call.

## Optional (non-secret) vars

- `ELEVENLABS_API_BASE` — override the ElevenLabs API origin (tests point it at
  the local mock). Defaults to `https://api.elevenlabs.io`.
- `REQUEST_TIMEOUT_MS` — outbound request timeout in ms (default `12000`).
