/* global document, window */
import assert from "node:assert/strict";
import console from "node:console";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { chromium, expect } from "@playwright/test";
import { makeFixtures } from "./fixtures.mjs";
import { checkNavigationAndActions, screens } from "./screens.mjs";

const dist = fileURLToPath(new URL("../../apps/web/dist", import.meta.url));
const output = resolve(process.argv[2] ?? fileURLToPath(new URL("../../test-results/console-review/console-review.html", import.meta.url)));
const origin = "http://127.0.0.1:17881";
const layouts = [{ width: 1180, height: 883 }, { width: 390, height: 844 }];
const languages = ["en", "tl"];
const browser = await chromium.launch();

try {
  const context = await browser.newContext({ reducedMotion: "reduce", timezoneId: "Asia/Manila", serviceWorkers: "block" });
  const page = await context.newPage();
  const issues = [];
  let sample = "";
  let fixture;
  page.setDefaultTimeout(5000);
  page.on("pageerror", (error) => issues.push(`${sample}: ${error.message}`));
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.origin !== origin) {
      issues.push(`${sample}: unexpected request to ${url.origin}`);
      return route.abort();
    }
    const response = fixture(url, method, request.postData());
    if (response?.html) return route.fulfill({ body: response.html, contentType: "text/html; charset=utf-8", status: response.status ?? 200 });
    if (response) return route.fulfill({ status: response.status ?? 200, json: response.json });
    if (method === "GET" && !["xhr", "fetch"].includes(request.resourceType())) {
      const path = resolve(dist, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
      if (path.startsWith(dist + sep)) {
        try {
          return await route.fulfill({ path });
        } catch {
          // Report missing build assets alongside any unhandled fixture routes.
        }
      }
    }
    issues.push(`${sample}: no fixture or build asset for ${method} ${url.pathname}`);
    return route.fulfill({ status: 404, body: "" });
  });

  async function open(screen, language = "en") {
    fixture = makeFixtures({ ...screen, language });
    // A fresh document reloads the simulated sign-in and clears in-page state.
    await page.goto("about:blank");
    const response = await page.goto(origin + (screen.url ?? `/#/${screen.path}`));
    assert(response?.ok(), `Could not load ${sample}`);
    await expect(page.locator("html")).toHaveAttribute("lang", language);
  }

  const captures = [];
  for (const layout of layouts) {
    await page.setViewportSize(layout);
    for (const [index, language] of languages.entries()) {
      for (const screen of screens.filter(({ title }) => title[index])) {
        sample = `${screen.name}, ${language}, ${layout.width}px`;
        try {
          await open(screen, language);
          await expect(page.getByRole("heading", { name: screen.title[index], exact: true }).first()).toBeVisible();
          await screen.verify(page, language);
          await page.evaluate(() => document.fonts.ready);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          assert(overflow <= 1, `Page is ${overflow}px wider than the viewport`);
          assert.deepEqual(issues, []);
          const image = await page.screenshot({ type: "jpeg", quality: 82, fullPage: true, animations: "disabled" });
          captures.push({ name: screen.name, note: screen.note, language, width: layout.width, image: image.toString("base64") });
          console.info(`Captured ${sample}`);
        } catch (error) {
          throw new Error(`Review failed for ${sample}`, { cause: error });
        }
      }
    }
  }

  sample = "Keyboard and fixture actions";
  await checkNavigationAndActions(page, open);
  assert.deepEqual(issues, []);
  console.info("Passed navigation, keyboard focus, no-show, archive and hosted form submission checks");
  await context.close();

  const template = await readFile(new URL("./walkthrough.html", import.meta.url), "utf8");
  const commit = process.env.GITHUB_SHA ?? "";
  const data = JSON.stringify({ captures, commit }).replaceAll("<", "\\u003c");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, template.replace("<!-- WALKTHROUGH_DATA -->", () => data), "utf8");

  const offline = await browser.newPage({ offline: true });
  const offlineErrors = [];
  offline.on("pageerror", (error) => offlineErrors.push(error.message));
  await offline.goto(pathToFileURL(output).href);
  const image = offline.getByRole("img");
  for (const capture of captures) {
    await offline.getByLabel("Language", { exact: true }).selectOption(capture.language);
    await offline.getByLabel("Layout", { exact: true }).selectOption(String(capture.width));
    await offline.getByLabel("Screen", { exact: true }).selectOption(capture.name);
    await expect(image).toHaveAttribute("alt", `${capture.name} at ${capture.width}px (${capture.language === "en" ? "English" : "Tagalog"})`);
    const width = await image.evaluate(async (element) => {
      await element.decode();
      return element.naturalWidth;
    });
    assert.equal(width, capture.width, `Offline image width for ${capture.name}`);
  }
  assert.deepEqual(offlineErrors, []);
  console.info(`Verified ${captures.length} images offline in ${output}`);
} finally {
  await browser.close();
}
