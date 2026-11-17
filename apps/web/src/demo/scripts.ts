import type { WorkflowDefinition } from "@daloy/engine";

/**
 * The demo's scripted AI helper. Each script answers one starter prompt with the fixed questions of the Build with AI
 * plan (docs/console-navigation-plan.md, section 4) and drafts a real definition from the answers. No model runs here;
 * the page says so on every screen.
 */
export type Question = { id: string; text: string; choices: { value: string; label: string }[] };
export type Draft = { name: string; when: string; plan: string[]; definition: WorkflowDefinition };
export type Script = {
  id: "booking" | "shop" | "bills";
  audience: string;
  title: string;
  prompt: string;
  keywords: string[];
  reply: string;
  questions: Question[];
  /** The sample the visitor sends through the approved draft: trigger data, prefilled and editable. */
  sample: Record<string, string>;
  draft: (answers: Record<string, string>) => Draft;
};

const ME = "you@example.com";
// A week from today at 10:00, so the sample call is always in the future.
const nextWeek = () => `${new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)}T10:00`;
type Step = WorkflowDefinition["steps"][number];
type Edge = WorkflowDefinition["edges"][number];

/** Steps in order, each with its plain sentence, joined by unlabelled edges unless the caller adds its own. */
function chain(items: [Step, string][]): { steps: Step[]; plan: string[]; edges: Edge[] } {
  const steps = items.map(([s]) => s);
  return { steps, plan: items.map(([, p]) => p), edges: steps.slice(1).map((s, i) => ({ from: steps[i]!.id, to: s.id })) };
}

const booking: Script = {
  id: "booking",
  audience: "Freelancer",
  title: "Client booking",
  prompt: "When a client books a call, confirm it and remind them the day before.",
  keywords: ["client", "book", "call", "appointment", "session", "consult", "meeting"],
  reply: "I can draft that. A client books, Daloy confirms by email, waits until the day before the call, then sends a reminder. Three quick questions first.",
  questions: [
    {
      id: "start",
      text: "What starts it?",
      choices: [
        { value: "form", label: "Someone fills a form" },
        { value: "webhook", label: "Another system sends a web request" },
      ],
    },
    {
      id: "who",
      text: "Who should know?",
      choices: [
        { value: "me", label: "Me" },
        { value: "none", label: "No one, only the client" },
      ],
    },
    {
      id: "where",
      text: "Where should it go?",
      choices: [
        { value: "email", label: "Email" },
        { value: "sheets", label: "Email and a Google Sheet" },
      ],
    },
  ],
  sample: { name: "Ana Reyes", email: "ana@example.com", call_at: nextWeek(), topic: "Logo for my bakery" },
  draft(a) {
    const fields = [
      { name: "name", label: "Your name", type: "text", required: true },
      { name: "email", label: "Email", type: "email", required: true },
      { name: "call_at", label: "Call date and time", type: "datetime", required: true, timezone: "Asia/Manila" },
      { name: "topic", label: "What is the call about?", type: "textarea", required: false },
    ] as const;
    const items: [Step, string][] = [
      [{ id: "confirm", type: "email", config: { to: "{{trigger.email}}", subject: "Your call is booked", text: "Hi {{trigger.name}}, your call on {{trigger.call_at}} is booked. Reply to this email to change it." } }, "Email the client that the call is booked."],
    ];
    if (a.who === "me") items.push([{ id: "notify_me", type: "email", config: { to: ME, subject: "New booking: {{trigger.name}}", text: "{{trigger.name}} ({{trigger.email}}) booked a call on {{trigger.call_at}}. Topic: {{trigger.topic}}" } }, "Email you the booking."]);
    if (a.where === "sheets") items.push([{ id: "log", type: "sheets", config: { columns: ["{{trigger.name}}", "{{trigger.email}}", "{{trigger.call_at}}", "{{trigger.topic}}"] } }, "Add a row to your bookings sheet."]);
    items.push(
      [{ id: "wait", type: "delay", config: { until: "{{trigger.call_at}}", offsetSeconds: -86_400 } }, "Wait until one day before the call."],
      [{ id: "remind", type: "email", config: { to: "{{trigger.email}}", subject: "Reminder: your call tomorrow", text: "Hi {{trigger.name}}, a reminder that your call is on {{trigger.call_at}}." } }, "Email the client a reminder."],
    );
    const { steps, plan, edges } = chain(items);
    const trigger = a.start === "webhook" ? { type: "webhook" as const, config: { fields: [...fields] } } : { type: "form" as const, config: { fields: [...fields] } };
    return { name: "Client booking", when: a.start === "webhook" ? "When your booking page sends a new booking" : "When a client fills your booking form", plan, definition: { trigger, steps, edges } };
  },
};

