import { expect, test, type Page } from "@playwright/test";

// Build with AI as a chat (#/ai): the model asks, the person answers, the draft stays on the page until Turn it on or Save as draft (decision 0049).
async function signUp(page: Page) {
  const email = `bwa-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  return email;
}

const count = async (page: Page) => ((await (await page.request.get("/workflows")).json()) as unknown[]).length;

/** The summary card is the last bubble; nothing exists until Turn it on. */
async function summaryThenTurnOn(page: Page, before: number) {
  await expect(page.getByRole("button", { name: "Turn it on", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Change something", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save as draft", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#\/ai$/);
  expect(await count(page)).toBe(before);
  await page.getByRole("button", { name: "Turn it on", exact: true }).click();
  await expect(page).toHaveURL(/#\/a\/[^/]+$/);
}

/** Opens #/ai, sends the first message, and records every chat call and every workflow write. */
async function start(page: Page, message: string) {
  const chats: string[] = [];
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "POST") return;
    const path = new URL(r.url()).pathname;
    if (path === "/ai/chat") chats.push(r.postData() ?? "");
    if (path === "/workflows") posts.push(path);
  });
  await page.goto("/#/ai");
  await expect(page.getByRole("heading", { name: "Build with AI", level: 1 })).toBeVisible();
  await page.getByLabel("What should happen?").fill(message);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  return { chats, posts };
}

test("asks a question with chips, then waits for Turn it on", async ({ page }) => {
  const email = await signUp(page);
  const before = await count(page);
  const { chats } = await start(page, "Please ask me a question first: thanks after my contact form.");

  const answer = page.getByRole("button", { name: "Someone fills a form", exact: true });
  await expect(answer).toBeVisible();
  await expect(page.getByText("What starts it?")).toBeVisible();
  await answer.click();

  // A clean draft still waits: the summary card shows, nothing is created, until the owner presses Turn it on.
  await summaryThenTurnOn(page, before);
  await expect(page.getByText("Running", { exact: true })).toBeVisible();
  expect(await count(page)).toBe(before + 1);

  // The first message carries the words and the connected app kinds, and never the real address.
  const first = JSON.parse(chats[0]!) as { messages: { role: string; content: string }[]; apps?: string[] };
  expect(first.messages.map((m) => m.role)).toEqual(["user"]);
  expect(first.messages[0]!.content).toContain("thanks after my contact form");
  expect(Array.isArray(first.apps)).toBe(true);
  expect(chats.join(" ")).not.toContain(email);
});

test("a typed answer is sent as typed, not forced to a chip", async ({ page }) => {
  await signUp(page);
  const before = await count(page);
  const { chats } = await start(page, "Please ask me a question first: thanks after my contact form.");
  await expect(page.getByRole("button", { name: "On a schedule", exact: true })).toBeVisible();
  await page.getByLabel("What should happen?").fill("Someone fills the form on my website");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await summaryThenTurnOn(page, before);
  expect(chats).toHaveLength(2);
  expect(chats[1]).toContain("Someone fills the form on my website");
});

test("a draft with warnings waits, and a change carries it", async ({ page }) => {
  await signUp(page);
  const before = await count(page);
  const { chats } = await start(page, "Ask my boss approval, then thank the sender.");

  await expect(page.getByRole("heading", { name: "Check the draft: Boss approval" })).toBeVisible();
  const review = page.getByRole("region", { name: /Check the draft/ });
  await expect(review.getByRole("heading", { name: "Check before turning on" })).toBeVisible();
  await expect(review).toContainText('Approval step "ask" has no "rejected" edge');
  await expect(review).toContainText('Approval step "ask" has no "timeout" edge');
  // A warning holds it here: nothing is created yet.
  expect(await count(page)).toBe(before);

  await expect(review.getByRole("table")).toBeVisible();
  await page.getByRole("button", { name: "Change something" }).click();
  await page.getByLabel("What should change?").fill("Wait one day before the email.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Turn it on", exact: true })).toBeVisible();
  expect(chats.at(-1)).toContain('"current"');
  await summaryThenTurnOn(page, before);
  expect(await count(page)).toBe(before + 1);
});

test("a photo of a schedule builds a file field and an AI step, and says which box to tick (U4)", async ({ page }) => {
  await signUp(page);
  const before = await count(page);
  await start(page, "I upload a photo of my semester schedule on a form, AI turns it into text and puts it in Sheets as a table");

  await expect(page.getByRole("heading", { name: "Check the draft: Schedule photo to Sheets" })).toBeVisible();
  const review = page.getByRole("region", { name: /Check the draft/ });
  await expect(review).toContainText('AI step "read" reads no file, but the form has a file field');
  await expect(review).toContainText("Let the AI read these files");
  // The warning holds the draft: nothing is created, and the owner, not the model, turns file reading on.
  expect(await count(page)).toBe(before);
});

test("with no model the template suggestion matches by keyword, hides premature buttons, and spends 0 quota", async ({ page }) => {
  await signUp(page);
  const before = await count(page);
  await page.route("**/ai/chat", (r) =>
    r.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ message: "The AI service is temporarily unavailable. Try again in a few minutes, or start from a ready-made template below." }),
    }),
  );

  await start(page, "Resort concierge on Messenger and Instagram with GCash.");
  await expect(page.getByRole("heading", { name: "The AI is not set up, or it did not answer." })).toBeVisible();
  await expect(page.getByText(/temporarily unavailable/i)).toBeVisible();
  await expect(page.getByRole("link", { name: "Check the AI model" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Browse the template library" })).toHaveAttribute("href", "#/new");
  await expect(page.getByRole("button", { name: "Build it now" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start over" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /Resort concierge for Messenger & Instagram/ })).toBeVisible();
  expect(await count(page)).toBe(before);

  await page.getByRole("button", { name: /Conversation logs/ }).click();
  await expect(page.locator("#ai-logs-drawer .ai-log-badge")).toHaveText("Failed");
  await page.getByRole("button", { name: "Close logs" }).click();

  await page.getByLabel("What should happen?").fill("Track requests from the people in my office.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Track an office request/ })).toBeVisible();
  expect(await count(page)).toBe(before);

  const usage = (await (await page.request.get("/usage")).json()) as { ai: { used: number } };
  expect(usage.ai.used).toBe(0);

  await page.goto("/#/settings/ai");
  await expect(page.getByRole("heading", { name: "Page not found", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to Automations" })).toHaveAttribute("href", "#/");
});

test("owners see Build with AI inside the New picker on desktop and mobile", async ({ page }) => {
  await signUp(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/#/new");
  await expect(page.getByRole("link", { name: "Build with AI", exact: true })).toHaveAttribute("href", "#/ai");
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole("link", { name: "Build with AI", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Build with AI", level: 1 })).toBeVisible();
});

test("Enter sends, Shift+Enter is a newline", async ({ page }) => {
  await signUp(page);
  const chats: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/ai/chat") chats.push(r.postData() ?? "");
  });
  await page.goto("/#/ai");
  const box = page.getByLabel("What should happen?");
  await box.fill("Please ask me a question first: thanks after my contact form.");
  await box.press("Shift+Enter");
  await expect(box).toHaveValue(/form\.\n$/);
  expect(chats).toHaveLength(0);
  await box.press("Enter");
  await expect(page.getByText("What starts it?")).toBeVisible();
  expect(chats).toHaveLength(1);
});

test("a starter chip fills the box and sends nothing", async ({ page }) => {
  await signUp(page);
  const chats: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/ai/chat") chats.push(r.postData() ?? "");
  });
  await page.goto("/#/ai");
  await expect(page.getByText("Nothing goes live until you press Turn it on.")).toBeVisible();
  for (const role of ["Freelancer", "Small shop", "Salon", "Virtual assistant"]) await expect(page.getByRole("button", { name: new RegExp(`^${role}`) })).toBeVisible();
  await page.getByRole("button", { name: /^Freelancer/ }).click();
  await expect(page.getByLabel("What should happen?")).not.toHaveValue("");
  await expect(page.getByRole("log", { name: "Conversation" })).toHaveCount(0);
  expect(chats).toHaveLength(0);
});
