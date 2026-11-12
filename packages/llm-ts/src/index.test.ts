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
