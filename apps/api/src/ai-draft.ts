import { aiConnection, type Db } from "@daloy/db";
import { draftPrompt, parseDraftReply } from "@daloy/engine";
import { generate, type Message } from "@daloy/llm-ts";
import { Body, Controller, HttpCode, HttpException, HttpStatus, Inject, Post, UseGuards } from "@nestjs/common";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, CONFIG, CurrentUser, DB, RateLimit, ZodPipe, type ApiConfig, type SessionUser, MANAGE } from "./http";
import { explain } from "./settings";

const draftInput = z.object({ request: z.string().trim().min(1).max(2000), current: z.unknown().optional() });

/**
 * Builds or changes a workflow draft from plain words, with the model the user picked (decision 0017).
 * It only returns a draft: the console shows it in the editor and the user saves or publishes it.
 */
@Controller("ai")
@UseGuards(SessionGuard, Allow(MANAGE))
export class AiDraftController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  @Post("draft")
  @HttpCode(200)
  @UseGuards(RateLimit(10))
  async draft(@CurrentUser() user: SessionUser, @Body(new ZodPipe(draftInput)) body: z.output<typeof draftInput>) {
    const { model, ...connection } = await aiConnection(this.db, this.config.secretsKey, user.workspaceId);
    const prompt = draftPrompt(body);
    const messages: Message[] = [...prompt.messages];
    let errors: string[] = [];
    // One try, then one more with the problems of the first reply, so a near miss gets fixed.
    for (let attempt = 1; attempt <= 2; attempt++) {
      let text: string;
      try {
        ({ text } = await generate({ system: prompt.system, messages, model, connection, temperature: 0.2, maxTokens: 4096, timeoutMs: 90_000 }));
      } catch (err) {
        throw new HttpException({ message: explain(err) }, HttpStatus.BAD_GATEWAY);
      }
      const result = parseDraftReply(text);
      if (result.ok) return { name: result.name, summary: result.summary, definition: result.definition };
      errors = result.errors;
      messages.push({ role: "assistant", content: text }, { role: "user", content: `That reply has these problems:\n- ${errors.join("\n- ")}\nReply again with the corrected JSON object only.` });
    }
    throw new HttpException({ message: "The AI could not make a valid workflow. Try describing it in simpler steps, or pick a larger model.", errors }, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}
