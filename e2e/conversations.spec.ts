import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";

// C7 (decision 0125): Conversations page on desktop and 390 px mobile, takeover/hand-back, field editing,
// Confirm stay, owner R6 export/delete, and Tagalog copy.
test("conversations page manages handoff, guest fields, stay confirmation, mobile layout, and Tagalog copy", async ({ page }) => {
  const email = `conv-${Date.now()}@test.local`;
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();

  await page.request.post("/resources", { data: { name: "Beach Casita" } });

  // Connect Meta Messenger against the test server fake providers and seed an inbound guest message.
  const pageId = process.env.E2E_META_PAGE_ID!;
  const appSecret = "c7_e2e_app_secret_001";
  const pageToken = process.env.E2E_META_TOKEN!;
  expect(
    (
      await page.request.put("/settings/connections/meta-messenger", {
        data: { pageId, pageAccessToken: pageToken, appSecret, verifyToken: "c7_verify_1" },
      })
    ).status(),
  ).toBe(200);

  const wf = await (await page.request.post("/workflows", { data: { name: "Concierge", slug: `c7-${Date.now()}` } })).json();
  const def = {
    trigger: { type: "meta_dm", config: { channel: "both", requireImage: false } },
    steps: [{ id: "wait", type: "delay", config: { seconds: 1 } }],
    edges: [],
  };
  await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition: def, publish: true } });

  const metaStatus = await (await page.request.get("/settings/connections")).json();
  const metaConn = (metaStatus.connections as { provider: string; destination?: { webhookPath?: string } }[]).find((c) => c.provider === "meta_messenger");
  const webhookPath = metaConn!.destination!.webhookPath!;
  const body = JSON.stringify({
    object: "page",
    entry: [
      {
        id: pageId,
        messaging: [
          {
            sender: { id: "guest-psid-1" },
            recipient: { id: pageId },
            timestamp: Date.now(),
            message: { mid: `m_${Date.now()}`, text: "Do you have rooms for 2 guests on Dec 15?" },
          },
        ],
      },
    ],
  });
  const sig = `sha256=${createHmac("sha256", appSecret).update(body).digest("hex")}`;
  expect(
    (
      await page.request.post(`/hooks/meta/${webhookPath}`, {
        headers: { "content-type": "application/json", "x-hub-signature-256": sig },
        data: body,
      })
    ).status(),
  ).toBe(200);

  // Open Conversations from the Inbox header link.
  await page.getByRole("link", { name: "Inbox" }).click();
  await page.getByRole("link", { name: "Conversation settings" }).click();
  await expect(page.getByRole("heading", { name: "Conversations", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Alert settings" }).click();
  await expect(page.getByLabel("Staff Messenger recipient ID (optional)")).toBeVisible();
  await expect(page.getByText("Message your own Facebook Page from your staff Messenger account.")).toBeVisible();
  await page.getByRole("button", { name: "Hide alert settings" }).click();
  await expect(page.getByRole("region", { name: "Message history" }).getByText("Do you have rooms for 2 guests on Dec 15?")).toBeVisible();

  // Take over, verify Needs staff status, edit guest fields, and hand back.
  await page.getByRole("button", { name: "Take over" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Conversation taken over." }).first()).toBeVisible();
  await expect(page.locator(".cv-badge-staff")).toContainText("Needs staff");

  const nextYear = new Date().getUTCFullYear() + 1;
  await page.getByLabel("Name", { exact: true }).fill("Elena Reyes");
  await page.getByLabel("Check-in", { exact: true }).fill(`${nextYear}-09-10`);
  await page.getByLabel("Check-out", { exact: true }).fill(`${nextYear}-09-12`);
  await page.getByLabel("Guests", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Guest details saved." }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Elena Reyes" })).toBeVisible();

  // Confirm stay linked to the conversation.
  await page.getByRole("button", { name: "Confirm stay" }).click();
  await page.getByRole("button", { name: "Save stay" }).click();
  await expect(page.getByRole("status").filter({ hasText: "confirmed." }).first()).toBeVisible();

  await page.getByRole("button", { name: "Hand back" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Handed back to bot." }).first()).toBeVisible();

  // Switch to Tagalog and verify Conversations renders Tagalog headings without missing keys.
  expect((await page.request.put("/settings/language", { data: { language: "tl" } })).status()).toBe(200);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Mga usapan", exact: true })).toBeVisible();

  // Check 390 px mobile layout: list first after load, tap item to open detail, zero overflow, back button returns to list.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("region", { name: "Listahan ng mga usapan" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: /Elena Reyes/ }).click();
  await expect(page.getByRole("button", { name: "Bumalik sa mga usapan" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Bumalik sa mga usapan" }).click();
  await expect(page.getByRole("region", { name: "Listahan ng mga usapan" })).toBeVisible();
});
