import { appendFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

function deliver(subject: string, text: string) {
  const message = [
    "From: Website <website@example.test>",
    "Reply-To: maya@example.test",
    "To: inquiries@example.test",
    `Subject: ${subject}`,
    `Message-ID: <${subject.replaceAll(" ", "-")}@example.test>`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    text,
  ].join("\r\n");
  appendFileSync(process.env.E2E_IMAP_MAIL_FILE!, JSON.stringify(message) + "\n");
}

test("the owner connects an inbox and a new website inquiry creates one live run", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account instead" }).click();
  await page.getByLabel("Email").fill(`email-in-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("email inquiry test password");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.goto("/#/new");
  await page.getByLabel("Name").fill("Website inbox");
  await page.getByRole("button", { name: "Create and open editor" }).click();
  await expect(page.getByRole("heading", { name: "Website inbox" })).toBeVisible();
  const workflowId = new URL(page.url()).hash.split("/")[2]!;

  deliver("Older inquiry", "Already in the inbox before it was connected.");
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.getByRole("button", { name: "Trigger: manual" }).click();
  await page.getByLabel("Starts when").selectOption("email");
  await page.getByLabel("IMAP host").fill("imap.office.example");
  await page.getByLabel("Mailbox username").fill("inquiries@example.test");
  await page.getByLabel("Mailbox app password").fill("fixture-inbox-password");
  await page.getByRole("button", { name: "Connect mailbox" }).click();
  await expect(page.getByText(/^Mailbox checked\./)).toBeVisible({ timeout: 30_000 });
  deliver("Inquiry while setting up", "Delivered after checking the account and before publishing.");

  await page.getByLabel("Add a step as the first step").selectOption("condition");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("Value", { exact: true }).fill("{{trigger.subject}}");
  await page.getByLabel("Operator").selectOption("exists");
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText(/Version \d+ is live/)).toBeVisible();
  await page.getByRole("button", { name: "Trigger: email" }).click();
  await expect(page.getByText("Listening for new mail", { exact: true })).toBeVisible({ timeout: 30_000 });
  deliver("New website inquiry", "Could we book an appointment on Friday?");

  type InboxRun = { id: string; state: string; triggerPayload: { subject: string; text: string } };
  const inboxRuns = async () => {
    const result = await page.request.get(`/runs?workflowId=${workflowId}&test=false`);
    expect(result.ok()).toBeTruthy();
    return (await result.json()) as InboxRun[];
  };
  await expect
    .poll(async () => (await inboxRuns()).map((run) => [run.state, run.triggerPayload.subject]), { timeout: 30_000 })
    .toEqual([["succeeded", "New website inquiry"]]);
  const [inquiry] = await inboxRuns();
  expect(inquiry!.triggerPayload.text).toContain("Could we book an appointment on Friday?");
  await page.goto(`/#/runs/${inquiry!.id}`);
  await expect(page.getByRole("heading", { name: "What happened", exact: true })).toBeVisible();
  await page.getByText("Details for a technician").click();
  await expect(page.getByLabel("Trigger data")).toContainText("maya@example.test");
});
