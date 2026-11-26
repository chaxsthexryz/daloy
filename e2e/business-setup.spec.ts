import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const decodeQp = (s: string) => s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
const mail = () => readFileSync(process.env.E2E_MAIL_FILE!, "utf8").split("\n").filter(Boolean).map((l) => decodeQp(JSON.parse(l) as string));

// Roadmap phase 2, local path: the owner saves their business details, tests email, turns on inquiry replies and
// submits an inquiry as a customer without opening the editor. Mail goes to the e2e SMTP sink, never to Gmail.
test("an owner sets up inquiry replies and a customer's inquiry reaches both inboxes", async ({ page, context }) => {
  // Publish, Run live version and Disconnect ask first (N4a); accept each.
  page.on("dialog", (d) => void d.accept());
  const stamp = Date.now();
  const owner = `owner-${stamp}@test.local`;
  const inbox = `front-${stamp}@clinic.test`;
  const customer = `rosa-${stamp}@example.com`;
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(owner);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();

  await page.getByRole("link", { name: "New automation" }).first().click();
  await page.getByRole("link", { name: "Set up inquiry replies" }).click();
  await expect(page.getByRole("heading", { name: "Business", level: 1 })).toBeVisible();
  await expect(page.getByText("Save a business name and an inbox for new inquiries above first.")).toBeVisible();
  await page.getByLabel("Business name").fill("Lim Dental");
  await page.getByLabel("Website", { exact: true }).fill("https://limdental.example");
  await page.getByLabel("Inbox for new inquiries").fill(inbox);
  await page.getByRole("button", { name: "Save business details" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  // Connecting Gmail (on Apps) sends nothing; disconnecting pauses mail until the owner picks the local server again.
  await page.getByRole("link", { name: "Business" }).first().click(); await page.getByRole("navigation", { name: "Business" }).getByRole("link", { name: "Apps", exact: true }).click();
  await page.getByRole("button", { name: "Connect Gmail" }).click();
  // The e2e stack has a Google client, so the app password form is under Advanced (decision 0063).
  await page.getByText("Advanced: use a key or token instead").click();
  await page.getByLabel("Gmail address").fill(`lim.dental.${stamp}@gmail.com`);
  await page.getByLabel("App password", { exact: true }).fill("abcd efgh ijkl mnop");
  await page.getByRole("button", { name: "Save Gmail sender" }).click();
  await expect(page.getByText("Waiting for you to confirm the test email")).toBeVisible();
  await page.getByRole("link", { name: "Business", exact: true }).first().click();
  await expect(page.getByText("Customer replies will not be sent until Gmail is confirmed and working.")).toBeVisible();
  await page.getByRole("link", { name: "Business" }).first().click(); await page.getByRole("navigation", { name: "Business" }).getByRole("link", { name: "Apps", exact: true }).click();
  await page.getByRole("button", { name: "Manage Gmail" }).click();
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByText("Mail from your automations is paused until you reconnect Gmail.")).toBeVisible();
  await page.getByRole("button", { name: "Use the local mail server instead" }).click();
  await expect(page.getByText("this installation's mail server")).toBeVisible();

  await page.getByRole("button", { name: "Send a test email to me" }).click();
  await expect(page.getByText(`accepted a test email to ${owner}`)).toBeVisible();
  expect(mail().filter((m) => m.includes(`To: ${owner}`) && m.includes("kymavo test email"))).toHaveLength(1);
  await page.getByRole("link", { name: "Business", exact: true }).first().click();

  await expect(page.getByText(`New inquiries go to ${inbox}.`)).toBeVisible();
  await page.getByRole("button", { name: "Turn on inquiry replies" }).click();
  await expect(page.getByText("Inquiry replies are on.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy inquiry form link" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy embed code" })).toBeVisible();
  await expect(page.getByText(/send its notification emails to a folder connected to an email-in automation/)).toBeVisible();

  // The customer's side: the hosted form names the business.
  const form = await context.newPage();
  await form.goto(await page.locator("code", { hasText: "/forms/" }).innerText());
  await expect(form.getByRole("heading", { name: "Lim Dental" })).toBeVisible();
  await form.getByLabel("Your name").fill("Rosa Diaz");
  await form.getByLabel("Your email").fill(customer);
  await form.getByLabel("How can we help?").fill("Do you open on Saturdays?");
  await form.getByRole("button", { name: "Send" }).click();
  await expect(form.getByText("Thanks, we received your message.")).toBeVisible();

  await expect(() => {
    const sent = mail();
    expect(sent.filter((m) => m.includes(`To: ${customer}`) && m.includes("Thanks for contacting Lim Dental"))).toHaveLength(1);
    expect(sent.filter((m) => m.includes(`To: ${inbox}`) && m.includes("Do you open on Saturdays?") && m.includes(customer))).toHaveLength(1);
  }).toPass({ timeout: 30_000 });
  // From carries the business name over the installation's address.
  expect(mail().find((m) => m.includes(`To: ${customer}`))).toContain("From: Lim Dental <daloy@localhost>");
});
