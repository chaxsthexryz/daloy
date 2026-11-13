import { createServer } from "node:http";

/**
 * A stand-in for Ollama's /api/chat in the e2e stack, so the "Build with AI" flow runs without a model.
 * A new-workflow request gets a one-step draft; a change request gets the same draft with a delay in front.
 */
const form = { type: "form", config: { fields: [{ name: "email", label: "Email", type: "email", required: true }] } };
const thank = { id: "thank", type: "email", config: { to: "{{trigger.email}}", subject: "Thanks", text: "We got your message." } };
const built = { name: "Contact thanks", summary: "Thanks everyone who fills the contact form.", definition: { trigger: form, steps: [thank], edges: [] } };
const changed = {
  name: "Contact thanks",
  summary: "Waits one day before the thank-you email.",
  definition: { trigger: form, steps: [{ id: "wait_a_day", type: "delay", config: { seconds: 86400 } }, thank], edges: [{ from: "wait_a_day", to: "thank" }] },
};

export function startLlmFake(port: number) {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      // The AI model page lists the local server's models.
      if (req.method === "GET" && req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: "fake-model" }] }));
      if (req.method !== "POST") return res.writeHead(404).end("{}");
      const body = JSON.parse(raw) as { messages: { content: string }[] };
      const change = body.messages.some((m) => m.content.startsWith("Change this workflow"));
      res.end(JSON.stringify({ message: { content: JSON.stringify(change ? changed : built) }, prompt_eval_count: 1, eval_count: 1 }));
    });
  });
  server.listen(port, "127.0.0.1");
  return server;
}
