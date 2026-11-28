import type { Db } from "@daloy/db";
import { Controller, Get, Header, Inject, NotFoundException, Req, Res } from "@nestjs/common";
import type { Request, RequestHandler, Response } from "express";
import { platformAdmin } from "./admin";
import { CONFIG, DB, onAdminHost, type ApiConfig } from "./http";

/**
 * The platform admin console (decision 0152), its own page beside the workspace console. Tabs are hash routes, so
 * /admin is the only path: the admin API owns every /admin/<name> path. Without ADMIN_HOST only a platform admin's
 * session gets the page, and everyone else the admin API's own 404. On ADMIN_HOST the page is also where the admin
 * signs in, so it loads for anyone there; Cloudflare Access stands in front of that host, and every admin route still
 * needs the admin and their two-factor check (decisions 0157, 0158).
 */
@Controller("admin")
export class AdminPageController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get()
  // Access depends on the session cookie, so no shared cache (Cloudflare) may keep a copy.
  @Header("cache-control", "no-store")
  async page(@Req() req: Request, @Res() res: Response) {
    if (!onAdminHost(req, this.config.adminHost)) await platformAdmin(this.db, this.config, req);
    if (!this.config.webDist) throw new NotFoundException();
    // root, not a joined path: send refuses any path with a dot folder (such as a .claude worktree) in it.
    res.sendFile("admin.html", { root: this.config.webDist });
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

// The same body AdminGuard's 404 has, so a refused host answers like a missing admin.
const notFound = (res: Response) => res.status(404).json({ message: "Not Found", statusCode: 404 });
// What the admin host answers besides static files: the admin page and API, and the sign-in the page needs. Case and
// spelling must match exactly; anything else is a 404.
const ADMIN_HOST_ROUTES = /^\/(admin(\/.*)?|auth\/(login|logout|me))$/;

/**
 * With ADMIN_HOST set (decision 0157): on that host / is the admin console, the workspace console and the workspace API
 * answer 404, and the static files (the admin page's assets) stay. On every other host /admin and the admin API answer
 * 404, so the admin exists only on its own host. `before` runs ahead of static serving, `after` behind it.
 */
export function adminHostRouting(adminHost: string): { before: RequestHandler; after: RequestHandler } {
  return {
    before(req, res, next) {
      if (onAdminHost(req, adminHost)) {
        if (req.path === "/" || /^\/index\.html$/i.test(req.path)) req.url = "/admin";
      } else if (/^\/+admin(\/|$)/i.test(req.path)) {
        return notFound(res);
      }
      next();
    },
    after(req, res, next) {
      if (onAdminHost(req, adminHost) && !ADMIN_HOST_ROUTES.test(req.path)) return notFound(res);
      next();
    },
  };
}
