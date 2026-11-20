import { expect, test } from "@playwright/test";

const control = (slackMember: boolean) => fetch(`${process.env.E2E_PROVIDERS_URL}/__control`, { method: "POST", body: JSON.stringify({ slackMember }) });

// N10b: Ask what happened, on the run page (N4g moved it off #/ai). A request whose Slack note fails is the cheapest problem request with a reference.
test("an owner asks why a request stopped and only reads, nothing in the card changes the request", async ({ page, context }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account instead" }).click();
  await page.getByLabel("Email").fill(`ask-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();

  await page.getByRole("link", { name: "Apps" }).first().click();
  await page.getByRole("button", { name: "Connect Slack" }).click();
  // This installation has a Slack app (decision 0061), so the pasted token is under Advanced.
  await page.getByText("Advanced: use your own Slack app token").click();
  await page.getByLabel("Bot token").fill(process.env.E2E_SLACK_TOKEN!);
  await page.getByRole("button", { name: "Save token" }).click();
  await page.getByRole("button", { name: "Pick a channel" }).click();
  await page.getByLabel("Channel", { exact: true }).selectOption({ label: "#office-requests" });
  await page.getByRole("button", { name: "Save channel" }).click();
  await expect(page.getByText("Notes go to #office-requests.")).toBeVisible();

  await page.getByRole("link", { name: "New automation" }).first().click();
  await page.getByRole("link", { name: "Try the preview" }).click();
  await page.getByRole("button", { name: "Use this template" }).click();
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

    const row = page.getByRole("complementary", { name: "Selected request" });
    await expect(async () => {
      await page.getByRole("button", { name: "Refresh" }).click();
      await expect(row).toContainText("Slack note: The Slack app is not in that channel", { timeout: 1000 });
    }).toPass({ timeout: 30_000 });

    // Activity row link, then the run page region (decision 0049): no typing, the run's reference is loaded.
    await page.goto("/#/activity");
    // Semgrep: built from a test-made reference, not user input.
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    await page.getByRole("row", { name: new RegExp(reference) }).getByRole("link", { name: "Ask what happened" }).click();
    await expect(page).toHaveURL(/#\/runs\/[0-9a-f-]{36}\/ask$/);
    const card = page.getByRole("region", { name: "Ask what happened" });
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
