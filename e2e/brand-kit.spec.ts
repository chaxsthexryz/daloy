import { expect, test } from "@playwright/test";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);

test("the owner saves a logo and colour in Business settings, and a script-carrying SVG is refused", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`brand-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();

  await page.goto("/#/settings/business");
  await expect(page.getByText("No logo yet.")).toBeVisible();

  await page.getByLabel(/^Logo \(PNG/).setInputFiles({ name: "logo.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') });
  await page.getByRole("button", { name: "Upload logo" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "PNG, JPEG or WebP" })).toBeVisible();
  await expect(page.getByText("No logo yet.")).toBeVisible();

  await page.getByLabel(/^Logo \(PNG/).setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
  await page.getByRole("button", { name: "Upload logo" }).click();
  await expect(page.getByText("Logo saved.")).toBeVisible();
  await expect(page.getByText("A logo is saved.")).toBeVisible();

  await page.getByLabel("Accent colour").fill("#0b3d91");
  await page.getByRole("button", { name: "Save colour" }).click();
  await expect(page.getByText("Colour saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Accent colour")).toHaveValue("#0b3d91");

  await page.getByRole("button", { name: "Remove logo" }).click();
  await expect(page.getByText("No logo yet.")).toBeVisible();
});
