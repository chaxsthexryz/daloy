import { execSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";

// The seeded demo: `pnpm seed`, then sign in with the demo login from the README and find the templates and their test runs.
// SCREENSHOTS=1 also saves the README screenshots to docs/screenshots.
const shot = async (page: Page, name: string) => {
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `docs/screenshots/${name}.png` });
};

test("sign in to the seeded demo and browse its workflows and runs", async ({ page, baseURL }) => {
  execSync("pnpm seed", { env: { ...process.env, SEED_URL: baseURL }, stdio: "ignore" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByLabel("Email").fill("demo@daloy.local");
  await page.getByLabel("Password").fill("daloy-demo-2026");
  await page.getByRole("button", { name: "Sign in" }).click();
  for (const name of ["Inquiry triage", "Invoice follow-up", "Booking no-show follow-up"]) await expect(page.getByRole("link", { name })).toBeVisible();
  await shot(page, "workflows");

  await page.getByRole("link", { name: "Inquiry triage" }).click();
  // The trigger and five steps.
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
  await shot(page, "editor");

  // Both seeded test runs finish: mocked email and AI steps, no outside calls.
  await page.getByRole("navigation", { name: "This automation" }).getByRole("link", { name: "Activity" }).click();
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole("table").getByText("Done")).toHaveCount(2, { timeout: 1000 });
  }).toPass({ timeout: 60_000 });
  await shot(page, "run-history");

  await page.getByRole("table").getByRole("link").first().click();
  await expect(page.getByRole("heading", { name: "What happened", exact: true })).toBeVisible();
  await page.getByText("Details for a technician").click();
  await shot(page, "run");
});
