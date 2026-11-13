import { aiOutputSchema, buildPrompt, StepError, type AiConfig } from "@daloy/engine";
import { generate, LlmError, type Connection } from "@daloy/llm-ts";

// Classify and extract want the same answer every time; summaries and drafts read better with a little variation.
const TEMPERATURE: Record<AiConfig["task"], number> = { classify: 0, extract: 0, summarize: 0.3, draft: 0.3 };

/**
 * One model call. `input` is the resolved, untrusted data; buildPrompt keeps it out of the system prompt.
 * A reply that fails the output schema is retried once (attempt 1), then the step fails (decision 0010).
 */
export async function runAi(cfg: AiConfig, input: string, opts: { model: string; attempt: number; connection?: Connection }) {
  try {
    const { data, usage } = await generate({
      ...buildPrompt(cfg, input),
      schema: aiOutputSchema(cfg),
      model: opts.model,
      connection: opts.connection,
      temperature: TEMPERATURE[cfg.task],
      maxTokens: 1024,
      timeoutMs: 60_000,
    });
    return { output: data, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
  } catch (err) {
    if (err instanceof LlmError && err.invalidOutput) throw new StepError(err.message, opts.attempt < 2, { cause: err, usage: err.usage });
    throw err;
  }
}
