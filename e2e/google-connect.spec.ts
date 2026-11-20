import { expect, test } from "@playwright/test";

// Decision 0060: Connect with Google for Sheets and Drive, against the fake Google OAuth app in e2e/global-setup.ts.
// The Google Picker is an iframe from Google, so the page's pick() is replaced with a stand-in that returns the id
// the test chose. The server re-reads every picked id with its own grant, which is what this checks.
const control = async () => (await (await fetch(`${process.env.E2E_PROVIDERS_URL}/__control`)).json()) as { sheetRows: number; driveFiles: unknown[] };
type PickWindow = { daloyPick?: (kind: string, setup: { accessToken: string; apiKey: string; appId: string }) => Promise<string | null>; nextPick?: string | null; pickedWith?: { kind: string; apiKey: string; appId: string; token: boolean } };

test("an owner connects Sheets with Google, creates and picks sheets, adds a test row and disconnects", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await page.addInitScript(() => {
    const w = window as unknown as PickWindow;
    w.daloyPick = async (kind, setup) => {
      w.pickedWith = { kind, apiKey: setup.apiKey, appId: setup.appId, token: setup.accessToken.length > 0 };
      return w.nextPick ?? null;
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`google-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Apps" }).first().click();
  await page.getByRole("button", { name: "Connect Google Sheets" }).click();
  await expect(page.getByText("Advanced: use a key or token instead")).toBeVisible();
  // The fake consent page answers at once and sends the browser back through the shared callback.
  await page.getByRole("button", { name: "Connect with Google" }).click();
  await expect(page).toHaveURL(/#\/apps\/google-sheets-connected$/);
  await expect(page.getByText("Google Sheets is connected.")).toBeVisible();
  await expect(page.getByText("owner@clinic-e2e.example")).toBeVisible();

  await page.getByRole("button", { name: "Create a sheet for me" }).click();
  await expect(page.getByText("Rows go to Daloy requests, tab Sheet1.")).toBeVisible();
  const before = (await control()).sheetRows;
  await page.getByRole("button", { name: "Add a test row" }).click();
  await expect(page.getByText(/Google Sheets accepted a test row/)).toBeVisible();
  expect((await control()).sheetRows).toBe(before + 1);

  // A sheet the grant cannot reach is refused, and nothing changes.
  await page.evaluate(() => void ((window as unknown as PickWindow).nextPick = "e2e-unpicked-sheet-01"));
  await page.getByRole("button", { name: "Pick an existing sheet" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "pick the sheet again" })).toBeVisible();
  await expect(page.getByText("Rows go to Daloy requests, tab Sheet1.")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as PickWindow).pickedWith)).toEqual({ kind: "sheet", apiKey: "e2e-picker-key", appId: "000000000000", token: true });

  // A picked sheet: its real tabs become the tab list.
  await page.evaluate(() => void ((window as unknown as PickWindow).nextPick = "e2e-picked-sheet-0001"));
  await page.getByRole("button", { name: "Pick an existing sheet" }).click();
  await expect(page.getByText("Rows go to Front desk log, tab Requests.")).toBeVisible();
  await page.getByLabel("Tab", { exact: true }).selectOption("Walk-ins");
  await expect(page.getByText("Rows go to Front desk log, tab Walk-ins.")).toBeVisible();

  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("button", { name: "Connect with Google" })).toBeVisible();
  await expect(page.getByText("owner@clinic-e2e.example")).toBeHidden();
});

test("an owner connects Drive with Google and lets Daloy create its uploads folder, or picks one in My Drive", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await page.addInitScript(() => {
    (window as unknown as PickWindow).daloyPick = async () => "e2e-picked-folder-001";
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`google-drive-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Apps" }).first().click();
  await page.getByRole("button", { name: "Connect Google Drive" }).click();
  await page.getByRole("button", { name: "Connect with Google" }).click();
  await expect(page.getByText("Google Drive is connected.")).toBeVisible();
  await page.getByRole("button", { name: "Create a Daloy uploads folder" }).click();
  await expect(page.getByText("Files go to Daloy uploads.")).toBeVisible();
  await page.getByRole("button", { name: "Pick a folder" }).click();
  await expect(page.getByText("Files go to Clinic scans.")).toBeVisible();
});
