import { expect, test } from "@playwright/test";
import { addStep } from "./editor-steps";

// G2 (decision 0127): a Google Sheets row trigger set up in the editor, against the fake Google in e2e/global-setup.ts.
// The worker polls every second here instead of every 5 minutes. The Picker is replaced as in google-connect.spec.ts.
const SHEET = "e2e-picked-sheet-0001";
const appendRow = (row: string[]) =>
  fetch(`${process.env.E2E_PROVIDERS_URL}/__control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sheetAppend: { id: SHEET, tab: "Walk-ins", row } }) });

test("an owner sets up a new-row trigger on a Google Sheet tab, and only rows added after turning it on start runs", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await page.addInitScript((sheet) => {
    (window as unknown as { daloyPick: () => Promise<string> }).daloyPick = async () => sheet;
  }, SHEET);
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`g2-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Apps" }).first().click();
  await page.getByRole("button", { name: "Connect Google Sheets" }).click();
  await page.getByRole("button", { name: "Connect with Google" }).click();
  await expect(page.getByText("Google Sheets is connected.")).toBeVisible();
  await page.getByRole("button", { name: "Pick an existing sheet" }).click();
  await expect(page.getByText("Rows go to Front desk log, tab Requests.")).toBeVisible();
  // A row already in the tab before the trigger is turned on: it must never start a run.
  await appendRow(["Earlier walk-in"]);

  await page.goto("/#/new");
  await page.getByLabel("Name").fill("New walk-ins");
  await page.getByRole("button", { name: "Create and open editor" }).click();
  await expect(page.getByRole("heading", { name: "New walk-ins" })).toBeVisible();
  const workflowId = new URL(page.url()).hash.split("/")[2]!;

  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.getByRole("button", { name: "Trigger: You run it" }).click();
  await page.getByLabel("Starts when").selectOption("sheets_row");
  // The tab list comes from the chosen spreadsheet, read with the workspace's own Google connection.
  await page.getByLabel("Tab to watch").selectOption("Walk-ins");
  await expect(page.getByText("Daloy checks Front desk log every few minutes once this is turned on.")).toBeVisible();

  await addStep(page, "condition");
  await page.getByLabel("Value", { exact: true }).fill("{{trigger.rowNumber}}");
  await page.getByLabel("Operator").selectOption("exists");
  await page.getByRole("button", { name: "Publish" }).click();
  await page.getByRole("button", { name: "Turn on", exact: true }).click();
  await expect(page.getByText(/Version \d+ is live/)).toBeVisible();

  // Wait for the first poll, which only records where the tab stands.
  await expect
    .poll(async () => (await (await page.request.get(`/triggers/google/sheets_row?workflowId=${workflowId}`)).json()).watching?.started, { timeout: 30_000 })
    .toBe(true);
  await appendRow(["Ana Reyes"]);

  type SheetRun = { state: string; triggerPayload: { tab: string; values: string[] } };
  const sheetRuns = async () => (await (await page.request.get(`/runs?workflowId=${workflowId}&test=false`)).json()) as SheetRun[];
  await expect.poll(async () => (await sheetRuns()).map((r) => [r.state, r.triggerPayload.values]), { timeout: 30_000 }).toEqual([["succeeded", ["Ana Reyes"]]]);
  // More polls go by and the same row does not start a second run.
  await page.waitForTimeout(3000);
  expect(await sheetRuns()).toHaveLength(1);

  await page.reload();
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.getByRole("button", { name: "Trigger: Google Sheets, A row is added" }).click();
  await expect(page.getByText("Watching Front desk log. Daloy checks every few minutes.")).toBeVisible();
});
