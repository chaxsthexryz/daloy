import { describe, expect, it } from "vitest";
import {
  extractEmailAddress,
  isSelfAuthoredMessage,
  mailboxConnectionProblem,
  mailboxSelfLoopProblem,
  mailboxSourceOf,
  matchesMailboxFilters,
} from "./mailbox-triggers";

// G3 (decision 0132): pure mailbox trigger checks that need no database or network.
describe("mailboxConnectionProblem", () => {
  it("accepts a Gmail OAuth grant with gmail.readonly or mail.google.com", () => {
    expect(
      mailboxConnectionProblem("gmail_message", {
        status: "active",
        authMethod: "oauth",
        scopes: "openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly",
      }),
    ).toBeNull();
    expect(
      mailboxConnectionProblem("gmail_message", {
        status: "active",
        authMethod: "oauth",
        scopes: "openid email https://mail.google.com/",
      }),
    ).toBeNull();
  });

  it("rejects missing, app-password, failed, and send-only Gmail grants", () => {
    expect(mailboxConnectionProblem("gmail_message", null)).toBe("Gmail is not connected. Connect Gmail with Google in Apps.");
    expect(mailboxConnectionProblem("gmail_message", { status: "active", authMethod: "app_password", scopes: null })).toMatch(/app password/);
    expect(mailboxConnectionProblem("gmail_message", { status: "failed", authMethod: "oauth", scopes: "https://www.googleapis.com/auth/gmail.readonly" })).toMatch(/Reconnect Gmail/);
    const sendOnly = mailboxConnectionProblem("gmail_message", {
      status: "active",
      authMethod: "oauth",
      scopes: "openid email https://www.googleapis.com/auth/gmail.send",
    });
    expect(sendOnly).toContain("gmail.readonly");
  });

  it("accepts an Outlook OAuth grant with Mail.Read and rejects send-only or missing grants", () => {
    expect(
      mailboxConnectionProblem("outlook_message", {
        status: "active",
        authMethod: "oauth",
        scopes: "Mail.Send Mail.Read User.Read",
      }),
    ).toBeNull();
    expect(
      mailboxConnectionProblem("outlook_message", {
        status: "active",
        authMethod: "oauth",
        scopes: "https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Read",
      }),
    ).toBeNull();
    expect(mailboxConnectionProblem("outlook_message", null)).toBe("Outlook is not connected. Connect Outlook in Apps.");
    expect(mailboxConnectionProblem("outlook_message", { status: "failed", authMethod: "oauth", scopes: "Mail.Read" })).toMatch(/Reconnect Outlook/);
    expect(mailboxConnectionProblem("outlook_message", { status: "active", authMethod: "oauth", scopes: "Mail.Send User.Read" })).toBe(
      "Reconnect Outlook in Apps and allow reading mail (Mail.Read).",
    );
  });
});

describe("mailboxSelfLoopProblem and isSelfAuthoredMessage", () => {
  const base = { edges: [] };

  it("pauses a gmail_message automation that emails the same Gmail address", () => {
    const def = {
      ...base,
      trigger: { type: "gmail_message", config: {} },
      steps: [{ id: "reply", type: "email", config: { to: "owner@gmail.com, other@example.com", subject: "Hi", text: "ok" } }],
    };
    expect(mailboxSelfLoopProblem(def as never, "Owner@gmail.com")).toMatch(/same Gmail address/);
    expect(mailboxSelfLoopProblem(def as never, "someoneelse@gmail.com")).toBeNull();
    const templated = {
      ...base,
      trigger: { type: "gmail_message", config: {} },
      steps: [{ id: "reply", type: "email", config: { to: "{{trigger.from}}", subject: "Hi", text: "ok" } }],
    };
    expect(mailboxSelfLoopProblem(templated as never, "owner@gmail.com")).toBeNull();
    const disabled = { ...def, steps: [{ ...def.steps[0], disabled: true }] };
    expect(mailboxSelfLoopProblem(disabled as never, "owner@gmail.com")).toBeNull();
  });

  it("pauses an outlook_message automation that sends Outlook mail to the same mailbox", () => {
    const def = {
      ...base,
      trigger: { type: "outlook_message", config: {} },
      steps: [{ id: "reply", type: "outlook", config: { to: "Ana <ana@contoso.example>", subject: "Hi", text: "ok" } }],
    };
    expect(mailboxSelfLoopProblem(def as never, "ana@contoso.example")).toMatch(/same Outlook address/);
    expect(mailboxSelfLoopProblem(def as never, "other@contoso.example")).toBeNull();
  });

  it("extracts addresses and flags self-authored inbound messages", () => {
    expect(extractEmailAddress("Ana Lim <Ana@Contoso.Example>")).toBe("ana@contoso.example");
    expect(isSelfAuthoredMessage("Ana Lim <ana@contoso.example>", "ana@contoso.example")).toBe(true);
    expect(isSelfAuthoredMessage("guest@example.com", "ana@contoso.example")).toBe(false);
  });
});

describe("matchesMailboxFilters and mailboxSourceOf", () => {
  const msg = {
    from: "Orders Team <orders@shop.example>",
    subject: "Invoice #1042 for Ana",
    labelIds: ["INBOX", "Label_orders"],
    parentFolderId: "orders-folder",
  };

  it("matches case-insensitive sender, subject, label and folder filters", () => {
    expect(matchesMailboxFilters(msg, {})).toBe(true);
    expect(matchesMailboxFilters(msg, { from: "ORDERS@SHOP.EXAMPLE", subjectContains: "invoice #1042", label: "Orders" }, { labelId: "Label_orders" })).toBe(true);
    expect(matchesMailboxFilters(msg, { from: "other@shop.example" })).toBe(false);
    expect(matchesMailboxFilters(msg, { subjectContains: "Receipt" })).toBe(false);
    expect(matchesMailboxFilters(msg, { label: "Sent" })).toBe(false);
    expect(matchesMailboxFilters(msg, { folder: "Orders" }, { folderId: "orders-folder" })).toBe(true);
    expect(matchesMailboxFilters(msg, { folder: "Inbox" }, { folderId: "inbox" })).toBe(false);
  });

  it("changes source key when account or watched label/folder changes", () => {
    expect(mailboxSourceOf({ type: "gmail_message", config: { label: "INBOX" } }, "Ana <ana@gmail.com>")).toBe("gmail:ana@gmail.com:INBOX");
    expect(mailboxSourceOf({ type: "gmail_message", config: { label: "Orders" } }, "ana@gmail.com")).toBe("gmail:ana@gmail.com:Orders");
    expect(mailboxSourceOf({ type: "outlook_message", config: { folder: "Inbox" } }, "ana@contoso.example")).toBe("outlook:ana@contoso.example:Inbox");
  });
});
