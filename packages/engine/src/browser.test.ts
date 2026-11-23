import { describe, expect, it } from "vitest";
import { BLOCKED_RANGES, BROWSER_MAX_ACTIONS, browserActionsSchema, browserConfigSchema, refusedFillField, refusedFillValue, wouldDo } from "./browser";
import { definitionSchema } from "./definition";
import { lintDefinition } from "./lint";

const ok = (actions: unknown[]) => browserConfigSchema.safeParse({ url: "https://shop.example.com", actions });

describe("browser action schema", () => {
  it("accepts each action kind", () => {
    const r = ok([
      { action: "goto", url: "https://shop.example.com/item/{{trigger.sku}}" },
      { action: "click", selector: "#accept" },
      { action: "click", text: "Add to cart" },
      { action: "fill", selector: "input[name=q]", value: "{{trigger.name}}" },
      { action: "wait", selector: ".price" },
      { action: "extract", selector: ".price", name: "price" },
      { action: "screenshot" },
    ]);
    expect(r.success).toBe(true);
  });

  it("allows at most 20 actions", () => {
    expect(BROWSER_MAX_ACTIONS).toBe(20);
    expect(ok(Array.from({ length: 20 }, () => ({ action: "wait", selector: "body" }))).success).toBe(true);
    expect(ok(Array.from({ length: 21 }, () => ({ action: "wait", selector: "body" }))).success).toBe(false);
  });

  it("needs exactly one of selector or text on a click", () => {
    expect(ok([{ action: "click" }]).success).toBe(false);
    expect(ok([{ action: "click", selector: "a", text: "Buy" }]).success).toBe(false);
  });

  it("refuses unknown actions and extra keys", () => {
    expect(ok([{ action: "upload", selector: "input" }]).success).toBe(false);
    expect(ok([{ action: "screenshot", fullPage: true }]).success).toBe(false);
    expect(ok([{ action: "eval", script: "alert(1)" }]).success).toBe(false);
  });

  it("checks extract names: format, unique, not a reserved output key", () => {
    expect(ok([{ action: "extract", selector: "h1", name: "Price!" }]).success).toBe(false);
    expect(ok([{ action: "extract", selector: "h1", name: "a" }, { action: "extract", selector: "h2", name: "a" }]).success).toBe(false);
    for (const name of ["url", "screenshots", "mocked", "wouldDo"]) expect(ok([{ action: "extract", selector: "h1", name }]).success).toBe(false);
  });

  it("allows at most 5 screenshots", () => {
    expect(ok(Array.from({ length: 5 }, () => ({ action: "screenshot" }))).success).toBe(true);
    expect(ok(Array.from({ length: 6 }, () => ({ action: "screenshot" }))).success).toBe(false);
  });

  it("only allows http and https in a literal goto address", () => {
    expect(ok([{ action: "goto", url: "file:///etc/passwd" }]).success).toBe(false);
    expect(ok([{ action: "goto", url: "javascript:alert(1)" }]).success).toBe(false);
    expect(browserConfigSchema.safeParse({ url: "chrome://settings", actions: [] }).success).toBe(false);
    // A template is checked again by the service once it is filled in.
    expect(ok([{ action: "goto", url: "{{trigger.link}}" }]).success).toBe(true);
  });

  it("is a step type in a workflow definition", () => {
    const def = { trigger: { type: "manual", config: {} }, steps: [{ id: "look", type: "browser", config: { url: "https://shop.example.com", actions: [{ action: "screenshot" }] } }], edges: [] };
    expect(definitionSchema.safeParse(def).success).toBe(true);
  });

  it("is the same schema the service checks a resolved list with", () => {
    expect(browserActionsSchema.safeParse([{ action: "screenshot" }]).success).toBe(true);
  });
});

describe("refusedFillField", () => {
  it("refuses password fields", () => {
    expect(refusedFillField({ type: "password", autocomplete: "" })).toMatch(/password/);
    expect(refusedFillField({ type: "PASSWORD", autocomplete: "" })).toMatch(/password/);
    expect(refusedFillField({ type: "text", autocomplete: "current-password" })).toMatch(/password/);
    expect(refusedFillField({ type: "text", autocomplete: "section-a new-password" })).toMatch(/password/);
    expect(refusedFillField({ type: "text", autocomplete: "one-time-code" })).toMatch(/code/);
  });

  it("refuses card fields", () => {
    for (const ac of ["cc-number", "cc-csc", "cc-exp", "billing cc-name", "CC-NUMBER"]) expect(refusedFillField({ type: "text", autocomplete: ac })).toMatch(/card/);
    expect(refusedFillField({ type: "text", autocomplete: "", name: "cardnumber" })).toMatch(/card/);
    expect(refusedFillField({ type: "tel", autocomplete: "", name: "cvv" })).toMatch(/card/);
  });

  it("allows ordinary fields", () => {
    expect(refusedFillField({ type: "text", autocomplete: "name" })).toBeNull();
    expect(refusedFillField({ type: "email", autocomplete: "email", name: "email" })).toBeNull();
    expect(refusedFillField({ type: "search", autocomplete: "" })).toBeNull();
  });
});

describe("refusedFillValue", () => {
  it("refuses a value that is a card number", () => {
    expect(refusedFillValue("4111 1111 1111 1111")).toMatch(/card/);
    expect(refusedFillValue("4242-4242-4242-4242")).toMatch(/card/);
  });

  it("allows phone numbers and order numbers that fail the card check", () => {
    expect(refusedFillValue("09171234567")).toBeNull();
    expect(refusedFillValue("1234 5678 9012 3456")).toBeNull();
    expect(refusedFillValue("Ana Reyes")).toBeNull();
  });
});

describe("wouldDo", () => {
  it("describes each action without the typed value", () => {
    const lines = wouldDo("https://shop.example.com", [
      { action: "click", text: "Add to cart" },
      { action: "fill", selector: "#q", value: "secret text" },
      { action: "extract", selector: ".price", name: "price" },
      { action: "screenshot" },
    ]);
    expect(lines).toEqual([
      "Would open https://shop.example.com",
      'Would click the element with the text "Add to cart"',
      "Would type 11 characters into #q",
      "Would read .price into price",
      "Would take a screenshot",
    ]);
    expect(lines.join("\n")).not.toContain("secret text");
  });
});

describe("BLOCKED_RANGES", () => {
  it("covers loopback, private and metadata addresses", () => {
    const nets = BLOCKED_RANGES.map(([n, p]) => `${n}/${p}`);
    for (const n of ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "::1/128", "fc00::/7"]) expect(nets).toContain(n);
  });
});

describe("browser lint", () => {
  const def = (actions: unknown[]) => definitionSchema.parse({ trigger: { type: "manual", config: {} }, steps: [{ id: "look", type: "browser", config: { url: "https://shop.example.com", actions } }], edges: [] });
  it("warns when the step reads nothing and takes no screenshot", () => {
    expect(lintDefinition(def([{ action: "click", text: "Next" }]))).toEqual([expect.stringContaining('Browser step "look" reads nothing')]);
    expect(lintDefinition(def([{ action: "extract", selector: ".price", name: "price" }]))).toEqual([]);
    expect(lintDefinition(def([{ action: "screenshot" }]))).toEqual([]);
  });
});
