import { describe, expect, it } from "vitest";
import { approvalShell, escapeHtml, groupFields, safeColour, shell, splitErrors } from "./public-pages";

describe("splitErrors", () => {
  it("puts each message under its field and keeps the rest as general messages", () => {
    const r = splitErrors(["summary: must be text", "amount: must be at least 1", "payload: expected object", "files: must be a PDF"], ["summary", "amount"]);
    expect(r.byField.get("summary")).toBe("must be text");
    expect(r.byField.get("amount")).toBe("must be at least 1");
    expect(r.general).toEqual(["payload: expected object", "files: must be a PDF"]);
  });
  it("keeps the first message of a field and does not read a colon inside the message as a field", () => {
    const r = splitErrors(["a: first", "a: second", "b: note: with colon"], ["a", "b"]);
    expect(r.byField.get("a")).toBe("first");
    expect(r.byField.get("b")).toBe("note: with colon");
  });
});

describe("groupFields", () => {
  const f = (name: string, type: string) => ({ name, label: name, type, required: false }) as never;
  it("pairs neighbouring short fields and leaves long ones alone", () => {
    const rows = groupFields([f("a", "text"), f("b", "number"), f("c", "email"), f("d", "textarea"), f("e", "number")]);
    expect(rows.map((r) => r.map((x) => x.name))).toEqual([["a"], ["b", "c"], ["d"], ["e"]]);
  });
  it("does not pair three in a row into one", () => {
    expect(groupFields([f("a", "number"), f("b", "number"), f("c", "number")]).map((r) => r.length)).toEqual([2, 1]);
  });
});

describe("safeColour", () => {
  it("accepts a #rrggbb colour and falls back for anything else, so a stored value cannot add CSS", () => {
    expect(safeColour("#1F6B45", "#000000")).toBe("#1F6B45");
    expect(safeColour("red;}</style><script>", "#000000")).toBe("#000000");
    expect(safeColour(null, "#123456")).toBe("#123456");
  });
});

describe("page shells", () => {
  const brand = { id: "w1", name: "Sampaguita <b>", accent: "#1f6b45", ink: "#ffffff", logo: true };
  it("sets the language, the embed class and the brand colours", () => {
    const html = shell({ body: "<p>x</p>", title: "T", language: "tl", brand, embed: true });
    expect(html).toContain('lang="tl"');
    expect(html).toContain('class="embed"');
    expect(html).toContain("--accent:#1f6b45");
    expect(html).toContain('src="/brand/logo/w1"');
  });
  it("shows no brand rule and a black button when no brand is set", () => {
    const html = shell({ body: "<p>x</p>", title: "T", language: "en" });
    expect(html).toContain("--accent:#0a0b0f");
    expect(html).not.toContain("/brand/logo/");
    expect(html).not.toContain('class="ruled"');
  });
  it("escapes the business name on the approval page and uses the kymavo mark without a brand", () => {
    const branded = approvalShell({ title: "Link", heading: "H", body: "", language: "en", brand });
    expect(branded).toContain("Sampaguita &lt;b&gt;");
    expect(branded).not.toContain("Sampaguita <b>");
    const plain = approvalShell({ title: "Link", heading: "H", body: "", language: "en", eyebrow: "Approval" });
    expect(plain).toContain(">kymavo<");
    expect(plain).toContain("--accent:#1b45c9");
    expect(plain).toContain(">Approval<");
  });
});

describe("escapeHtml", () => {
  it("escapes the five characters", () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });
});
