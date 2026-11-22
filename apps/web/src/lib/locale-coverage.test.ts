import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hasTagalog } from "./locale";

const src = fileURLToPath(new URL("..", import.meta.url));
// Names that read the same in Taglish: brands, and Meta's own setup field labels, which owners match against Meta's console.
const SAME = new Set([
  "Daloy", "Google Sheets", "Slack",
  "App Secret", "Facebook Page ID", "Instagram Account ID:", "Instagram Business Account ID", "Page", "Page Access Token", "Page ID:", "Verify Token",
]);

describe("Taglish coverage", () => {
  it("translates every literal t() string on every console page", () => {
    const missing: string[] = [];
    for (const file of readdirSync(src).filter((name) => name.endsWith(".tsx"))) {
      const text = readFileSync(`${src}/${file}`, "utf8");
      for (const [, raw] of text.matchAll(/\bt\("((?:[^"\\]|\\.)+)"/g)) {
        const key = raw!.replace(/\\(.)/g, "$1");
        if (!SAME.has(key) && !hasTagalog(key)) missing.push(`${file}: ${key}`);
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });
});
