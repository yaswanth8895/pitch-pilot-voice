# Credentials checklist

Fill in the blanks. **Nothing here goes in Git** — Worker values are set with
`wrangler secret put`, ElevenLabs/OpenAI values live in the ElevenLabs dashboard,
Convex values are set by the colleague. Full sequence: [`GO-LIVE.md`](GO-LIVE.md).

## A. Voice Worker secrets (6) — `wrangler secret put <NAME>`

| # | Name | Value | Where to get it |
|---|------|-------|-----------------|
| 1 | `VOICE_SHARED_SECRET` | `__________` | Generate with `openssl rand -hex 32`; share out-of-band (never commit). Use the same value in Convex |
| 2 | `CONVEX_SITE_URL` | `__________` | Colleague → deployed Convex `https://<deployment>.convex.site` |
| 3 | `ELEVENLABS_API_KEY` | `__________` | ElevenLabs → Settings → API Keys |
| 4 | `ELEVENLABS_AGENT_ID` | `__________` | Created by `npm run agent:create` (or ElevenLabs → Agents) |
| 5 | `ELEVENLABS_PHONE_NUMBER_ID` | `__________` | ElevenLabs → Agents → Phone Numbers (after importing the Twilio number) |
| 6 | `ELEVENLABS_WEBHOOK_SECRET` | `__________` | ElevenLabs → Webhooks (created after the Worker is deployed) |

## B. Twilio account — feeds ElevenLabs, NOT the Worker

| Name | Value | Where to get it |
|------|-------|-----------------|
| Twilio Account SID | `__________` | Twilio Console dashboard |
| Twilio Auth Token | `__________` | Twilio Console dashboard |
| Twilio phone number (E.164, outbound-capable) | `__________` | Twilio Console → Phone Numbers → Buy a number |

→ You enter these in ElevenLabs (Import Twilio number); they produce
`ELEVENLABS_PHONE_NUMBER_ID` (A5).

## C. OpenAI — OPTIONAL (only if using Custom LLM)

| Name | Value | Where to get it |
|------|-------|-----------------|
| `OPENAI_API_KEY` | `__________` | platform.openai.com → API keys → **stored inside the ElevenLabs agent**, not the Worker |

Skip this if you use the default native `gpt-4o` (ElevenLabs runs + bills it).

## D. Convex side — set by the colleague

| Name | Value | Notes |
|------|-------|-------|
| `VOICE_SHARED_SECRET` | (same as A1) | must match the Worker exactly |
| `VOICE_SERVICE_URL` | `__________` | the deployed Worker URL (available after `npm run deploy`) |

## E. Cloudflare — for deploy (no value to fetch)

Run `npx wrangler login` once (browser auth).

## Setting secrets safely (never paste in chat or a file)

Worker secrets go into Cloudflare via a hidden prompt — the value is never typed
as part of a command, written to a file, or shown on screen:

```bash
npx wrangler login                          # one-time
npx wrangler secret put ELEVENLABS_API_KEY  # paste at the hidden prompt
# repeat for each secret name in section A
```

`npm run agent:create` needs the key as a shell env var (not a Cloudflare
secret). Set it silently so it stays out of shell history:

```bash
read -rs ELEVENLABS_API_KEY && export ELEVENLABS_API_KEY
npm run agent:create
```

Rules:

- Never paste a secret into chat, `.env.example`, `CREDENTIALS.md`, or any
  committed file.
- `.dev.vars` is git-ignored (safe locally), but the agent script reads
  `process.env`, so use the `read -rs` method above.
- Avoid inline `KEY=sk_… npm run …` — it lands in `~/.zsh_history`.
- If a secret ever appears in chat or shell history, treat it as exposed and
  rotate it.

---

### Summary: who supplies what
- **You fetch:** ElevenLabs API key · Twilio SID+token+number · (after deploy) ElevenLabs webhook secret
- **You create:** the ElevenLabs agent id (`npm run agent:create`)
- **Already generated:** `VOICE_SHARED_SECRET`
- **Colleague provides:** `CONVEX_SITE_URL` (+ sets the shared secret & Worker URL on the Convex side)
- **Optional:** OpenAI key (only for Custom LLM)
