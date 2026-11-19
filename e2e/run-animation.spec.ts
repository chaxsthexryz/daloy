import { expect, test, type Page } from "@playwright/test";

// N4c: the diagram takes the run's state. Mocked test runs, so nothing is sent.
const definition = {
  trigger: { type: "manual", config: {} },
  steps: [
    { id: "post", type: "http", config: { method: "POST", url: "https://orders.example.com/orders", headers: {}, body: "{}" } },
    { id: "pause", type: "delay", config: { seconds: 3600 } },
  ],
  edges: [{ from: "post", to: "pause" }],
};

async function signUp(page: Page, tag: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account instead" }).click();
  await page.getByLabel("Email").fill(`${tag}-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
  const wf = await (await page.request.post("/workflows", { data: { name: "Orders", slug: `orders-${tag}-${Date.now()}` } })).json();
  await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition, publish: false } });
  return wf.id as string;
}

const node = (page: Page, text: string, state: string) => page.locator(`.node.run-${state}`, { hasText: text });
const edge = (page: Page, id: string) => page.locator(`[data-testid="rf__edge-${id}"] .run-edge`);

test("the editor and the run page show the trigger and first edge done before the last step", async ({ page }) => {
  const id = await signUp(page, "anim");
  await page.goto(`/#/w/${id}`);
  await page.getByRole("button", { name: "Test run draft" }).click();

  // The delay step waits an hour, so the last step is never Done while the steps before it are.
  await expect(node(page, "pause", "waiting")).toContainText("Waiting", { timeout: 30_000 });
  await expect(node(page, "Trigger", "done")).toContainText("Done");
  await expect(node(page, "post", "done")).toContainText("Done");
  await expect(edge(page, "trigger->entry")).toHaveAttribute("data-state", "done");
  await expect(edge(page, "post:next")).toHaveAttribute("data-state", "done");
  await expect(page.locator(".node.run-done", { hasText: "pause" })).toHaveCount(0);
  await expect(page.getByRole("group", { name: /delay step pause.*Waiting/ })).toBeVisible();

  // The same picture on the run page, read only, with the technician details still there.
  await page.getByRole("link", { name: "Open this run in the run history" }).click();
  const path = page.getByRole("region", { name: "Path it took" });
  await expect(path.locator(".node.run-waiting")).toContainText("Waiting", { timeout: 30_000 });
  await expect(path.locator(".node.run-done")).toHaveCount(2);
  await expect(page.getByText("Details for a technician")).toBeVisible();

  // Phones replace the diagram with the same steps and statuses in a readable list.
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(path).toBeVisible();
  await expect(path.locator(".run-canvas")).toBeHidden();
  const steps = path.getByRole("listitem");
  await expect(steps).toHaveCount(2);
  await expect(steps.nth(0)).toContainText("post");
  await expect(steps.nth(0)).toContainText("Done");
  await expect(steps.nth(1)).toContainText("pause");
  await expect(steps.nth(1)).toContainText("Waiting");
  await expect(steps.nth(1)).toBeVisible();
});

test("a failed step is red and says Problem", async ({ page }) => {
  const id = await signUp(page, "fail");
  const res = await page.request.post(`/workflows/${id}/test-runs`, { data: { definition, payload: {}, choices: { post: { fail: "permanent" } } } });
  expect(res.status()).toBe(202);
  await page.goto(`/#/runs/${(await res.json()).id}`);
  const path = page.getByRole("region", { name: "Path it took" });
  await expect(path.locator(".node.run-problem")).toContainText("Problem", { timeout: 30_000 });
  await expect(path.locator(".node.run-problem")).toContainText("post");
  await expect(path.locator(".node.run-idle")).toContainText("Not reached");
  await expect(edge(page, "trigger->entry")).toHaveAttribute("data-state", "done");
});

// A run that is still working lasts well under a second with mocked calls, so the poll answer is faked here.
for (const reduced of [false, true]) {
  test(`work flowing into a step ${reduced ? "does not move" : "moves"} with prefers-reduced-motion ${reduced ? "reduce" : "no-preference"}`, async ({ page }) => {
    const id = await signUp(page, reduced ? "calm" : "move");
    const res = await page.request.post(`/workflows/${id}/test-runs`, { data: { definition, payload: {} } });
    const runId = (await res.json()).id as string;
    await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
    await page.route(`**/runs/${runId}`, async (route) => {
      const real = await (await route.fetch()).json();
      const post = real.steps.find((s: { stepId: string }) => s.stepId === "post");
      await route.fulfill({ json: { ...real, state: "running", finishedAt: null, steps: [{ ...post, state: "running", finishedAt: null, output: null }] } });
    });
    await page.goto(`/#/runs/${runId}`);
    const path = page.getByRole("region", { name: "Path it took" });
    await expect(path.locator(".node.run-working")).toContainText("Working", { timeout: 30_000 });
    await expect(edge(page, "trigger->entry")).toHaveAttribute("data-state", "flowing");
    await expect(path.locator(".run-dot animateMotion")).toHaveCount(reduced ? 0 : 1);
    const pulse = await path.locator(".node.run-working").evaluate((el) => getComputedStyle(el).animationName);
    expect(pulse).toBe(reduced ? "none" : "node-pulse");
  });
}
