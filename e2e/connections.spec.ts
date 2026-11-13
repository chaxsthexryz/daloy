import { expect, test } from "@playwright/test";

// Roadmap phase 3: connect Google Sheets and Slack (fakes from e2e/global-setup.ts), send office requests to both, and
// retry only the Slack note when Slack fails after the sheet row went in.
const control = async (body?: { slackMember: boolean }) => {
  const res = await fetch(`${process.env.E2E_PROVIDERS_URL}/__control`, body ? { method: "POST", body: JSON.stringify(body) } : {});
  return (await res.json()) as { sheetRows: number; slackMessages: string[] };
};

test("an owner connects Sheets and Slack, and retries only the Slack note that failed", async ({ page, context }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account instead" }).click();
  await page.getByLabel("Email").fill(`lim-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();

  // Connections on the Business and email page.
  await page.getByRole("link", { name: "Business and email" }).first().click();
  await page.getByLabel("Service account key file (JSON)").fill(process.env.E2E_SHEETS_KEY!);
  await expect(page.getByText("Share the sheet with daloy-e2e@office-demo.iam.gserviceaccount.com as an Editor.")).toBeVisible();
  await page.getByLabel("Sheet link").fill("https://docs.google.com/spreadsheets/d/e2e-sheet-0000000001/edit");
  await page.getByLabel("Tab name").fill("Requests");
  await page.getByRole("button", { name: "Connect Google Sheets" }).click();
  await expect(page.getByText("Rows go to Office requests, tab Requests.")).toBeVisible();
  const rowsBefore = (await control()).sheetRows;
  await page.getByRole("button", { name: "Add a test row" }).click();
  await expect(page.getByText(/Google Sheets accepted a test row/)).toBeVisible();
  expect((await control()).sheetRows).toBe(rowsBefore + 1);

  await page.getByLabel("Bot token").fill(process.env.E2E_SLACK_TOKEN!);
  await page.getByRole("button", { name: "Connect Slack" }).click();
  await page.getByRole("button", { name: "Pick a channel" }).click();
  await page.getByLabel("Channel").selectOption({ label: "#office-requests" });
  await page.getByRole("button", { name: "Save channel" }).click();
  await expect(page.getByText("Notes go to #office-requests.")).toBeVisible();
  await page.getByRole("button", { name: "Send a test message" }).click();
  await expect(page.getByText(/Slack accepted a test message/)).toBeVisible();

  // An office request that also goes to both.
  await page.getByRole("link", { name: "Home" }).click();
  await page.getByRole("link", { name: "Try an example" }).click();
  await page.getByRole("button", { name: "Set up for my office" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByLabel("A row in your Google Sheet").check();
  await page.getByLabel(/A short note in your Slack channel/).check();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Post the reference and subject to your Slack channel.")).toBeVisible();
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByRole("status")).toContainText("Accepting requests");

  // Slack fails (the app was removed from the channel). The sheet row still goes in.
  await control({ slackMember: false });
  const before = await control();
  const form = await context.newPage();
  await form.goto(await page.locator("code").innerText());
  await form.getByLabel("Your name").fill("Rosa Diaz");
  await form.getByLabel("Your email").fill("rosa@test.local");
  await form.getByLabel("What needs attention?").fill("The aircon in room 3 drips.");
  await form.getByRole("button", { name: "Send" }).click();
  await expect(form.getByRole("heading", { name: "Request received" })).toBeVisible();

  const row = page.locator("tbody tr").first();
  await expect(async () => {
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(row).toContainText("Sheet row: added", { timeout: 1000 });
    await expect(row).toContainText("Slack note: The Slack app is not in that channel", { timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  expect((await control()).sheetRows).toBe(before.sheetRows + 1);

  // The owner adds the app back and retries the Slack note alone.
  await control({ slackMember: true });
  await row.getByRole("button", { name: "Retry" }).click();
  await expect(async () => {
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(row).toContainText("Slack note: posted", { timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  const after = await control();
  expect(after.sheetRows).toBe(before.sheetRows + 1);
  expect(after.slackMessages.filter((m) => m.includes("The aircon in room 3 drips."))).toHaveLength(1);
});
