import { aiConnection, claimUsage, isLocalModel, QuotaError, type AiConnection, type Db } from "@daloy/db";
import { chatPrompt, lintDefinition, parseChatReply, type ChatMessage } from "@daloy/engine";
import { generate, type Message } from "@daloy/llm-ts";
import { Body, Controller, HttpCode, HttpException, HttpStatus, Inject, Post, UseGuards } from "@nestjs/common";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, CONFIG, CurrentUser, DB, RateLimit, ZodPipe, type ApiConfig, type SessionUser, MANAGE } from "./http";
import { explain } from "./settings";

/** The app kinds the page may name, so nothing typed by a person reaches the prompt through this field. */
const APP_KINDS = ["google_sheets", "slack", "outlook", "teams"] as const;

const chatInput = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(2000) }))
    .min(1)
    .max(20),
  current: z.unknown().optional(),
  apps: z.array(z.enum(APP_KINDS)).max(APP_KINDS.length).optional(),
});

/**
 * Build with AI as a conversation (decision 0048): one message from the person is one model call, and the model
 * answers with either one question or the whole draft. Only the draft is returned; nothing is saved here.
 */
@Controller("ai")
@UseGuards(SessionGuard, Allow(MANAGE))
export class AiChatController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  @Post("chat")
  @HttpCode(200)
  @UseGuards(RateLimit(10))
  async chat(@CurrentUser() user: SessionUser, @Body(new ZodPipe(chatInput)) body: z.output<typeof chatInput>) {
    const { model, ...connection } = await aiConnection(this.db, this.config.secretsKey, user.workspaceId);
    // One message is one AI action, whatever the repair below does.
    await claimUsage(this.db, user.workspaceId, "ai").catch((err: unknown) => {
      throw err instanceof QuotaError ? new HttpException({ message: err.message }, HttpStatus.TOO_MANY_REQUESTS) : err;
    });
    return chatTurn({ ...body, model, connection });
  }
}

/**
 * One message from the person, as the console sends it: the model call, plus one repair try. Exported so the AI
 * stress test (apps/api/scripts/ai-stress.ts) runs exactly this code. `stats` counts calls and tokens for it.
 */
export async function chatTurn(input: {
  messages: ChatMessage[];
  current?: unknown;
  apps?: string[];
  model: string;
  connection: Omit<AiConnection, "model">;
  stats?: { calls: number; inputTokens: number; outputTokens: number; replies: string[] };
}) {
  const prompt = chatPrompt({ messages: input.messages, current: input.current, apps: input.apps, full: !isLocalModel(input.connection) });
  const messages: Message[] = [...prompt.messages];
  let firstDraft: { kind: "draft"; name: string; summary: string; definition: Parameters<typeof lintDefinition>[0]; warnings: string[] } | undefined;
  let errors: string[] = [];
  // One try, then one more with the problems of the first reply: a near miss gets fixed, and a valid draft with lint
  // warnings gets the same second try (decision 0033). A question is returned as it is, so nobody waits twice for it.
  for (let attempt = 1; attempt <= 2; attempt++) {
    let text: string;
    let usage: { inputTokens: number; outputTokens: number };
    try {
      ({ text, usage } = await generate({ system: prompt.system, messages, model: input.model, connection: input.connection, temperature: 0.2, maxTokens: 4096, timeoutMs: 90_000 }));
    } catch (err) {
      if (firstDraft) return firstDraft;
      throw new HttpException({ message: explain(err) }, HttpStatus.BAD_GATEWAY);
    }
    if (input.stats) {
      input.stats.calls++;
      input.stats.inputTokens += usage.inputTokens;
      input.stats.outputTokens += usage.outputTokens;
      input.stats.replies.push(text);
    }
    const result = parseChatReply(text);
    if (!result.ok) {
      if (firstDraft) return firstDraft;
      errors = result.errors;
      messages.push(
        { role: "assistant", content: text },
        { role: "user", content: `That reply has these problems:\n- ${errors.join("\n- ")}\nReply again with one JSON object only: either the question, or the draft.` },
      );
      continue;
    }
    if (result.kind === "question") return { kind: "question" as const, text: result.text, choices: result.choices };
    const draft = { kind: "draft" as const, name: result.name, summary: result.summary, definition: result.definition, warnings: lintDefinition(result.definition) };
    if (draft.warnings.length === 0 || attempt === 2 || firstDraft) return draft;
    firstDraft = draft;
    messages.push(
      { role: "assistant", content: text },
      { role: "user", content: `That draft is valid but has these problems:\n- ${draft.warnings.join("\n- ")}\nFix them unless the request asks for exactly that. Reply with the corrected JSON object only.` },
    );
  }
  throw new HttpException({ message: "The AI could not make a valid workflow. Try describing it in simpler steps, or pick a larger model.", errors }, HttpStatus.UNPROCESSABLE_ENTITY);
}
