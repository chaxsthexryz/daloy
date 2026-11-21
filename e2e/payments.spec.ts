import { captureReview } from "./review-capture";
import { createHmac } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

// R3 pilot scenario (decisions 0088 to 0090): booking D-1042 expects a 350 peso deposit. The customer sends a transfer
// reference on the pay page, which puts it in Receipts to review. A verified PayMongo event then confirms it. Both show
// in the one booking history, the deposit stays apart from the balance, one confirmation SMS goes out, and a pay-later
// booking stays active with its balance outstanding. All providers are the e2e fakes.
// Inert demo image for the fake seller. It contains no payment destination.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAGAAAABgAQAAAADK40qVAAAAo0lEQVR4nM2TPQ7CMAxGn0uHiiWwMLC0R+j9NyQO0CMUCTEnW8XyMRDaLkhuJX485Sl+sewkJqYocAERkCQgOJ0CKQIEyVunINlzZTu/8y0IeXKKXqfEQEAy99xsxf18FlRvu+Z6zjtdVHc/ZqhQdRkd62cHNMDtBT1wyDBwGuoyQ7u3dgP/2PY7SGa20CkRaXHRZK60n0CQK20W419Y4Kx5FA8MPSsRciNC8AAAAABJRU5ErkJggg==", "base64");
const PHONE = "09171230042";

type RunView = { state: string; steps: { stepId: string; output?: Record<string, unknown> }[] };

async function publish(page: Page, name: string, steps: object[], edges: object[] = []) {
  const wf = await (await page.request.post("/workflows", { data: { name, slug: `${name}-${Date.now()}` } })).json();
  const fields = [
    { name: "order", label: "Order", type: "text", required: true },
    { name: "phone", label: "Mobile", type: "text", required: true },
    { name: "who", label: "Chair", type: "resource", required: true },
    { name: "at", label: "Time", type: "datetime", required: true, timezone: "Asia/Manila", slotMinutes: 60 },
  ];
  const definition = { trigger: { type: "webhook", config: { fields } }, steps, edges };
  expect((await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition, publish: true } })).status()).toBe(201);
  return wf.id as string;
}

async function run(page: Page, workflowId: string, payload: object) {
  const { id } = await (await page.request.post(`/workflows/${workflowId}/runs`, { data: { payload } })).json();
  let view: RunView | undefined;
  await expect.poll(async () => (view = (await (await page.request.get(`/runs/${id}`)).json()) as RunView).state, { timeout: 30_000 }).toBe("succeeded");
  return Object.fromEntries(view!.steps.map((s) => [s.stepId, s.output ?? {}])) as Record<string, Record<string, string>>;
}

const smsTo = async (to: string) => ((await (await fetch(`${process.env.E2E_PROVIDERS_URL}/__control`)).json()) as { unismsMessages: { recipient: string; content: string }[] }).unismsMessages.filter((m) => m.recipient === to);

