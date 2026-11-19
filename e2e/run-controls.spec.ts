import { createHmac } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

// N11b: pause an automation from Home, see a signed webhook refused and accepted again, and cancel a run that waits on a delay.
// Nothing leaves the machine: the only step is a long delay.
async function signUp(page: Page, label: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account instead" }).click();
  await page.getByLabel("Email").fill(`${label}-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
}

test("pausing stops a signed webhook, resuming starts it again, and a waiting run can be cancelled", async ({ page, request }) => {
  await signUp(page, "controls");
  const stamp = Date.now();
  expect((await page.request.put("/secrets/hook_key", { data: { value: "whsec_e2e" } })).status()).toBe(204);
  const wf = await (await page.request.post("/workflows", { data: { name: "Nightly sync", slug: `sync-${stamp}` } })).json();
  const definition = { trigger: { type: "webhook", config: { hmacSecret: "hook_key", requireTimestamp: true } }, steps: [{ id: "hold", type: "delay", config: { seconds: 3600 } }], edges: [] };
  expect((await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition, publish: true } })).status()).toBe(201);
  const path = (await (await page.request.get(`/workflows/${wf.id}`)).json()).trigger.webhookPath as string;

  // A signed call with a timestamp, from a caller that is not signed in.
  let n = 0;
  const call = async () => {
    const body = JSON.stringify({ event: ++n });
    const t = Math.floor(Date.now() / 1000);
    // Semgrep: a fixed test signing key for the fake webhook.
    // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key
    const signature = `sha256=${createHmac("sha256", "whsec_e2e").update(`${t}.${body}`).digest("hex")}`;
    return request.post(`/hooks/${path}`, { headers: { "Content-Type": "application/json", "X-Daloy-Timestamp": String(t), "X-Daloy-Signature": signature }, data: body });
  };
  const first = await call();
  expect(first.status()).toBe(202);
  const runId = (await first.json()).runId as string;

  // Pause from Home.
  await page.reload();
  const card = page.locator(".card", { has: page.getByRole("link", { name: "Nightly sync" }) });
  await card.getByRole("button", { name: "Pause" }).click();
  await expect(card.locator(".tag", { hasText: "Paused" })).toBeVisible();
  await expect(card).toContainText("starts no new runs");
  const refused = await call();
  expect(refused.status()).toBe(409);
  expect((await refused.json()).message).toContain("paused");

  // An old signature is refused even when the automation runs.
  await card.getByRole("button", { name: "Resume" }).click();
  await expect(card.getByRole("button", { name: "Pause" })).toBeVisible();
  expect((await call()).status()).toBe(202);
  const body = JSON.stringify({ event: "old" });
  const old = Math.floor(Date.now() / 1000) - 600;
  // Semgrep: a fixed test signing key for the fake webhook.
  // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key
  const stale = await request.post(`/hooks/${path}`, { headers: { "Content-Type": "application/json", "X-Daloy-Timestamp": String(old), "X-Daloy-Signature": `sha256=${createHmac("sha256", "whsec_e2e").update(`${old}.${body}`).digest("hex")}` }, data: body });
  expect(stale.status()).toBe(401);

  // Cancel the first run, which is waiting on its delay.
  await page.goto(`/#/runs/${runId}`);
  const cancel = page.getByRole("button", { name: "Cancel run" });
  await expect(cancel).toBeVisible({ timeout: 30_000 });
  page.once("dialog", (d) => void d.accept());
  await cancel.click();
  await expect(cancel).toBeHidden();
  const detail = await (await page.request.get(`/runs/${runId}`)).json();
  expect(detail.state).toBe("cancelled");
});
