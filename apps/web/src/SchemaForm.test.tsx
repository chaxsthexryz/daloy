import { stepJsonSchemas } from "@daloy/engine";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LanguageContext } from "./Language";
import { SchemaForm, type JsonSchema } from "./SchemaForm";

const html = (schema: unknown) =>
  renderToStaticMarkup(
    <LanguageContext.Provider value={{ language: "en", setLanguage: () => undefined }}>
      <SchemaForm schema={schema as JsonSchema} value={{ text: "Hi", quickReplies: [{ title: "Rooms", choice: "rooms" }], columns: ["a"] }} onChange={() => undefined} />
    </LanguageContext.Provider>,
  );

// C2 (decision 0118): the menu has no form yet, so it is not drawn as a text box that would turn it into a string.
describe("step form lists", () => {
  it("leaves out a menu and still draws a list of text fields", () => {
    const schemas = stepJsonSchemas();
    const reply = html(schemas.meta_reply);
    expect(reply).toContain("Message");
    expect(reply).not.toContain("QuickReplies");
    expect(reply).not.toContain("[object Object]");
    expect(html(schemas.sheets)).toContain("Columns");
  });
});
