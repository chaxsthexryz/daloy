import { expect, test } from "@playwright/test";

// N10a: a failed preview run explains itself in plain words; the owner can ask the fake model to reword it.
async function failedRun(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`explain-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
  const wf = await (await page.request.post("/workflows", { data: { name: "Orders", slug: `orders-${Date.now()}` } })).json();
  const definition = {
    trigger: { type: "manual", config: {} },
    steps: [{ id: "post", type: "http", config: { method: "POST", url: "https://orders.example.com/orders", headers: {}, body: "{}" } }],
    edges: [],
  };
  const res = await page.request.post(`/workflows/${wf.id}/test-runs`, { data: { definition, payload: {}, choices: { post: { fail: "permanent" } } } });
  expect(res.status()).toBe(202);
  await page.goto(`/#/runs/${(await res.json()).id}`);
  await expect(page.locator(".state").first()).toHaveText("Problem", { timeout: 30_000 });
}

test("a failed run shows why it stopped, with the raw error only under the technician details", async ({ page }) => {
  await failedRun(page);
  const why = page.getByRole("region", { name: "Why it stopped" });
  await expect(why.locator(".message.error")).not.toBeEmpty();
  await expect(page.getByLabel("Full error")).toBeHidden();
  await page.getByText("Details for a technician").click();
  await expect(page.getByLabel("Full error")).toBeVisible();
  await expect(why.getByLabel("Full error")).toHaveCount(0);
});

test("Explain in simpler words shows the model's text and leaves the state alone", async ({ page }) => {
  await failedRun(page);
  await page.getByRole("button", { name: "Explain in simpler words (uses 1 AI action)" }).click();
  await expect(page.getByText("Written by the AI model")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("The automation stopped because a step was set to fail in this preview. Nothing was sent.")).toBeVisible();
  await expect(page.locator(".state").first()).toHaveText("Problem");
});
