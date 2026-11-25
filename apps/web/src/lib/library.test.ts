import type { WorkflowDefinition } from "@daloy/engine";
import { describe, expect, it } from "vitest";
import { taglishSampleFor } from "./library";

describe("taglishSampleFor", () => {
  it("extracts a Taglish customer message sample from message-sending steps", () => {
    const def = {
      trigger: { type: "form" },
      steps: [
        { id: "book", type: "book_slot", config: {} },
        { id: "send_pay_dm", type: "meta_reply", config: { text: "Hi {{trigger.name}}, naka-hold na ang slot mo." } },
      ],
    } as unknown as WorkflowDefinition;
    expect(taglishSampleFor(def)).toEqual({ body: "Hi {{trigger.name}}, naka-hold na ang slot mo." });
  });

  it("includes email subject when the sample step has both subject and text", () => {
    const def = {
      trigger: { type: "webhook" },
      steps: [
        { id: "send_receipt", type: "email", config: { to: "{{trigger.email}}", subject: "Natanggap na namin ang order mo", text: "Hi {{trigger.customer_name}}, thank you sa order mo." } },
      ],
    } as unknown as WorkflowDefinition;
    expect(taglishSampleFor(def)).toEqual({
      subject: "Natanggap na namin ang order mo",
      body: "Hi {{trigger.customer_name}}, thank you sa order mo.",
    });
  });

  it("extracts confirmedMessage from payment_due steps when no earlier message exists", () => {
    const def = {
      trigger: { type: "form" },
      steps: [
        { id: "ask_payment", type: "payment_due", config: { confirmedMessage: "Hi {{trigger.customer_name}}, confirmed na ang payment mo." } },
      ],
    } as unknown as WorkflowDefinition;
    expect(taglishSampleFor(def)).toEqual({ body: "Hi {{trigger.customer_name}}, confirmed na ang payment mo." });
  });

  it("returns null when no step sends a customer-facing text sample", () => {
    const def = {
      trigger: { type: "manual" },
      steps: [{ id: "save", type: "sheets_append", config: {} }],
    } as unknown as WorkflowDefinition;
    expect(taglishSampleFor(def)).toBeNull();
  });
});
