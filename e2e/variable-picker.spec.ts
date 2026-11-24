import { expect, test } from "@playwright/test";

// E3: the variable picker puts a reference at the cursor of the focused text field, offers only upstream data, and shows sample output from the last test.
test("click a variable to insert it at the cursor, upstream only, with a preview from the last test, on desktop and phone", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`e3-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
  const wf = await (await page.request.post("/workflows", { data: { name: "Picker", slug: `picker-${Date.now()}` } })).json();
  const definition = {
    trigger: { type: "form", config: { fields: [{ name: "email", label: "Email", type: "email", required: true }, { name: "note", label: "Note", type: "text", required: true }] } },
    steps: [
      { id: "read", type: "ai", config: { task: "extract", input: "{{trigger.note}}", fields: { amount: "Total", store: "Store name" } } },
      { id: "check", type: "condition", config: { condition: { left: "{{steps.read.output.amount}}", op: "gt", right: 100 } } },
      { id: "mail", type: "email", config: { to: "{{trigger.email}}", subject: "Hello !", text: "Hi" } },
      { id: "other", type: "email", config: { to: "x@example.com", subject: "Other", text: "Hi" } },
    ],
    edges: [
      { from: "read", to: "check" },
      { from: "check", to: "mail", on: "true" },
      { from: "check", to: "other", on: "false" },
    ],
  };
  const saved = await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition, publish: false } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/#/w/${wf.id}`);
  await page.locator('.react-flow__node[data-id="mail"]').click();

  const picker = page.getByRole("region", { name: "Insert data from earlier steps" });
  // Only data that can exist before this step: the trigger and "read" (and "check"), not the sibling "other" or this step.
  await expect(picker.getByRole("group", { name: "From the trigger" })).toBeVisible();
  await expect(picker.getByRole("group", { name: "From read" })).toBeVisible();
  await expect(picker.getByRole("group", { name: "From other" })).toHaveCount(0);
  await expect(picker.getByRole("group", { name: "From mail" })).toHaveCount(0);
  await expect(picker).toContainText("{{secrets.name}}");

  // At the cursor: between "Hello " and "!".
  const subject = page.getByLabel("Subject");
  await subject.click();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await picker.getByRole("button", { name: "Insert {{steps.read.output.amount}}" }).click();
  await expect(subject).toHaveValue("Hello {{steps.read.output.amount}}!");
  await expect(picker.getByRole("status")).toContainText("Inserted {{steps.read.output.amount}} into Subject");

  // Keyboard: the last field stays the target, so focusing a chip and pressing Enter inserts there.
  const text = page.getByLabel("Message");
  await text.click();
  await picker.getByRole("button", { name: "Insert {{trigger.email}}" }).focus();
  await page.keyboard.press("Enter");
  await expect(text).toHaveValue(/\{\{trigger\.email\}\}/);

  // The last test's sample output shows next to each earlier step's fields.
  await page.getByRole("region", { name: "Test this step" }).getByRole("button", { name: "Test this step" }).click();
  await expect(picker.getByRole("group", { name: "From read" }).locator(".a7-var-preview").first()).toBeVisible({ timeout: 30_000 });

  // The phone sheet works the same way.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload();
  await page.getByRole("button", { name: /^mail / }).click();
  const sheet = page.getByRole("dialog", { name: "Edit step" });
  await sheet.getByLabel("Subject").click();
  await sheet.getByRole("button", { name: "Insert {{trigger.note}}" }).click();
  await expect(sheet.getByLabel("Subject")).toHaveValue(/\{\{trigger\.note\}\}/);
});
