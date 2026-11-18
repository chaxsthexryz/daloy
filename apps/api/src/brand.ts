import { readBrand, readLogo, saveBrand, type Db } from "@daloy/db";
import { ACCENT, LOGO_MAX_BYTES, LOGO_MIME, logoType } from "@daloy/engine";
import { BadRequestException, Body, Controller, Delete, Get, Header, HttpCode, Inject, NotFoundException, Param, Put, StreamableFile, UseGuards } from "@nestjs/common";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, CurrentUser, DB, MANAGE, ZodPipe, type SessionUser } from "./http";

const accentInput = z.strictObject({ accent: z.string().regex(ACCENT).nullable() });
// The logo arrives as base64 inside JSON (no new upload dependency); the decoded size is checked below.
const logoInput = z.strictObject({ data: z.string().max(Math.ceil((LOGO_MAX_BYTES * 4) / 3) + 4) });

/** Brand kit (decision 0050): one accent colour and one logo. The business name is the existing profile name. */
@Controller("settings/brand")
@UseGuards(SessionGuard, Allow(MANAGE))
export class BrandController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async read(@CurrentUser() user: SessionUser) {
    const brand = await readBrand(this.db, user.workspaceId);
    return { accent: brand?.accent ?? null, logo: !!brand?.logo };
  }

  @Put()
  async putAccent(@CurrentUser() user: SessionUser, @Body(new ZodPipe(accentInput)) body: z.output<typeof accentInput>) {
    await saveBrand(this.db, user.workspaceId, body);
    return body;
  }

  /** The type comes from the file's own bytes. SVG can carry script, so it is refused like every other type but three. */
  @Put("logo")
  async putLogo(@CurrentUser() user: SessionUser, @Body(new ZodPipe(logoInput)) body: z.output<typeof logoInput>) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body.data)) throw new BadRequestException("The logo is not valid base64");
    const data = Buffer.from(body.data, "base64");
    if (data.length > LOGO_MAX_BYTES) throw new BadRequestException(`The logo is over ${LOGO_MAX_BYTES / 1024} KB`);
    const type = logoType(data);
    if (!type) throw new BadRequestException("The logo must be a PNG, JPEG or WebP file");
    await saveBrand(this.db, user.workspaceId, { logo: { type, data } });
    return { logo: true };
  }

  @Delete("logo")
  @HttpCode(204)
  async removeLogo(@CurrentUser() user: SessionUser) {
    await saveBrand(this.db, user.workspaceId, { logo: null });
  }
}

/** The logo for public pages. Nothing else about the workspace is readable here, and the type is only ever one of three images. */
@Controller("brand/logo")
export class BrandLogoController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get(":id")
  @Header("Cache-Control", "public, max-age=300")
  async logo(@Param("id", new ZodPipe(z.uuid())) id: string) {
    const logo = await readLogo(this.db, id);
    if (!logo) throw new NotFoundException();
    return new StreamableFile(logo.data, { type: LOGO_MIME[logo.type] });
  }
}
