import { createHash } from "node:crypto";
import type { AiConnection } from "@daloy/db";
import { aiConfigSchema, aiOutputSchema, buildPrompt, TEMPLATES } from "@daloy/engine";
import { generate, listModels, LlmError } from "@daloy/llm-ts";

/* The sample classify call shared by the workspace AI test (settings.ts) and the admin one (admin.ts). */

// The classify step of the Inquiry triage template, so the test checks exactly what that workflow will run.
const triage = TEMPLATES.find((t) => t.slug === "inquiry-triage")!.definition.steps.find((s) => s.id === "classify")!;
const classify = aiConfigSchema.parse(triage.config);
const SAMPLE = "Hi, I was charged twice for my March invoice (INV-2026-0412). Can you refund one of the payments?";

/** Up to twelve names, so an error stays readable when a provider offers hundreds of models. */
export function few(models: string[]): string {
  if (models.length <= 12) return models.join(", ");
  return `${models.slice(0, 12).join(", ")} and ${models.length - 12} more`;
}

/**
 * Plain-language reasons for the console. Only the HTTP status is known, never the provider's response body.
 * `models` are the names the provider offers, when they could be read, so a wrong model name says what to type.
 */
export function explain(err: unknown, models: string[] = []): string {
  if (!(err instanceof LlmError)) return "The test failed unexpectedly. Check the worker and API logs.";
  if (err.message.includes("token limit")) return "The model spent its whole token limit thinking and gave no answer. Pick a smaller or non-thinking model.";
  if (err.invalidOutput) return "The model answered, but not in the expected format. A larger model usually fixes this.";
  if (err.message.endsWith("TimeoutError")) return "The model took too long to answer. A hosted model may be overloaded; try again in a minute.";
  const status = Number(/HTTP (\d+)/.exec(err.message)?.[1]);
  if (!status) return "Could not connect to the model. For a local model, check that the server in .env (Ollama by default) is running.";
  if (status === 401 || status === 403) return "The provider rejected the API key.";
  // A 400 is what most providers answer for a model name they do not serve, so say what they do serve.
  if (status === 400 || status === 404) {
    if (models.length > 0) return `The provider does not offer this model name (HTTP ${status}). It offers: ${few(models)}.`;
    return status === 404 ? "The provider does not know this model name." : `The provider answered with HTTP ${status}. The model name may be wrong.`;
  }
  if (status === 429) return "The provider's rate limit or free quota was reached. Wait a minute and try again.";
  if (status >= 500) return `The provider is busy or down right now (HTTP ${status}). Try again in a minute.`;
  return `The provider answered with HTTP ${status}.`;
}

/**
 * The model names a provider offers, kept for five minutes so saving twice does not ask twice. The key is not kept,
 * only a short hash of it, and a failed lookup is not remembered: the next save asks again.
 */
const modelCache = new Map<string, { at: number; models: string[] }>();
export async function providerModels(conn: AiConnection): Promise<string[]> {
  const cacheKey = `${conn.baseUrl}|${createHash("sha256").update(conn.apiKey ?? "").digest("hex").slice(0, 16)}`;
  const hit = modelCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.models;
  const models = await listModels(conn, 3000);
  modelCache.set(cacheKey, { at: Date.now(), models });
  return models;
}

/** One real model call on a sample inquiry. A failure comes back as a plain reason, so the caller can show it. */
export async function sampleTest(connection: Omit<AiConnection, "model">, model: string) {
  const started = Date.now();
  try {
    const { data, usage } = await generate({ ...buildPrompt(classify, SAMPLE), schema: aiOutputSchema(classify), model, connection, temperature: 0, maxTokens: 256, timeoutMs: 30_000 });
    return { ok: true as const, model, sample: SAMPLE, label: (data as { label: string }).label, ms: Date.now() - started, ...usage };
  } catch (err) {
    // Only on a name the provider may not serve: one extra request to say which names it does.
    const status = Number(/HTTP (\d+)/.exec((err as Error).message)?.[1]);
    const offered = status === 400 || status === 404 ? await providerModels({ ...connection, model }).catch(() => []) : [];
    return { ok: false as const, model, sample: SAMPLE, error: explain(err, offered) };
  }
}

