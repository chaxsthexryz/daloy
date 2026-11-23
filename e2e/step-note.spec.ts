import { expect, test } from "@playwright/test";

// T4: the owner writes a note on a step in its panel. The note shows under the step title on the canvas card and stays after a save.
test("step note: typed in the panel, shown on the card, kept on save", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`t4-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
  const wf = await (await page.request.post("/workflows", { data: { name: "Noted flow", slug: `noted-${Date.now()}` } })).json();
  const definition = {
    trigger: { type: "manual", config: {} },
    steps: [{ id: "thank_you", type: "email", config: { to: "ana@example.com", subject: "Hello", text: "Hi" } }],
    edges: [],
  };
  expect((await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition, publish: false } })).ok()).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/#/w/${wf.id}`);
  await expect(page.getByRole("heading", { name: "Noted flow", level: 1 })).toBeVisible();

  const node = page.locator('.react-flow__node[data-id="thank_you"]');
  await node.click();
  const note = page.getByLabel("Note", { exact: true });
  await note.fill("Only for customers who paid");
  await expect(page.locator("#step-note-count")).toHaveText("27 of 300 characters. Shown on the step and in Explain this flow.");
  await expect(node.locator(".node-note")).toHaveText("Only for customers who paid");

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".a7-chip")).toHaveText("Draft");
  await page.reload();
  await expect(node.locator(".node-note")).toHaveText("Only for customers who paid");
});
