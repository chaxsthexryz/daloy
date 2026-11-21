import { createHash } from "node:crypto";
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

// A request that mentions "boss approval" gets a draft whose approval has no rejected or timeout edge, so the lint
// warnings (decision 0033) reach the editor. The fake repeats it when asked to repair it.
const approvalAsk = { id: "ask", type: "approval", config: { approver: "boss@example.com", subject: "Approve?", message: "Please decide.", timeoutSeconds: 3600 } };
const warned = {
  name: "Boss approval",
  summary: "Asks the boss to approve.",
  definition: { trigger: form, steps: [approvalAsk, thank], edges: [{ from: "ask", to: "thank", on: "approved" }] },
};

// U4: a request that mentions a "semester schedule" photo gets a form with a file field and an AI step that does not
// list the file, because Build with AI never writes "files". The warning tells the owner which box to tick.
const scheduleForm = { type: "form", config: { fields: [{ name: "schedule", label: "Photo of your schedule", type: "file", required: true }] } };
const scheduled = {
  name: "Schedule photo to Sheets",
  summary: "Reads a photo of a schedule into text and adds it to Sheets. Tick Let the AI read these files on the AI step.",
  definition: {
    trigger: scheduleForm,
    steps: [
      { id: "read", type: "ai", config: { task: "summarize", input: "Write the schedule in the photo as plain text." } },
      { id: "save", type: "sheets", config: { columns: ["{{steps.read.output.text}}"] } },
    ],
    edges: [{ from: "read", to: "save" }],
  },
};

// N22: what each AI step request carried, so a spec can check which images and text reached the model.
const aiRequests: { images: string[]; text: string }[] = [];

export function startLlmFake(port: number) {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      // The AI model page lists the local server's models.
      if (req.method === "GET" && req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: "fake-model" }] }));
      if (req.method === "GET" && req.url === "/__control") return res.end(JSON.stringify({ aiRequests }));
      if (req.method !== "POST") return res.writeHead(404).end("{}");
      const body = JSON.parse(raw) as { model?: string; messages: { role?: string; content: string; images?: string[] }[] };
      // W6: the AI model page's test. The model "fake-broken" is refused; the sample inquiry gets a label for any other.
      if (body.model === "fake-broken") return res.writeHead(404).end(JSON.stringify({ error: "model 'fake-broken' not found" }));
      if (body.messages.some((m) => m.content.includes("charged twice for my March invoice")))
        return res.end(JSON.stringify({ message: { content: JSON.stringify({ label: "billing" }) }, prompt_eval_count: 40, eval_count: 3 }));
      // An AI step (buildPrompt): record the images and the user text, and answer an extract task.
      if (body.messages.some((m) => m.role === "system" && m.content.startsWith("You are one step in an automated workflow"))) {
        const user = body.messages.filter((m) => m.role === "user");
        aiRequests.push({
          images: user.flatMap((m) => m.images ?? []).map((b64) => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex")),
          text: user.map((m) => m.content).join(" "),
        });
        const extract = body.messages.some((m) => m.content.includes("Extract these fields"));
        const content = extract ? JSON.stringify({ shop: "Sari-sari Store", amount: "250.00", date: "2026-11-18" }) : "{}";
        return res.end(JSON.stringify({ message: { content }, prompt_eval_count: 1, eval_count: 1 }));
      }
      // The run explainer (N10a) asks for plain text, not a workflow draft.
      if (body.messages.some((m) => m.content.startsWith("You explain why a Daloy automation stopped")))
        return res.end(JSON.stringify({ message: { content: "The automation stopped because a step was set to fail in this preview. Nothing was sent." }, prompt_eval_count: 1, eval_count: 1 }));
      const change = body.messages.some((m) => m.content.startsWith("Change this workflow"));
      const payload = body.messages.some((m) => m.content.includes("boss approval")) ? warned : body.messages.some((m) => m.content.includes("semester schedule")) ? scheduled : change ? changed : built;
      // The chat (#/ai, decision 0048) asks for a question or a draft: the first message alone gets the question.
      if (body.messages[0]?.content.startsWith("You help someone build an automation")) {
        const said = body.messages.filter((m) => m.role === "user" && !m.content.startsWith("The current draft is:"));
        const hasCurrent = body.messages.some((m) => m.content.startsWith("The current draft is:"));
        const reply =
          said.length === 1 && said[0]!.content.includes("ask me a question first")
            ? { kind: "question", text: "What starts it?", choices: ["Someone fills a form", "On a schedule"] }
            : { kind: "draft", ...(hasCurrent ? changed : payload) };
        return res.end(JSON.stringify({ message: { content: JSON.stringify(reply) }, prompt_eval_count: 1, eval_count: 1 }));
      }
      res.end(JSON.stringify({ message: { content: JSON.stringify(payload) }, prompt_eval_count: 1, eval_count: 1 }));
    });
  });
  server.listen(port, "127.0.0.1");
  return server;
}
