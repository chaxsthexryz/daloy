import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";

// Phase N21: a visitor attaches a file to a hosted form, a Drive step saves it into a shared drive folder (fake Drive API from
// e2e/global-setup.ts), and the owner downloads it from the run as an attachment. A file that is not a photo or PDF is refused.
type DriveFile = { id: string; name: string; parent: string; size: number; sha256: string };
const saved = async () => ((await (await fetch(`${process.env.E2E_PROVIDERS_URL}/__control`)).json()) as { driveFiles: DriveFile[] }).driveFiles;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("daloy e2e pixels")]);

test("a form file is saved to Drive and downloaded from the run, and an SVG is refused", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`files-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Business" }).first().click(); await page.getByRole("navigation", { name: "Business" }).getByRole("link", { name: "Apps", exact: true }).click();
  await page.getByRole("button", { name: "Connect Google Drive" }).click();
  // Google sign-in is the main option in e2e (decision 0060); the service account form is under Advanced.
  await page.getByText("Advanced: use a key or token instead").click();
  await page.getByLabel("Service account key file (JSON)").fill(process.env.E2E_SHEETS_KEY!);
  await page.getByLabel("Folder link").fill(`https://drive.google.com/drive/folders/${process.env.E2E_DRIVE_FOLDER}?usp=sharing`);
  await page.getByRole("button", { name: "Connect Google Drive" }).click();
  await expect(page.getByText("Files go to")).toBeVisible();
  await expect(page.getByText("Patient files")).toBeVisible();

  const slug = `intake-${Date.now()}`;
  const wf = await (await page.request.post("/workflows", { data: { name: "Patient intake", slug } })).json();
  const definition = {
    trigger: { type: "form", config: { fields: [{ name: "id_photo", label: "ID photo", type: "file", required: true }] } },
    steps: [{ id: "drive", type: "drive", config: {} }],
    edges: [],
  };
  expect((await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition, publish: true } })).status()).toBe(201);
  const formId = ((await (await page.request.get(`/workflows/${wf.id}`)).json()) as { trigger: { id: string } }).trigger.id;

  // A browser posts the form as multipart, so the refusal is what a visitor sees.
  await page.goto(`/forms/${formId}`);
  await page.locator('input[type="file"]').setInputFiles({ name: "logo.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>') });
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("body")).toContainText("must be a JPEG, PNG, WebP or HEIC photo, or a PDF");

  await page.goto(`/forms/${formId}`);
  await page.locator('input[type="file"]').setInputFiles({ name: "id front.png", mimeType: "image/png", buffer: PNG });
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Thanks, we received your message.")).toBeVisible();

  const mine = async () => (await saved()).filter((f) => f.parent === process.env.E2E_DRIVE_FOLDER && f.name.endsWith("id front.png"));
  await expect.poll(async () => (await mine()).length, { timeout: 30_000 }).toBe(1);
  expect((await mine())[0]).toMatchObject({ size: PNG.length, sha256: createHash("sha256").update(PNG).digest("hex") });

  // Only the accepted file made a run.
  const runs = (await (await page.request.get(`/runs?workflowId=${wf.id}`)).json()) as { id: string }[];
  expect(runs).toHaveLength(1);
  await page.goto(`/#/runs/${runs[0]!.id}`);
  const link = page.getByRole("link", { name: /Download/ });
  await expect(page.getByRole("region", { name: "Files" }).getByText("id front.png")).toBeVisible();
  const href = (await link.getAttribute("href"))!;
  expect(await link.getAttribute("download")).not.toBeNull();
  const file = await page.request.get(href);
  expect(file.status()).toBe(200);
  expect(file.headers()["content-disposition"]).toMatch(/^attachment/);
  expect(Buffer.compare(await file.body(), PNG)).toBe(0);
});
