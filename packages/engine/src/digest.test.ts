import { describe, expect, it } from "vitest";
import { digestEmail } from "./digest";

// R5 (decision 0092): the owner's morning digest says only what needs doing and links to where.
const some = { receipts: 3, unpaid: 1, failedReplies: 2 };

describe("digestEmail", () => {
  it("is null when there is nothing to do, so no message is sent", () => {
    expect(digestEmail({ receipts: 0, unpaid: 0, failedReplies: 0 }, "https://d.example")).toBeNull();
  });

  it("lists each non-zero count with a link, and leaves out the zero ones", () => {
    const m = digestEmail({ receipts: 3, unpaid: 0, failedReplies: 0 }, "https://d.example")!;
    expect(m.subject).toBe("3 things need you in Daloy this morning");
    expect(m.text).toContain("3 receipts to review");
    expect(m.text).toContain("https://d.example/#/receipts");
    expect(m.text).not.toContain("unpaid");
    expect(m.text).not.toContain("failed");
  });

  it("uses the singular for one item and the subject counts every item", () => {
    const m = digestEmail({ receipts: 1, unpaid: 1, failedReplies: 1 }, "https://d.example")!;
    expect(m.subject).toBe("3 things need you in Daloy this morning");
    expect(m.text).toContain("1 receipt to review");
    expect(m.text).toContain("1 unpaid order");
    expect(m.text).toContain("1 failed reply");
    expect(digestEmail({ receipts: 1, unpaid: 0, failedReplies: 0 }, undefined)!.subject).toBe("1 thing needs you in Daloy this morning");
  });

  it("links unpaid orders and failed replies to Activity, and drops links without a public URL", () => {
    expect(digestEmail(some, "https://d.example")!.text).toContain("https://d.example/#/activity");
    expect(digestEmail(some, undefined)!.text).not.toContain("http");
  });

  it("includes conversations waiting for staff in both languages", () => {
    const withConvos = { receipts: 0, unpaid: 0, failedReplies: 0, conversationsWaiting: 2 };
    const en = digestEmail(withConvos, "https://d.example", "en")!;
    expect(en.subject).toBe("2 things need you in Daloy this morning");
    expect(en.text).toContain("2 conversations waiting for staff: https://d.example/#/conversations");
    const tl = digestEmail({ ...withConvos, conversationsWaiting: 1 }, "https://d.example", "tl")!;
    expect(tl.text).toContain("1 usapang naghihintay ng staff: https://d.example/#/conversations");
  });

  it("has Tagalog copy and no dashes", () => {
    const m = digestEmail(some, "https://d.example", "tl")!;
    expect(m.subject).toContain("6");
    expect(m.text).toContain("resibong susuriin");
    for (const language of ["en", "tl"] as const) expect(JSON.stringify(digestEmail(some, "https://d.example", language))).not.toMatch(/[–—]/);
  });
});
