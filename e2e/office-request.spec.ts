import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const decodeQp = (s: string) => s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
const mail = () => readFileSync(process.env.E2E_MAIL_FILE!, "utf8").split("\n").filter(Boolean).map((l) => decodeQp(JSON.parse(l) as string));

// Roadmap phase 1: preview, leave a draft, resume, turn on, submit the form (double-click) and find one request and its receipt.
test("a beginner previews, sets up, turns on and receives one office request", async ({ page, context }) => {
  const staff = `staff-${Date.now()}@test.local`;
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account instead" }).click();
  await page.getByLabel("Email").fill(`ana-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();

  // Preview: worked out in the browser, so nothing is recorded or sent.
  await page.getByRole("link", { name: "New automation" }).first().click();
  await page.getByRole("link", { name: "Try an example" }).click();
  await expect(page.getByRole("heading", { name: "Preview only", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Try with sample details" }).click();
  const preview = page.getByRole("region", { name: "Preview result" });
  await expect(preview).toContainText("Sample reference: REQ-SAMPLE");
  await expect(preview).toContainText("We received your request REQ-SAMPLE");

  // Setup: two steps, then leave and come back to the same step.
  await page.getByRole("button", { name: "Set up for my office" }).click();
  await expect(page.getByLabel("Automation name")).toHaveValue("Office requests");
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("heading", { name: "Fields staff fill in" })).toBeVisible();
  await page.getByLabel("Anything else we should know?").check();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("heading", { name: "Where requests and alerts go" })).toBeVisible();
  await page.getByRole("button", { name: "Save and finish later" }).click();
  await page.locator("summary", { hasText: "Drafts (1)" }).click();
  await page.getByRole("link", { name: "Office requests: continue setup" }).click();
  await expect(page.getByRole("heading", { name: "Where requests and alerts go" })).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
  await expect(page.getByText("Ask for name, email, what needs attention, where it is, anything else.")).toBeVisible();
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByRole("status")).toContainText("Accepting requests");
  await expect(page.getByText("No requests yet.")).toBeVisible();

  // The employee's side: a double-click on Send still gives one request.
  const form = await context.newPage();
  await form.goto(await page.locator("code").innerText());
  await form.getByLabel("Your name").fill("Rosa Diaz");
  await form.getByLabel("Your email").fill(staff);
  await form.getByLabel("What needs attention?").fill("The printer on floor 2 is jammed.");
  await form.getByRole("button", { name: "Send" }).dblclick();
  await expect(form.getByRole("heading", { name: "Request received" })).toBeVisible();
  const reference = /REQ-[0-9A-Z]{6}/.exec(await form.locator("strong").innerText())![0];

  const rows = page.locator("tbody tr");
  await expect(async () => {
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Processed", { timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await expect(rows.first()).toContainText(reference);

  // The office notification mentions the staff address too, so pick the receipt by its subject.
  const receipts = mail().filter((m) => m.includes(`To: ${staff}`) && m.includes("We received your request"));
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toContain(`Your reference is ${reference}`);
  expect(mail().some((m) => m.includes("REQ-SAMPLE"))).toBe(false);

  // One automation, three tabs (N4e): Overview, Activity and Steps.
  const tabs = page.getByRole("navigation", { name: "This automation" });
  await tabs.getByRole("link", { name: "Activity" }).click();
  await expect(tabs.getByRole("link", { name: "Activity" })).toHaveAttribute("aria-current", "page");
  await tabs.getByRole("link", { name: "Steps" }).click();
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await tabs.getByRole("link", { name: "Overview" }).click();
  await expect(page.getByRole("status")).toContainText("Accepting requests");

  // On a phone, from Home: the bottom bar's Activity, the reference typed in, and its run (three taps).
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/#/");
  await page.getByRole("navigation", { name: "Quick" }).getByRole("link", { name: "Activity" }).click();
  await page.getByLabel("Find a request or automation").fill(reference);
  const found = page.locator("tbody tr");
  await expect(found).toHaveCount(1);
  await expect(found).toContainText(reference);
  await found.getByRole("link").click();
  await expect(page.getByRole("heading", { name: "What happened" })).toBeVisible();
});
