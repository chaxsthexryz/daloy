import { expect, test, type Page } from "@playwright/test";

// N4d: New automation from the top, search and state filters, drafts apart with Delete, the Activity table on desktop and
// run errors without step ids. Nothing leaves the machine: the failing step is a number check on a missing value.
async function signUp(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account instead" }).click();
  await page.getByLabel("Email").fill(`nav-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
}

async function publish(page: Page, name: string, steps: object[]) {
  const wf = await (await page.request.post("/workflows", { data: { name, slug: `${name.toLowerCase()}-${Date.now()}` } })).json();
  const definition = { trigger: { type: "manual", config: {} }, steps, edges: [] };
  expect((await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition, publish: true } })).status()).toBe(201);
  return wf.id as string;
}

test("an owner starts from the top button, narrows the list, deletes a draft and reads a failed run", async ({ page }) => {
  await signUp(page);
  const broken = await publish(page, "Broken", [{ id: "check", type: "condition", config: { condition: { left: "{{trigger.amount}}", op: "gt", right: 100 } } }]);
  await publish(page, "Fine", [{ id: "pause", type: "delay", config: { seconds: 1 } }]);
  const run = await (await page.request.post(`/workflows/${broken}/runs`, { data: { payload: {} } })).json();

  // The header button opens New automation, and a guided template reaches its first step (which makes a draft).
  await page.reload();
  await page.getByRole("main").getByRole("link", { name: "New automation" }).click();
  await expect(page).toHaveURL(/#\/new$/);
  await page.getByRole("button", { name: "Set up for my office" }).click();
  await expect(page.getByLabel("Automation name")).toBeVisible();

  // Problem filter and search, with the failed automation sorted first.
  await page.getByRole("link", { name: "Automations", exact: true }).first().click();
  const cards = page.locator("ul.cards > li");
  await expect(async () => {
    await page.reload();
    await expect(cards.first()).toContainText("Problem", { timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole("button", { name: "Problem" }).click();
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText("Broken");
  await page.getByRole("button", { name: "All" }).click();
  await page.getByLabel("Find an automation").fill("fin");
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText("Fine");
  await page.getByLabel("Find an automation").fill("");

  // The draft is not a card; it sits under Drafts and can be deleted.
  await expect(cards).toHaveCount(2);
  await page.locator("summary", { hasText: "Drafts (1)" }).click();
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.locator("summary", { hasText: "Drafts" })).toHaveCount(0);
  expect(await (await page.request.get("/workflows")).json()).toHaveLength(2);

  // On desktop the Activity table is a table: its heading row sits above the first row, at the same left edge.
  await page.goto(`/#/w/${broken}/runs`);
  const th = page.locator("table thead th").first();
  const td = page.locator("table tbody td").first();
  await expect(td).toBeVisible();
  const [h, d] = [(await th.boundingBox())!, (await td.boundingBox())!];
  expect(Math.abs(h.x - d.x)).toBeLessThan(2);
  expect(h.y).toBeLessThan(d.y);

  // The run's error is shown without the step id; the full text stays for a technician.
  // The raw error shows first and N10a's "Why it stopped" panel replaces it once the explanation loads, so wait for that load.
  const explained = page.waitForResponse((r) => r.url().includes(`/runs/${run.id}/explanation`), { timeout: 30_000 });
  await page.goto(`/#/runs/${run.id}`);
  await explained;
  const error = page.locator('section[aria-label="Why it stopped"], main > .message.error').first();
  await expect(error).toBeVisible({ timeout: 30_000 });
  await expect(error).not.toContainText("step check:");
  await expect(page.getByText("Retry runs the failed step again.")).toBeVisible();
});

test("Settings in the menu sets light or dark on this device, and System follows the device", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await signUp(page);
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(await theme()).toBe("light");
  const light = await background();

  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await expect(page.getByText(/Signed in as nav-\d+@test\.local, Owner\./)).toBeVisible();
  await expect(page.getByRole("link", { name: "AI model" })).toHaveAttribute("href", "#/settings/ai");
  await page.getByLabel("Dark").check();
  expect(await theme()).toBe("dark");
  expect(await background()).not.toBe(light);

  // The choice is kept on reload and set before the page draws (public/theme.js).
  await page.reload();
  expect(await theme()).toBe("dark");
  await expect(page.getByLabel("Dark")).toBeChecked();

  // System follows the device again, including a later switch.
  await page.getByLabel("System (follows this device)").check();
  expect(await theme()).toBe("light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(theme).toBe("dark");
});

test("Apps lists each app as a card, and Connect opens that app's own setup", async ({ page }) => {
  await signUp(page);
  await page.getByRole("link", { name: "Apps" }).first().click();
  await expect(page.getByRole("button", { name: "All 6" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Connected 0" })).toBeVisible();
  const more = page.getByRole("region", { name: "More" });
  for (const name of ["Gmail", "Outlook", "Google Sheets", "Slack", "Microsoft Teams", "Telegram"]) await expect(more.getByRole("heading", { name, exact: true })).toBeVisible();

  await page.getByLabel("Find an app").fill("sla");
  await expect(more.getByRole("listitem")).toHaveCount(1);
  await page.getByRole("button", { name: "Connect Slack" }).click();
  await expect(page.getByRole("region", { name: "Slack setup" }).getByLabel("Bot token")).toBeVisible();
  await expect(page.getByRole("button", { name: "Close Slack" })).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "Connected 0" }).click();
  await expect(page.getByText("Nothing is connected yet.")).toBeVisible();
});
