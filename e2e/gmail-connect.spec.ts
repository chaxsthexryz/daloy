import { expect, test } from "@playwright/test";

// Decision 0063: Connect Gmail with Google, against the fake Google OAuth app and the fake Gmail API in e2e/global-setup.ts.
const control = async () => (await (await fetch(`${process.env.E2E_PROVIDERS_URL}/__control`)).json()) as { gmailMessages: { user: string; raw: string }[] };

test("an owner connects Gmail with Google, sends a test email through the Gmail API and disconnects", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`gmail-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Apps" }).first().click();
  await page.getByRole("button", { name: "Connect Gmail", exact: true }).click();
  await expect(page.getByText("Advanced: use a key or token instead")).toBeVisible();
  await expect(page.getByText("Daloy cannot read your mail.")).toBeVisible();
  // The fake consent page answers at once and sends the browser back through the shared callback.
  await page.getByRole("button", { name: "Connect Gmail with Google" }).click();
  await expect(page).toHaveURL(/#\/apps\/gmail-connected$/);
  await expect(page.getByText("Gmail is connected.")).toBeVisible();
  await expect(page.getByText("Sending from this address")).toBeVisible();
  await expect(page.locator("strong", { hasText: "owner@clinic-e2e.example" })).toBeVisible();

  // Google confirmed the address, so there is no confirmation link: the test email goes to the owner's own address.
  const before = (await control()).gmailMessages.length;
  await page.getByRole("button", { name: "Send a test email to me" }).click();
  await expect(page.getByText("Google accepted a test email to owner@clinic-e2e.example")).toBeVisible();
  const sent = (await control()).gmailMessages;
  expect(sent).toHaveLength(before + 1);
  expect(sent.at(-1)!.raw).toContain("To: owner@clinic-e2e.example");
  expect(sent.at(-1)!.raw).not.toContain("verify-sender");

  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("button", { name: "Connect Gmail with Google" })).toBeVisible();
  await expect(page.getByText("Mail from your automations is paused until you reconnect Gmail.")).toBeVisible();
  await page.getByRole("button", { name: "Use the local mail server instead" }).click();
  await expect(page.getByText("this installation's mail server")).toBeVisible();
});
