import type { Draft, Turn } from "./ai-chat";

export type AiLogStatus = "draft" | "saved" | "live";

export interface AiConversationLog {
  id: string;
  title: string;
  updatedAt: string;
  status: AiLogStatus;
  turns: Turn[];
  draft: Draft | null;
}

const PREFIX = "kymavo.ai.logs.";
const MAX_LOGS = 30;

function keyFor(email?: string): string {
  const clean = (email ?? "workspace").trim().toLowerCase() || "workspace";
  return `${PREFIX}${clean}`;
}

function deriveTitle(turns: Turn[], draft: Draft | null): string {
  if (draft?.name?.trim()) return draft.name.trim();
  const firstUser = turns.find((t) => t.role === "user")?.text.trim() ?? "";
  if (!firstUser) return "Untitled conversation";
  return firstUser.length > 68 ? `${firstUser.slice(0, 65)}...` : firstUser;
}

export function createAiLogId(): string {
  return `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function loadAiLogs(email?: string): AiConversationLog[] {
  try {
    const raw = window.localStorage.getItem(keyFor(email));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is AiConversationLog =>
        Boolean(item) &&
        typeof item.id === "string" &&
        typeof item.title === "string" &&
        Array.isArray(item.turns),
    );
  } catch {
    return [];
  }
}

function saveAll(email: string | undefined, logs: AiConversationLog[]): AiConversationLog[] {
  try {
    window.localStorage.setItem(keyFor(email), JSON.stringify(logs.slice(0, MAX_LOGS)));
  } catch {
    // Ignore storage quota or private mode failures.
  }
  return logs.slice(0, MAX_LOGS);
}

export function upsertAiLog(
  email: string | undefined,
  entry: {
    id: string;
    turns: Turn[];
    draft: Draft | null;
    status?: AiLogStatus;
  },
): AiConversationLog[] {
  if (entry.turns.length === 0 && !entry.draft) return loadAiLogs(email);
  const current = loadAiLogs(email);
  const prev = current.find((item) => item.id === entry.id);
  const nextStatus: AiLogStatus = entry.status ?? prev?.status ?? "draft";
  const updated: AiConversationLog = {
    id: entry.id,
    title: deriveTitle(entry.turns, entry.draft),
    updatedAt: new Date().toISOString(),
    status: nextStatus,
    turns: entry.turns,
    draft: entry.draft,
  };
  const rest = current.filter((item) => item.id !== entry.id);
  return saveAll(email, [updated, ...rest]);
}

export function deleteAiLog(email: string | undefined, id: string): AiConversationLog[] {
  const current = loadAiLogs(email);
  return saveAll(email, current.filter((item) => item.id !== id));
}
