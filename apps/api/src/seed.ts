import { resolve } from "node:path";
import { TEMPLATES } from "@daloy/engine";

export const DEMO_EMAIL = "demo@daloy.local";
export const DEMO_PASSWORD = "daloy-demo-2026";

// Realistic trigger payloads for the test runs that fill the run history.
const SAMPLES: Record<(typeof TEMPLATES)[number]["slug"], Record<string, unknown>[]> = {
  "inquiry-triage": [
    { name: "Maria Santos", email: "maria.santos@example.com", message: "I was charged twice for my March invoice. Can you refund one of them?" },
    { name: "Jun Reyes", email: "jun.reyes@example.com", message: "Do you deliver to Cebu, and how long does it usually take?" },
  ],
  "invoice-follow-up": [
    { invoice_id: "INV-2026-0412", customer_name: "Lito Cruz", customer_email: "lito@example.com", amount: "PHP 18,500.00", pay_url: "https://pay.example.com/INV-2026-0412" },
  ],
  "no-show-follow-up": [
    { status: "no_show", customer_name: "Ana Lim", customer_email: "ana.lim@example.com", service: "haircut", rebook_url: "https://book.example.com/r/8f2k" },
    { status: "attended", customer_name: "Ben Tan", customer_email: "ben.tan@example.com", service: "massage", rebook_url: "https://book.example.com/r/3m9q" },
  ],
};

/**
 * Creates the demo user, publishes the three starter templates and starts mocked test runs, all through the API,
 * so the seed goes through the same validation and trigger setup as the console. Safe to run twice.
 */
export async function seed(baseUrl: string) {
  let cookie = "";
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(new URL(path, baseUrl), { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") || cookie;
    if (!res.ok && res.status !== 409) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return res.status === 409 ? null : (res.json() as Promise<Record<string, unknown>>);
  };

  // 409: the demo user exists already, so sign in instead.
  if (!(await call("POST", "/auth/register", { email: DEMO_EMAIL, password: DEMO_PASSWORD }))) await call("POST", "/auth/login", { email: DEMO_EMAIL, password: DEMO_PASSWORD });
  const existing = new Set(((await call("GET", "/workflows")) as unknown as { slug: string }[]).map((w) => w.slug));
  for (const t of TEMPLATES) {
    if (existing.has(t.slug)) continue;
    const wf = (await call("POST", "/workflows", { name: t.name, slug: t.slug }))!;
    await call("POST", `/workflows/${wf.id}/versions`, { definition: t.definition, publish: true });
    for (const payload of SAMPLES[t.slug]) await call("POST", `/workflows/${wf.id}/test-runs`, { definition: t.definition, payload });
  }
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const url = process.env.SEED_URL ?? "http://localhost:3000";
  await seed(url);
  console.log(`seeded ${url}: sign in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
}
