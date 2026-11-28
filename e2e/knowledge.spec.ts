import { expect, test, type Page } from "@playwright/test";
import { joinAs, registerOwner } from "./workspace";

// C3: the Knowledge page. Owner and operator add drafts with a base price and named rules, publish a numbered version,
// and an edit after that shows "not published" without touching the version in use. Same flow at 390 px and desktop,
// in English and in Taglish.
const WORDS = {
  en: { link: "Knowledge", page: "Knowledge", heading: "Knowledge", add: "Add an entry", save: "Save entry", publish: "Publish", live: "Live: version 1", unpublished: "You have changes that are not published.", rules: "1 named rules", empty: "No entries yet. Start with your rooms and your rates." },
  tl: { link: "Kaalaman", page: "Kaalaman", heading: "Kaalaman", add: "Magdagdag ng entry", save: "I-save ang entry", publish: "I-publish", live: "Live: bersyon 1", unpublished: "May mga pagbabago kang hindi pa na-publish.", rules: "1 pinangalanang patakaran sa presyo", empty: "Wala pang entry. Magsimula sa mga kuwarto at rate mo." },
} as const;

async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

for (const [viewport, size] of [["390 px", { width: 390, height: 844 }], ["desktop", { width: 1280, height: 800 }]] as const) {
  for (const lang of ["en", "tl"] as const) {
    test(`Knowledge: write, publish and edit after publish, ${viewport}, ${lang === "en" ? "English" : "Taglish"}`, async ({ page, browser }) => {
      const w = WORDS[lang];
      page.on("dialog", (d) => void d.accept());
      await page.setViewportSize(size);
      await registerOwner(page);
      if (lang === "tl") expect((await page.request.put("/settings/language", { data: { language: "tl" } })).ok()).toBe(true);
      await page.goto("/#/knowledge");
      await page.reload();
      await expect(page.getByRole("heading", { name: w.page, level: 1 })).toBeVisible();
      await expect(page.locator('#main-menu a[href="#/business?tab=knowledge"]')).toHaveAttribute("data-active", "true");
      await expect(page.getByText(w.empty)).toBeVisible();
      await expect(page.getByRole("button", { name: w.publish, exact: true })).toBeDisabled();

      // A room with a base price, a deposit percent and one named season rule.
      await page.getByRole("button", { name: w.add }).click();
      await page.locator("#kn-title").fill("Garden room");
      await page.locator("#kn-body").fill("Sleeps four. Fan only.");
      await page.locator("#kn-price").fill("3500");
      await page.locator("#kn-capacity").fill("4");
      await page.locator("#kn-deposit").selectOption("percent");
      await expect(page.locator(".kn-required-badge")).toBeVisible();
      await page.locator("#kn-deposit-value").fill("30");
      await page.locator("#kn-form-title ~ fieldset").getByRole("button").last().click(); // Add a rule
      await page.locator("#kn-rule-name-0").fill("Peak season");
      await page.locator("#kn-rule-price-0").fill("4800");
      await page.locator("#kn-rule-from-0").fill("12-15");
      await page.locator("#kn-rule-to-0").fill("01-10");
      await noSideScroll(page);
      await page.getByRole("button", { name: w.save }).click();

      const row = page.getByRole("listitem").filter({ hasText: "Garden room" });
      await expect(page.getByText("1 entry", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: w.add })).not.toHaveClass(/\bblue\b/);
      await expect(row).toContainText(`PHP 3,500`);
      await expect(row).toContainText(w.rules);
      await expect(page.getByText(w.unpublished)).toBeVisible();

      await page.getByRole("button", { name: w.publish, exact: true }).click();
      await expect(page.getByRole("heading", { name: w.live })).toBeVisible();
      await expect(page.getByRole("button", { name: w.publish, exact: true })).toBeDisabled();

      if (lang === "en") {
        await page.getByRole("button", { name: w.add }).click();
        await page.locator("#kn-kind").selectOption("arrival");
        await page.locator("#kn-title").fill("Check-in hours");
        await page.locator("#kn-check-in").fill("15:00");
        await page.locator("#kn-check-out").fill("11:00");
        await page.getByRole("button", { name: w.save }).click();
        await expect(page.getByRole("listitem").filter({ hasText: "Check-in hours" })).toContainText("3:00 PM / 11:00 AM");
        await page.getByRole("listitem").filter({ hasText: "Check-in hours" }).getByRole("button", { name: "Delete Check-in hours" }).click();
        await expect(page.getByRole("listitem").filter({ hasText: "Check-in hours" })).toHaveCount(0);
      }

      // An edit after publish is only a draft: version 1 stays live and Publish wakes up.
      await row.getByRole("button").first().click();
      await page.locator("#kn-price").fill("3900");
      await page.getByRole("button", { name: w.save }).click();
      await expect(row).toContainText("PHP 3,900");
      await expect(page.getByRole("heading", { name: w.live })).toBeVisible();
      await expect(page.getByText(w.unpublished)).toBeVisible();
      const live = await page.request.get("/knowledge/versions/1");
      expect((await live.json()).entries[0].fields.price).toBe(3500);
      await noSideScroll(page);

      // An operator sees the page; a requester does not get the link.
      if (lang === "en") {
        // The invite form lives on the Team page, so the owner makes the links at desktop width; the joined member gets this viewport.
        await page.setViewportSize({ width: 1280, height: 800 });
        const operator = await joinAs(browser, page, "Operator", size);
        await operator.goto("/#/knowledge");
        await operator.reload();
        await expect(operator.getByRole("heading", { name: "Knowledge", level: 1 })).toBeVisible();
        await expect(operator.getByRole("listitem").filter({ hasText: "Garden room" })).toBeVisible();
        const requester = await joinAs(browser, page, "Requester", size);
        expect((await requester.request.get("/knowledge")).status()).toBe(403);
      }
    });
  }
}