const shop: Script = {
  id: "shop",
  audience: "Small business",
  title: "Online-shop order",
  prompt: "When an online-shop order comes in, log it, tell me, and let me approve big orders.",
  keywords: ["order", "shop", "store", "online", "customer", "sell", "product", "deliver", "purchase"],
  reply: "I can draft that. Each order is logged, and orders over ₱5,000 wait for your approval before the customer gets a confirmation. Three quick questions first.",
  questions: [
    {
      id: "start",
      text: "What starts it?",
      choices: [
        { value: "webhook", label: "My shop sends a web request" },
        { value: "form", label: "Someone fills an order form" },
      ],
    },
    {
      id: "where",
      text: "Where should each order go?",
      choices: [
        { value: "sheets", label: "Google Sheet" },
        { value: "slack", label: "Slack" },
        { value: "email", label: "Email to me" },
      ],
    },
    {
      id: "approve",
      text: "Should you approve big orders first?",
      choices: [
        { value: "yes", label: "Yes, orders over ₱5,000" },
        { value: "no", label: "No" },
      ],
    },
  ],
  sample: { order_id: "1042", name: "Ben Cruz", email: "ben@example.com", total: "7500", items: "2 bags of coffee beans, 1 grinder" },
  draft(a) {
    const fields = [
      { name: "order_id", label: "Order number", type: "text", required: true },
      { name: "name", label: "Customer name", type: "text", required: true },
      { name: "email", label: "Customer email", type: "email", required: true },
      { name: "total", label: "Total in pesos", type: "number", required: true, min: 0 },
      { name: "items", label: "Items", type: "textarea", required: true },
    ] as const;
    const log: [Step, string] =
      a.where === "sheets"
        ? [{ id: "log", type: "sheets", config: { columns: ["{{trigger.order_id}}", "{{trigger.name}}", "{{trigger.total}}", "{{trigger.items}}"] } }, "Add the order to your orders sheet."]
        : a.where === "slack"
          ? [{ id: "log", type: "slack", config: { text: "New order {{trigger.order_id}}: ₱{{trigger.total}}, {{trigger.items}}" } }, "Post the order to your Slack channel."]
          : [{ id: "log", type: "email", config: { to: ME, subject: "New order {{trigger.order_id}}", text: "{{trigger.name}} ordered {{trigger.items}} for ₱{{trigger.total}}." } }, "Email you the order."];
    const receipt: [Step, string] = [
      { id: "receipt", type: "email", config: { to: "{{trigger.email}}", subject: "Order {{trigger.order_id}} confirmed", text: "Hi {{trigger.name}}, we have your order: {{trigger.items}}. Total: ₱{{trigger.total}}. Reference {{trigger.reference}}." } },
      "Email the customer a confirmation.",
    ];
    let built: { steps: Step[]; plan: string[]; edges: Edge[] };
    if (a.approve === "yes") {
      built = chain([
        log,
        [{ id: "is_big", type: "condition", config: { condition: { left: "{{trigger.total}}", op: "gt", right: 5000 } } }, "Check whether the total is over ₱5,000."],
        [{ id: "approve", type: "approval", config: { to: ME, subject: "Approve order {{trigger.order_id}}?", message: "{{trigger.name}} ordered {{trigger.items}} for ₱{{trigger.total}}.", timeoutSeconds: 172_800 } }, "If it is, ask you to approve it."],
        receipt,
        [{ id: "decline", type: "email", config: { to: "{{trigger.email}}", subject: "About order {{trigger.order_id}}", text: "Hi {{trigger.name}}, we cannot take this order. We will refund any payment." } }, "If you decline, email the customer."],
        [{ id: "nudge", type: "email", config: { to: ME, subject: "Order {{trigger.order_id}} still needs you", text: "Nobody approved order {{trigger.order_id}} within two days." } }, "If nobody answers in two days, remind you."],
      ]);
      built.edges = [
        { from: "log", to: "is_big" },
        { from: "is_big", to: "approve", on: "true" },
        { from: "is_big", to: "receipt", on: "false" },
        { from: "approve", to: "receipt", on: "approved" },
        { from: "approve", to: "decline", on: "rejected" },
        { from: "approve", to: "nudge", on: "timeout" },
      ];
    } else built = chain([log, receipt]);
    const trigger = a.start === "form" ? { type: "form" as const, config: { fields: [...fields] } } : { type: "webhook" as const, config: { fields: [...fields] } };
    return { name: "Online-shop orders", when: a.start === "form" ? "When someone fills your order form" : "When your shop sends a new order", plan: built.plan, definition: { trigger, steps: built.steps, edges: built.edges } };
  },
};

