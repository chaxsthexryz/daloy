import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LanguageContext } from "./Language";
import { ToastHost } from "./Toast";

describe("ToastHost upper-right layout", () => {
  it("positions the toast stack on the upper side in toast.css", () => {
    const css = readFileSync(resolve(__dirname, "toast.css"), "utf8");
    expect(css).toContain("top: 20px;");
    expect(css).toContain("right: 24px;");
    expect(css).not.toContain("bottom: 24px;");
  });

  it("renders cleanly when empty", () => {
    const html = renderToStaticMarkup(
      <LanguageContext.Provider value={{ language: "en", setLanguage: () => undefined }}>
        <ToastHost />
      </LanguageContext.Provider>,
    );
    expect(html).toBe("");
  });
});
