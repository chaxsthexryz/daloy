import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { translate } from "../../apps/web/src/lib/locale.ts";
import { expect } from "@playwright/test";
import { makeFixtures, workflowId } from "./fixtures.mjs";

const account = "hello@bakery.example";
const stamp = "2026-11-20T01:42:00Z";
const providers = [
  ["gmail", "Gmail", null, "Google rejected the app password."],
  ["outlook", "Outlook", null, "Administrator approval needed."],
  ["google_sheets", "Google Sheets", { spreadsheetId: "sample-sheet", title: "Website inquiries", tab: "Requests" }, "Google could not find that sheet."],
  ["slack", "Slack", { channelName: "purchasing", channelId: "sample-channel" }, "Slack revoked access to this workspace."],
  ["teams", "Microsoft Teams", null, "Teams refused the workflow link."],
  ["telegram", "Telegram", { chatTitle: "Bakery team" }, "Telegram could not find the chat."],
  ["google_calendar", "Google Calendar", { title: "Daloy bookings" }, "Permission declined."],
  ["google_drive", "Google Drive", { title: "Daloy uploads" }, "Google no longer accepts access to this folder."],
  ["paymongo", "PayMongo", { mode: "test", webhookPath: "sample" }, "Webhook missing."],
  ["airtable", "Airtable", { tableName: "Customer orders" }, "Airtable rejected the token."],
  ["notion", "Notion", { databaseTitle: "New inquiries" }, "No database shared."],
  ["trello", "Trello", { listName: "Incoming" }, "Not connected."],
];
const link = "v".repeat(43);
const appsTitle = ["Apps", "Mga app"];
export function fixtures(screen) {
  const fallback = makeFixtures(screen);
  const problem = screen.problem && screen.app;
  const connections = providers.slice(1).filter(([id]) => {
    if (screen.directory && !["google_sheets", "slack", "google_calendar"].includes(id)) return false;
    return !(id === problem && ["trello", "google_calendar", "outlook"].includes(id));
  }).map(([id, , target, error]) => ({
    provider: id, account: id === "teams" ? "Purchasing" : account,
    status: id === problem ? "failed" : "active", authMethod: ["teams", "telegram", "paymongo"].includes(id) ? "token" : "oauth",
    destination: id === "notion" && id === problem ? null : id === "paymongo" && id === problem ? { ...target, webhookPending: true } : target,
    lastError: id === problem ? error : null, lastTestedAt: stamp,
  }));
  let verification = screen.verification || "ready";
  return (url, method, body) => {
    const p = url.pathname;
    if (p === "/settings/connections") return { json: {
      connections, outlook: { configured: true, adminConsentUrl: "https://example.test/approval" }, oauth: providers.map(([id]) => id.replaceAll("_", "-")),
      shared: ["google_sheets", "google_calendar"], sharedGoogleApps: { google_sheets: ["google_calendar"], google_calendar: ["google_sheets"] },
      usage: { google_sheets: [{ id: workflowId, name: "Office requests" }] }, latestPayment: null, paymongoWebhookBase: "/hooks/paymongo",
    } };
    if (p === "/settings/email") return { json: {
      profile: { businessName: "Sampaguita Bakery", website: "https://bakery.example", inquiryEmail: account, replyTo: account },
      sender: { address: account, status: problem === "gmail" ? "failed" : "active", authMethod: problem === "gmail" ? "app_password" : "oauth",
        lastError: problem === "gmail" ? providers[0][3] : null, verifiedAt: stamp, lastTestedAt: stamp },
      signInEmail: account, installationFrom: account, installationAllowed: true, installationLocal: false,
    } };
    if (p === "/settings/email/verify/status") return { json: { state: verification, address: account } };
    if (p === "/settings/email/verify" && method === "POST") {
      assert.equal(verification, "ready");
      verification = "used";
      return { json: {}, status: 200 };
    }
    if (p.endsWith("/tabs")) return { json: { tabs: ["Requests"] } };
    if (p.endsWith("/databases")) return { json: [] };
    if (p.endsWith("/test") && method === "POST") {
      if (p === "/settings/email/test") return { json: { ok: true, from: account, to: account, gmail: true } };
      return { json: problem ? { ok: false, error: providers.find(([id]) => id === problem)[3] } : { ok: true } };
    }
    if (p === "/settings/brand") return { json: { logo: false, accent: screen.problem ? null : "#13704a" } };
    if (p === "/settings/brand/logo" && method === "PUT") return { status: 400, json: { message: "The logo must be a PNG, JPEG or WebP file" } };
    if (p === "/workflows") return { json: [{ id: workflowId, slug: "website-inquiries", name: "Website inquiries" }] };
    if (p === "/workflows/" + workflowId) return { json: { trigger: { id: "public-sample" }, live: {} } };
    return fallback(url, method, body);
  };
}