async function registerSeller(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`seller-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
}

test("booking D-1042: a transfer receipt goes to review, a verified checkout confirms it, and the booking shows one payment history", async ({ page }) => {
  await registerSeller(page);

  expect((await page.request.put("/settings/connections/paymongo", { data: { secretKey: process.env.E2E_PAYMONGO_KEY, webhookSecret: process.env.E2E_PAYMONGO_WEBHOOK_SECRET } })).status()).toBe(200);
  expect((await page.request.put("/settings/connections/unisms", { data: { secretKey: process.env.E2E_UNISMS_KEY } })).status()).toBe(200);
  const conns = (await (await page.request.get("/settings/connections")).json()) as { connections: { provider: string; destination: { webhookPath?: string } }[] };
  const hookPath = conns.connections.find((c) => c.provider === "paymongo")!.destination.webhookPath!;
  expect((await page.request.put("/payments/settings", { data: { gcashNumber: "0917 555 0101", accountName: "Lia Nail Studio", qr: PNG.toString("base64") } })).status()).toBe(200);

  const chair1 = await (await page.request.post("/resources", { data: { name: "Chair 1" } })).json();
  const chair2 = await (await page.request.post("/resources", { data: { name: "Chair 2" } })).json();
  const year = new Date().getUTCFullYear() + 1;
  const book = { id: "book", type: "booking", config: { action: "create", resource: "{{trigger.who}}", start: "{{trigger.at}}", minutes: 60 } };
  const deposits = await publish(page, "deposit", [
    book,
    { id: "ask", type: "payment_due", config: { reference: "{{trigger.order}}", kind: "deposit", amount: "350", total: "1200", booking: "book", checkout: true, channel: "sms", to: "{{trigger.phone}}", confirmedMessage: "Deposit for {{trigger.order}} received. See you!" } },
  ], [{ from: "book", to: "ask", on: "done" }]);
  const out = await run(page, deposits, { order: "D-1042", phone: PHONE, who: chair1.id, at: `${year}-02-10T10:00` });
  const payUrl = out.ask!.payUrl!;
  const checkoutUrl = out.ask!.checkoutUrl!;
  expect(payUrl).toMatch(/\/pay\/[A-Za-z0-9_-]{43}$/);
  expect(checkoutUrl).toMatch(/^https:\/\/checkout\.paymongo\.test\/cs_/);

  // The customer's pay page: the amount, the QR Ph code and number, the checkout link and the reference form.
  const customer = await page.context().browser()!.newPage();
  await customer.goto(new URL(payUrl).pathname);
  await expect(customer.getByRole("heading", { name: "Deposit for D-1042" })).toBeVisible();
  await expect(customer.getByText("PHP 350.00")).toBeVisible();
  await expect(customer.getByText("0917 555 0101")).toBeVisible();
  await expect(customer.getByRole("img", { name: "QR Ph code to pay" })).toBeVisible();
  await expect(customer.getByRole("link", { name: "Or pay online with GCash" })).toHaveAttribute("href", checkoutUrl);
  await customer.getByLabel("Transfer reference number").fill("GC 5544 3322 11");
  await customer.getByLabel("Amount you sent (pesos, optional)").fill("350");
  await captureReview(customer, "06", "Customer payment page", "The customer can enter a transfer reference or open hosted checkout.");
  await customer.getByLabel("Receipt screenshot (optional)").setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: PNG });
  await customer.getByRole("button", { name: "Send reference" }).click();
  await expect(customer.getByText("Reference received")).toBeVisible();
  await expect(customer.getByText("Your order stays pending until then.")).toBeVisible();
  await captureReview(customer, "07", "Reference received", "The transfer stays pending while the seller checks their account.");

  // Receipts to review: one row with the order, amounts, reference, channel and the private image.
  await page.getByRole("link", { name: "Receipts to review" }).click();
  const list = page.getByRole("list", { name: "Receipts to review" });
  const row = list.getByRole("listitem").filter({ hasText: "D-1042" });
  await expect(row).toContainText("PHP 350.00");
  await expect(row).toContainText("GC 5544 3322 11");
  await expect(row).toContainText("QR Ph or GCash transfer");
  await expect(row.getByRole("link", { name: "Open receipt image" })).toBeVisible();
  await captureReview(page, "08", "Receipts to review", "Staff can inspect the private receipt and match the reference and amount.");
  expect((await page.request.get((await row.getByRole("link", { name: "Open receipt image" }).getAttribute("href"))!)).headers()["content-type"]).toBe("image/png");
  // The customer cannot open it: the image needs a staff session.
  expect((await customer.request.get((await row.getByRole("link", { name: "Open receipt image" }).getAttribute("href"))!)).status()).toBe(401);

  // The automatic path: a signed, matching PayMongo event confirms the deposit. A replay changes nothing.
  const sessionId = checkoutUrl.split("/").pop()!;
  const body = JSON.stringify({ data: { id: `evt_d1042_${Date.now()}`, type: "event", attributes: { type: "checkout_session.payment.paid", livemode: false, data: { id: sessionId, attributes: { payments: [{ id: "pay_d1042", attributes: { amount: 35000, currency: "PHP", status: "paid" } }] } } } } });
  const deliver = async () => {
    const t = Math.floor(Date.now() / 1000);
    const te = createHmac("sha256", process.env.E2E_PAYMONGO_WEBHOOK_SECRET!).update(`${t}.${body}`).digest("hex");
    return (await fetch(`http://localhost:3100/hooks/paymongo/${hookPath}`, { method: "POST", headers: { "content-type": "application/json", "paymongo-signature": `t=${t},te=${te},li=` }, body })).json();
  };
  expect(await deliver()).toEqual({ ok: true });
  expect(await deliver()).toEqual({ duplicate: true });
  await expect.poll(async () => (await smsTo("+639171230042")).filter((m) => m.content.includes("Deposit for D-1042 received")).length, { timeout: 20_000 }).toBe(1);

  // The receipt under review is reconciled against the same order: flagged, and it cannot confirm a second time.
  await page.reload();
  await expect(row).toContainText("Already confirmed");
  await expect(row.getByRole("button", { name: "Confirm payment" })).toBeDisabled();
  await row.getByLabel("Reason or question for the customer").fill("Already paid through PayMongo checkout");
  await row.getByRole("button", { name: "Reject" }).click();
  await expect(page.getByText("Nothing to review.")).toBeVisible();

  // A pay-later booking proceeds with its balance outstanding.
  const later = await publish(page, "paylater", [book, { id: "ask", type: "payment_due", config: { reference: "{{trigger.order}}", kind: "balance", amount: "1200", booking: "book" } }], [{ from: "book", to: "ask", on: "done" }]);
  await run(page, later, { order: "D-1043", phone: PHONE, who: chair2.id, at: `${year}-02-10T11:00` });

  // One booking history for D-1042: both paths, the source of the confirmation, and the balance apart from the deposit.
  await page.getByRole("link", { name: "Bookings" }).click();
  await page.getByRole("region", { name: "Day agenda" }).getByRole("button", { name: /Chair 1/ }).click();
  const card = page.getByRole("region", { name: "Chair 1" });
  const payments = card.getByLabel("Payments");
  await expect(payments).toContainText("Deposit PHP 350.00");
  await expect(payments).toContainText("Confirmed by a verified PayMongo payment");
  await expect(payments).toContainText("Balance outstanding: PHP 850.00");
  await expect(payments).toContainText("Receipt submitted, in review");
  await expect(payments).toContainText("Receipt rejected");
  await expect(payments.getByText("Confirmed", { exact: true }).first()).toBeVisible();
  await captureReview(page, "09", "Verified deposit", "One verified PHP 350 deposit leaves a PHP 850 balance.");

  await page.getByRole("region", { name: "Day agenda" }).getByRole("button", { name: /Chair 2/ }).click();
  const card2 = page.getByRole("region", { name: "Chair 2" });
  await expect(card2).toContainText("Active");
  await expect(card2.getByLabel("Payments")).toContainText("Waiting for payment");
  await expect(card2.getByLabel("Payments")).toContainText("Balance outstanding: PHP 1,200.00");
  await captureReview(page, "10", "Pay later", "The other booking remains active with its full balance outstanding.");

  // Exactly one confirmation reached the customer, plus the reason for the rejected duplicate receipt.
  await expect.poll(async () => (await smsTo("+639171230042")).map((m) => m.content), { timeout: 20_000 }).toContain("We could not confirm your payment for D-1042: Already paid through PayMongo checkout");
  expect((await smsTo("+639171230042")).filter((m) => m.content.includes("Deposit for D-1042 received"))).toHaveLength(1);
  await customer.close();
});

