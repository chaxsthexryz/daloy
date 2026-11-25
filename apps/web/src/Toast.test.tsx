import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LanguageContext } from "./Language";
import { ToastHost } from "./Toast";

describe("ToastHost bottom-right layout", () => {
  it("positions the toast stack at the bottom-right in toast.css so it never overlaps breadcrumbs or titles", () => {
    const css = readFileSync(resolve(__dirname, "toast.css"), "utf8");
    expect(css).toContain("bottom: 20px;");
    expect(css).toContain("right: 20px;");
    expect(css).not.toContain("top: 16px;");
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
