import { describe, expect, it } from "vitest";
import { maskSecrets } from "./mask";

describe("maskSecrets", () => {
  it("masks values under secret-looking keys at any depth", () => {
    const input = {
      email: "a@b.test",
      headers: { Authorization: "Bearer abc", "X-Api-Key": "k1", accept: "json" },
      nested: [{ password: "hunter2" }, { api_key: 42 }, { client_secret: { deep: true } }],
      session_token: "t",
      "set-cookie": "sid=1",
    };
    expect(maskSecrets(input)).toEqual({
      email: "a@b.test",
      headers: { Authorization: "[secret]", "X-Api-Key": "[secret]", accept: "json" },
      nested: [{ password: "[secret]" }, { api_key: "[secret]" }, { client_secret: "[secret]" }],
      session_token: "[secret]",
      "set-cookie": "[secret]",
    });
  });

  it("keeps null under a secret key, so an empty field still reads as empty", () => {
    expect(maskSecrets({ password: null })).toEqual({ password: null });
  });

  it("leaves values the worker already redacted and plain scalars alone", () => {
    expect(maskSecrets("Bearer [secret]")).toBe("Bearer [secret]");
    expect(maskSecrets(3)).toBe(3);
    expect(maskSecrets(null)).toBe(null);
  });

  it("does not change the input object", () => {
    const input = { token: "x" };
    maskSecrets(input);
    expect(input.token).toBe("x");
  });
});
