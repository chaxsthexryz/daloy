import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";

/** Capture an asserted UI state from a real browser run using the suite's fake providers. */
export async function captureReview(page: Page, key: string, name: string, note: string, language = "en") {
  if (!process.env.DALOY_WALKTHROUGH) return;
  const dir = join("test-results", "review-frames");
  await mkdir(dir, { recursive: true });
  const original = page.viewportSize();
  const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  try {
    for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
      });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
        { message: name + " page overflow at " + size.width + "px" }).toBeLessThanOrEqual(0);
      const frame = await page.screenshot({ type: "jpeg", quality: 80, animations: "disabled", fullPage: true });
      await writeFile(join(dir, key + "-" + size.width + ".json"), JSON.stringify({
        name, note, language, width: size.width, image: frame.toString("base64"),
      }));
    }
  } finally {
    if (original) await page.setViewportSize(original);
    await page.evaluate(({ x, y }) => window.scrollTo(x, y), scroll);
  }
}
