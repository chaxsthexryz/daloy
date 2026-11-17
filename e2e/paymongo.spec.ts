import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";

// PayMongo (fake API from e2e/global-setup.ts): connect through the console, make a checkout link from a run, then a signed paid webhook starts a payment-triggered run once.
test("an owner connects PayMongo, a run makes a payment link, and the paid webhook starts a run once", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account instead" }).click();
  await page.getByLabel("Email").fill(`pm-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();

  await page.getByRole("link", { name: "Apps" }).first().click();
  await page.getByRole("button", { name: "Connect PayMongo" }).click();
  await page.getByLabel("Secret key").fill(process.env.E2E_PAYMONGO_KEY!);
  await page.getByLabel("Webhook secret").fill(process.env.E2E_PAYMONGO_WEBHOOK_SECRET!);
  await page.getByRole("button", { name: "Connect PayMongo" }).click();
  await expect(page.getByText("Test mode", { exact: true })).toBeVisible();
  const hookUrl = (await page.locator("code", { hasText: "/hooks/paymongo/" }).textContent())!;

  const publish = async (name: string, definition: object) => {
    const wf = await (await page.request.post("/workflows", { data: { name, slug: `${name}-${Date.now()}` } })).json();
    expect((await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition, publish: true } })).status()).toBe(201);
    return wf.id as string;
  };
  const linker = await publish("link", {
    trigger: { type: "manual", config: {} },
    steps: [{ id: "link", type: "paymongo_link", config: { amount: "150.50", description: "Cleaning", reference: "ORD-1" } }],
    edges: [],
  });
  const listener = await publish("paid", { trigger: { type: "payment", config: { events: ["paid"] } }, steps: [{ id: "pause", type: "delay", config: { seconds: 1 } }], edges: [] });

  const { id: runId } = await (await page.request.post(`/workflows/${linker}/runs`, { data: { payload: {} } })).json();
  let url = "";
  await expect
    .poll(async () => {
      const run = await (await page.request.get(`/runs/${runId}`)).json();
      url = run.steps.find((s: { stepId?: string; output?: { url?: string } }) => s.output?.url)?.output.url ?? "";
      return run.state;
    }, { timeout: 30_000 })
    .toBe("succeeded");
  const { paymongoSessions } = (await (await fetch(`${process.env.E2E_PROVIDERS_URL}/__control`)).json()) as { paymongoSessions: { id: string; amount: number }[] };
  expect(paymongoSessions).toHaveLength(1);
  expect(paymongoSessions[0]!.amount).toBe(15050);
  expect(url).toBe(`https://checkout.paymongo.test/${paymongoSessions[0]!.id}`);

  const body = JSON.stringify({
    data: {
      id: "evt_e2e_1",
      type: "event",
      attributes: { type: "checkout_session.payment.paid", livemode: false, data: { id: paymongoSessions[0]!.id, attributes: { payments: [{ id: "pay_e2e_1", attributes: { amount: 15050, currency: "PHP", status: "paid" } }] } } },
    },
  });
  const deliver = async () => {
    const t = Math.floor(Date.now() / 1000);
    const te = createHmac("sha256", process.env.E2E_PAYMONGO_WEBHOOK_SECRET!).update(`${t}.${body}`).digest("hex");
    const res = await fetch(hookUrl, { method: "POST", headers: { "content-type": "application/json", "paymongo-signature": `t=${t},te=${te},li=` }, body });
    return { status: res.status, json: (await res.json()) as { duplicate?: boolean } };
  };
  const listenerRuns = async () => ((await (await page.request.get(`/runs?workflowId=${listener}`)).json()) as unknown[]).length;

  expect((await deliver()).status).toBe(200);
  await expect.poll(listenerRuns, { timeout: 15_000 }).toBe(1);
  expect((await deliver()).json).toEqual({ duplicate: true });
  expect(await listenerRuns()).toBe(1);
});
