import { join } from "node:path";
import { Controller, Get, Header, Inject, NotFoundException, Res, UseGuards } from "@nestjs/common";
import type { RequestHandler, Response } from "express";
import { AdminGuard } from "./admin";
import { CONFIG, type ApiConfig } from "./http";

/**
 * The platform admin console (decision 0152), its own page beside the workspace console. AdminGuard answers 404 to
 * everyone outside PLATFORM_ADMINS, so to them the page does not exist. Tabs are hash routes, so /admin is the only path:
 * the admin API owns every /admin/<name> path.
 */
@Controller("admin")
@UseGuards(AdminGuard)
export class AdminPageController {
  constructor(@Inject(CONFIG) private readonly config: ApiConfig) {}

  @Get()
  // Access depends on the session cookie, so no shared cache (Cloudflare) may keep a copy.
  @Header("cache-control", "no-store")
  page(@Res() res: Response) {
    if (!this.config.webDist) throw new NotFoundException();
    res.sendFile(join(this.config.webDist, "admin.html"));
  }
}

/**
 * Sends every request for the built admin.html, however it is spelled, to the guarded /admin route, so the static file
 * server never hands it out by itself.
 */
export const hideAdminHtml: RequestHandler = (req, _res, next) => {
  let path = req.path;
  try {
    path = decodeURIComponent(path);
  } catch {
    // A malformed escape cannot name a file; static serving refuses it on its own.
  }
  if (/admin\.html/i.test(path)) req.url = "/admin";
  next();
};
