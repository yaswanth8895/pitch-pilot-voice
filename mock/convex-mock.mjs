/**
 * Dependency-free local stand-in for the colleague's Convex HTTP actions.
 * Implements just enough of contracts/voice-api.md to prove the voice
 * round-trip before the real Convex deployment exists.
 *
 *   GET  /voice/context?leadId=…   (X-Shared-Secret)
 *   POST /voice/completed          (X-Shared-Secret)
 *   POST /voice/failed             (X-Shared-Secret)
 *
 * Run standalone:  node mock/convex-mock.mjs
 * Or import { startMock } for in-process tests.
 */
import http from "node:http";

const SYNTHETIC_LEADS = {
  lead_synthetic_1: {
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
  },
};

export function startMock({ port = 8788, secret = "dev-shared-secret" } = {}) {
  const received = { context: [], completed: [], failed: [] };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const badSecret = req.headers["x-shared-secret"] !== secret;
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "GET" && url.pathname === "/voice/context") {
      if (badSecret) return send(401, { error: "invalid secret" });
      const leadId = url.searchParams.get("leadId") || "";
      received.context.push({ leadId });
      const lead = SYNTHETIC_LEADS[leadId];
      return lead ? send(200, lead) : send(404, { error: "lead not found" });
    }

    if (req.method === "POST" && (url.pathname === "/voice/completed" || url.pathname === "/voice/failed")) {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
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
      return;
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
    console.log(`[mock] Convex voice mock listening on ${url}`);
    console.log(`[mock] try: curl -H 'X-Shared-Secret: dev-shared-secret' '${url}/voice/context?leadId=lead_synthetic_1'`);
  });
}
