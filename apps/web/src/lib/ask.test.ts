import { describe, expect, it } from "vitest";
import { filterRequests, recentRequests, type AskRunInput } from "./ask";

const run = (overrides: Partial<AskRunInput> = {}): AskRunInput => ({
  id: "run-1",
  reference: "REQ-2026-0001",
  workflowName: "Office request",
  state: "succeeded",
  createdAt: "2026-11-25T10:00:00.000Z",
  ...overrides,
});

describe("recentRequests", () => {
  it("keeps only runs with non-empty references and deduplicates keeping the newest", () => {
    const items = recentRequests([
      run({ id: "1", reference: null }),
      run({ id: "2", reference: "   " }),
      run({ id: "3", reference: "REQ-100", workflowName: "Newest", state: "failed" }),
      run({ id: "4", reference: "REQ-200", workflowName: "Booking" }),
      run({ id: "5", reference: "REQ-100", workflowName: "Older" }),
    ]);

    expect(items).toEqual([
      { id: "3", reference: "REQ-100", workflowName: "Newest", state: "failed", createdAt: "2026-11-25T10:00:00.000Z" },
      { id: "4", reference: "REQ-200", workflowName: "Booking", state: "succeeded", createdAt: "2026-11-25T10:00:00.000Z" },
    ]);
  });

  it("caps the number of recent requests", () => {
    const many = Array.from({ length: 30 }, (_, i) => run({ id: `id-${i}`, reference: `REQ-${i}` }));
    expect(recentRequests(many)).toHaveLength(25);
    expect(recentRequests(many, 5)).toHaveLength(5);
  });
});

describe("filterRequests", () => {
  const list = recentRequests([
    run({ id: "1", reference: "REQ-A102", workflowName: "Resort inquiry" }),
    run({ id: "2", reference: "REQ-B204", workflowName: "Deposit hold" }),
  ]);

  it("returns the full list when the query is blank", () => {
    expect(filterRequests(list, "")).toEqual(list);
    expect(filterRequests(list, "   ")).toEqual(list);
  });

  it("matches case-insensitively across reference and workflowName", () => {
    expect(filterRequests(list, "b204").map((r) => r.id)).toEqual(["2"]);
    expect(filterRequests(list, "RESORT").map((r) => r.id)).toEqual(["1"]);
    expect(filterRequests(list, "none")).toEqual([]);
  });
});
