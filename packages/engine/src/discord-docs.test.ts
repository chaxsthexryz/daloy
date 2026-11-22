import { describe, expect, it } from "vitest";
import { definitionSchema } from "./definition";
import { checkDiscordContent, DISCORD_MAX_CHARS, docsReplaceRequests, googleDocUrl, isPlaceholderKey } from "./discord-docs";

describe("Discord content", () => {
  it("trims the text and accepts a normal message", () => {
    expect(checkDiscordContent("  New order REQ-12  ")).toEqual({ ok: true, value: "New order REQ-12" });
  });
  it("refuses an empty message, and one that is only spaces", () => {
    expect(checkDiscordContent("")).toMatchObject({ ok: false });
    expect(checkDiscordContent(" \n ")).toMatchObject({ ok: false });
  });
  it("allows exactly the limit and refuses one more character", () => {
    expect(checkDiscordContent("a".repeat(DISCORD_MAX_CHARS))).toMatchObject({ ok: true });
    const over = checkDiscordContent("a".repeat(DISCORD_MAX_CHARS + 1));
    expect(over).toMatchObject({ ok: false });
    expect(over.ok === false && over.error).toContain("2000");
  });
  it("counts an emoji as one character, as Discord does", () => {
    expect(checkDiscordContent("😀".repeat(DISCORD_MAX_CHARS))).toMatchObject({ ok: true });
  });
});

describe("Google Docs placeholders", () => {
  it("accepts plain names and refuses braces, empty names and long names", () => {
    for (const k of ["name", "order_id", "Customer name", "due-date", "a.b"]) expect(isPlaceholderKey(k), k).toBe(true);
    for (const k of ["", " ", "{{name}}", "a}", "x".repeat(41), "line\nbreak"]) expect(isPlaceholderKey(k), JSON.stringify(k)).toBe(false);
  });

  type Req = { replaceAllText: { containsText: { text: string; matchCase: boolean }; replaceText: string } };
  /** What Docs does with a batch: each request in order, on the text the one before it left. */
  const apply = (doc: string, requests: Req[]) => requests.reduce((d, r) => d.split(r.replaceAllText.containsText.text).join(r.replaceAllText.replaceText), doc);

  it("matches {{key}} exactly, with case, and swaps each token for its value", () => {
    const req = docsReplaceRequests({ name: "Ana Cruz", total: "PHP 1,200" }, "n1");
    expect(req).toHaveLength(4);
    expect(req.every((r) => r.replaceAllText.containsText.matchCase)).toBe(true);
    expect(req.slice(0, 2).map((r) => r.replaceAllText.containsText.text)).toEqual(["{{name}}", "{{total}}"]);
    expect(req.slice(2).map((r) => r.replaceAllText.replaceText)).toEqual(["Ana Cruz", "PHP 1,200"]);
    expect(apply("Dear {{name}}, you owe {{total}}. {{Name}} stays.", req)).toBe("Dear Ana Cruz, you owe PHP 1,200. {{Name}} stays.");
  });

  it("makes no request when there are no values", () => {
    expect(docsReplaceRequests({})).toEqual([]);
  });

  it("puts a value that contains a placeholder in as plain text, with no second pass", () => {
    const req = docsReplaceRequests({ a: "{{b}}", b: "x" }, "n2");
    expect(apply("A={{a}} B={{b}}", req)).toBe("A={{b}} B=x");
  });

  it("does not let a value change which text a later request matches, whatever the order of keys", () => {
    const req = docsReplaceRequests({ b: "x", a: "{{b}}" }, "n3");
    expect(apply("{{a}} {{b}}", req)).toBe("{{b}} x");
  });

  it("uses a different token each call, so a visitor cannot type one", () => {
    const a = docsReplaceRequests({ k: "v" })[0]!.replaceAllText.replaceText;
    const b = docsReplaceRequests({ k: "v" })[0]!.replaceAllText.replaceText;
    expect(a).not.toBe(b);
  });

  it("builds the link from the id alone", () => {
    expect(googleDocUrl("1AbC_d-9")).toBe("https://docs.google.com/document/d/1AbC_d-9/edit");
    expect(() => googleDocUrl("a/b")).toThrow();
  });
});

describe("Discord and Google Docs steps in a definition", () => {
  const parse = (steps: unknown, edges: unknown[] = []) => definitionSchema.safeParse({ trigger: { type: "manual", config: {} }, steps, edges });

  it("accepts a discord step and a google_docs step", () => {
    const r = parse([
      { id: "ping", type: "discord", config: { text: "New order {{trigger.reference}}" } },
      { id: "doc", type: "google_docs", config: { templateId: "1AbCdEfGhIjKlMn", name: "Invoice {{trigger.reference}}", values: { name: "{{trigger.name}}" } } },
    ], [{ from: "ping", to: "doc" }]);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
  it("refuses a discord message above 2000 characters and an empty one", () => {
    expect(parse([{ id: "ping", type: "discord", config: { text: "a".repeat(2001) } }]).success).toBe(false);
    expect(parse([{ id: "ping", type: "discord", config: { text: "" } }]).success).toBe(false);
  });
  it("refuses a placeholder name with braces and more than 50 values", () => {
    expect(parse([{ id: "doc", type: "google_docs", config: { templateId: "1AbCdEfGhIjKlMn", name: "x", values: { "{{a}}": "b" } } }]).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, "v"]));
    expect(parse([{ id: "doc", type: "google_docs", config: { templateId: "1AbCdEfGhIjKlMn", name: "x", values: many } }]).success).toBe(false);
  });
  it("refuses a google_docs step with no template or a template id that is not a file id", () => {
    expect(parse([{ id: "doc", type: "google_docs", config: { name: "x" } }]).success).toBe(false);
    expect(parse([{ id: "doc", type: "google_docs", config: { templateId: "../etc", name: "x" } }]).success).toBe(false);
  });
  it("lets a later step read the document link", () => {
    const r = parse([
      { id: "doc", type: "google_docs", config: { templateId: "1AbCdEfGhIjKlMn", name: "x" } },
      { id: "ping", type: "discord", config: { text: "Doc: {{steps.doc.output.url}}" } },
    ], [{ from: "doc", to: "ping" }]);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
});
