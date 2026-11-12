import * as z from "zod";
import { conditionSchema, delayConfigSchema, emailConfigSchema, httpConfigSchema, type Step } from "./definition";

/**
 * JSON Schema for each step type's config, which the builder turns into a form.
 * io "input" describes what the user types, so fields with defaults are optional.
 * Refinements (such as the 20-header cap) are not in the JSON; the API still enforces them on save.
 */
export function stepJsonSchemas(): Record<Step["type"], unknown> {
  const json = (s: z.ZodType) => z.toJSONSchema(s, { io: "input", unrepresentable: "any" });
  const open = { type: "object", additionalProperties: true };
  return {
    condition: json(z.object({ condition: conditionSchema })),
    http: json(httpConfigSchema),
    email: json(emailConfigSchema),
    delay: json(delayConfigSchema),
    ai: open,
    approval: open,
  };
}
