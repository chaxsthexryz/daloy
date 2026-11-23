import { expect, test } from "@playwright/test";

// T2: "Test with this data" on a failed run opens the editor with that run's trigger data as the sample, secrets still hidden,
// and the test it runs stays mocked.
test("a failed run's data becomes the editor's sample, and the test with it fakes every app", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`retest-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();

  const wf = await (await page.request.post("/workflows", { data: { name: "Orders", slug: `orders-${Date.now()}` } })).json();
  const definition = {
    trigger: { type: "manual", config: {} },
    steps: [{ id: "post", type: "http", config: { method: "POST", url: "https://orders.example.com/orders", headers: {}, body: "{}" } }],
    edges: [],
  };
  expect((await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition } })).status()).toBe(201);
  const res = await page.request.post(`/workflows/${wf.id}/test-runs`, { data: { definition, payload: { customer: "Ana", password: "hunter2" }, choices: { post: { fail: "permanent" } } } });
  expect(res.status()).toBe(202);
  const runId = (await res.json()).id as string;
  await page.goto(`/#/runs/${runId}`);
  await expect(page.locator(".state").first()).toHaveText("Problem", { timeout: 30_000 });

  await page.getByRole("link", { name: "Test with this data" }).click();
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  await expect(page).toHaveURL(new RegExp(`#/w/${wf.id}\\?from=${runId}$`));
  const box = page.getByLabel("Sample trigger data (JSON)");
  await expect(box).toBeVisible();
  await expect(box).toHaveValue(/"customer": "Ana"/);
  await expect(box).toHaveValue(/"password": "\[secret\]"/);
  await expect(box).not.toHaveValue(/hunter2/);
  await expect(page.getByText(/Sample data from request .+\. Values hidden as \[secret\] stay hidden\./)).toBeVisible();

  const sent = page.waitForRequest((r) => r.url().endsWith(`/workflows/${wf.id}/test-runs`) && r.method() === "POST");
  await page.getByRole("button", { name: "Test run", exact: true }).click();
  const body = (await sent).postDataJSON() as { payload: Record<string, unknown>; mode?: string };
  expect(body.payload.customer).toBe("Ana");
  expect(body.mode ?? "mock").toBe("mock");
  await expect(page.locator(".run > p").first()).toHaveText(/test run, mocked calls/, { timeout: 30_000 });
});
