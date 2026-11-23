import { describe, expect, it } from "vitest";
import { answerPrompt, contactsIn, guardReply, quoteStay, redactContacts } from "./concierge";
import type { KnowledgeEntry } from "./knowledge";

const garden: KnowledgeEntry = {
  id: "room-garden",
  kind: "room",
  title: "Garden room",
  body: "Two queen beds, sea view. Extra mattress ₱600.",
  fields: {
    price: 3500,
    unit: "night",
    capacity: 4,
    deposit: { mode: "percent", value: 30 },
    rules: [
      { name: "Weekend", price: 4200, days: ["fri", "sat"] },
      { name: "Peak season", price: 4800, from: "12-15", to: "01-10" },
      { name: "Holidays", price: 5500, from: "12-24", to: "01-01" },
      { name: "Extra guest", price: 500, unit: "person_night" },
    ],
  },
};
const cottage: KnowledgeEntry = { id: "room-cottage", kind: "room", title: "Beach cottage", body: "", fields: { price: 2000, unit: "night", capacity: 2, deposit: { mode: "fixed", value: 1000 } } };
const map: KnowledgeEntry = { id: "loc", kind: "location", title: "How to get here", body: "Two hours from Manila.", fields: { url: "https://maps.example.com/resort" } };
const faq: KnowledgeEntry = { id: "faq-pets", kind: "faq", title: "Pets", body: "Small pets welcome for ₱300.", fields: {} };
const entries = [garden, cottage, map, faq];

const guard = (reply: string, cited: string[], extra: Partial<Parameters<typeof guardReply>[1]> = {}) => guardReply(reply, { entries, cited, language: "en", ...extra });

describe("guardReply prices", () => {
  it("keeps a price that a cited entry states, in any of its rules or its body", () => {
    for (const reply of ["The Garden room is ₱3,500 per night.", "Weekends are PHP 4200 a night.", "An extra mattress is P600.", "Extra guests pay 500 pesos per night.", "The deposit is 30%."]) {
      expect(guard(reply, ["room-garden"]), reply).toMatchObject({ reply, replaced: null, flags: [] });
    }
  });

  it("replaces an invented price", () => {
    const out = guard("The Garden room is only ₱2,999 per night!", ["room-garden"]);
    expect(out.replaced).toBe("price");
    expect(out.reply).not.toMatch(/2,999/);
    expect(out.needsHuman).toBe(true);
  });

  it("replaces a price that is in the sheet but not in an entry the answer cited", () => {
    expect(guard("The cottage is ₱2,000 a night.", ["room-garden"]).replaced).toBe("price");
    expect(guard("The cottage is ₱2,000 a night.", []).replaced).toBe("price");
  });

  it("does not trust a peso figure from an entry that cannot hold a price", () => {
    expect(guard("Pets are ₱300.", ["faq-pets"]).replaced).toBe("price");
  });

  it("checks a bare number in a rate phrase but not a count of nights or guests", () => {
    expect(guard("It is 2800 per night.", ["room-garden"]).replaced).toBe("price");
    expect(guard("It is 2,800/night.", ["room-garden"]).replaced).toBe("price");
    expect(guard("For 2 nights and 3 guests the Garden room fits 4 pax.", ["room-garden"]).replaced).toBeNull();
  });

  it("refuses a total it cannot see in the sheet, since totals come from stay_quote", () => {
    expect(guard("Two nights come to ₱7,000.", ["room-garden"]).replaced).toBe("price");
  });
});

describe("guardReply availability", () => {
  it.each([
    "Yes, the Garden room is available on those dates.",
    "We have vacancy this weekend.",
    "Sorry, we are fully booked.",
    "The room is free on Saturday.",
    "Your room is reserved for you.",
    "Opo, may bakante pa kami.",
    "May slot pa po sa Sabado.",
    "Puno na po kami ngayong weekend.",
    "Wala nang kwarto sa Disyembre.",
    "Available pa po ang cottage.",
  ])("replaces %s", (reply) => {
    const out = guard(reply, ["room-garden"]);
    expect(out.replaced).toBe("availability");
    expect(out.needsHuman).toBe(true);
    expect(out.reply).toMatch(/check with the team/i);
  });

  it("keeps free things that are not rooms and answers in Tagalog when the workspace is", () => {
    expect(guard("Breakfast is free and parking is free.", []).replaced).toBeNull();
    expect(guard("Feel free to message us.", []).replaced).toBeNull();
    expect(guard("May bakante pa po.", [], { language: "tl" }).reply).toMatch(/team/);
    expect(guard("May bakante pa po.", [], { language: "tl" }).reply).not.toBe(guard("May bakante pa po.", []).reply);
  });
});

