import { afterEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { generate, listModels, LlmError } from "./index";

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

  const img = { type: "image/png", base64: "QUJD" };
  const withImage = { ...base, messages: [{ role: "user" as const, content: "what is this", images: [img] }] };
  const sentBody = (fetch: ReturnType<typeof mockFetch>) => JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));

  it("sends images to Ollama in the images array", async () => {
    const fetch = mockFetch(ok("hi"));
    await generate(withImage);
    expect(sentBody(fetch).messages[1]).toEqual({ role: "user", content: "what is this", images: ["QUJD"] });
  });

  it("sends images to an OpenAI-compatible server as image_url parts, also in object JSON mode", async () => {
    for (const jsonMode of ["schema", "object"] as const) {
      const fetch = mockFetch(new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] })));
      await generate({ ...withImage, schema: z.object({}), connection: { provider: "openai", baseUrl: "http://x/v1", jsonMode } });
      expect(sentBody(fetch).messages[1]).toEqual({
        role: "user",
        content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }],
      });
    }
  });

  it("serializes a message without images exactly as before", async () => {
    const fetch = mockFetch(ok("hi"));
    await generate({ ...base, messages: [{ role: "user", content: "hello", images: [] }] });
    expect(JSON.stringify(sentBody(fetch).messages[1])).toBe('{"role":"user","content":"hello"}');
  });

  it("explains a 400 on a request with images, without retry", async () => {
    mockFetch(new Response("secret body", { status: 400 }));
    await expect(generate(withImage)).rejects.toMatchObject({
      message: "The AI model refused the file (HTTP 400). Pick a model that reads images on the AI model page.",
      retryable: false,
    });
  });

  it("keeps the plain message for a 400 without images", async () => {
    mockFetch(new Response("", { status: 400 }));
    await expect(generate(base)).rejects.toMatchObject({ message: "LLM returned HTTP 400" });
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

// A reply an OpenAI-compatible server would send, used inside and outside the describe below.
const okOpenAi = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 30, completion_tokens: 4 } }));

// LLM_PROVIDER=openai: any OpenAI-compatible chat API (Gemini, LM Studio, llama.cpp, vLLM, OpenRouter).
describe("generate with LLM_PROVIDER=openai", () => {
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

// DeepSeek answers 400 to json_schema ("This response_format type is unavailable now") but accepts json_object.
it("uses JSON object mode with the schema in the system message when the connection asks for it, and still validates", async () => {
  const fetch = mockFetch(okOpenAi('{"label":"billing"}'));
  const schema = z.object({ label: z.enum(["billing", "support"]) });
  const result = await generate({ ...base, schema, connection: { provider: "openai", baseUrl: "https://api.deepseek.com", jsonMode: "object" } });
  const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
  expect(body.response_format).toEqual({ type: "json_object" });
  expect(body.messages[0].role).toBe("system");
  expect(body.messages[0].content).toContain("JSON");
  expect(body.messages[0].content).toContain('"billing"');
  expect(result.data).toEqual({ label: "billing" });
});

it("adds a connection's extra body fields to an OpenAI-compatible request", async () => {
  const fetch = mockFetch(new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] })));
  await generate({ ...base, connection: { provider: "openai", baseUrl: "http://local:8080/v1", extraBody: { chat_template_kwargs: { enable_thinking: false } } } });
  const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
  expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  expect(body.model).toBe("llama3.2");
});

it("says a reply was cut off at the token limit, instead of blaming the JSON", async () => {
  vi.stubEnv("LLM_PROVIDER", "openai");
  vi.stubEnv("LLM_BASE_URL", "https://api.example.com/v1");
  mockFetch(new Response(JSON.stringify({ choices: [{ message: { content: '{"label":"bil' }, finish_reason: "length" }] })));
  await expect(generate({ ...base, schema: z.object({ label: z.string() }) })).rejects.toMatchObject({
    invalidOutput: true,
    message: expect.stringContaining("cut off at the token limit"),
  });
});

