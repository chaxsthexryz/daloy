import { expect, test, type Page } from "@playwright/test";

// T8: "Chat as your customer". Each message is a real-AI test run against the fake model (e2e/llm-fake.ts); the reply
// step stays mocked, so nothing is sent to Messenger.
const dm = { type: "meta_dm", config: { channel: "both", requireImage: false } };

async function signUp(page: Page, tag: string, definition: object) {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
  const wf = await (await page.request.post("/workflows", { data: { name: "Resort chat", slug: `chat-${tag}-${Date.now()}` } })).json();
  expect((await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition, publish: false } })).status()).toBe(201);
  return wf.id as string;
}

async function say(page: Page, text: string) {
  await page.getByPlaceholder("Message as your customer").fill(text);
  const sent = page.waitForRequest((r) => r.url().includes("/test-runs") && r.method() === "POST");
  await page.getByRole("region", { name: "Chat as your customer" }).getByRole("button", { name: "Send", exact: true }).click();
  return (await sent).postDataJSON() as { mode: string; payload: { senderId: string; text: string; conversation: { history: { direction: string; text: string }[] } } };
}

test("an owner types a question as the customer and sees the answer from the price list", async ({ page }) => {
  const definition = {
    trigger: dm,
    steps: [
      { id: "answer", type: "ai", config: { task: "answer", input: "{{trigger.text}}" } },
      { id: "reply", type: "meta_reply", config: { recipientId: "{{trigger.senderId}}", channel: "{{trigger.channel}}", text: "{{steps.answer.output.reply}}" } },
    ],
    edges: [{ from: "answer", to: "reply" }],
  };
  const id = await signUp(page, "chat", definition);
  expect((await page.request.post("/knowledge/entries", { data: { kind: "fee", title: "Day tour", fields: { price: 350, unit: "day" } } })).ok()).toBe(true);
  expect((await page.request.post("/knowledge/publish")).ok()).toBe(true);

  await page.goto(`/#/w/${id}`);
  await expect(page.getByRole("heading", { name: "Chat as your customer" })).toBeVisible();
  const body = await say(page, "Magkano po ang day tour?");
  expect(body.mode).toBe("ai");
  expect(body.payload).toMatchObject({ senderId: "test-customer", text: "Magkano po ang day tour?" });

  const log = page.getByRole("log", { name: "Test chat" });
  await expect(log.locator(".is-customer")).toContainText("Magkano po ang day tour?");
  await expect(log.locator(".is-bot")).toContainText("Day tour is ₱350 per day.", { timeout: 30_000 });
  await expect(page.locator(".node.run-done", { hasText: "reply" })).toBeVisible();

  // The next message carries the chat so far, as the conversation history the webhook would send.
  const second = await say(page, "Salamat!");
  expect(second.payload.conversation.history.map((h) => h.direction)).toEqual(["in", "out", "in"]);
  await expect(log.locator(".is-bot")).toHaveCount(2);
  await expect(log.locator(".is-bot").last()).toContainText("Day tour is ₱350 per day.", { timeout: 30_000 });
});

test("a run with no reply step shows the path it took", async ({ page }) => {
  const definition = {
    trigger: dm,
    steps: [
      { id: "is_receipt", type: "condition", config: { condition: { left: "{{trigger.text}}", op: "contains", right: "receipt" } } },
      { id: "wait", type: "delay", config: { seconds: 1 } },
    ],
    edges: [{ from: "is_receipt", to: "wait", on: "true" }],
  };
  const id = await signUp(page, "chatpath", definition);
  await page.goto(`/#/w/${id}`);
  await say(page, "Hello po");
  await expect(page.getByRole("log", { name: "Test chat" }).locator(".is-bot")).toContainText("No reply step ran. The run went: is_receipt (false).", { timeout: 30_000 });
});
