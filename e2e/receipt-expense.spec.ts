import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

// Phase N22: an AI step reads a form photo. The fake model (e2e/llm-fake.ts) records the sha256 of each image it receives.
type AiRequest = { images: string[]; text: string };
const aiRequests = async () => ((await (await fetch(`${process.env.E2E_LLM_URL}/__control`)).json()) as { aiRequests: AiRequest[] }).aiRequests;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("daloy receipt pixels")]);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function signUp(page: Page, prefix: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account instead" }).click();
  await page.getByLabel("Email").fill(`${prefix}-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
}

const formId = async (page: Page, id: string) => ((await (await page.request.get(`/workflows/${id}`)).json()) as { trigger: { id: string } }).trigger.id;

test("the receipt template sends the photo to the model, which fills the approval", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await signUp(page, "receipt");
  await page.getByRole("link", { name: "Apps" }).first().click();
  await page.getByRole("button", { name: "Connect Google Drive" }).click();
  // Google sign-in is the main option in e2e (decision 0060); the service account form is under Advanced.
  await page.getByText("Advanced: use a key or token instead").click();
  await page.getByLabel("Service account key file (JSON)").fill(process.env.E2E_SHEETS_KEY!);
  await page.getByLabel("Folder link").fill(`https://drive.google.com/drive/folders/${process.env.E2E_DRIVE_FOLDER}?usp=sharing`);
  await page.getByRole("button", { name: "Connect Google Drive" }).click();
  await expect(page.getByText("Files go to")).toBeVisible();
  await page.getByRole("button", { name: "Connect Google Sheets" }).click();
  // Google sign-in is the main option in e2e (decision 0060); the service account form is under Advanced.
  await page.getByText("Advanced: use a key or token instead").click();
  await page.getByLabel("Service account key file (JSON)").fill(process.env.E2E_SHEETS_KEY!);
  await page.getByLabel("Sheet link").fill("https://docs.google.com/spreadsheets/d/e2e-sheet-0000000001/edit");
  await page.getByLabel("Tab name").fill("Requests");
  await page.getByRole("button", { name: "Connect Google Sheets" }).click();
  await expect(page.getByText("Rows go to")).toBeVisible();

  await page.goto("/#/new");
  await page.getByLabel("Name").fill("Receipts");
  await page.getByLabel("Start from").selectOption({ label: "Template: Receipt to expense row" });
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByRole("status")).toHaveText(/Version \d+ is live/);
  const id = page.url().split("#/w/")[1]!.split("/")[0]!;

  await page.goto(`/forms/${await formId(page, id)}`);
  await page.getByLabel("Your name").fill("Ana");
  await page.getByLabel("Email").fill("ana@test.local");
  await page.locator('input[type="file"]').setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: PNG });
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Thanks, we received your message.")).toBeVisible();

  await expect.poll(async () => (await aiRequests()).some((r) => r.images.includes(sha(PNG))), { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => ((await (await page.request.get(`/runs?workflowId=${id}`)).json()) as unknown[]).length).toBe(1);
  const [run] = (await (await page.request.get(`/runs?workflowId=${id}`)).json()) as { id: string }[];
  await page.goto(`/#/runs/${run!.id}`);
  const output = page.getByLabel("Output of read_receipt");
  await expect(output).toContainText("Sari-sari Store", { timeout: 30_000 });
  await expect(output).toContainText("250.00");
  await expect(page.locator(".run > p").first()).toHaveText(/^waiting/);
});

test("an AI step without files gets no image, even when the form has a photo field", async ({ page }) => {
  await signUp(page, "nofiles");
  const marker = `marker-${Date.now()}`;
  const wf = await (await page.request.post("/workflows", { data: { name: "No files", slug: `nofiles-${Date.now()}` } })).json();
  const definition = {
    trigger: {
      type: "form",
      config: { fields: [{ name: "note", label: "Note", type: "text", required: true }, { name: "photo", label: "Photo", type: "file", required: true }] },
    },
    steps: [{ id: "read", type: "ai", config: { task: "extract", input: "Note: {{trigger.note}}", fields: { shop: "Shop name" } } }],
    edges: [],
  };
  expect((await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition, publish: true } })).status()).toBe(201);

  await page.goto(`/forms/${await formId(page, wf.id)}`);
  await page.getByLabel("Note").fill(marker);
  await page.locator('input[type="file"]').setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: PNG });
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Thanks, we received your message.")).toBeVisible();

  await expect.poll(async () => (await aiRequests()).find((r) => r.text.includes(marker)), { timeout: 30_000 }).toBeTruthy();
  expect((await aiRequests()).find((r) => r.text.includes(marker))!.images).toEqual([]);
});
