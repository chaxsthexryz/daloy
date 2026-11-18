import { WorkflowPausedError } from "@daloy/db";
import { type ArgumentsHost, Catch, type ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";

/**
 * A paused automation refuses every route that would start a run: webhook, the console's Run button, a signed
 * staff change that starts one. One answer for all of them, so a caller sees a 409 with the reason (decision 0054).
 */
@Catch(WorkflowPausedError)
export class PausedFilter implements ExceptionFilter {
  catch(err: WorkflowPausedError, host: ArgumentsHost) {
    host.switchToHttp().getResponse<Response>().status(409).json({ statusCode: 409, error: "Conflict", message: err.message });
  }
}