test("staff confirm a manual transfer and retry only its failed SMS", async ({ page, browser }) => {
  await registerSeller(page);
  const reference = "M-1044";
  const phone = "09171230044";
  const message = "Transfer for M-1044 confirmed.";
  expect((await page.request.put("/payments/settings", { data: { gcashNumber: "0917 555 0101", accountName: "Lia Nail Studio" } })).status()).toBe(200);
  const resource = await (await page.request.post("/resources", { data: { name: "Pickup desk" } })).json();
  const workflow = await publish(page, "manual-payment", [{
    id: "ask", type: "payment_due", config: { reference: "{{trigger.order}}", kind: "full", amount: "350", channel: "sms", to: "{{trigger.phone}}", confirmedMessage: message },
  }]);
  const year = new Date().getUTCFullYear() + 1;
  const out = await run(page, workflow, { order: reference, phone, who: resource.id, at: `${year}-02-11T10:00` });
  const customer = await browser.newPage();
  await customer.goto(new URL(out.ask!.payUrl!).pathname);
  await expect(customer.getByRole("link", { name: "Or pay online with GCash" })).toHaveCount(0);
  await customer.getByLabel("Transfer reference number").fill("MANUAL 1044");
  await customer.getByRole("button", { name: "Send reference" }).click();
  await expect(customer.getByText("Reference received")).toBeVisible();
  await customer.close();

  await page.getByRole("link", { name: "Receipts to review" }).click();
  const row = page.getByRole("listitem").filter({ hasText: reference });
  page.once("dialog", d => void d.accept());
  await row.getByRole("button", { name: "Confirm payment" }).click();
  // This workspace has no SMS connection. Confirmation succeeds before the reply fails.
  await expect.poll(async () => {
    const rows: { reference: string; replyState: string | null }[] = await (await page.request.get("/payments/review")).json();
    return rows.find(r => r.reference === reference)?.replyState;
  }, { timeout: 20_000 }).toBe("failed");
  await page.reload();
  await expect(row.getByRole("button", { name: "Retry reply" })).toBeVisible();
  await captureReview(page, "11", "Retry the reply", "The transfer is already confirmed. The seller can reconnect SMS and resend just the message.");
  expect((await page.request.put("/settings/connections/unisms", { data: { secretKey: process.env.E2E_UNISMS_KEY } })).status()).toBe(200);
  await row.getByRole("button", { name: "Retry reply" }).click();
  await expect.poll(async () => (await smsTo("+639171230044")).filter(m => m.content === message).length, { timeout: 20_000 }).toBe(1);
  const [due] = await (await page.request.get("/payments/dues?reference=" + reference)).json();
  expect(due).toMatchObject({ status: "confirmed", confirmedSource: "transfer", outstanding: 0 });
  const history = due.history.map((item: { event: string }) => item.event);
  expect(history.filter((event: string) => event === "confirmed")).toHaveLength(1);
  expect(history.filter((event: string) => event === "reply_retried")).toHaveLength(1);
});
