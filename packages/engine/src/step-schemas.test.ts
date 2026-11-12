import { describe, expect, it } from "vitest";
import { stepJsonSchemas } from "./step-schemas";

describe("stepJsonSchemas", () => {
  const schemas = stepJsonSchemas();

  it("covers every step type", () => {
    expect(Object.keys(schemas).sort()).toEqual(["ai", "approval", "condition", "delay", "email", "http"]);
  });

  it("describes http as an object with a method enum and required url", () => {
    const http = schemas.http as { type: string; required: string[]; properties: Record<string, { enum?: string[]; maxLength?: number }> };
    expect(http.type).toBe("object");
    expect(http.properties.method!.enum).toEqual(["GET", "POST", "PUT", "PATCH", "DELETE"]);
    expect(http.properties.url!.maxLength).toBe(2000);
    expect(http.required).toEqual(expect.arrayContaining(["method", "url"]));
    // headers has a default, so the form may leave it out
    expect(http.required).not.toContain("headers");
  });

  it("describes delay seconds as a bounded integer", () => {
    const delay = schemas.delay as { properties: { seconds: { type: string; minimum: number; maximum: number } } };
    expect(delay.properties.seconds).toMatchObject({ type: "integer", minimum: 1, maximum: 2_592_000 });
  });

  it("nests the condition operator enum", () => {
    const cond = schemas.condition as { properties: { condition: { properties: { op: { enum: string[] } } } } };
    expect(cond.properties.condition.properties.op.enum).toContain("contains");
  });

  it("is plain JSON", () => {
    expect(JSON.parse(JSON.stringify(schemas))).toEqual(schemas);
  });
});
