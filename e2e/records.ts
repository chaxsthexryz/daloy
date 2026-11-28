import { expect, type Page } from "@playwright/test";

type RecordApp = "airtable" | "notion" | "trello";
export type RecordState = { airtableRecords: Record<string, unknown>[]; notionPages: Record<string, unknown>[]; trelloCards: string[] };

/** Read the local fake only. Never contact a live record provider from an e2e spec. */
export async function recorded(): Promise<RecordState> {
  const res = await fetch(`${process.env.E2E_PROVIDERS_URL}/__control`);
  expect(res.ok).toBe(true);
  return (await res.json()) as RecordState;
}

export async function signUp(page: Page, app: RecordApp) {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`${app}-oauth-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Business" }).first().click();
  await page.locator("#main-menu").getByRole("link", { name: "Apps", exact: true }).click();
}

export function recordPanel(page: Page, name: string) {
  return page.locator(".connection").filter({ has: page.getByRole("heading", { name, exact: true }) });
}

export async function connectRecord(page: Page, app: RecordApp, name: string) {
  await signUp(page, app);
  await page.getByRole("button", { name: `Connect ${name}`, exact: true }).click();
  const panel = recordPanel(page, name);
  await panel.getByRole("button", { name: `Connect ${name}`, exact: true }).click();
  // Semgrep: built from a test-made reference, not user input.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  await expect(page).toHaveURL(new RegExp(`/#/apps/${app}-connected$`));
  await expect(recordPanel(page, name)).toContainText(`${name} is connected.`);
  return recordPanel(page, name);
}

/** A normal run queues and delivers through the worker, using the target selected in the browser. */
export async function sendRecord(page: Page, app: RecordApp, title: string) {
  const created = await page.request.post("/workflows", { data: { name: `${app} records`, slug: `${app}-${Date.now()}` } });
  expect(created.status()).toBe(201);
  const workflow = (await created.json()) as { id: string };
  const config = app === "airtable" ? { fields: { Name: "{{trigger.title}}" } } : app === "notion" ? { title: "{{trigger.title}}", fields: { Notes: "Sent by the record e2e test" } } : { name: "{{trigger.title}}", desc: "Sent by the record e2e test" };
  const definition = { trigger: { type: "webhook", config: {} }, steps: [{ id: "record", type: app, config }], edges: [] };
  expect((await page.request.post(`/workflows/${workflow.id}/versions`, { data: { definition, publish: true } })).status()).toBe(201);
  expect((await page.request.post(`/workflows/${workflow.id}/runs`, { data: { payload: { title } } })).status()).toBe(202);
  await expect.poll(async () => {
    const state = await recorded();
    if (app === "airtable") return state.airtableRecords.filter((r) => r.Name === title).length;
    if (app === "notion") return state.notionPages.filter((p) => JSON.stringify(p).includes(title)).length;
    return state.trelloCards.filter((c) => c === title).length;
  }, { timeout: 30_000 }).toBe(1);
  const runs = (await (await page.request.get(`/runs?workflowId=${workflow.id}`)).json()) as { id: string }[];
  expect(runs).toHaveLength(1);
  await expect.poll(async () => {
    const deliveries = (await (await page.request.get(`/deliveries?runId=${runs[0]!.id}`)).json()) as { provider: string; state: string }[];
    return deliveries.map((d) => ({ provider: d.provider, state: d.state }));
  }, { timeout: 30_000 }).toEqual([{ provider: app, state: "delivered" }]);
}
