import { describe, expect, it } from "vitest";
import { definitionSchema } from "./definition";
import { emailMenu, numberedChoice, numberedMenu, workflowChoices } from "./menu";

// C2 (decision 0118): menu buttons on Messenger and Instagram, and the same menu as a numbered list in email.
const reply = (quickReplies: unknown) => ({ trigger: { type: "meta_dm", config: {} }, steps: [{ id: "reply", type: "meta_reply", config: { text: "Ano po ang kailangan ninyo?", quickReplies } }] });
const errors = (def: unknown) => {
  const r = definitionSchema.safeParse(def);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};
const menu = [
  { title: "Rooms", choice: "rooms" },
  { title: "Rates", choice: "rates" },
  { title: "Location", choice: "location" },
] as const;

describe("menu limits at save", () => {
  it("takes up to 13 buttons with titles up to 20 characters", () => {
    expect(errors(reply(menu))).toEqual([]);
    const thirteen = Array.from({ length: 13 }, (_, i) => ({ title: `Option ${i + 1}`, choice: ["rooms", "rates", "location", "activities", "book", "staff"][i % 6] }));
    expect(errors(reply(thirteen))).toEqual([]);
    expect(errors(reply([...thirteen, { title: "Fourteen", choice: "rooms" }])).length).toBeGreaterThan(0);
    expect(errors(reply([{ title: "x".repeat(20), choice: "rooms" }]))).toEqual([]);
    expect(errors(reply([{ title: "x".repeat(21), choice: "rooms" }])).length).toBeGreaterThan(0);
    expect(errors(reply([{ title: "  ", choice: "rooms" }])).length).toBeGreaterThan(0);
  });

  it("refuses a choice outside the fixed list, and lets two titles share a choice", () => {
    expect(errors(reply([{ title: "Spa", choice: "spa" }])).length).toBeGreaterThan(0);
    expect(errors(reply([{ title: "Rooms", choice: "rooms" }, { title: "Kwarto", choice: "rooms" }]))).toEqual([]);
  });

  it("refuses two email menus that number their choices differently", () => {
    const email = (id: string, m: unknown) => ({ id, type: "email", config: { to: "{{trigger.replyTo}}", subject: "Re: {{trigger.subject}}", text: "Pili po:", menu: m } });
    const def = (a: unknown, b: unknown) => ({ trigger: { type: "email", config: {} }, steps: [email("one", a), email("two", b)], edges: [{ from: "one", to: "two" }] });
    expect(errors(def(menu, menu))).toEqual([]);
    expect(errors(def(menu, [...menu].reverse())).length).toBeGreaterThan(0);
  });
});

describe("workflow choices", () => {
  it("lists every choice any menu of the workflow offers, and the email menu in its order", () => {
    const def = definitionSchema.parse({
      trigger: { type: "email", config: {} },
      steps: [
        { id: "mail", type: "email", config: { to: "{{trigger.replyTo}}", subject: "Hi", text: "Pili po:", menu } },
        { id: "dm", type: "meta_reply", config: { text: "x", quickReplies: [{ title: "Book", choice: "book" }] } },
      ],
      edges: [{ from: "mail", to: "dm" }],
    });
    expect(workflowChoices(def)).toEqual(["rooms", "rates", "location", "book"]);
    expect(emailMenu(def)).toEqual(["rooms", "rates", "location"]);
  });
});

describe("numbered email menu", () => {
  it("writes the menu as a numbered list", () => {
    expect(numberedMenu([...menu])).toBe("1. Rooms\n2. Rates\n3. Location");
  });

  it("maps a reply of 2 to choice 2, above the quoted message", () => {
    const choices = ["rooms", "rates", "location"] as const;
    expect(numberedChoice("2", choices)).toBe("rates");
    expect(numberedChoice(" 2. \r\n\r\nOn Mon, the resort wrote:\r\n> 1. Rooms\r\n> 2. Rates", choices)).toBe("rates");
    expect(numberedChoice("\n\n3\n", choices)).toBe("location");
  });

  it("maps nothing for a number outside the menu or a sentence that starts with a number", () => {
    const choices = ["rooms", "rates"] as const;
    expect(numberedChoice("0", choices)).toBeUndefined();
    expect(numberedChoice("3", choices)).toBeUndefined();
    expect(numberedChoice("2 adults, Dec 20", choices)).toBeUndefined();
    expect(numberedChoice("", choices)).toBeUndefined();
    expect(numberedChoice("2", [])).toBeUndefined();
  });
});
