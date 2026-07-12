# Go Live — one real call

Everything is built and tested against mocks. This is the exact sequence to make
a **real** outbound call once credentials are in hand. Run all commands from the
`pitch-pilot-voice/` repo root.

## 0. What you need (and from whom)

| Value | Where it comes from |
|---|---|
| `ELEVENLABS_API_KEY` | ElevenLabs dashboard → API Keys |
| A Twilio number linked in ElevenLabs → `ELEVENLABS_PHONE_NUMBER_ID` | ElevenLabs → Phone Numbers (native Twilio integration) |
| `ELEVENLABS_AGENT_ID` | created in step 1 below |
| `ELEVENLABS_WEBHOOK_SECRET` | created in step 4 below |
| `CONVEX_SITE_URL` (`https://<deployment>.convex.site`) | **colleague** — their deployed Convex |
| `VOICE_SHARED_SECRET` | generate with `openssl rand -hex 32`; **same value in Worker and Convex** (share out-of-band, never commit) |
| A real, answerable lead in Convex (with a phone you can pick up) | **colleague** — seed lead |

Pre-flight (confirm nothing is broken): `npm ci && npm test` → 49 checks pass.

## 1. Provision the ElevenLabs agent

```bash
ELEVENLABS_API_KEY=sk_… npm run agent:create
# prints: agent_id: agent_xxxxx   ← save it for step 2
# (defaults to native OpenAI gpt-4o; override with AGENT_LLM=… if desired)
```

Then in the ElevenLabs dashboard, attach your **native Twilio number** to this
agent and note its `phone_number_id`.

## 2. Authenticate wrangler + set Worker secrets

```bash
npx wrangler login    # one-time Cloudflare auth

npx wrangler secret put VOICE_SHARED_SECRET        # paste the shared value above
npx wrangler secret put CONVEX_SITE_URL            # colleague's https://<deployment>.convex.site
npx wrangler secret put ELEVENLABS_API_KEY
npx wrangler secret put ELEVENLABS_AGENT_ID        # from step 1
npx wrangler secret put ELEVENLABS_PHONE_NUMBER_ID # from step 1
```

## 3. First deploy → get the Worker URL

```bash
npm run deploy
# note the deployed URL, e.g. https://pitch-pilot-voice.<subdomain>.workers.dev
curl https://<worker-url>/health      # → {"ok":true}
```

## 4. Point ElevenLabs at the Worker webhook → set the secret

In ElevenLabs → Webhooks, enable **`post_call_transcription`** →
`POST https://<worker-url>/webhooks/elevenlabs`, then copy its signing secret:

```bash
npx wrangler secret put ELEVENLABS_WEBHOOK_SECRET  # paste the signing secret
# (secret update is live — no redeploy needed)
```

## 5. Connect with the colleague's Convex

- They set the **same** `VOICE_SHARED_SECRET` in Convex.
- They set `VOICE_SERVICE_URL = https://<worker-url>` in Convex (so their
  `startCall` action reaches this Worker).
- Their Convex exposes `/voice/context`, `/voice/completed`, `/voice/failed`,
  and `/voice/recording`, with a real callable lead seeded.

## 6. Make the first real call

Trigger it from the dashboard (their **Start Call** button), or directly:

```bash
curl -i -X POST https://<worker-url>/start-call \
  -H 'Content-Type: application/json' \
  -H "X-Shared-Secret: $VOICE_SHARED_SECRET" \
  -d '{"leadId":"<real-convex-lead-id>"}'
# → 202 {"accepted":true,"callId":"conv_…"}   and the phone rings
```

## 7. Verify the full loop

- [ ] Phone rings; the agent speaks and holds a short conversation.
- [ ] After hang-up, ElevenLabs calls `/webhooks/elevenlabs` (check
      `npx wrangler tail` for the request).
- [ ] Convex `/voice/completed` receives the transcript → dashboard shows
      transcript + summary + updated lead state.
- [ ] Convex `/voice/recording` receives the audio → recording is playable on
      the lead page.

## Rollback / fallback

- Something flaky? Set `FAKE_CALL=true` (redeploy) to prove the Convex round-trip
  without ElevenLabs, then flip back.
- Debug live traffic: `npx wrangler tail`.
- Keep a recorded video of one successful call as the demo fallback.
