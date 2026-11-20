import { describe, expect, it } from "vitest";
import { checkNewPassword, checkPasswordChange } from "./password";

describe("checkNewPassword", () => {
  it("accepts 12 to 200 characters", () => {
    expect(checkNewPassword("123456789012")).toBeNull();
    expect(checkNewPassword("x".repeat(200))).toBeNull();
  });
  it("refuses fewer than 12 and more than 200", () => {
    expect(checkNewPassword("")).toBe("too-short");
    expect(checkNewPassword("12345678901")).toBe("too-short");
    expect(checkNewPassword("x".repeat(201))).toBe("too-long");
  });
});

describe("checkPasswordChange", () => {
  it("accepts a current password and a new one of 12 characters", () => {
    expect(checkPasswordChange("old password", "123456789012")).toBeNull();
  });
  it("asks for the current password first", () => {
    expect(checkPasswordChange("", "short")).toBe("current-required");
  });
  it("refuses a new password under 12 characters", () => {
    expect(checkPasswordChange("old password", "12345678901")).toBe("too-short");
  });
  it("refuses a new password over 200 characters", () => {
    expect(checkPasswordChange("old password", "x".repeat(201))).toBe("too-long");
    expect(checkPasswordChange("old password", "x".repeat(200))).toBeNull();
  });
  it("counts characters, not spaces trimmed away", () => {
    expect(checkPasswordChange("old password", " ".repeat(12))).toBeNull();
  });
});
