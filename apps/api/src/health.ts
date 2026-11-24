import { WorkflowPausedError, type Db } from "@daloy/db";
import type { ErrorReporter } from "@daloy/engine";
import { type ArgumentsHost, Catch, Controller, type ExceptionFilter, Get, HttpException, Inject, ServiceUnavailableException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Request, Response } from "express";
import { DB } from "./http";

/** Unauthenticated liveness/DB readiness check for uptime monitors and reverse proxies (A2, decision 0124). */
@Controller("health")
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async check() {
    try {
      await this.db.execute(sql`select 1`);
      return { ok: true };
    } catch {
      throw new ServiceUnavailableException("database unavailable");
    }
  }
}

/** Captures 5xx and unexpected errors via the optional Sentry/GlitchTip reporter without exposing details to callers. */
@Catch()
export class ErrorReportFilter implements ExceptionFilter {
  constructor(private readonly reporter: ErrorReporter) {}

  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    if (err instanceof WorkflowPausedError) {
      res.status(409).json({ statusCode: 409, error: "Conflict", message: err.message });
      return;
    }
    if (err instanceof HttpException) {
      const status = err.getStatus();
      const body = err.getResponse();
      if (status >= 500) {
        void this.reporter.capture(err, { tags: { method: req.method, path: req.path }, extra: { status } });
      }
      res.status(status).json(typeof body === "string" ? { statusCode: status, message: body } : body);
      return;
    }
    void this.reporter.capture(err, { tags: { method: req.method, path: req.path }, extra: { status: 500 } });
    res.status(500).json({ statusCode: 500, message: "Internal server error" });
  }
}
