import { expect, test, type Page } from "@playwright/test";

// The Automations home (N4b): one card per automation with its state and last event, the Needs you strip, the Advanced page, and the phone layout.
// Nothing leaves the machine: the runs are delays and a mocked HTTP step.
async function signUp(page: Page, label: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account instead" }).click();
  await page.getByLabel("Email").fill(`${label}-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
}

test("Home shows each automation's state and last event, and a Needs you strip", async ({ page }) => {
  await signUp(page, "automations");
  await expect(page.getByText("No automations yet.")).toBeVisible();

  const stamp = Date.now();
  const form = await (await page.request.post("/workflows", { data: { name: "Contact form", slug: `contact-${stamp}` } })).json();
  const definition = {
    trigger: { type: "form", config: { fields: [{ name: "email", label: "Email", type: "email", required: true }] } },
    steps: [{ id: "pause", type: "delay", config: { seconds: 1 } }],
    edges: [],
  };
  expect((await page.request.post(`/workflows/${form.id}/versions`, { data: { definition, publish: true } })).status()).toBe(201);
  expect((await page.request.post(`/workflows/${form.id}/runs`, { data: { payload: { email: "ana@example.com" } } })).status()).toBe(202);

  // A preview run that waits for a person gives the strip its count (preview runs never change a card's result).
  const orders = await (await page.request.post("/workflows", { data: { name: "Orders", slug: `orders-${stamp}` } })).json();
  const orderDef = {
    trigger: { type: "manual", config: {} },
    steps: [{ id: "post", type: "http", config: { method: "POST", url: "https://orders.example.com/orders", headers: {}, body: "{}" } }],
    edges: [],
  };
  const test = await page.request.post(`/workflows/${orders.id}/test-runs`, { data: { definition: orderDef, payload: {}, choices: { post: { fail: "unknown" } } } });
  expect(test.status()).toBe(202);

  // A row is a button that selects the automation; its panel beside the table has the status, the recent runs and the next actions.
  const row = page.getByRole("row", { name: /Contact form/ });
  const panel = page.getByRole("complementary", { name: "Contact form" });
  await expect(async () => {
    await page.reload();
    await row.getByRole("button", { name: "Contact form" }).click();
    await expect(panel.getByText("Done", { exact: true })).toBeVisible({ timeout: 1000 });
    await expect(page.locator(".ops-alert.attn")).toContainText("1 request needs you", { timeout: 1000 });
  }).toPass({ timeout: 60_000 });
  await expect(row.getByRole("cell", { name: "Form", exact: true })).toBeVisible();
  await expect(panel).toContainText("On");
  await expect(row).toContainText(/ago|just now/);
  await expect(panel.getByRole("button", { name: "Copy form link" })).toBeVisible();
  await expect(panel.getByRole("link", { name: "View all" })).toHaveAttribute("href", `#/w/${form.id}/runs`);
  await expect(panel.getByRole("link", { name: "Open steps" })).toHaveAttribute("href", `#/w/${form.id}`);
  const orderRow = page.getByRole("row", { name: /Orders/ });
  await expect(orderRow).toContainText("Never");
  await orderRow.getByRole("button", { name: "Orders" }).click();
  await expect(page.getByRole("complementary", { name: "Orders" })).toContainText("No activity yet");

  // Developer pages are behind Advanced, and the strip opens the run.
  await page.getByRole("link", { name: "Advanced" }).click();
  await expect(page.getByRole("heading", { name: "Advanced", exact: true })).toBeVisible();
  for (const name of ["AI model", "API tokens", "Resources"]) await expect(page.getByRole("link", { name })).toBeVisible();
  await page.getByRole("link", { name: "Automations" }).click();
  await page.getByRole("link", { name: "Open the oldest" }).click();
  await expect(page.getByRole("region", { name: "Needs you" })).toBeVisible({ timeout: 30_000 });
});

test("on a phone the menu collapses, nothing scrolls sideways, and the activity table becomes cards", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await signUp(page, "phone");
  const menu = page.getByRole("button", { name: "Menu" });
  await expect(menu).toBeVisible();
  await expect(page.getByRole("link", { name: "Advanced" })).toBeHidden();
  expect((await menu.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await menu.click();
  await expect(page.getByRole("link", { name: "Advanced" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Team" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // One preview run so the activity page has a row.
  const wf = await (await page.request.post("/workflows", { data: { name: "Cards", slug: `cards-${Date.now()}` } })).json();
  const definition = { trigger: { type: "manual", config: {} }, steps: [{ id: "pause", type: "delay", config: { seconds: 1 } }], edges: [] };
  expect((await page.request.post(`/workflows/${wf.id}/test-runs`, { data: { definition, payload: {} } })).status()).toBe(202);
  await page.goto(`/#/w/${wf.id}/runs`);
  const row = page.locator(".table.cards tbody tr").first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  expect(await row.evaluate((e) => getComputedStyle(e).display)).toBe("block");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.setViewportSize({ width: 1280, height: 800 });
  expect(await row.evaluate((e) => getComputedStyle(e).display)).toBe("table-row");
});
