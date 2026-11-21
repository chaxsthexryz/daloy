import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL, URL } from "node:url";
import { env } from "node:process";
import { chromium } from "@playwright/test";

const dir = "test-results/review-frames";
const captures = [];
for (const file of (await readdir(dir)).sort()) {
  captures.push(JSON.parse(await readFile(resolve(dir, file), "utf8")));
}
const keys = ["Business name", "Business categories", "First workflow", "Tagalog setup", "Workflow steps",
  "Customer payment page", "Reference received", "Receipts to review", "Verified deposit", "Pay later", "Retry the reply"];
for (const name of keys) {
  assert.deepEqual(captures.filter(c => c.name === name).map(c => c.width).sort((a, b) => a - b), [390, 1440], name);
}
const template = (await readFile(new URL("./walkthrough.html", import.meta.url), "utf8"))
  .replaceAll("1180", "1440").replaceAll("Daloy console review", "Daloy onboarding and payments");
const data = JSON.stringify({ captures, commit: env.GITHUB_SHA ?? "" }).replaceAll("<", "\\u003c");
const output = resolve("test-results/daloy-onboarding-payments.html");
await writeFile(output, template.replace("<!-- WALKTHROUGH_DATA -->", () => data));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ offline: true });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(pathToFileURL(output).href);
  for (const { language, width, name } of captures) {
    await page.getByLabel("Language", { exact: true }).selectOption(language);
    await page.getByLabel("Layout", { exact: true }).selectOption(String(width));
    await page.getByLabel("Screen", { exact: true }).selectOption(name);
    const image = page.getByRole("img");
    assert.equal(await image.getAttribute("alt"), name + " at " + width + "px (" + (language === "en" ? "English" : "Tagalog") + ")");
    assert.equal(await image.evaluate(async el => { await el.decode(); return el.naturalWidth; }), width);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
