import { expect, test } from "@playwright/test";

// U3: turn a step off from its right-click menu. The node goes grey, a saved draft keeps it off, and a mocked test run
// records it as skipped and carries on to the next step (decision 0097).
test("disable a step: greyed node, kept on save, skipped in a test run, then enabled again", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`u3-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  const wf = await (await page.request.post("/workflows", { data: { name: "Three emails", slug: `three-${Date.now()}` } })).json();
  const mail = (to: string) => ({ to, subject: "Hello", text: "Hi" });
  const definition = {
    trigger: { type: "manual", config: {} },
    steps: [
      { id: "check", type: "condition", config: { condition: { left: "1", op: "eq", right: "1" } } },
      { id: "first_mail", type: "email", config: mail("first@example.com") },
      { id: "second_mail", type: "email", config: mail("second@example.com") },
      { id: "third_mail", type: "email", config: mail("third@example.com") },
    ],
    edges: [
      { from: "check", to: "first_mail", on: "true" },
      { from: "first_mail", to: "second_mail" },
      { from: "second_mail", to: "third_mail" },
    ],
  };
  expect((await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition, publish: false } })).ok()).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/#/w/${wf.id}`);
  await expect(page.getByRole("heading", { name: "Three emails", level: 1 })).toBeVisible();
  const explain = page.getByRole("dialog", { name: "Explain this flow" });
  if (await explain.isVisible()) await explain.getByRole("button", { name: "Got it" }).click();
  await page.getByRole("button", { name: "Diagram", exact: true }).click();

  const node = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
  const menu = (id: string) => page.getByRole("menu", { name: `Actions for ${id}` });

  // A branching step has no Disable item: a skipped step would have no branch to follow.
  await node("check").click({ button: "right" });
  await expect(menu("check").getByRole("menuitem", { name: "Disable" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await node("second_mail").click({ button: "right" });
  await menu("second_mail").getByRole("menuitem", { name: "Disable" }).click();
  await expect(page.locator(".a7-note")).toHaveText("Turned off second_mail. Runs skip it and go on to the next step.");
  await expect(node("second_mail").locator(".node")).toHaveClass(/node-off/);
  await expect(node("second_mail")).toContainText("Turned off");
  await expect(node("second_mail")).toHaveAttribute("aria-label", /, turned off$/);

  // Saved and reloaded, the step is still off.
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".a7-chip")).toHaveText("Draft");
  await page.reload();
  await page.getByRole("button", { name: "Diagram", exact: true }).click();
  await expect(node("second_mail").locator(".node")).toHaveClass(/node-off/);

  // The mocked test skips it and sends the step after it.
  await page.getByRole("button", { name: "Test run", exact: true }).click();
  const steps = page.locator(".a7-test .steps > li");
  await expect(steps).toHaveCount(4, { timeout: 30_000 });
  await expect(steps.nth(2)).toContainText("skipped second_mail");
  await expect(steps.nth(2)).toContainText("Skipped: This step is turned off in the editor.");
  await expect(steps.nth(3)).toContainText("succeeded third_mail");
  await expect(node("second_mail")).toContainText("Skipped");

  // Enable turns it back on.
  await node("second_mail").click({ button: "right" });
  await menu("second_mail").getByRole("menuitem", { name: "Enable" }).click();
  await expect(node("second_mail").locator(".node")).not.toHaveClass(/node-off/);
});