describe("guardReply links and placeholders", () => {
  it("strips a link that is not in the sheet and keeps one that is", () => {
    const out = guard("Pay at https://evil.example.net/pay or see https://maps.example.com/resort for directions. Also www.other.ph and bit.ly/x.", []);
    expect(out.reply).not.toMatch(/evil|other\.ph|bit\.ly/);
    expect(out.reply).toContain("https://maps.example.com/resort");
    expect(out.flags).toContain("link");
    expect(out.replaced).toBeNull();
  });

  it("keeps the pay link it is given", () => {
    expect(guard("Pay here: https://daloy.example.com/pay/abc", [], { links: ["https://daloy.example.com/pay/abc"] }).flags).toEqual([]);
  });

  it("removes contact placeholders and template braces", () => {
    const out = guard("We will email you at [email] or call [phone]. {{trigger.secret}}", []);
    expect(out.reply).not.toMatch(/\[email\]|\[phone\]|\{\{/);
    expect(out.flags).toContain("placeholder");
  });
});

describe("contacts", () => {
  const text = "I'm Ana, ana.cruz@example.com, 0917 123 4567 or +63 918-765-4321. Arrive 12/26 for 2 nights, ₱3,500 ok?";
  it("redacts emails and Philippine mobile numbers but keeps dates and prices", () => {
    const red = redactContacts(text);
    expect(red).not.toMatch(/ana\.cruz|0917|4567|918/);
    expect(red).toContain("[email]");
    expect(red).toContain("[phone]");
    expect(red).toContain("12/26");
    expect(red).toContain("₱3,500");
  });

  it("finds them with fixed patterns", () => {
    expect(contactsIn(text)).toEqual({ email: "ana.cruz@example.com", phone: "+639171234567" });
    expect(contactsIn("no contact here")).toEqual({});
  });
});

describe("answerPrompt", () => {
  it("never puts the guest's email or phone in what the model sees", () => {
    const history = [
      { direction: "in", text: "Hi, my email is ana.cruz@example.com", at: "2026-11-23T01:00:00Z" },
      { direction: "out", text: "Thanks!", at: "2026-11-23T01:00:05Z" },
      { direction: "in", text: "Call me at 09171234567", at: "2026-11-23T01:01:00Z" },
    ];
    const prompt = answerPrompt({ task: "answer", input: "Or text +63 917 123 4567, rates for Dec 26?" }, "Or text +63 917 123 4567, rates for Dec 26?", history, entries);
    const seen = JSON.stringify(prompt);
    expect(seen).not.toMatch(/ana\.cruz|0917|917 123|1234567/);
    expect(seen).toContain("room-garden");
    expect(prompt.system).not.toContain("rates for Dec 26");
    expect(prompt.messages[0]!.content).toContain("rates for Dec 26");
  });
});

describe("quoteStay", () => {
  it("prices 2 nights across a season boundary, one night each side", () => {
    // 14 Dec 2026 is a Monday (base), 15 Dec is a Tuesday in Peak season.
    const q = quoteStay(garden, { checkIn: "2026-12-14", nights: 2, guests: 2 });
    expect(q.nights).toEqual([
      { date: "2026-12-14", price: 3500, rule: null },
      { date: "2026-12-15", price: 4800, rule: "Peak season" },
    ]);
    expect(q).toMatchObject({ subtotal: 8300, extraGuestFee: 0, total: 8300, deposit: 2490 });
  });

  it("lets the narrower season win over a wider one, and a season win over a weekday rule", () => {
    // 25 Dec 2026 is a Friday: Weekend, Peak season and Holidays all match.
    expect(quoteStay(garden, { checkIn: "2026-12-25", nights: 1, guests: 2 }).nights[0]).toMatchObject({ price: 5500, rule: "Holidays" });
    // 9 Jan 2027 is a Saturday in Peak season, which wraps the new year.
    expect(quoteStay(garden, { checkIn: "2027-01-09", nights: 1, guests: 2 }).nights[0]).toMatchObject({ price: 4800, rule: "Peak season" });
    // 13 Nov 2026 is a Friday outside any season.
    expect(quoteStay(garden, { checkIn: "2026-11-13", nights: 1, guests: 2 }).nights[0]).toMatchObject({ price: 4200, rule: "Weekend" });
  });

  it("lets a rule with both a season and weekdays win over either alone, and keeps the first written on a tie", () => {
    const entry: KnowledgeEntry = { ...garden, fields: { ...garden.fields, rules: [{ name: "Peak", price: 4800, from: "12-01", to: "12-31" }, { name: "Peak weekend", price: 6000, from: "12-01", to: "12-31", days: ["sat"] }, { name: "Peak too", price: 9999, from: "12-01", to: "12-31" }] } };
    expect(quoteStay(entry, { checkIn: "2026-12-05", nights: 2, guests: 1 }).nights.map((n) => n.rule)).toEqual(["Peak weekend", "Peak"]);
  });

  it("charges extra guests above capacity per night and takes a fixed deposit", () => {
    const q = quoteStay(garden, { checkIn: "2026-11-16", nights: 2, guests: 6 });
    expect(q).toMatchObject({ subtotal: 7000, extraGuests: 2, extraGuestFee: 2000, total: 9000, deposit: 2700 });
    expect(quoteStay(cottage, { checkIn: "2026-11-16", nights: 3, guests: 2 })).toMatchObject({ total: 6000, deposit: 1000 });
  });

  it("charges a per-person rate for every guest", () => {
    const entry: KnowledgeEntry = { id: "dorm", kind: "rate", title: "Dorm bed", body: "", fields: { price: 800, unit: "person_night" } };
    expect(quoteStay(entry, { checkIn: "2026-11-16", nights: 2, guests: 3 })).toMatchObject({ subtotal: 4800, total: 4800, deposit: 4800 });
  });

  it("refuses what it cannot price", () => {
    expect(() => quoteStay(cottage, { checkIn: "2026-11-16", nights: 1, guests: 9 })).toThrow(/capacity|more guests/i);
    expect(() => quoteStay({ ...garden, fields: { ...garden.fields, rules: [] } }, { checkIn: "2026-11-16", nights: 1, guests: 6 })).toThrow(/more guests/);
    expect(() => quoteStay(map, { checkIn: "2026-11-16", nights: 1, guests: 2 })).toThrow(/price/);
    expect(() => quoteStay(garden, { checkIn: "2026-02-30", nights: 1, guests: 2 })).toThrow(/date/);
    expect(() => quoteStay(garden, { checkIn: "2026-11-16", nights: 0, guests: 2 })).toThrow(/nights/);
    expect(() => quoteStay({ ...cottage, fields: { price: 900, unit: "day" } }, { checkIn: "2026-11-16", nights: 1, guests: 2 })).toThrow(/night/);
  });
});
