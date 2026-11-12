/** JSON fetch against the API on the same origin (the Vite proxy in dev, the API itself in compose). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
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

export type Workflow = { id: string; name: string; slug: string; createdAt: string };
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
  createdAt: string;
  finishedAt: string | null;
};
export type RunSummary = {
  id: string;
  workflowId: string;
  version: number;
  state: string;
  test: boolean;
  live: boolean;
  error: string | null;
  triggerPayload: unknown;
  createdAt: string;
  finishedAt: string | null;
};
export type Run = RunSummary & { steps: StepRun[] };

export const FINISHED = new Set(["succeeded", "failed", "cancelled"]);
