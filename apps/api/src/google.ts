import {
  connectionCredential,
  createDriveFolder,
  createSpreadsheet,
  driveFolderInfo,
  docsTemplateInfo,
  pickerToken,
  ProviderError,
  setDestination,
  sheetInfo,
  withGoogle,
  type Db,
  type GoogleConnection,
  type ProviderUrls,
} from "@daloy/db";
import { BadRequestException, Body, Controller, Get, Header, HttpCode, Inject, NotFoundException, Param, Post, UseGuards } from "@nestjs/common";
import type { HelmetOptions } from "helmet";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, CONFIG, CurrentUser, DB, MANAGE, RateLimit, ZodPipe, type ApiConfig, type SessionUser } from "./http";
import { historyHider } from "./mask";

/**
 * The Google Picker's hosts, and nothing else, added to the console's content security policy when the Picker is set
 * up (decision 0060). Taken from Google's drive-picker-element README, not from an official Picker page (unverified).
 */
export const GOOGLE_PICKER_CSP = { scriptSrc: ["https://apis.google.com"], frameSrc: ["https://docs.google.com", "https://drive.google.com"] } as const;

/** Helmet options for the console: the default policy, plus the Picker hosts only when this installation has a Picker key. */
export function consoleHeaders(providers: ProviderUrls): HelmetOptions | undefined {
  if (!providers.googleOAuth?.pickerApiKey) return undefined;
  return { contentSecurityPolicy: { directives: { scriptSrc: ["'self'", ...GOOGLE_PICKER_CSP.scriptSrc], frameSrc: ["'self'", ...GOOGLE_PICKER_CSP.frameSrc] } } };
}

// A Google file id, as the Picker returns it. The server re-reads it with its own grant before saving it (R12).
const fileId = z.string().regex(/^[\w-]{10,100}$/);
const sheetPick = z.strictObject({ spreadsheetId: fileId, tab: z.string().trim().min(1).max(100).optional() });
const folderPick = z.strictObject({ folderId: fileId });
const templatePick = z.strictObject({ templateId: fileId });
const APPS = { "google-sheets": "google_sheets", "google-drive": "google_drive" } as const;
const app = new ZodPipe(z.enum(["google-sheets", "google-drive"]).transform((s) => APPS[s]));

const asBadRequest = (err: unknown): never => {
  if (err instanceof ProviderError) throw new BadRequestException(err.message);
  throw err;
};

/**
 * Easy connect for Sheets and Drive after a Google sign-in (plan 6.1): create a sheet or folder, or pick one in the
 * Google Picker. The page sends only the picked id; Daloy reads it with its own drive.file grant, which Google refuses
 * for any file the owner did not pick, so a forged id gains nothing. Owners only, like every connection route.
 */
