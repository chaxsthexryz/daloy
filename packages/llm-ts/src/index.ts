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

/**
 * extraBody: fields added to an OpenAI-compatible request, such as a local server's switch to turn off thinking.
 * reasoningTokens: added to max_tokens for providers whose hidden thinking counts against it, so maxTokens stays the
 * budget for the answer itself.
 */
// jsonMode "object": the provider rejects json_schema (DeepSeek), so ask for a JSON object and put the schema in the system message.
export type Connection = { provider: string; baseUrl: string; apiKey?: string; extraBody?: Record<string, unknown>; reasoningTokens?: number; jsonMode?: "schema" | "object" };

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
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
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
function request<T>(input: GenerateInput<T>, provider: string, baseUrl: string, extraBody?: Record<string, unknown>, reasoningTokens = 0, jsonMode: "schema" | "object" = "schema") {
  const asObject = provider === "openai" && jsonMode === "object" && input.schema;
  const system = asObject ? `${input.system}

Reply with only a JSON object that matches this JSON schema:
${JSON.stringify(jsonSchema(input.schema!))}` : input.system;
  const messages = [{ role: "system", content: system }, ...input.messages];
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
        ...extraBody,
        model: input.model,
        messages,
        temperature: input.temperature,
        max_tokens: input.maxTokens + reasoningTokens,
        response_format: asObject ? { type: "json_object" } : input.schema && { type: "json_schema", json_schema: { name: "output", schema: jsonSchema(input.schema) } },
      },
      read: (b: OpenAiChatResponse) => ({
        text: b.choices?.[0]?.message?.content ?? "",
        cutOff: b.choices?.[0]?.finish_reason === "length",
        usage: { inputTokens: b.usage?.prompt_tokens ?? 0, outputTokens: b.usage?.completion_tokens ?? 0 },
      }),
    };
  }
  throw new LlmError(`unknown LLM_PROVIDER "${provider}" (use ollama or openai)`, false);
}

/** Calls the configured chat API, then checks the reply against input.schema if one is given. */
export async function generate<T = unknown>(input: GenerateInput<T>): Promise<GenerateResult<T>> {
  const conn: Connection = input.connection ?? {
    provider: process.env.LLM_PROVIDER || "ollama",
    baseUrl: process.env.LLM_BASE_URL ?? "http://localhost:11434",
    apiKey: process.env.LLM_API_KEY,
  };
  const apiKey = conn.apiKey;
  const req = request(input, conn.provider, conn.baseUrl.replace(/\/+$/, ""), conn.extraBody, conn.reasoningTokens, conn.jsonMode);

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

  const reply = req.read((await res.json()) as OllamaChatResponse & OpenAiChatResponse);
  const { text, usage } = reply;
  // Usually a thinking model that spent the whole budget on hidden reasoning.
  if ("cutOff" in reply && reply.cutOff && text.trim() === "") {
    throw new LlmError("the model used up its token limit before answering (thinking counts toward it)", false, { invalidOutput: true, usage });
  }
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

/** The model names a server offers: Ollama's /api/tags, or /models on an OpenAI-compatible server. */
export async function listModels(conn: Connection, timeoutMs = 5000): Promise<string[]> {
  const base = conn.baseUrl.replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(conn.provider === "ollama" ? `${base}/api/tags` : `${base}/models`, {
      headers: conn.apiKey ? { authorization: `Bearer ${conn.apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new LlmError(`LLM request failed: ${(err as Error).name}`, true, { cause: err });
  }
  if (!res.ok) throw new LlmError(`LLM returned HTTP ${res.status}`, res.status === 429 || res.status >= 500);
  const body = (await res.json()) as { models?: { name?: string }[]; data?: { id?: string }[] };
  const names = conn.provider === "ollama" ? body.models?.map((m) => m.name) : body.data?.map((m) => m.id);
  return (names ?? []).filter((n): n is string => typeof n === "string");
}
