import { createServer } from "node:http";
import { type AddressInfo } from "node:net";
import { expect, test, type APIRequestContext } from "@playwright/test";

// Doop rows E7 and E8 (decision 0079): the public form, its validation page, receipt and paused page, then the same form in
// an iframe at phone width. Every check uses the visitor's own browser; the owner's setup goes through the API.
async function owner(request: APIRequestContext, fields: unknown[]) {
  const email = `pub-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
  expect((await request.post("/auth/register", { data: { email, password: "e2e test password 1" } })).status()).toBe(201);
  const wf = await (await request.post("/workflows", { data: { name: "Equipment", slug: `eq-${Date.now()}` } })).json();
  const definition = { trigger: { type: "form", config: { fields } }, steps: [{ id: "pause", type: "delay", config: { seconds: 1 } }], edges: [] };
  expect((await request.post(`/workflows/${wf.id}/versions`, { data: { definition, publish: true } })).status()).toBe(201);
  const { trigger } = await (await request.get(`/workflows/${wf.id}`)).json();
  return { workflowId: wf.id as string, formId: trigger.id as string };
}

const FIELDS = [
  { name: "summary", label: "What do you need?", type: "text", required: true },
  { name: "details", label: "Details", type: "textarea", required: false },
  { name: "amount", label: "Amount in pesos", type: "number", required: true, min: 1 },
  { name: "email", label: "Your email", type: "email", required: false },
  { name: "quote", label: "Quote or photo", type: "file", required: false },
];

test("a visitor sees the business brand, fixes a refused file and gets a receipt, and a paused form says so", async ({ page }) => {
  const o = await owner(page.request, FIELDS);
  expect((await page.request.put("/settings/email/profile", { data: { businessName: "Sampaguita Bakery", website: null, inquiryEmail: null, replyTo: null } })).status()).toBe(204);
  expect((await page.request.put("/settings/brand", { data: { accent: "#1f6b45" } })).status()).toBe(200);

  await page.goto(`/forms/${o.formId}`);
  await expect(page.getByRole("heading", { name: "Sampaguita Bakery" })).toBeVisible();
  // The accent colours the button and the rule under the name; the Daloy brand does not appear.
  await expect(page.getByRole("button", { name: "Send" })).toHaveCSS("background-color", "rgb(31, 107, 69)");
  await expect(page.locator("main")).toHaveClass("ruled");
  await expect(page.getByText("Daloy")).toHaveCount(0);
  await expect(page.getByText("Up to 3 files, 5 MB each.")).toBeVisible();

  // Amount 5 passes the browser; the server refuses the .docx, and the answers stay in the form.
  await page.getByLabel("What do you need?").fill("Two folding tables for the Saturday tasting");
  await page.getByLabel("Details").fill("Needed by 8 am.");
  await page.getByLabel("Amount in pesos").fill("1800");
  await page.getByLabel("Quote or photo").setInputFiles({ name: "menu-draft.docx", mimeType: "application/vnd.openxmlformats", buffer: Buffer.from("not a photo") });
  await page.getByRole("button", { name: "Send" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("The form was not sent. Fix these and send again.");
  await expect(alert).toContainText("quote: must be a JPEG, PNG, WebP or HEIC photo, or a PDF");
  await expect(page.locator("#e-quote")).toHaveText("must be a JPEG, PNG, WebP or HEIC photo, or a PDF");
  await expect(page.getByLabel("What do you need?")).toHaveValue("Two folding tables for the Saturday tasting");
  await expect(page.getByLabel("Details")).toHaveValue("Needed by 8 am.");
  await expect(page.getByLabel("Quote or photo")).toHaveAttribute("aria-invalid", "true");

  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Thanks, we received your message.")).toBeVisible();
  const runs = await (await page.request.get(`/runs?workflowId=${o.workflowId}`)).json();
  expect(runs).toHaveLength(1);

  // Paused: nothing is stored and the page says why.
  expect((await page.request.post(`/workflows/${o.workflowId}/pause`, { data: {} })).ok()).toBe(true);
  await page.goto(`/forms/${o.formId}`);
  await expect(page.getByRole("heading", { name: "This form is paused" })).toBeVisible();
  await expect(page.getByText("Not taking submissions", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toHaveCount(0);
});

test("the form does not scroll sideways at phone width, in the page and in an iframe on another site", async ({ page, browser }) => {
  const o = await owner(page.request, FIELDS);
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const visitor = await phone.newPage();
  await visitor.goto(`/forms/${o.formId}`);
  expect(await visitor.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(visitor.getByRole("button", { name: "Send" })).toBeVisible();

  const snippet = `<iframe src="http://localhost:3100/forms/${o.formId}/embed" title="Request form" style="width:100%;border:0" height="640"></iframe>`;
  const site = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><meta name="viewport" content="width=device-width"><body style="margin:0;background:#eee">${snippet}</body>`);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  try {
    await visitor.goto(`http://127.0.0.1:${(site.address() as AddressInfo).port}/`);
    const frame = visitor.frameLocator("iframe");
    await frame.getByLabel("What do you need?").fill("Two folding tables");
    await frame.getByLabel("Amount in pesos").fill("1800");
    await frame.getByRole("button", { name: "Send" }).click();
    await expect(frame.getByText("Thanks, we received your message.")).toBeVisible();
    // Framing is allowed for this route only; the console and the plain form page keep their frame ban.
    expect(await visitor.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await new Promise<void>((resolve) => site.close(() => resolve()));
    await phone.close();
  }
  const runs = await (await page.request.get(`/runs?workflowId=${o.workflowId}`)).json();
  expect(runs).toHaveLength(1);
});