it("adds a connection's thinking headroom to max_tokens, so maxTokens stays the answer's budget", async () => {
  const fetch = mockFetch(new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] })));
  await generate({ ...base, connection: { provider: "openai", baseUrl: "https://g.example/v1", reasoningTokens: 2048 } });
  const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
  expect(body.max_tokens).toBe(200 + 2048);
});

describe("listModels", () => {
  it("reads Ollama's /api/tags", async () => {
    const fetch = mockFetch(new Response(JSON.stringify({ models: [{ name: "llama3.2:latest" }, { name: "hermes3" }] })));
    expect(await listModels({ provider: "ollama", baseUrl: "http://ollama.local:11434/" })).toEqual(["llama3.2:latest", "hermes3"]);
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe("http://ollama.local:11434/api/tags");
  });

  it("reads an OpenAI-compatible /models with the key", async () => {
    const fetch = mockFetch(new Response(JSON.stringify({ data: [{ id: "Qwen3.5-4B-Q4_K_M" }, { id: "other" }] })));
    expect(await listModels({ provider: "openai", baseUrl: "http://127.0.0.1:18434/v1", apiKey: "k" })).toEqual(["Qwen3.5-4B-Q4_K_M", "other"]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:18434/v1/models");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer k");
  });

  it("fails with LlmError when the server is down or answers an error", async () => {
    mockFetch(new TypeError("fetch failed"));
    await expect(listModels({ provider: "ollama", baseUrl: "http://x" })).rejects.toBeInstanceOf(LlmError);
    mockFetch(new Response("no", { status: 401 }));
    await expect(listModels({ provider: "openai", baseUrl: "http://x" })).rejects.toMatchObject({ message: "LLM returned HTTP 401" });
  });
});

it("says the token limit ran out when a reply is empty and cut off, instead of 'not valid JSON'", async () => {
  mockFetch(new Response(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }], usage: { prompt_tokens: 30, completion_tokens: 0 } })));
  const err = (await generate({ ...base, schema: z.object({}), connection: { provider: "openai", baseUrl: "https://g.example/v1" } }).catch((e: unknown) => e)) as LlmError;
  expect(err.message).toMatch(/used up its token limit/);
  expect(err).toMatchObject({ retryable: false, invalidOutput: true, usage: { inputTokens: 30, outputTokens: 0 } });
});

// A model host that answers with a redirect must not move the prompt or the key to another origin (review, route and data checks).
describe("redirects", () => {
  async function pair() {
    const { createServer } = await import("node:http");
    const hits: { url?: string; auth?: string }[] = [];
    const target = createServer((req, res) => {
      hits.push({ url: req.url, auth: req.headers.authorization });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ message: { content: "hi" }, models: [] }));
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const targetUrl = `http://127.0.0.1:${(target.address() as import("node:net").AddressInfo).port}`;
    const front = createServer((_req, res) => res.writeHead(307, { location: `${targetUrl}/stolen` }).end());
    await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
    const baseUrl = `http://127.0.0.1:${(front.address() as import("node:net").AddressInfo).port}`;
    const close = () => Promise.all([target, front].map((s) => new Promise((r) => s.close(r))));
    return { hits, baseUrl, close };
  }

  it("generate refuses a redirect and sends nothing to the other origin", async () => {
    const { hits, baseUrl, close } = await pair();
    try {
      await expect(generate({ ...base, connection: { provider: "ollama", baseUrl, apiKey: "secret-key" } })).rejects.toBeInstanceOf(LlmError);
      expect(hits).toEqual([]);
    } finally {
      await close();
    }
  });

  it("listModels refuses a redirect and sends nothing to the other origin", async () => {
    const { hits, baseUrl, close } = await pair();
    try {
      await expect(listModels({ provider: "openai", baseUrl, apiKey: "secret-key" })).rejects.toBeInstanceOf(LlmError);
      expect(hits).toEqual([]);
    } finally {
      await close();
    }
  });
});
