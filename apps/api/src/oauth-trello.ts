import { setDestination, trelloBoards, trelloLists, type Db } from "@daloy/db";
import { Body, Controller, Get, HttpCode, Inject, Param, Put, UseGuards } from "@nestjs/common";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, CONFIG, CurrentUser, DB, MANAGE, RateLimit, ZodPipe, type SessionUser } from "./http";
import { notInList, oauthConnection, pickerCall, type Config } from "./oauth-records";

const id24 = z.string().regex(/^[a-f0-9]{24}$/i);
const boardParam = new ZodPipe(id24);
const targetInput = z.strictObject({ boardId: id24, listId: id24 });

/** The board and list pickers. Owners only. */
@Controller("settings/connections/trello")
@UseGuards(SessionGuard, Allow(MANAGE))
export class TrelloOAuthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @Get("boards")
  @UseGuards(RateLimit(20))
  async boards(@CurrentUser() user: SessionUser) {
    const conn = await oauthConnection(this.db, this.config, user, "trello");
    return pickerCall(this.db, this.config, user, "trello", conn, (t) => trelloBoards(this.config.providers, { bearer: t }));
  }

  @Get("boards/:boardId/lists")
  @UseGuards(RateLimit(20))
  async lists(@CurrentUser() user: SessionUser, @Param("boardId", boardParam) boardId: string) {
    const conn = await oauthConnection(this.db, this.config, user, "trello");
    return pickerCall(this.db, this.config, user, "trello", conn, (t) => trelloLists(this.config.providers, { bearer: t }, boardId));
  }

  /** Saves the list. The board and the list must be in the lists read now with the connection's own token. */
  @Put("target")
  @HttpCode(204)
  @UseGuards(RateLimit(20))
  async target(@CurrentUser() user: SessionUser, @Body(new ZodPipe(targetInput)) body: z.output<typeof targetInput>) {
    const conn = await oauthConnection(this.db, this.config, user, "trello");
    const { board, list } = await pickerCall(this.db, this.config, user, "trello", conn, async (t) => {
      const auth = { bearer: t };
      const board = (await trelloBoards(this.config.providers, auth)).find((b) => b.id === body.boardId);
      return { board, list: board && (await trelloLists(this.config.providers, auth, board.id)).find((l) => l.id === body.listId) };
    });
    if (!board) throw notInList("board");
    if (!list) throw notInList("list");
    await setDestination(this.db, user.workspaceId, "trello", { boardId: board.id, boardName: board.name, listId: list.id, listName: list.name });
  }
}
