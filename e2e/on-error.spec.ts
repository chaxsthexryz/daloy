import { expect, test } from "@playwright/test";

// T3: "If this step fails" set to skip. A mocked test run with that step set to fail records it skipped, says so, and
// sends the step after it. Nothing is sent: a mocked run fakes every outside call (decision 0028).
test("a step set to skip on failure is skipped in a mocked failing test run and the next step runs", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`t3-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  const wf = await (await page.request.post("/workflows", { data: { name: "Skip on failure", slug: `t3-${Date.now()}` } })).json();
  const mail = (to: string) => ({ to, subject: "Hello", text: "Hi" });
  const definition = {
    trigger: { type: "manual", config: {} },
    steps: [
      { id: "first_mail", type: "email", config: mail("first@example.com") },
      { id: "second_mail", type: "email", config: mail("second@example.com") },
    ],
    edges: [{ from: "first_mail", to: "second_mail" }],
  };
  expect((await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition, publish: false } })).ok()).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/#/w/${wf.id}`);
  await expect(page.getByRole("heading", { name: "Skip on failure", level: 1 })).toBeVisible();
  const explain = page.getByRole("dialog", { name: "Explain this flow" });
  if (await explain.isVisible()) await explain.getByRole("button", { name: "Got it" }).click();
  await page.getByRole("button", { name: "Diagram", exact: true }).click();

  await page.locator('.react-flow__node[data-id="first_mail"]').click();
  const policy = page.getByLabel("If this step fails");
  await expect(policy).toHaveValue("stop");
  await policy.selectOption({ label: "Skip it and carry on" });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".a7-chip")).toHaveText("Draft");

  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.locator(".a7-test-settings > summary").click();
  await page.locator("#choice-first_mail").selectOption({ label: "fail (permanent)" });
  await page.getByRole("button", { name: "Test run", exact: true }).click();
  const steps = page.locator(".a7-test .steps > li");
  await expect(steps).toHaveCount(2, { timeout: 30_000 });
  await expect(steps.nth(0)).toContainText("skipped first_mail");
  await expect(steps.nth(0)).toContainText("This step failed, so the run skipped it and carried on.");
  await expect(steps.nth(1)).toContainText("succeeded second_mail");
});