@Controller("settings/connections")
@UseGuards(SessionGuard, Allow(MANAGE))
export class GoogleController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Required<ApiConfig>,
  ) {}

  /**
   * One route for both apps: a one-hour drive.file access token for the Picker, with the public API key and app id.
   * Never cached, never logged.
   */
  @Post(":app/picker-token")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @UseGuards(RateLimit(10))
  async pickerToken(@CurrentUser() user: SessionUser, @Param("app", app) provider: "google_sheets" | "google_drive") {
    const g = this.config.providers.googleOAuth;
    if (!g?.pickerApiKey || !g.projectNumber) throw new BadRequestException("The Google Picker is not set up on this installation. Use Create instead, or ask the person who runs Daloy to set GOOGLE_PICKER_API_KEY and GOOGLE_PROJECT_NUMBER.");
    const conn = await this.google(user.workspaceId, provider);
    const t = await pickerToken(this.db, this.config.secretsKey, this.config.providers, user.workspaceId, provider, conn).catch(asBadRequest);
    return { accessToken: t.accessToken, expiresAt: t.expiresAt, apiKey: g.pickerApiKey, appId: g.projectNumber };
  }

  /** Create a sheet for me: a spreadsheet named "Daloy requests" in the owner's Drive, its first tab chosen. */
  @Post("google-sheets/create")
  @HttpCode(200)
  @UseGuards(RateLimit(5))
  async createSheet(@CurrentUser() user: SessionUser) {
    const conn = await this.google(user.workspaceId, "google_sheets");
    const made = await this.call(user.workspaceId, "google_sheets", conn, (auth) => createSpreadsheet(this.config.providers, auth, "Daloy requests"));
    return this.saveSheet(user.workspaceId, made.spreadsheetId, made.title, made.tabs, undefined);
  }

  /** A picked sheet, or another tab of the chosen one. Read with Daloy's own grant first. */
  @Post("google-sheets/pick")
  @HttpCode(200)
  @UseGuards(RateLimit(10))
  async pickSheet(@CurrentUser() user: SessionUser, @Body(new ZodPipe(sheetPick)) body: z.output<typeof sheetPick>) {
    const conn = await this.google(user.workspaceId, "google_sheets");
    const info = await this.call(user.workspaceId, "google_sheets", conn, (auth) => sheetInfo(this.config.providers, auth, body.spreadsheetId));
    return this.saveSheet(user.workspaceId, body.spreadsheetId, info.title, info.tabs, body.tab);
  }

  /** The chosen sheet's real tab names, for the tab dropdown. */
  @Get("google-sheets/tabs")
  @UseGuards(RateLimit(20))
  async tabs(@CurrentUser() user: SessionUser) {
    const conn = await this.google(user.workspaceId, "google_sheets");
    const id = conn.destination?.spreadsheetId;
    if (!id) throw new NotFoundException("No sheet is chosen yet.");
    return this.call(user.workspaceId, "google_sheets", conn, (auth) => sheetInfo(this.config.providers, auth, id));
  }

  /** Daloy creates a "Daloy uploads" folder in the owner's My Drive. */
  @Post("google-drive/create")
  @HttpCode(200)
  @UseGuards(RateLimit(5))
  async createFolder(@CurrentUser() user: SessionUser) {
    const conn = await this.google(user.workspaceId, "google_drive");
    const folder = await this.call(user.workspaceId, "google_drive", conn, (auth) => createDriveFolder(this.config.providers, auth, "Daloy uploads"));
    await setDestination(this.db, user.workspaceId, "google_drive", folder);
    return folder;
  }

  /** A picked folder, in My Drive or a shared drive. Read with Daloy's own grant first. */
  @Post("google-drive/pick")
  @HttpCode(200)
  @UseGuards(RateLimit(10))
  async pickFolder(@CurrentUser() user: SessionUser, @Body(new ZodPipe(folderPick)) body: z.output<typeof folderPick>) {
    const conn = await this.google(user.workspaceId, "google_drive");
    const { title } = await this.call(user.workspaceId, "google_drive", conn, (auth) => driveFolderInfo(this.config.providers, auth, body.folderId));
    await setDestination(this.db, user.workspaceId, "google_drive", { folderId: body.folderId, title });
    return { folderId: body.folderId, title };
  }

  /**
   * A template picked for a "Make a document" step. Read with Daloy's own grant first, like every pick. Nothing is saved
   * here: the editor keeps the id in the step, so each workflow can use its own template.
   */
  @Post("google-drive/template")
  @HttpCode(200)
  @UseGuards(RateLimit(20))
  async checkTemplate(@CurrentUser() user: SessionUser, @Body(new ZodPipe(templatePick)) body: z.output<typeof templatePick>) {
    const conn = await this.google(user.workspaceId, "google_drive");
    return this.call(user.workspaceId, "google_drive", conn, (auth) => docsTemplateInfo(this.config.providers, auth, body.templateId));
  }

  private async saveSheet(workspaceId: string, spreadsheetId: string, title: string, tabs: string[], tab: string | undefined) {
    const chosen = tab ?? tabs[0];
    if (!chosen || !tabs.includes(chosen)) throw new BadRequestException(`The sheet has no tab called "${tab ?? ""}". Its tabs are: ${tabs.join(", ")}.`);
    await setDestination(this.db, workspaceId, "google_sheets", { spreadsheetId, tab: chosen, title });
    return { spreadsheetId, title, tabs, tab: chosen };
  }

  private async call<T>(workspaceId: string, provider: "google_sheets" | "google_drive", conn: GoogleConnection, fn: Parameters<typeof withGoogle<T>>[6]) {
    try {
      return await withGoogle(this.db, this.config.secretsKey, this.config.providers, workspaceId, provider, conn, fn);
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      const hide = await historyHider(this.db, this.config.secretsKey, workspaceId);
      throw new BadRequestException(hide(err.message) as string);
    }
  }

  /** The connection, which must be a Google sign-in: a service account cannot use drive.file picks or make files in My Drive. */
  private async google(workspaceId: string, provider: "google_sheets" | "google_drive") {
    const conn = await connectionCredential(this.db, this.config.secretsKey, workspaceId, provider);
    if (!conn) throw new NotFoundException(`${provider === "google_sheets" ? "Google Sheets" : "Google Drive"} is not connected.`);
    if (conn.authMethod !== "oauth") throw new BadRequestException("This works with a Google sign-in. Choose Connect with Google first.");
    return conn;
  }
}
