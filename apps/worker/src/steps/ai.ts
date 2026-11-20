import { aiOutputSchema, buildPrompt, StepError, type AiConfig } from "@daloy/engine";
import type { loadAiFiles } from "./ai-files";
import { generate, LlmError, type Connection } from "@daloy/llm-ts";

// Classify and extract want the same answer every time; summaries and drafts read better with a little variation.
const TEMPERATURE: Record<AiConfig["task"], number> = { classify: 0, extract: 0, summarize: 0.3, draft: 0.3 };

/**
 * One model call. `input` is the resolved, untrusted data; buildPrompt keeps it out of the system prompt.
 * A reply that fails the output schema is retried once (attempt 1), then the step fails (decision 0010).
 */
export async function runAi(cfg: AiConfig, input: string, opts: { model: string; attempt: number; connection?: Connection; files?: Awaited<ReturnType<typeof loadAiFiles>> }) {
  const { files } = opts;
  const { system, messages } = buildPrompt(cfg, input, files && { images: files.images.length, pdfs: files.pdfs });
  try {
    const { data, usage } = await generate({
      system,
      messages: files?.images.length ? [{ ...messages[0]!, images: files.images }] : messages,
      schema: aiOutputSchema(cfg),
      model: opts.model,
      connection: opts.connection,
      temperature: TEMPERATURE[cfg.task],
      // 4,096, not 1,024: a transcription of one dense page (a class schedule, a receipt with many lines) runs past
      // a thousand tokens, and a reply cut off mid-JSON fails as "not valid JSON" with no hint why. Output is billed
      // by what the model writes, so a larger ceiling costs nothing when the answer is short.
      maxTokens: 4096,
      timeoutMs: 60_000,
    });
    return { output: data, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
  } catch (err) {
    if (err instanceof LlmError && err.invalidOutput) throw new StepError(err.message, opts.attempt < 2, { cause: err, usage: err.usage });
    throw err;
  }
}
