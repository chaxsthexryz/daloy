import { createHash } from "node:crypto";
import { aiConnection, claimUsage, localConnection, presetConnection, PRESET_IDS, PRESETS, QuotaError, readAiSettings, refundUsage, saveAiSettings, type AiConnection, type Db } from "@daloy/db";
import { aiConfigSchema, aiOutputSchema, buildPrompt, TEMPLATES } from "@daloy/engine";
import { generate, listModels, LlmError } from "@daloy/llm-ts";
import { BadRequestException, Body, Controller, Get, HttpCode, HttpException, HttpStatus, Inject, Post, Put, UseGuards } from "@nestjs/common";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, CONFIG, CurrentUser, DB, RateLimit, ZodPipe, type ApiConfig, type SessionUser, MANAGE } from "./http";

const settingsInput = z.object({
  preset: z.enum(PRESET_IDS),
  model: z.string().trim().min(1).max(200),
  apiKey: z.string().trim().min(1).max(500).optional(),
});

const modelsInput = z.object({
  preset: z.enum(PRESET_IDS),
  // A key typed on the page but not saved yet, so the list can be shown before saving.
  apiKey: z.string().trim().min(1).max(500).optional(),
});

// The classify step of the Inquiry triage template, so the test checks exactly what that workflow will run.
const triage = TEMPLATES.find((t) => t.slug === "inquiry-triage")!.definition.steps.find((s) => s.id === "classify")!;
const classify = aiConfigSchema.parse(triage.config);
const SAMPLE = "Hi, I was charged twice for my March invoice (INV-2026-0412). Can you refund one of the payments?";

/** Up to twelve names, so an error stays readable when a provider offers hundreds of models. */
function few(models: string[]): string {
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
 * Plain outage wording for non-admin workspace owners on Build with AI and Run explanations. Never exposes API key
 * internals or local .env instructions.
 */
export function explainForOwner(err: unknown): string {
  const unavailable = "The AI service is temporarily unavailable. Try again in a few minutes, or start from a ready-made template below.";
  if (!(err instanceof LlmError)) return unavailable;
  if (err.message.includes("token limit")) return "The model spent its whole token limit thinking and gave no answer. Pick a smaller or non-thinking model.";
  if (err.invalidOutput) return "The model answered, but not in the expected format. A larger model usually fixes this.";
  if (err.message.endsWith("TimeoutError")) return "The model took too long to answer. A hosted model may be overloaded; try again in a minute.";
  const status = Number(/HTTP (\d+)/.exec(err.message)?.[1]);
  if (status === 429) return "The provider's rate limit or free quota was reached. Wait a minute and try again.";
  return unavailable;
}

/**
 * The model names a provider offers, kept for five minutes so saving twice does not ask twice. The key is not kept,
 * only a short hash of it, and a failed lookup is not remembered: the next save asks again.
 */
const modelCache = new Map<string, { at: number; models: string[] }>();
async function providerModels(conn: AiConnection): Promise<string[]> {
  const cacheKey = `${conn.baseUrl}|${createHash("sha256").update(conn.apiKey ?? "").digest("hex").slice(0, 16)}`;
  const hit = modelCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.models;
  const models = await listModels(conn, 3000);
  modelCache.set(cacheKey, { at: Date.now(), models });
  return models;
}

/** The AI model a user's workflows run with. Keys are write-only, like secrets. */
@Controller("settings/ai")
@UseGuards(SessionGuard, Allow(MANAGE))
export class SettingsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get()
  async get(@CurrentUser() user: SessionUser) {
    const saved = await readAiSettings(this.db, user.workspaceId);
    const localModel = localConnection().model;
    const current = saved ? { ...saved, saved: true } : { preset: "local", model: localModel, hasKey: false, keys: [], saved: false };
    const presets = Object.fromEntries(
      Object.entries(PRESETS).map(([id, p]) => [id, { label: p.label, defaultModel: id === "local" ? localModel : p.defaultModel, needsKey: p.needsKey, models: p.models }]),
    );
    return { current, presets };
  }

  /** The models the local server from .env offers, so the console can list them. Only that URL is ever called. */
  @Get("local-models")
  async localModels() {
    try {
      return { ok: true, models: await listModels(localConnection()) };
    } catch (err) {
      return { ok: false, models: [], error: explain(err) };
    }
  }

  /** The model names a provider offers, so the console can offer them before the choice is saved. */
  @Post("models")
  @HttpCode(200)
  @UseGuards(RateLimit(10))
  async offeredModels(@CurrentUser() user: SessionUser, @Body(new ZodPipe(modelsInput)) body: z.output<typeof modelsInput>) {
    let conn: AiConnection;
    try {
      conn = body.preset === "local" ? localConnection() : await presetConnection(this.db, this.config.secretsKey, user.workspaceId, body.preset, body.apiKey);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    try {
      return { ok: true, models: await listModels(conn) };
    } catch (err) {
      return { ok: false, models: [], error: explain(err) };
    }
  }

  @Put()
  @HttpCode(204)
  async put(@CurrentUser() user: SessionUser, @Body(new ZodPipe(settingsInput)) body: z.output<typeof settingsInput>) {
    // A hosted provider serves a fixed list of model names, and it answers HTTP 400 for anything else. Check the name
    // against that list before saving it, so a display name such as "DeepSeek-V4.1-Flash" cannot be stored. A
    // provider that cannot be reached is not a reason to refuse, so a failed lookup lets the save through.
    if (body.preset !== "local") {
      let conn: AiConnection;
      try {
        conn = await presetConnection(this.db, this.config.secretsKey, user.workspaceId, body.preset, body.apiKey);
      } catch (err) {
        throw new BadRequestException((err as Error).message);
      }
      const offered = await providerModels(conn).catch(() => null);
      if (offered?.length && !offered.includes(body.model)) {
        throw new BadRequestException(`The provider does not offer "${body.model}". Its model names are: ${few(offered)}.`);
      }
    }
    try {
      await saveAiSettings(this.db, this.config.secretsKey, user.workspaceId, body);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  /** One real model call on a sample inquiry, with the saved settings. Costs tokens, so it has its own limit. */
  @Post("test")
  @HttpCode(200)
  @UseGuards(RateLimit(10))
  async test(@CurrentUser() user: SessionUser) {
    const { model, ...connection } = await aiConnection(this.db, this.config.secretsKey, user.workspaceId);
    const now = new Date();
    await claimUsage(this.db, user.workspaceId, "ai", { now }).catch((err: unknown) => {
      throw err instanceof QuotaError ? new HttpException({ message: err.message }, HttpStatus.TOO_MANY_REQUESTS) : err;
    });
    const started = Date.now();
    try {
      const { data, usage } = await generate({ ...buildPrompt(classify, SAMPLE), schema: aiOutputSchema(classify), model, connection, temperature: 0, maxTokens: 256, timeoutMs: 30_000 });
      return { ok: true, model, sample: SAMPLE, label: (data as { label: string }).label, ms: Date.now() - started, ...usage };
    } catch (err) {
      await refundUsage(this.db, user.workspaceId, "ai", { now }).catch(() => undefined);
      // Only on a name the provider may not serve: one extra request to say which names it does.
      const status = Number(/HTTP (\d+)/.exec((err as Error).message)?.[1]);
      const offered = status === 400 || status === 404 ? await providerModels({ ...connection, model }).catch(() => []) : [];
      return { ok: false, model, sample: SAMPLE, error: explain(err, offered) };
    }
  }
}
