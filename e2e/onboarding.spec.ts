import { captureReview } from "./review-capture";
import { expect, test, type Page } from "@playwright/test";

// Roadmap R1: a new owner answers three screens and gets one editable draft with a sample order. Nothing is
// connected, published or sent, and a second pass opens the same draft.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);

async function register(page: Page, tag: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`${tag}-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("link", { name: "Start setup" })).toBeVisible();
}

const next = (page: Page) => page.getByRole("button", { name: "Next", exact: true });

test("a new owner reaches a draft with a sample order in three screens, and running it twice opens the same draft", async ({ page }) => {
  await register(page, "onb-desktop");
  await page.getByRole("link", { name: "Start setup" }).click();

  // Screen 1: the step is in words and in the progress bar, and Next waits for a name.
  await expect(page.getByText("Set up kymavo")).toBeVisible();
  await expect(page.locator("main")).not.toContainText("Daloy");
  await expect(page.getByText("Step 1 of 3: Your business")).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "Step 1 of 3: Your business");
  await expect(page.getByRole("heading", { name: "What name should customers see?" })).toBeFocused();
  await expect(next(page)).toBeDisabled();
  await page.getByLabel("Business name").fill("Ana's Sweets");
  await expect(page.locator(".ob-mark")).toHaveText("AS");
  const preview = page.locator(".brand-preview");
  await expect(preview.getByText("Ana's Sweets")).toBeVisible();
  await preview.getByRole("tab", { name: "Payment page" }).click();
  await expect(preview.getByText("PHP 1,500.00")).toBeVisible();
  await expect(preview.getByText("Upload receipt")).toBeVisible();
  await preview.getByRole("tab", { name: "Public form" }).click();
  await captureReview(page, "01", "Business name", "The public business name appears in the preview.");
  await page.getByLabel("Website").fill("https://anassweets.example");
  await page.getByLabel(/^Logo/).setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
  await expect(page.locator(".ob-mark img")).toBeVisible();
  await expect(page.locator(".ob .file-picker-name")).toHaveText("logo.png");
  await expect(page.getByText("Your logo is saved.")).toBeVisible();
  await next(page).click();

  // Screen 2: one primary category, up to three related ones.
  await expect(page.getByText("Step 2 of 3: Business type")).toBeVisible();
  await expect(next(page)).toBeDisabled();
  await page.getByRole("radio", { name: /Food orders/ }).check();
  await expect(page.getByRole("checkbox", { name: /Food orders/ })).toHaveCount(0);
  for (const name of ["Online retail", "Beauty and wellness", "Professional services"]) await page.getByRole("checkbox", { name: new RegExp(name) }).check();
  await expect(page.getByRole("checkbox", { name: /^Other/ })).toBeDisabled();
  await captureReview(page, "02", "Business categories", "The owner picked Food orders and three related categories.");
  await next(page).click();

  // Screen 3: a suggested first workflow, and a payment choice only for the workflows that take money.
  await expect(page.getByText("Step 3 of 3: First workflow")).toBeVisible();
  await expect(page.getByRole("radio", { name: /Order follow-up/ })).toBeChecked();
  await expect(page.getByRole("button", { name: "Create my draft" })).toBeDisabled();
  await page.getByRole("radio", { name: /Bookings/ }).check();
  await expect(page.getByText("How do customers pay?")).toHaveCount(0);
  await page.getByRole("radio", { name: /Order follow-up/ }).check();
  await page.getByRole("radio", { name: /Pay later/ }).check();
  await captureReview(page, "03", "First workflow", "The owner can start with an order workflow and pick how customers pay.");
  await page.getByRole("button", { name: "Create my draft" }).click();

  await expect(page.getByRole("heading", { name: "Your draft is ready" })).toBeVisible();
  await expect(page.getByText("SAMPLE-1001")).toBeVisible();
  await expect(page.getByText("Nothing is connected, published or sent yet.")).toBeVisible();
  const open = page.getByRole("link", { name: "Open my draft" });
  const draft = await open.getAttribute("href");
  expect(draft).toMatch(/^#\/a\/[0-9a-f-]{36}$/);

  // The answers survived a reload. Onboarding again shows the same draft, and Edit my answers goes back to screen 1.
  await page.goto("/#/onboarding");
  await page.reload();
  await expect(page.getByRole("link", { name: "Open my draft" })).toHaveAttribute("href", draft!);
  await page.getByRole("button", { name: "Edit my answers" }).click();
  await expect(page.getByLabel("Business name")).toHaveValue("Ana's Sweets");
  await expect(page.getByLabel("Website")).toHaveValue("https://anassweets.example");
  await next(page).click();
  await expect(page.getByRole("radio", { name: /Food orders/ })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /Online retail/ })).toBeChecked();
  await next(page).click();
  await expect(page.getByRole("radio", { name: /Pay later/ })).toBeChecked();
  await page.getByRole("button", { name: "Create my draft" }).click();
  await expect(page.getByRole("link", { name: "Open my draft" })).toHaveAttribute("href", draft!);

  // One draft in the workspace, still a draft, and the setup card is gone from Automations.
  await page.goto("/#/");
  await expect(page.getByRole("link", { name: "Start setup" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Resume setup" })).toHaveCount(0);
  await page.goto(`/${draft}`);
  await expect(page.getByRole("heading", { name: /order/i }).first()).toBeVisible();
});

test("Save and close keeps the answer, Resume setup returns to the next screen and Back shows it again", async ({ page }) => {
  await register(page, "onb-resume");
  await page.getByRole("link", { name: "Start setup" }).click();
  await page.getByLabel("Business name").fill("Lim Dental");
  await page.getByRole("button", { name: "Save and close" }).click();

  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByText("Step 2 of 3: Business type")).toBeVisible();
  await page.getByRole("link", { name: "Resume setup" }).click();
  await expect(page.getByRole("heading", { name: "What kind of business do you run?" })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByLabel("Business name")).toHaveValue("Lim Dental");

  // The name is the workspace's business name, so Business settings shows it.
  await page.goto("/#/settings/business");
  await expect(page.getByLabel("Business name")).toHaveValue("Lim Dental");
});

test("Not now hides the card and #/onboarding still opens", async ({ page }) => {
  await register(page, "onb-skip");
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByRole("link", { name: "Start setup" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Today" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Start setup" })).toHaveCount(0);
  await page.goto("/#/onboarding");
  await expect(page.getByText("Step 1 of 3: Your business")).toBeVisible();
});

test("on a phone the action bar stays on screen with the keyboard open, and the flow reads in Tagalog", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await register(page, "onb-phone");
  await page.request.put("/settings/language", { data: { language: "tl" } });
  await page.reload();
  await page.getByRole("link", { name: "Simulan ang setup" }).click();
  await expect(page.getByText("Hakbang 1 sa 3: Ang negosyo mo")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Anong pangalan ang dapat makita ng mga customer?" })).toBeVisible();

  // A shorter viewport stands in for the keyboard: the page scrolls, but the primary button stays inside it.
  await page.getByLabel("Pangalan ng negosyo").fill("Kape ni Mara");
  await captureReview(page, "04", "Tagalog setup", "The same setup starts in Tagalog.", "tl");
  await page.setViewportSize({ width: 390, height: 420 });
  await page.getByLabel("Pangalan ng negosyo").focus();
  const button = page.getByRole("button", { name: "Susunod" });
  await expect(button).toBeInViewport({ ratio: 1 });
  const box = (await button.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  // Enter in the field goes to the next screen, as the on-screen keyboard's Go key does.
  await page.getByLabel("Pangalan ng negosyo").press("Enter");
  await expect(page.getByText("Hakbang 2 sa 3: Uri ng negosyo")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("radio", { name: /Beauty at wellness/ }).check();
  await expect(page.getByRole("button", { name: "Susunod" })).toBeInViewport({ ratio: 1 });
  await page.getByRole("button", { name: "Susunod" }).click();
  await expect(page.getByRole("radio", { name: /Mga booking/ })).toBeChecked();
  await expect(page.getByText("Iminumungkahi")).toBeVisible();
  await page.getByRole("button", { name: "Gawin ang draft ko" }).click();
  await expect(page.getByRole("heading", { name: "Handa na ang draft mo" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Buksan ang draft ko" })).toBeInViewport();
  // No horizontal scroll on a phone.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("direct #/signup lands in Step 1 of onboarding and Resorts and hotels suggests Bookings", async ({ page }) => {
  await page.goto("/#/signup");
  await expect(page.getByRole("heading", { name: "Create an account" })).toBeVisible();
  await page.getByLabel("Email").fill(`signup-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL(/#\/onboarding$/);
  await expect(page.getByText("Step 1 of 3: Your business")).toBeVisible();
  await page.getByLabel("Business name").fill("Casa del Mar Resort");
  await next(page).click();

  await expect(page.getByText("Step 2 of 3: Business type")).toBeVisible();
  await page.getByRole("radio", { name: /Resorts and hotels/ }).check();
  await next(page).click();

  await expect(page.getByText("Step 3 of 3: First workflow")).toBeVisible();
  await expect(page.getByRole("radio", { name: /Bookings/ })).toBeChecked();
  await expect(page.locator("main")).not.toContainText("Daloy");
});
