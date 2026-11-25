import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteAiLog, loadAiLogs, upsertAiLog } from "./ai-logs";

describe("ai-logs", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    (globalThis as unknown as { window: unknown }).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
      },
    };
  });

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it("records failed status and error, then clears the error when a later turn succeeds", () => {
    const failed = upsertAiLog("owner@test.local", {
      id: "ai-1",
      turns: [{ role: "user", text: "Resort concierge" }],
      draft: null,
      status: "failed",
      error: "The AI service is temporarily unavailable.",
    });
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      id: "ai-1",
      status: "failed",
      error: "The AI service is temporarily unavailable.",
    });

    const loaded = loadAiLogs("owner@test.local");
    expect(loaded[0]?.status).toBe("failed");

    const recovered = upsertAiLog("owner@test.local", {
      id: "ai-1",
      turns: [
        { role: "user", text: "Resort concierge" },
        { role: "assistant", text: "Draft ready" },
      ],
      draft: { name: "Concierge", summary: "Answers guests", definition: { trigger: { type: "manual", config: {} }, steps: [], edges: [] }, warnings: [] },
      status: "draft",
    });
    expect(recovered[0]?.status).toBe("draft");
    expect(recovered[0]?.error).toBeUndefined();

    expect(deleteAiLog("owner@test.local", "ai-1")).toEqual([]);
  });
});
