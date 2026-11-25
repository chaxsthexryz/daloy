import { expect, test } from "@playwright/test";
import { addStep } from "./editor-steps";

// R2b: the setup guide, a sample test that goes out of date on an edit, the failing example, and the Turn on summary.
test("try a sample, see it go out of date, then turn on from the summary", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`r2b-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.goto("/#/new");
  await page.getByLabel("Name").fill("Guide check");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Guide check", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "List", exact: true }).click();
  await addStep(page, "approval");
  // The guide and the sample test show in the panel's overview, with no step selected (U2).
  const close = page.locator(".a7-panel").getByRole("button", { name: "Close", exact: true });
  await close.click();

  const guide = page.getByRole("region", { name: "Setup guide" });
  await expect(guide).toContainText("Try a sample");
  const sample = page.getByRole("region", { name: "Try a sample" });
  await expect(sample).toContainText("No sample test yet.");
  await expect(sample).toContainText("Every step has what it needs.");

  await sample.getByRole("button", { name: "Try a sample" }).click();
  await expect(sample).toContainText("The last sample test passed.", { timeout: 30_000 });
  await expect(sample.locator(".badge").first()).toBeVisible();

  // Adding a step changes the draft, so the old result is out of date.
  await page.getByRole("button", { name: /^approval_1 / }).click();
  await addStep(page, "email", { after: "approval_1", branch: "approved" });
  await close.click();
  await expect(sample).toContainText("Out of date");

  // The failing example removes the email's recipient from a copy; the real draft keeps passing its checks.
  await sample.getByRole("button", { name: "Show a failing example" }).click();
  await expect(sample).toContainText("Gmail, Send email has no recipient.");
  await expect(sample).toContainText("Every step has what it needs.");

  // Explain this flow reads from the draft.
  await page.getByRole("button", { name: "Explain this flow" }).click();
  const explain = page.getByRole("dialog", { name: "Explain this flow" });
  await expect(explain).toContainText("Starts when");
  await expect(explain).toContainText("Send email");
  await explain.getByRole("button", { name: "Got it" }).click();

  // Turn on shows the apps, recipients and sample test, and waits for the owner.
  await page.getByRole("button", { name: "Publish" }).click();
  const turnOn = page.getByRole("dialog", { name: "Turn on this automation" });
  await expect(turnOn).toContainText("Who gets what");
  await expect(turnOn).toContainText("Out of date");
  await turnOn.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".a7-chip")).toHaveText("Draft");
});

test("Booking with a GCash or QR Ph deposit omits PayMongo, adds a resource inline, and flags SMS plan blockers", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`preflight-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();

  await page.goto("/#/new");
  await page.getByRole("button", { name: "Use this: Booking with a GCash or QR Ph deposit" }).click();
  await expect(page).toHaveURL(/#\/w\/[^/]+$/);

  await expect(page.getByText(/Left: connect PayMongo/)).toHaveCount(0);
  const sample = page.getByRole("region", { name: "Try a sample" });
  await expect(sample).toContainText("Add at least one room or resource");
  await expect(sample).not.toContainText("Every step has what it needs.");
  await expect(sample.getByRole("button", { name: "Try a sample" })).toBeDisabled();

  // Create a room inline and verify Try a sample becomes enabled and passes.
  await sample.getByLabel("Add a room or resource").fill("Deluxe Room");
  await sample.getByRole("button", { name: "Add", exact: true }).click();
  await expect(sample).toContainText("Every step has what it needs.", { timeout: 15_000 });
  await sample.getByRole("button", { name: "Try a sample" }).click();
  await expect(sample).toContainText("The last sample test passed.", { timeout: 30_000 });

  // Simulate Preview plan (0 SMS) on GET /usage and verify Publish > Turn on blocks with a clear reason.
  await page.route("**/usage", async (route) => {
    const res = await route.fetch();
    const json = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...json, plan: "preview", label: "Preview", sms: { used: 0, limit: 0, resetsOn: "2026-12-01" } }) });
  });
  await page.reload();
  await expect(sample).toContainText("SMS sending is not included on the Preview plan");
  await page.getByRole("button", { name: "Publish" }).click();
  const turnOn = page.getByRole("dialog", { name: "Turn on this automation" });
  await expect(turnOn).toContainText("SMS sending is not included on the Preview plan");
  await expect(turnOn.getByRole("button", { name: "Turn on", exact: true })).toBeDisabled();
});