function panel(id, name, problem) {
  const code = problem && (id === "outlook" ? "admin_required" : id === "google_calendar" ? "declined" : "");
  const path = code ? "apps/" + id.replaceAll("_", "-") + "-" + code : "apps";
  return {
    name: name + (problem ? " | Needs attention" : " | Connected"), app: id, problem, path,
    title: code ? [name, name] : appsTitle,
    note: problem ? "Recovery state in the sample workspace." : "Saved connection in the sample workspace.",
    async verify(page, language) {
      if (!code) await page.locator("#select-" + id).click();
      await expect(page.locator("#panel-title")).toHaveText(name);
      const testButton = {
        gmail: "Send a test email to me", outlook: "Send a test email to {email}",
        google_sheets: "Add a test row", slack: "Send a test message", teams: "Send a test message",
        telegram: "Send a test message", google_calendar: "Add a test event", paymongo: "Test",
        airtable: "Check the connection", notion: "Add a test page", trello: "Add a test card",
      }[id];
      if (!problem && testButton) {
        const action = page.locator("#app-setup").getByRole("button", { name: translate(language, testButton, { email: account }), exact: true });
        await action.click();
        await expect(page.locator("#app-setup [role=status]").filter({ hasText: /./ }).first()).toBeVisible();
      }
      if (problem && id === "notion") {
        await page.locator("#app-setup").getByRole("button", { name: /database/i }).first().click();
        await expect(page.locator("#notion-parent")).toBeVisible();
      }
      if (problem && id === "google_sheets") {
        await page.locator("#app-setup .connection-block .actions button").filter({ hasText: /test row|test na row|test na hanay/i }).first().click();
        await expect(page.getByRole("alert").filter({ hasText: "Google could not find that sheet." }).last()).toBeVisible();
      }
    },
  };
}
const directory = { name: "Apps directory", title: appsTitle, path: "apps", directory: true, note: "Saved connections and available apps.", verify: async page => expect(page.locator("#select-google_sheets")).toBeVisible() };
const confirmation = (verification) => ({
  name: "Gmail sender | " + verification, verification, title: ["Confirm your Gmail sender", "Kumpirmahin ang Gmail sender mo"],
  path: "verify-sender/" + link, note: "The owner reviews the one-time sender link.", verify: async page => {
    await expect(page.locator(".verify-card [role=status]")).not.toHaveText(/Loading|Naglo-load/);
    await expect(page.locator(".verify-card button")).toHaveCount(verification === "ready" ? 1 : 0);
  },
});
export const screens = [
  directory,
  { ...directory, name: "Connected search", note: "The matching app is available under All.", async verify(page) {
    await page.locator(".app-tabs button").last().click(); await page.locator("#app-find").fill("Drive");
    await expect(page.locator(".app-empty #select-google_drive")).toBeVisible();
  } },
  ...providers.flatMap(([id, name]) => [panel(id, name, false), panel(id, name, true)]),
  ...["connected", "declined", "expired"].map(code => ({
    ...panel("google_sheets", "Google Sheets", false), name: "Consent return | " + code,
    path: "apps/google-sheets-" + code, title: ["Google Sheets","Google Sheets"],
    async verify(page) { await expect(page.locator("#app-setup .connection > [role=" + (code === "connected" ? "status" : "alert") + "]").first()).toBeVisible(); },
  })),
  ...["ready", "expired", "used"].map(confirmation),
  ...[false, true].map(problem => ({ name: problem ? "Business | Logo rejected" : "Business profile", title: ["Business","Negosyo"], path: "settings/business", problem, note: "Profile, brand and public inquiry form.",
    async verify(page) {
      await expect(page.locator("#p-businessName")).toHaveValue("Sampaguita Bakery");
      if (problem) {
        await page.locator("#b-logo").setInputFiles({ name:"sample.txt", mimeType:"text/plain", buffer: Buffer.from("sample") });
        await page.locator('[aria-labelledby="brand-h"] button').first().click();
        await expect(page.locator('[aria-labelledby="brand-h"] [role=alert]')).toBeVisible();
      }
    },
  })),
];
export async function checkActions(page, open) {
  await open(directory);
  await page.locator("#select-slack").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#panel-title")).toBeFocused();
  await page.locator(".panel-back").click();
  await expect(page.locator("#select-slack")).toBeFocused();
  await open(confirmation("ready"));
  await page.locator(".verify-card button").click();
  await expect(page.locator(".verify-card [role=status]")).toContainText("Confirmed.");
}
