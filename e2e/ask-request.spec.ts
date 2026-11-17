import { expect, test } from "@playwright/test";

const control = (slackMember: boolean) => fetch(`${process.env.E2E_PROVIDERS_URL}/__control`, { method: "POST", body: JSON.stringify({ slackMember }) });

// N10b: Ask about a request. A request whose Slack note fails is the cheapest problem request with a reference.
test("an owner asks why a request stopped and only reads, nothing in the card changes the request", async ({ page, context }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account instead" }).click();
  await page.getByLabel("Email").fill(`ask-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();

  await page.getByRole("link", { name: "Apps" }).first().click();
  await page.getByRole("button", { name: "Connect Slack" }).click();
  await page.getByLabel("Bot token").fill(process.env.E2E_SLACK_TOKEN!);
  await page.getByRole("button", { name: "Connect Slack" }).click();
  await page.getByRole("button", { name: "Pick a channel" }).click();
  await page.getByLabel("Channel", { exact: true }).selectOption({ label: "#office-requests" });
  await page.getByRole("button", { name: "Save channel" }).click();
  await expect(page.getByText("Notes go to #office-requests.")).toBeVisible();

  await page.getByRole("link", { name: "New automation" }).first().click();
  await page.getByRole("link", { name: "Try an example" }).click();
  await page.getByRole("button", { name: "Set up for my office" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("heading", { name: "Where requests and alerts go" })).toBeVisible();
  await page.getByLabel(/A short note in your Slack channel/).check();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByRole("status")).toContainText("Accepting requests");

  await control(false);
  try {
    const form = await context.newPage();
    await form.goto(await page.locator("code").innerText());
    await form.getByLabel("Your name").fill("Rosa Diaz");
    await form.getByLabel("Your email").fill("rosa@test.local");
    await form.getByLabel("What needs attention?").fill("The lights in room 4 flicker.");
    await form.getByRole("button", { name: "Send" }).click();
    await expect(form.getByRole("heading", { name: "Request received" })).toBeVisible();
    const reference = /REQ-[0-9A-Z]{6}/.exec(await form.locator("strong").innerText())![0];

    const row = page.locator("tbody tr").first();
    await expect(async () => {
      await page.getByRole("button", { name: "Refresh" }).click();
      await expect(row).toContainText("Slack note: The Slack app is not in that channel", { timeout: 1000 });
    }).toPass({ timeout: 30_000 });

    await page.goto("/#/ai");
    const card = page.getByRole("region", { name: "Ask about a request" });
    await card.getByRole("button", { name: new RegExp(reference) }).click();
    await card.getByRole("button", { name: "Why did it stop?" }).click();
    await expect(card.locator("strong").first()).not.toHaveText("");
    await expect(card.getByRole("link", { name: "Open this request" })).toHaveAttribute("href", /#\/runs\/[0-9a-f-]{36}$/);
    await card.getByRole("button", { name: "What happened?" }).click();
    await expect(card.locator("strong").first()).not.toHaveText("");
    await expect(card.getByRole("button", { name: /^(Retry|Approve|Send again|Post again|Mark as posted)/ })).toHaveCount(0);
  } finally {
    await control(true);
  }
});
