import { aiConnection, PRESET_IDS, PRESETS, readAiSettings, saveAiSettings, type Db } from "@daloy/db";
import { aiConfigSchema, aiOutputSchema, buildPrompt, TEMPLATES } from "@daloy/engine";
import { generate, LlmError } from "@daloy/llm-ts";
import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Post, Put, UseGuards } from "@nestjs/common";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { CONFIG, CurrentUser, DB, RateLimit, ZodPipe, type ApiConfig, type SessionUser } from "./http";

const settingsInput = z.object({
  preset: z.enum(PRESET_IDS),
  model: z.string().trim().min(1).max(200),
  apiKey: z.string().trim().min(1).max(500).optional(),
});

// The classify step of the Inquiry triage template, so the test checks exactly what that workflow will run.
const triage = TEMPLATES.find((t) => t.slug === "inquiry-triage")!.definition.steps.find((s) => s.id === "classify")!;
const classify = aiConfigSchema.parse(triage.config);
const SAMPLE = "Hi, I was charged twice for my March invoice (INV-2026-0412). Can you refund one of the payments?";

/** Plain-language reasons for the console. Only the HTTP status is known, never the provider's response body. */
export function explain(err: unknown): string {
  if (!(err instanceof LlmError)) return "The test failed unexpectedly. Check the worker and API logs.";
  if (err.invalidOutput) return "The model answered, but not in the expected format. A larger model usually fixes this.";
  if (err.message.endsWith("TimeoutError")) return "The model took too long to answer. A hosted model may be overloaded; try again in a minute.";
  const status = Number(/HTTP (\d+)/.exec(err.message)?.[1]);
  if (!status) return "Could not connect to the model. For a local model, check that Ollama is running and the model is pulled.";
  if (status === 401 || status === 403) return "The provider rejected the API key.";
  if (status === 404) return "The provider does not know this model name.";
  if (status === 429) return "The provider's rate limit or free quota was reached. Wait a minute and try again.";
  if (status >= 500) return `The provider is busy or down right now (HTTP ${status}). Try again in a minute.`;
  return `The provider answered with HTTP ${status}.`;
}

/** The AI model a user's workflows run with. Keys are write-only, like secrets. */
@Controller("settings/ai")
@UseGuards(SessionGuard)
export class SettingsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get()
  async get(@CurrentUser() user: SessionUser) {
    const saved = await readAiSettings(this.db, user.id);
    const current = saved ? { ...saved, saved: true } : { preset: "local", model: process.env.LLM_MODEL || "llama3.2", hasKey: false, saved: false };
    const presets = Object.fromEntries(Object.entries(PRESETS).map(([id, p]) => [id, { label: p.label, defaultModel: p.defaultModel, needsKey: p.needsKey, models: p.models }]));
    return { current, presets };
  }

  @Put()
  @HttpCode(204)
  async put(@CurrentUser() user: SessionUser, @Body(new ZodPipe(settingsInput)) body: z.output<typeof settingsInput>) {
    try {
      await saveAiSettings(this.db, this.config.secretsKey, user.id, body);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  /** One real model call on a sample inquiry, with the saved settings. Costs tokens, so it has its own limit. */
  @Post("test")
  @HttpCode(200)
  @UseGuards(RateLimit(10))
  async test(@CurrentUser() user: SessionUser) {
    const { model, ...connection } = await aiConnection(this.db, this.config.secretsKey, user.id);
    const started = Date.now();
    try {
      const { data, usage } = await generate({ ...buildPrompt(classify, SAMPLE), schema: aiOutputSchema(classify), model, connection, temperature: 0, maxTokens: 256, timeoutMs: 30_000 });
      return { ok: true, model, sample: SAMPLE, label: (data as { label: string }).label, ms: Date.now() - started, ...usage };
    } catch (err) {
      return { ok: false, model, sample: SAMPLE, error: explain(err) };
    }
  }
}
