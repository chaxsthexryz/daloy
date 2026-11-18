import { describe, expect, it } from "vitest";
import { validSecretName } from "./secrets";
import { translate } from "./locale";

describe("secret names", () => {
  it("accepts what the API accepts", () => {
    for (const ok of ["shop_hook", "a", "k2_x", "a".repeat(100)]) expect(validSecretName(ok)).toBe(true);
  });
  it("refuses what the API refuses", () => {
    for (const bad of ["", "Shop", "1key", "_key", "my-key", "my key", "a".repeat(101), "key\n"]) expect(validSecretName(bad)).toBe(false);
  });
  it("has Tagalog copy", () => {
    expect(translate("tl", "Secrets")).not.toBe("Secrets");
    expect(translate("tl", "Delete the secret {name}? Anything that uses it stops working.", { name: "shop_hook" })).toContain("shop_hook");
    expect(translate("tl", "Save secret")).not.toBe("Save secret");
  });
});
