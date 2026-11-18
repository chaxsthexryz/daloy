import { readFileSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, test, type Page } from "@playwright/test";

const OLD = "e2e test password 1";
const NEW = "e2e brand new password 2";

// Quoted-printable, as nodemailer sends long lines: drop soft line breaks and decode =XX.
const decodeQp = (s: string) => s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

/** Waits for the password reset email to `to` in the SMTP sink and returns the link in it. */
async function resetLink(to: string): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const messages = readFileSync(process.env.E2E_MAIL_FILE!, "utf8").split("\n").filter(Boolean).map((l) => decodeQp(JSON.parse(l) as string));
    const link = messages.filter((m) => m.includes(to)).map((m) => /http:\/\/localhost:\d+\/#\/reset-password\/[A-Za-z0-9_-]{43}/.exec(m)?.[0]).find(Boolean);
    if (link) return link;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no reset email to ${to}`);
}

async function register(page: Page, email: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account instead" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(OLD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
}

async function signIn(page: Page, email: string, password: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("forgot password: the emailed link sets a new password and the old one stops working", async ({ page }) => {
  const email = `forgot-${Date.now()}@test.local`;
  await register(page, email);
  await page.getByRole("button", { name: "Sign out" }).click();

  await page.getByRole("link", { name: "Forgot your password?" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send link" }).click();
  await expect(page.getByRole("status")).toContainText("If an account exists for that email, we sent a link");

  await page.goto(await resetLink(email));
  await page.getByLabel(/New password/).fill(NEW);
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByRole("status")).toHaveText("Password changed. Sign in with your new password.");
  await page.getByRole("link", { name: "Sign in" }).click();

  await signIn(page, email, OLD);
  await expect(page.getByRole("alert")).not.toBeEmpty();
  await signIn(page, email, NEW);
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
});

test("change password from the account page, then sign in with the new one", async ({ page }) => {
  const email = `change-${Date.now()}@test.local`;
  await register(page, email);
  await page.getByRole("link", { name: "Account", exact: true }).click();
  await page.getByLabel("Current password").fill(OLD);
  await page.getByLabel(/New password/).fill(NEW);
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByRole("status")).toHaveText("Password changed. Your other sessions are signed out.");

  await page.getByRole("button", { name: "Sign out" }).click();
  await signIn(page, email, NEW);
  // Sign-in keeps the address, so this lands on the account page again.
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});

test("a read-only token shows its scope and expiry and only reaches the read tools", async ({ page }) => {
  await register(page, `scopes-${Date.now()}@test.local`);
  // A published form workflow would be a tool for a token with the "run" scope; this one must not see it.
  const wf = await (await page.request.post("/workflows", { data: { name: "Contact form", slug: `contact-${Date.now()}` } })).json();
  const definition = {
    trigger: { type: "form", config: { fields: [{ name: "email", label: "Email", type: "email", required: true }] } },
    steps: [{ id: "pause", type: "delay", config: { seconds: 1 } }],
    edges: [],
  };
  expect((await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition, publish: true } })).status()).toBe(201);

  await page.goto("/#/tokens");
  await page.getByLabel("Name").fill("read only");
  await page.getByLabel("Start workflows").uncheck();
  await page.getByRole("button", { name: "Create token" }).click();
  await expect(page.getByRole("status")).toContainText("Access: Read runs and bookings. Expires ");
  await expect(page.getByRole("status")).not.toContainText("Never expires");
  await expect(page.getByRole("row", { name: /read only/ })).toContainText("Read runs and bookings");
  const token = (await page.getByLabel("New token").textContent())!.trim();

  const client = new Client({ name: "e2e", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:3100/mcp"), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(["get_run_status", "list_bookings"]);
  await client.close();
});
