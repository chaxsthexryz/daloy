import { expect, test } from "@playwright/test";
import { approvalLink } from "./mail";

const PASSWORD = "e2e test password 1";

// Roadmap phase 5: a Microsoft office connects Outlook (after an administrator requirement) and Teams, turns on the
// purchase request template with a named approver, and follows one request from its form to purchasing, without the
// editor. Microsoft is the fake from e2e/global-setup.ts.
type Control = { outlookMessages: { to: string; subject: string; text: string }[]; teamsPosts: string[] };
const control = async (body?: { microsoftConsent: "grant" | "admin_required" }) => {
  const res = await fetch(`${process.env.E2E_PROVIDERS_URL}/__control`, body ? { method: "POST", body: JSON.stringify(body) } : {});
  return (await res.json()) as Control;
};

test("a purchase request goes from the form to the named approver, then to purchasing by Outlook and Teams", async ({ page, context, browser }) => {
  const approver = `manager-${Date.now()}@test.local`;
  const purchasing = `purchasing-${Date.now()}@test.local`;
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account instead" }).click();
  await page.getByLabel("Email").fill(`office-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();

  // The approver joins the workspace.
  await page.getByRole("link", { name: "Team" }).click();
  await page.getByLabel("Email").fill(approver);
  await page.getByRole("button", { name: "Create invite link" }).click();
  const invite = (await page.getByLabel("Invite link").textContent())!.trim();
  const joining = await browser.newContext();
  const joinPage = await joining.newPage();
  await joinPage.goto(invite);
  await joinPage.getByLabel(/Password/).fill(PASSWORD);
  await joinPage.getByRole("button", { name: "Join" }).click();
  await expect(joinPage.getByRole("heading", { name: "My requests" })).toBeVisible();
  await joining.close();

  // Outlook: the administrator requirement is shown before leaving Daloy, and a blocked consent comes back explained.
  await page.getByRole("link", { name: "Workflows" }).click();
  await page.getByRole("link", { name: "Business and email" }).first().click();
  const panel = (name: string) => page.locator(".connection").filter({ has: page.getByRole("heading", { name, exact: true }) });
  const outlook = panel("Outlook");
  await expect(outlook).toContainText("Many organizations only let an administrator approve a new app.");
  await expect(outlook.getByRole("link", { name: "this approval link" })).toHaveAttribute("href", /adminconsent\?client_id=/);
  await control({ microsoftConsent: "admin_required" });
  await outlook.getByRole("button", { name: "Connect Outlook" }).click();
  await expect(panel("Outlook").getByRole("alert").first()).toContainText("only lets an administrator approve new apps");
  await control({ microsoftConsent: "grant" });
  await panel("Outlook").getByRole("button", { name: "Connect Outlook" }).click();
  await expect(panel("Outlook")).toContainText("Outlook is connected.");
  await expect(panel("Outlook")).toContainText("Mailbox ana@contoso.example");
  await page.getByRole("button", { name: "Send a test email to ana@contoso.example" }).click();
  await expect(page.getByText(/Outlook accepted a test email/)).toBeVisible();

  // Teams: the workflow link from Teams and the channel's name.
  await page.getByLabel("Workflow link").fill(process.env.E2E_TEAMS_URL!);
  await page.getByLabel("Teams channel name, to show in Daloy").fill("Purchasing");
  await page.getByRole("button", { name: "Connect Teams" }).click();
  await panel("Microsoft Teams").getByRole("button", { name: "Send a test message" }).click();
  await expect(page.getByText(/Teams accepted the test message/)).toBeVisible();

  // Guided setup: the approver, purchasing, Outlook and Teams.
  await page.getByRole("link", { name: "Home" }).click();
  await page.getByRole("button", { name: "Set up purchase requests" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByLabel("Who approves purchases")).toBeVisible();
  await page.getByLabel("Who approves purchases").selectOption({ label: `${approver} (approver)` });
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByLabel("Send approved requests to (purchasing)").fill(purchasing);
  await page.getByLabel("Send the emails from our Outlook mailbox").check();
  await page.getByLabel(/Post a note in our Teams channel/).check();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText(`Ask ${approver} to approve or reject it, signed in to Daloy.`)).toBeVisible();
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByRole("status")).toContainText("Accepting requests");

  // An employee submits the form and gets a reference.
  const form = await context.newPage();
  await form.goto(await page.locator("code").innerText());
  await form.getByLabel("Your name").fill("Marco Reyes");
  await form.getByLabel("Your email").fill("marco@test.local");
  await form.getByLabel("What do you want to buy?").fill("Ergonomic chair for the front desk");
  await form.getByLabel("Estimated cost").fill("PHP 8,500");
  await form.getByLabel("Why is it needed?").fill("The current chair is broken.");
  await form.getByRole("button", { name: "Send" }).click();
  await expect(form.getByRole("heading", { name: "Request received" })).toBeVisible();
  const reference = /Your reference is (\S+)\./.exec(await form.locator("body").innerText())![1]!;

  // The owner sees it waiting for the approver, with the receipt sent from Outlook.
  const row = page.locator("tbody tr").filter({ hasText: reference });
  await expect(async () => {
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(row).toContainText("Waiting for a decision", { timeout: 1000 });
    await expect(row).toContainText("Outlook email: sent to marco@test.local", { timeout: 1000 });
  }).toPass({ timeout: 30_000 });

  // The named approver signs in from the emailed link and approves.
  const link = await approvalLink(approver);
  const deciding = await browser.newContext();
  const decidePage = await deciding.newPage();
  await decidePage.goto(link);
  await decidePage.getByRole("link", { name: "Sign in" }).click();
  await decidePage.getByLabel("Email").fill(approver);
  await decidePage.getByLabel("Password").fill(PASSWORD);
  await decidePage.getByRole("button", { name: "Sign in" }).click();
  await expect(decidePage.getByText("Ergonomic chair for the front desk").first()).toBeVisible();
  await decidePage.getByRole("button", { name: "Approve" }).click();
  await expect(decidePage.getByText("Your answer (approved) is recorded.")).toBeVisible();
  await deciding.close();

  // Purchasing gets the Outlook email, the Teams channel the note, and the owner sees every delivery on the request.
  await expect(async () => {
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(row).toContainText("Finished", { timeout: 1000 });
    await expect(row).toContainText(`Outlook email: sent to ${purchasing}`, { timeout: 1000 });
    await expect(row).toContainText("Teams note: accepted by Teams", { timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  const sent = await control();
  expect(sent.outlookMessages.filter((m) => m.to === purchasing && m.subject === `Approved purchase ${reference}: Ergonomic chair for the front desk`)).toHaveLength(1);
  expect(sent.teamsPosts.filter((t) => t.includes(reference))).toEqual([`Purchase request ${reference} was approved: Ergonomic chair for the front desk\nPurchasing has the details. Decisions are made in Daloy by the named approver.`]);
  expect(page.url()).not.toContain("#/w/");
});
