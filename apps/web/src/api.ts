import type { LastRun } from "./lib/states";
/** JSON fetch against the API on the same origin (the Vite proxy in dev, the API itself in compose). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as { message?: string | string[] } | null;
  if (!res.ok) {
    const m = data?.message;
    throw new ApiError(res.status, Array.isArray(m) ? m.join("\n") : (m ?? res.statusText));
  }
  return data as T;
}

// setup is the guided setup progress (null for workflows built in the editor); live is set by the list route.
export type Workflow = { id: string; name: string; slug: string; createdAt: string; setup?: unknown; live?: boolean; pausedAt?: string | null; formId?: string | null; last?: LastRun | null; scheduleMissedAt?: string | null };
export type VersionSummary = { id: string; version: number; published: boolean; createdAt: string };
export type Version = VersionSummary & { definition: unknown };
export type StepRun = {
  id: string;
  stepId: string;
  attempt: number;
  state: string;
  input: unknown;
  output: unknown;
  error: string | null;
  branch: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  // What a failed outside call may have done, and who answered a parked or failed attempt (decision 0030).
  outcome: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
  finishedAt: string | null;
};
export type RunSummary = {
  id: string;
  workflowId: string;
  workflowName: string;
  /** The request that started it, for guided automations. */
  reference: string | null;
  version: number;
  state: string;
  test: boolean;
  live: boolean;
  aiLive?: boolean;
  /** Test outcomes the tester chose, by step id (decision 0028); `{live: true}` sent that one step for real (0110). */
  testChoices?: Record<string, object> | null;
  error: string | null;
  triggerPayload: unknown;
  // The run, or one of its Sheets or Slack deliveries, waits for a person.
  needsReview: boolean;
  /** Its booking was changed since; it stops at its next step (decision 0032). */
  superseded?: boolean;
  createdAt: string;
  finishedAt: string | null;
};
export type Run = RunSummary & { steps: StepRun[] };

export const FINISHED = new Set(["succeeded", "failed", "cancelled"]);

export type Meter = { used: number; limit: number | null; resetsOn: string };
export type Plan = "preview" | "pilot" | "business" | "business_plus";
/** GET /usage (owners and operators): the plan, what this workspace has used, and when each count resets. plan null means no limits. */
export type Usage = {
  plan: Plan | null;
  label: string | null;
  limits: Record<string, number> | null;
  ai: Meter;
  sms?: Meter;
  email: Meter;
  http: Meter;
  automations: { live: number; limit: number | null };
  minScheduleMinutes: number | null;
};
export const getUsage = () => api<Usage>("GET", "/usage");
