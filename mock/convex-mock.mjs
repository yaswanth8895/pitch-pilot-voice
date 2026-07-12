/**
 * Dependency-free local stand-in for the colleague's Convex HTTP actions, plus
 * a fake ElevenLabs outbound-call endpoint for Stage-2/3 tests. Implements just
 * enough of contracts/voice-api.md to exercise the voice Worker offline.
 *
 *   GET  /voice/context?leadId=…            (X-Shared-Secret)
 *   POST /voice/completed                   (X-Shared-Secret)
 *   POST /voice/failed                      (X-Shared-Secret)
 *   POST /v1/convai/twilio/outbound-call    (fake ElevenLabs; set ELEVENLABS_API_BASE)
 *
 * Run standalone:  node mock/convex-mock.mjs
 * Or import { startMock } for in-process tests.
 */
import http from "node:http";

function lead(overrides) {
  return {
    leadId: "lead_synthetic_1",
    name: "Jane Doe",
    phone: "+15551234567",
    company: "Acme",
    strategy: "Lead with time-savings; Jane runs a 5-person SDR team and hates manual research.",
    productKnowledge: {
      summary: "PitchPilot turns a landing page and a lead list into personalized outbound calls.",
      features: ["Automatic product research", "Per-lead strategy", "Live call dashboard"],
      pricing: ["$0 hackathon demo"],
      objections: ["We already use a dialer", "Is call recording compliant?"],
      faq: [{ question: "Does it record?", answer: "Only with disclosure and consent." }],
      benefits: ["Save hours of manual research", "Every lead gets a tailored pitch"],
    },
    ...overrides,
  };
}

// Regular leads returned by /voice/context. `lead_active_call` is special-cased
// below to return 409 (already called / another call active).
const SYNTHETIC_LEADS = {
  lead_synthetic_1: lead({ leadId: "lead_synthetic_1" }),
  lead_bad_phone: lead({ leadId: "lead_bad_phone", name: "Bad Phone", phone: "not-a-number" }),
  lead_provider_fail: lead({ leadId: "lead_provider_fail", name: "Provider Fail", phone: "+10000000000" }),
  lead_slow: lead({ leadId: "lead_slow", name: "Slow Provider", phone: "+15550000001" }),
};

const FAIL_NUMBER = "+10000000000"; // fake ElevenLabs returns 400 for this
const SLOW_NUMBER = "+15550000001"; // fake ElevenLabs delays for this

export function startMock({ port = 8788, secret = "dev-shared-secret" } = {}) {
  const received = { context: [], completed: [], failed: [], elevenCalls: [], recordings: [] };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const badSecret = req.headers["x-shared-secret"] !== secret;
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const readBody = (cb) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => cb(raw));
    };

    // --- Convex: get lead context ---
    if (req.method === "GET" && url.pathname === "/voice/context") {
      if (badSecret) return send(401, { error: "invalid secret" });
      const leadId = url.searchParams.get("leadId") || "";
      received.context.push({ leadId });
      if (leadId === "lead_active_call") return send(409, { error: "another call is active" });
      const found = SYNTHETIC_LEADS[leadId];
      return found ? send(200, found) : send(404, { error: "lead not found" });
    }

    // --- Convex: completed / failed ---
    if (req.method === "POST" && (url.pathname === "/voice/completed" || url.pathname === "/voice/failed")) {
      return readBody((raw) => {
        if (badSecret) return send(401, { error: "invalid secret" });
        let payload = {};
        try {
          payload = JSON.parse(raw || "{}");
        } catch {
          return send(400, { error: "invalid json" });
        }
        (url.pathname === "/voice/completed" ? received.completed : received.failed).push(payload);
        console.log(`[mock] ${url.pathname} <-`, JSON.stringify(payload));
        send(200, { accepted: true });
      });
    }

    // --- Convex: save recording (raw audio bytes) ---
    if (req.method === "POST" && url.pathname === "/voice/recording") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        if (badSecret) return send(401, { error: "invalid secret" });
        const bytes = Buffer.concat(chunks);
        received.recordings.push({
          leadId: url.searchParams.get("leadId"),
          callId: url.searchParams.get("callId"),
          contentType: req.headers["content-type"],
          bytes: bytes.length,
        });
        console.log(`[mock] /voice/recording <- ${bytes.length} bytes (lead ${url.searchParams.get("leadId")})`);
        send(200, { accepted: true });
      });
      return;
    }

    // --- Fake ElevenLabs: conversation audio ---
    if (req.method === "GET" && url.pathname.startsWith("/v1/convai/conversations/") && url.pathname.endsWith("/audio")) {
      res.writeHead(200, { "content-type": "audio/mpeg" });
      res.end(Buffer.from("FAKE_MP3_AUDIO_BYTES"));
      return;
    }

    // --- Fake ElevenLabs outbound call ---
    if (req.method === "POST" && url.pathname === "/v1/convai/twilio/outbound-call") {
      return readBody((raw) => {
        let payload = {};
        try {
          payload = JSON.parse(raw || "{}");
        } catch {
          return send(400, { detail: { message: "invalid json" } });
        }
        received.elevenCalls.push(payload);
        const to = payload.to_number;
        if (to === FAIL_NUMBER) return send(400, { detail: { message: "twilio_rejected_destination" } });
        const respond = () => send(200, { conversation_id: `conv_mock_${to}`, callSid: `CA_${to}` });
        if (to === SLOW_NUMBER) setTimeout(respond, 200);
        else respond();
      });
    }

    send(404, { error: "not found" });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${port}`,
        received,
        close: () => new Promise((r) => server.close(r)),
      }),
    );
  });
}

// Standalone runner
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.MOCK_PORT || 8788);
  startMock({ port }).then(({ url }) => {
    console.log(`[mock] Convex + fake-ElevenLabs mock listening on ${url}`);
    console.log(`[mock] try: curl -H 'X-Shared-Secret: dev-shared-secret' '${url}/voice/context?leadId=lead_synthetic_1'`);
  });
}
