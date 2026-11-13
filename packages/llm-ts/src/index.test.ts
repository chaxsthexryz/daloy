import { afterEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { generate, LlmError } from "./index";

const base = {
  system: "You classify inquiries.",
  messages: [{ role: "user" as const, content: "hello" }],
  model: "llama3.2",
  temperature: 0,
  maxTokens: 200,
  timeoutMs: 1000,
};

function mockFetch(response: Response | Error) {
  const fn = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const ok = (content: string) =>
  new Response(JSON.stringify({ message: { role: "assistant", content }, prompt_eval_count: 12, eval_count: 5 }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("generate", () => {
  it("posts to LLM_BASE_URL/api/chat with the system message first", async () => {
    vi.stubEnv("LLM_BASE_URL", "http://gateway.local:9000/");
    const fetch = mockFetch(ok("hi"));

    const result = await generate(base);

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://gateway.local:9000/api/chat");
    const body = JSON.parse(String(init.body));
    expect(body.messages[0]).toEqual({ role: "system", content: base.system });
    expect(body.messages[1]).toEqual(base.messages[0]);
    expect(body).toMatchObject({ model: "llama3.2", stream: false, options: { temperature: 0, num_predict: 200 } });
    expect(body.format).toBeUndefined();
    expect(result).toEqual({ text: "hi", usage: { inputTokens: 12, outputTokens: 5 } });
  });

  it("sends the schema as JSON schema and returns validated data", async () => {
    const fetch = mockFetch(ok('{"label":"billing"}'));
    const schema = z.object({ label: z.enum(["billing", "support"]) });

    const result = await generate({ ...base, schema });

    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.format.properties.label.enum).toEqual(["billing", "support"]);
    expect(result.data).toEqual({ label: "billing" });
  });

  it("rejects output that does not match the schema, without retry", async () => {
    mockFetch(ok('{"label":"spam"}'));
    const schema = z.object({ label: z.enum(["billing", "support"]) });

    await expect(generate({ ...base, schema })).rejects.toMatchObject({
      name: "LlmError",
      retryable: false,
      invalidOutput: true,
      usage: { inputTokens: 12, outputTokens: 5 },
    });
  });

  it("rejects output that is not JSON when a schema is given", async () => {
    mockFetch(ok("sure, here you go"));
    await expect(generate({ ...base, schema: z.object({}) })).rejects.toBeInstanceOf(LlmError);
  });

  it("marks server errors and rate limits as retryable", async () => {
    mockFetch(new Response("busy", { status: 503 }));
    await expect(generate(base)).rejects.toMatchObject({ retryable: true });
    mockFetch(new Response("slow down", { status: 429 }));
    await expect(generate(base)).rejects.toMatchObject({ retryable: true });
  });

  it("marks client errors as not retryable", async () => {
    mockFetch(new Response("no such model", { status: 404 }));
    await expect(generate(base)).rejects.toMatchObject({ retryable: false });
  });

  it("marks timeouts and network failures as retryable", async () => {
    mockFetch(new DOMException("timed out", "TimeoutError"));
    await expect(generate(base)).rejects.toMatchObject({ retryable: true });
    mockFetch(new TypeError("fetch failed"));
    await expect(generate(base)).rejects.toMatchObject({ retryable: true });
  });
});

// LLM_PROVIDER=openai: any OpenAI-compatible chat API (Gemini, LM Studio, llama.cpp, vLLM, OpenRouter).
describe("generate with LLM_PROVIDER=openai", () => {
  const okOpenAi = (content: string) =>
    new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 30, completion_tokens: 4 } }));

  it("posts to LLM_BASE_URL/chat/completions with the API key as a bearer token", async () => {
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("LLM_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai/");
    vi.stubEnv("LLM_API_KEY", "test-key");
    const fetch = mockFetch(okOpenAi("hi"));

    const result = await generate(base);

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-key");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "llama3.2", temperature: 0, max_tokens: 200 });
    expect(body.messages).toEqual([{ role: "system", content: base.system }, base.messages[0]]);
    expect(body.response_format).toBeUndefined();
    expect(body.stream).toBeUndefined();
    expect(result).toEqual({ text: "hi", usage: { inputTokens: 30, outputTokens: 4 } });
  });

  it("sends no authorization header without LLM_API_KEY (local servers)", async () => {
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("LLM_API_KEY", "");
    const fetch = mockFetch(okOpenAi("hi"));
    await generate(base);
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).has("authorization")).toBe(false);
  });

  it("asks for JSON schema output and validates the reply", async () => {
    vi.stubEnv("LLM_PROVIDER", "openai");
    const fetch = mockFetch(okOpenAi('{"label":"billing"}'));
    const schema = z.object({ label: z.enum(["billing", "support"]) });

    const result = await generate({ ...base, schema });

    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.name).toBe("output");
    expect(body.response_format.json_schema.schema.properties.label.enum).toEqual(["billing", "support"]);
    expect(body.response_format.json_schema.schema.$schema).toBeUndefined();
    expect(result.data).toEqual({ label: "billing" });
  });

  it("rejects a reply that does not match the schema, with its token counts", async () => {
    vi.stubEnv("LLM_PROVIDER", "openai");
    mockFetch(okOpenAi('{"label":"spam"}'));
    await expect(generate({ ...base, schema: z.object({ label: z.enum(["billing"]) }) })).rejects.toMatchObject({
      retryable: false,
      invalidOutput: true,
      usage: { inputTokens: 30, outputTokens: 4 },
    });
  });

  it("counts zero tokens when the reply has no usage", async () => {
    vi.stubEnv("LLM_PROVIDER", "openai");
    mockFetch(new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] })));
    expect((await generate(base)).usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("treats rate limits as retryable and a bad key as final, without echoing the key", async () => {
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("LLM_API_KEY", "test-key");
    mockFetch(new Response("quota", { status: 429 }));
    await expect(generate(base)).rejects.toMatchObject({ retryable: true });
    mockFetch(new Response("bad key test-key", { status: 401 }));
    const err = (await generate(base).catch((e: unknown) => e)) as LlmError;
    expect(err.retryable).toBe(false);
    expect(err.message).not.toContain("test-key");
  });
});

it("rejects an unknown LLM_PROVIDER without calling anything", async () => {
  vi.stubEnv("LLM_PROVIDER", "gemini");
  const fetch = mockFetch(new Response("{}"));
  await expect(generate(base)).rejects.toMatchObject({ name: "LlmError", retryable: false, message: expect.stringMatching(/LLM_PROVIDER/) });
  expect(fetch).not.toHaveBeenCalled();
});

it("uses an explicit connection instead of the env vars", async () => {
  vi.stubEnv("LLM_PROVIDER", "ollama");
  vi.stubEnv("LLM_BASE_URL", "http://env.local:11434");
  vi.stubEnv("LLM_API_KEY", "env-key");
  const fetch = mockFetch(new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] })));

  await generate({ ...base, connection: { provider: "openai", baseUrl: "https://api.example.com/v1/", apiKey: "user-key" } });

  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://api.example.com/v1/chat/completions");
  expect(new Headers(init.headers).get("authorization")).toBe("Bearer user-key");
});

it("sends no key with an explicit connection that has none, even if LLM_API_KEY is set", async () => {
  vi.stubEnv("LLM_API_KEY", "env-key");
  const fetch = mockFetch(ok("hi"));
  await generate({ ...base, connection: { provider: "ollama", baseUrl: "http://ollama.local:11434" } });
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("http://ollama.local:11434/api/chat");
  expect(new Headers(init.headers).has("authorization")).toBe(false);
});
