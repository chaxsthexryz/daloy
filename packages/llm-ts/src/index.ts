import * as z from "zod";

export type Message = { role: "user" | "assistant"; content: string };

export type GenerateInput<T> = {
  system: string;
  messages: Message[];
  schema?: z.ZodType<T>;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
};

export type GenerateResult<T> = {
  text: string;
  data?: T;
  usage: { inputTokens: number; outputTokens: number };
};

type Usage = GenerateResult<unknown>["usage"];

/**
 * `retryable` tells the engine's retry policy whether another attempt can help. `invalidOutput` marks a reply that
 * arrived but is not valid JSON or does not match the schema; `usage` then holds the tokens that reply cost.
 */
export class LlmError extends Error {
  override name = "LlmError";
  readonly invalidOutput: boolean;
  readonly usage?: Usage;
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: { cause?: unknown; invalidOutput?: boolean; usage?: Usage },
  ) {
    super(message, options);
    this.invalidOutput = options?.invalidOutput ?? false;
    this.usage = options?.usage;
  }
}

type OllamaChatResponse = {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
};

/** Calls the Ollama chat API. LLM_BASE_URL is read on every call so a gateway can be put in front without code changes. */
export async function generate<T = unknown>(input: GenerateInput<T>): Promise<GenerateResult<T>> {
  const baseUrl = (process.env.LLM_BASE_URL ?? "http://localhost:11434").replace(/\/+$/, "");

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(input.timeoutMs),
      body: JSON.stringify({
        model: input.model,
        stream: false,
        messages: [{ role: "system", content: input.system }, ...input.messages],
        format: input.schema ? z.toJSONSchema(input.schema) : undefined,
        options: { temperature: input.temperature, num_predict: input.maxTokens },
      }),
    });
  } catch (err) {
    // Timeouts and connection failures are transient.
    throw new LlmError(`LLM request failed: ${(err as Error).name}`, true, { cause: err });
  }

  if (!res.ok) {
    throw new LlmError(`LLM returned HTTP ${res.status}`, res.status === 429 || res.status >= 500);
  }

  const body = (await res.json()) as OllamaChatResponse;
  const text = body.message?.content ?? "";
  const usage = { inputTokens: body.prompt_eval_count ?? 0, outputTokens: body.eval_count ?? 0 };
  if (!input.schema) return { text, usage };

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new LlmError("LLM output is not valid JSON", false, { cause: err, invalidOutput: true, usage });
  }
  const parsed = input.schema.safeParse(json);
  if (!parsed.success) {
    throw new LlmError("LLM output does not match the schema", false, { cause: parsed.error, invalidOutput: true, usage });
  }
  return { text, data: parsed.data, usage };
}
