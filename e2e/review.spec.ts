import { expect, test } from "@playwright/test";

// A mocked test run whose POST is set to an unknown outcome waits for review; the operator says it went through.
// Nothing is sent: the run is mocked (decision 0030).
test("answer a run that needs review with It went through", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account instead" }).click();
  await page.getByLabel("Email").fill(`review-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Workflows", exact: true })).toBeVisible();

  // The builder is covered by main-flow.spec.ts; here the workflow and test run come from the API with the console session.
  const wf = await (await page.request.post("/workflows", { data: { name: "Orders", slug: `orders-${Date.now()}` } })).json();
  const definition = {
    trigger: { type: "manual", config: {} },
    steps: [
      { id: "post", type: "http", config: { method: "POST", url: "https://orders.example.com/orders", headers: {}, body: "{}" } },
      { id: "pause", type: "delay", config: { seconds: 1 } },
    ],
    edges: [{ from: "post", to: "pause" }],
  };
  const res = await page.request.post(`/workflows/${wf.id}/test-runs`, { data: { definition, payload: {}, choices: { post: { fail: "unknown" } } } });
  expect(res.status()).toBe(202);
  const { id } = await res.json();

  await page.goto(`/#/runs/${id}`);
  const review = page.getByRole("region", { name: "Needs review" });
  await expect(review).toBeVisible({ timeout: 30_000 });
  await expect(review).toContainText("A receiver that does not deduplicate may get it twice");
  await review.getByRole("button", { name: "It went through" }).click();
  await expect(page.locator(".run > p").first()).toHaveText(/^succeeded/, { timeout: 30_000 });
  await expect(page.locator(".run")).toContainText("Answered by");
  await expect(page.getByLabel("Output of post")).toContainText('"reconciled": "delivered"');
});
