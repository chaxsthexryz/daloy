import { describe, expect, it } from "vitest";
import { countActiveTokens, countResources, tokenStatus } from "./advanced";

const now = new Date("2026-11-21T00:00:00Z");

describe("tokenStatus", () => {
  it("is revoked once revokedAt is set, even if it has also expired", () => {
    expect(tokenStatus({ revokedAt: "2026-07-01T00:00:00Z", expiresAt: "2026-01-01T00:00:00Z" }, now)).toBe("revoked");
  });
  it("is expired when the expiry has passed and the token was not revoked", () => {
    expect(tokenStatus({ revokedAt: null, expiresAt: "2026-11-20T23:59:59Z" }, now)).toBe("expired");
  });
  it("is active with a future expiry or none", () => {
    expect(tokenStatus({ revokedAt: null, expiresAt: "2027-02-10T00:00:00Z" }, now)).toBe("active");
    expect(tokenStatus({ revokedAt: null, expiresAt: null }, now)).toBe("active");
  });
});

describe("counts beside page titles", () => {
  it("counts active and archived resources", () => {
    expect(countResources([{ active: true }, { active: true }, { active: false }])).toEqual({ active: 2, archived: 1 });
    expect(countResources([])).toEqual({ active: 0, archived: 0 });
  });
  it("counts only tokens that still work", () => {
    const list = [
      { revokedAt: null, expiresAt: null },
      { revokedAt: null, expiresAt: "2027-02-10T00:00:00Z" },
      { revokedAt: null, expiresAt: "2026-01-01T00:00:00Z" },
      { revokedAt: "2026-07-01T00:00:00Z", expiresAt: null },
    ];
    expect(countActiveTokens(list, now)).toBe(2);
  });
});
