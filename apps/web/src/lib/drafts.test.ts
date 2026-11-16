import { describe, expect, it } from "vitest";
import { isDraft, newestDraft } from "./drafts";

const wf = (id: string, createdAt: string, template: string | null, live = false) => ({ id, name: id, slug: id, createdAt, live, setup: template ? { template } : undefined });

describe("newestDraft", () => {
  it("picks the newest unfinished draft of the template", () => {
    const list = [wf("old", "2026-11-01T00:00:00Z", "office-request"), wf("new", "2026-11-10T00:00:00Z", "office-request"), wf("other", "2026-11-12T00:00:00Z", "purchase-request")];
    expect(newestDraft(list, "office-request")?.id).toBe("new");
    expect(newestDraft(list, "purchase-request")?.id).toBe("other");
  });
  it("is none when every guided workflow is published or none is guided", () => {
    expect(newestDraft([wf("a", "2026-11-01T00:00:00Z", "office-request", true), wf("b", "2026-11-02T00:00:00Z", null)], "office-request")).toBeUndefined();
    expect(newestDraft([], "office-request")).toBeUndefined();
  });
  it("shares its draft rule with the Draft: continue setup tag", () => {
    expect(isDraft(wf("a", "2026-11-01T00:00:00Z", "office-request"))).toBe(true);
    expect(isDraft(wf("a", "2026-11-01T00:00:00Z", "office-request", true))).toBe(false);
    expect(isDraft(wf("a", "2026-11-01T00:00:00Z", null))).toBe(false);
  });
});