const bills: Script = {
  id: "bills",
  audience: "Everyday",
  title: "Household bill reminder",
  prompt: "Remind my household to pay the electricity bill every month.",
  keywords: ["bill", "pay", "electric", "rent", "water", "month", "household", "family", "remind", "home"],
  reply: "I can draft that. On the day you pick each month, Daloy emails a reminder to pay the bill. Two quick questions first.",
  questions: [
    {
      id: "when",
      text: "What starts it? On a schedule, on which day?",
      choices: [
        { value: "1", label: "The 1st of each month" },
        { value: "15", label: "The 15th of each month" },
      ],
    },
    {
      id: "who",
      text: "Who should know?",
      choices: [
        { value: "me", label: "Me" },
        { value: "family", label: "Me and a family member" },
      ],
    },
  ],
  sample: {},
  draft(a) {
    const to = a.who === "family" ? `${ME}, family@example.com` : ME;
    const { steps, plan, edges } = chain([
      [{ id: "remind", type: "email", config: { to, subject: "Pay the electricity bill", text: "This is your monthly reminder to pay the electricity bill before it is due." } }, a.who === "family" ? "Email you and your family member a reminder." : "Email you a reminder."],
    ]);
    const day = a.when === "15" ? "15" : "1";
    return { name: "Electricity bill reminder", when: `At 8 in the morning on the ${day === "1" ? "1st" : "15th"} of each month`, plan, definition: { trigger: { type: "schedule", config: { cron: `0 8 ${day} * *` } }, steps, edges } };
  },
};

export const SCRIPTS: Script[] = [booking, shop, bills];

/**
 * Picks the script whose keywords the text mentions most. `sure` needs two or more hits and a clear lead, so loose
 * words only suggest the nearest script and the page says it is not a match.
 */
export function matchScript(text: string): { script: Script | undefined; sure: boolean } {
  const words = text.toLowerCase();
  const scored = SCRIPTS.map((script) => ({ script, score: script.keywords.filter((k) => words.includes(k)).length })).sort((x, y) => y.score - x.score);
  const [best, next] = scored;
  if (!best || best.score === 0) return { script: undefined, sure: false };
  return { script: best.script, sure: best.score >= 2 && best.score > (next?.score ?? 0) };
}
