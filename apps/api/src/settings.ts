import { aiConnection, claimUsage, localConnection, presetConnection, PRESET_IDS, PRESETS, QuotaError, readAiSettings, refundUsage, saveAiSettings, THINKING_LEVELS, type AiConnection, type Db } from "@daloy/db";
import { listModels, LlmError } from "@daloy/llm-ts";
import { BadRequestException, Body, Controller, Get, HttpCode, HttpException, HttpStatus, Inject, Post, Put, UseGuards } from "@nestjs/common";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { explain, few, providerModels, sampleTest } from "./ai-sample";
import { Allow, CONFIG, CurrentUser, DB, RateLimit, ZodPipe, type ApiConfig, type SessionUser, MANAGE } from "./http";

const settingsInput = z.object({
  preset: z.enum(PRESET_IDS),
  model: z.string().trim().min(1).max(200),
  apiKey: z.string().trim().min(1).max(500).optional(),
  // Left out, the saved level stays.
  thinking: z.enum(THINKING_LEVELS).optional(),
});

const modelsInput = z.object({
  preset: z.enum(PRESET_IDS),
  // A key typed on the page but not saved yet, so the list can be shown before saving.
  apiKey: z.string().trim().min(1).max(500).optional(),
});

export { explain };

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
    const current = saved ? { ...saved, saved: true } : { preset: "local", model: localModel, thinking: "off", hasKey: false, keys: [], saved: false };
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
    const result = await sampleTest(connection, model);
    if (!result.ok) await refundUsage(this.db, user.workspaceId, "ai", { now }).catch(() => undefined);
    return result;
  }
}
