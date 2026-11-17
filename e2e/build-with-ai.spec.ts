import { expect, test, type Page } from "@playwright/test";

// The Build with AI tab (#/ai): the page asks the questions, the fake model drafts, nothing is saved until Save as draft.
async function signUp(page: Page) {
  const email = `bwa-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account instead" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
  return email;
}

const count = async (page: Page) => ((await (await page.request.get("/workflows")).json()) as unknown[]).length;

/** Opens #/ai, types the description, and records every POST the page makes. */
async function start(page: Page, description: string) {
  const drafts: string[] = [];
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "POST") return;
    const path = new URL(r.url()).pathname;
    if (path === "/ai/draft") drafts.push(r.postData() ?? "");
    if (path === "/workflows") posts.push(path);
  });
  await page.goto("/#/ai");
  await expect(page.getByRole("heading", { name: "Build with AI", level: 1 })).toBeVisible();
  await page.getByLabel("What should happen?").fill(description);
  await page.getByRole("button", { name: "Next" }).click();
  return { drafts, posts };
}

const answer = (page: Page, ...labels: string[]) => labels.reduce((p, l) => p.then(() => page.getByRole("button", { name: l, exact: true }).click()), Promise.resolve());

test("answers the questions, reviews the draft in plain words, and saves nothing until Save as draft", async ({ page }) => {
  const email = await signUp(page);
  const before = await count(page);
  const { drafts, posts } = await start(page, "When someone fills my contact form, thank them by email.");

  await expect(page.getByRole("heading", { name: "What starts it?" })).toBeVisible();
  await answer(page, "Someone fills a form", "Me", "Email", "No");

  await expect(page.getByRole("heading", { name: "Check the draft: Contact thanks" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Check before turning on" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: /^Email / })).toHaveCount(1);
  await expect(page.getByText("Nothing is saved yet.")).toBeVisible();
  expect(await count(page)).toBe(before);
  expect(posts).toHaveLength(0);

  // The model gets the owner label and the connected apps, never the real address.
  expect(drafts).toHaveLength(1);
  const first = JSON.parse(drafts[0]!) as { request: string; current?: unknown };
  expect(first.request).toContain("owner@people.invalid");
  expect(first.request).toContain("Apps connected");
  expect(drafts[0]).not.toContain(email);

  // A change goes with the current draft; the review updates and the address still stays out.
  await page.getByRole("button", { name: "Change something" }).click();
  await page.getByLabel("What should change?").fill("Wait one day before the email.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Wait 1 day")).toBeVisible();
  await expect(page.locator("ol.numbered > li")).toHaveCount(2);
  expect(drafts).toHaveLength(2);
  const second = JSON.parse(drafts[1]!) as { request: string; current?: unknown };
  expect(second.current).toBeTruthy();
  expect(drafts[1]).not.toContain(email);
  expect(await count(page)).toBe(before);
  expect(posts).toHaveLength(0);

  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(page).toHaveURL(/#\/w\/[^/]+$/);
  await expect(page.getByText("Version 1, draft")).toBeVisible();
  expect(await count(page)).toBe(before + 1);
});

test("warnings appear under Check before turning on", async ({ page }) => {
  await signUp(page);
  await start(page, "Ask my boss approval, then thank the sender.");
  await answer(page, "Someone fills a form", "Me", "Email", "Yes, the person named above");

  await expect(page.getByRole("heading", { name: "Check the draft: Boss approval" })).toBeVisible();
  const review = page.getByRole("region", { name: /Check the draft/ });
  await expect(review.getByRole("heading", { name: "Check before turning on" })).toBeVisible();
  await expect(review).toContainText('Approval step "ask" has no "rejected" edge');
  await expect(review).toContainText('Approval step "ask" has no "timeout" edge');
});

test("with no model the template suggestion appears", async ({ page }) => {
  await signUp(page);
  const before = await count(page);
  await page.route("**/ai/draft", (r) => r.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ message: "No AI model is set up." }) }));

  await start(page, "Ask for purchases and tell me.");
  await answer(page, "Someone fills a form", "Me", "Email", "Yes, the person named above");
  await expect(page.getByRole("heading", { name: "The AI is not set up, or it did not answer." })).toBeVisible();
  await expect(page.getByText("No AI model is set up.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Check the AI model" })).toHaveAttribute("href", "#/settings/ai");
  await expect(page.getByRole("heading", { name: /Purchase request with a named approver/ })).toBeVisible();
  expect(await count(page)).toBe(before);

  await page.getByRole("button", { name: "Start over" }).click();
  await page.getByLabel("What should happen?").fill("Track requests from the people in my office.");
  await page.getByRole("button", { name: "Next" }).click();
  await answer(page, "Someone fills a form", "Me", "Email", "No");
  await expect(page.getByRole("heading", { name: /Track an office request/ })).toBeVisible();
  expect(await count(page)).toBe(before);
});

test("an Other answer is sent as typed", async ({ page }) => {
  await signUp(page);
  const { drafts } = await start(page, "When someone fills my contact form, thank them by email.");
  await answer(page, "Someone fills a form", "Me");
  await page.getByRole("button", { name: "Other", exact: true }).click();
  await page.getByLabel("Your own answer").fill("A shared folder");
  await page.getByRole("button", { name: "Use this answer" }).click();
  await answer(page, "No");
  await expect(page.getByRole("heading", { name: "Check the draft: Contact thanks" })).toBeVisible();
  expect(drafts[0]).toContain("A shared folder");
});

test("owners see Build with AI in the menu, and an AI link in the phone bottom bar", async ({ page }) => {
  await signUp(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Build with AI" })).toHaveAttribute("href", "#/ai");
  await page.setViewportSize({ width: 375, height: 812 });
  const ai = page.getByRole("navigation", { name: "Quick" }).getByRole("link", { name: "AI", exact: true });
  await expect(ai).toHaveAttribute("href", "#/ai");
  await ai.click();
  await expect(page.getByRole("heading", { name: "Build with AI", level: 1 })).toBeVisible();
});
