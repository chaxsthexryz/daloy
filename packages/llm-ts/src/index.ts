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
  /** Where to send the request. Without it, LLM_PROVIDER, LLM_BASE_URL and LLM_API_KEY are used. */
  connection?: Connection;
};

export type Connection = { provider: string; baseUrl: string; apiKey?: string };

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

type OpenAiChatResponse = {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

// The JSON schema the model must follow. "$schema" is dropped because some OpenAI-compatible servers reject it.
function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

/**
 * Builds the request for LLM_PROVIDER: "ollama" (default, Ollama's /api/chat) or "openai" (any OpenAI-compatible
 * /chat/completions API, such as Gemini, LM Studio, llama.cpp, vLLM or OpenRouter). LLM_API_KEY, if set, is sent as a
 * bearer token. All three env vars are read on every call, so a gateway can be put in front without code changes.
 */
function request<T>(input: GenerateInput<T>, provider: string, baseUrl: string) {
  const messages = [{ role: "system", content: input.system }, ...input.messages];
  if (provider === "ollama") {
    return {
      url: `${baseUrl}/api/chat`,
      body: { model: input.model, stream: false, messages, format: input.schema && jsonSchema(input.schema), options: { temperature: input.temperature, num_predict: input.maxTokens } },
      read: (b: OllamaChatResponse) => ({ text: b.message?.content ?? "", usage: { inputTokens: b.prompt_eval_count ?? 0, outputTokens: b.eval_count ?? 0 } }),
    };
  }
  if (provider === "openai") {
    return {
      url: `${baseUrl}/chat/completions`,
      body: {
        model: input.model,
        messages,
        temperature: input.temperature,
        max_tokens: input.maxTokens,
        response_format: input.schema && { type: "json_schema", json_schema: { name: "output", schema: jsonSchema(input.schema) } },
      },
      read: (b: OpenAiChatResponse) => ({
        text: b.choices?.[0]?.message?.content ?? "",
        usage: { inputTokens: b.usage?.prompt_tokens ?? 0, outputTokens: b.usage?.completion_tokens ?? 0 },
      }),
    };
  }
  throw new LlmError(`unknown LLM_PROVIDER "${provider}" (use ollama or openai)`, false);
}

/** Calls the configured chat API, then checks the reply against input.schema if one is given. */
export async function generate<T = unknown>(input: GenerateInput<T>): Promise<GenerateResult<T>> {
  const conn = input.connection ?? {
    provider: process.env.LLM_PROVIDER || "ollama",
    baseUrl: process.env.LLM_BASE_URL ?? "http://localhost:11434",
    apiKey: process.env.LLM_API_KEY,
  };
  const apiKey = conn.apiKey;
  const req = request(input, conn.provider, conn.baseUrl.replace(/\/+$/, ""));

  let res: Response;
  try {
    res = await fetch(req.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      signal: AbortSignal.timeout(input.timeoutMs),
      body: JSON.stringify(req.body),
    });
  } catch (err) {
    // Timeouts and connection failures are transient.
    throw new LlmError(`LLM request failed: ${(err as Error).name}`, true, { cause: err });
  }

  // Only the status: a provider's error body can echo the request, key included.
  if (!res.ok) {
    throw new LlmError(`LLM returned HTTP ${res.status}`, res.status === 429 || res.status >= 500);
  }

  const { text, usage } = req.read((await res.json()) as OllamaChatResponse & OpenAiChatResponse);
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
