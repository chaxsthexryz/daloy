import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { STEP_CATALOG, TRIGGER_CATALOG } from "@daloy/engine";
import { APP_LOGO, ICON_KEYS, LETTER_TILES, LOGOS } from "./AppMark";

const dir = resolve(__dirname, "../public/logos");
const files = readdirSync(dir).filter((f) => f.endsWith(".svg"));
const readme = readFileSync(resolve(dir, "README.md"), "utf8");

describe("app logos", () => {
  it("has one SVG for every logo the code names, and no stray files", () => {
    expect(files.map((f) => f.replace(".svg", "")).sort()).toEqual([...LOGOS].sort());
  });
  it.each([...LOGOS])("%s is a plain SVG with a source, terms and date in the README", (name) => {
    const svg = readFileSync(resolve(dir, `${name}.svg`), "utf8");
    expect(svg).toMatch(/<svg[\s>]/);
    expect(svg).not.toMatch(/<script|onload=|onclick=|<foreignObject|<image|href="http/i);
    expect(readme).toContain(`${name}.svg`);
  });
  it("records a reason for each brand that stayed a letter tile", () => {
    for (const name of LETTER_TILES) expect(readme.toLowerCase()).toContain(name);
  });
  it("gives every mark the catalog uses a logo, a line icon or a letter tile", () => {
    const known = new Set<string>([...LOGOS, ...ICON_KEYS, ...LETTER_TILES]);
    for (const e of [...Object.values(STEP_CATALOG), ...Object.values(TRIGGER_CATALOG)]) expect(known.has(e.mark), `no picture for mark "${e.mark}"`).toBe(true);
    for (const logo of Object.values(APP_LOGO)) expect(LOGOS as readonly string[]).toContain(logo);
  });
});
