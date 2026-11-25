import "./editor.css";
import { useLanguage } from "./Language";
import { canSendAlone, configProblems, definitionSchema, destination, lintDefinition, markText, stepBranches, stepEntry, stepLabel, STEP_NOTE_MAX, triggerEntry, triggerLabel, type FormField, type Step, type StepErrorPolicy, type Trigger } from "@daloy/engine";
import { AppMark } from "./AppMark";
import { Background, ReactFlow, type NodeChange } from "@xyflow/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AskAi } from "./AiDraft";
import { FormEmbed } from "./FormEmbed";
import { shareable, ShareSheet } from "./SharePanel";
import { api, FINISHED, type Run, type RunSummary, type Version, type Workflow } from "./api";
import { DropLine, editorEdgeTypes, editorNodeTypes, flowAriaLabels, ZoomBar } from "./FlowCanvas";
import { RunResult, StatePill, StepAttempt, useRun } from "./Runs";
import { ADDABLE, addStep, blankDraft, canMove, connectSteps, duplicateStep, moveStep, readCopiedStep, removeStep, setDisabled, toFlow, type AddableType, type ConnectError, type Draft } from "./lib/graph";
import { record, redo, startHistory, undo } from "./lib/history";
import { Popover, Sheet, useMedia, usePhone } from "./Sheet";
import { chosenFor, insertables, nextPaths, upstreamIds, openExits, setupLeft, unconnectedNodes, type ConnInfo } from "./lib/editor";
import { warningForLanguage } from "./lib/ai-build";
import { isLiveRunFinished, LIVE_RUN_EVENT, type LiveRunChange } from "./lib/live-runs";
import { runFlow } from "./lib/run-flow";
import { ago } from "./lib/states";
import { AutomationTabs } from "./Nav";
import { DocTemplatePicker } from "./DocTemplatePicker";
import { BrowserActions } from "./BrowserActions";
import { SwitchCases } from "./SwitchCases";
import { SchemaForm, type JsonSchema } from "./SchemaForm";
import { EmailSource } from "./EmailSource";
import { GoogleTriggerSettings } from "./GoogleTriggerSettings";
import { MailboxTriggerSettings } from "./MailboxTriggerSettings";
import { RecordTriggerSettings } from "./RecordTriggerSettings";
import { ExplainSheet, SampleTest, SetupGuide, TurnOnSheet } from "./Guide";
import { MonitorTriggerSettings } from "./MonitorTriggerSettings";
import { testState, type SampleResult } from "./lib/guide";
import { parseSample, variableGroups } from "./lib/variables";
import { VariablePicker } from "./VariablePicker";

const explainedKey = (id: string) => `daloy.explained.${id}`;
const wasExplained = (id: string) => {
  try {
    return localStorage.getItem(explainedKey(id)) === "1";
  } catch {
    return false; // storage can be blocked; the dialog then shows again, which is harmless
  }
};

/** Whether the side panel is folded to a strip, kept per viewer (U2). Storage can be blocked, so a failed read means open. */
const PANEL_KEY = "daloy.editor.panel";
const panelFolded = () => {
  try {
    return localStorage.getItem(PANEL_KEY) === "collapsed";
  } catch {
    return false;
  }
};

type Point = { x: number; y: number };
/** Where a menu opens: the bottom left of the control that opened it. */
const below = (el: Element): Point => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.bottom };
};
type MenuItem = { label: string; keys?: string; run: () => void };

/** Why connectSteps refused, in words. The panel's Connect to and a drag on the canvas say the same. */
function connectReason(e: ConnectError, t: (source: string, values?: Record<string, string | number>) => string) {
  if (e.id === "self") return t("A step cannot lead to itself.");
  if (e.id === "loop") return t("{to} already leads to {from}, so this would make a loop.", { to: e.to, from: e.from });
  if (e.id === "orphan") return t("{step} would have no way in. Connect it from another step first, or delete it.", { step: e.step });
  return t("Pick one of this step's branches.");
}

const PANEL_STEPS_FIT = { maxZoom: 1, padding: { top: "16px", right: "16px", bottom: "64px", left: "16px" } } as const;

type Catalog = { schemas: Record<string, JsonSchema>; branches: Record<string, string[]> };
type Loaded = Workflow & { trigger: { id: string; type: string; webhookPath: string | null; legacySignatureAt?: string | null } | null; live: Version | null; latest: Version | null };

// Tomorrow at 10:00 in the field's own zone, which is on any slot grid that divides the hours evenly.
const tomorrowAtTen = () => `${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}T10:00`;

function samplePayload(trigger: Trigger, resourceId = "a resource id from the Resources page"): string {
  if (trigger.type === "email") return JSON.stringify({ from: "ana@example.com", replyTo: "ana@example.com", to: ["inquiries@example.com"], subject: "Website inquiry", text: "I would like a quote.", messageId: "sample-inquiry@example.com", receivedAt: new Date().toISOString() }, null, 2);
  if (trigger.type === "meta_dm") return JSON.stringify({ channel: trigger.config.channel === "instagram" ? "instagram" : "messenger", senderId: "1234567890", messageId: "m_sample_1", text: "Here is my GCash receipt.", timestamp: new Date().toISOString(), image: [] }, null, 2);
  if (trigger.type === "whatsapp_message") return JSON.stringify({ channel: "whatsapp", senderId: "639171234567", senderName: "Ana Reyes", messageId: "wamid.sample_1", text: "Here is my GCash receipt.", timestamp: new Date().toISOString(), image: [] }, null, 2);
  if (trigger.type === "telegram_message") return JSON.stringify({ chatId: "123456789", chatType: "private", fromId: "123456789", fromName: "Ana Reyes", username: "anareyes", messageId: 42, updateId: 1001, date: "2026-11-23T09:15:00.000Z", text: "What's on my schedule today?", fileRefused: false, conversation: { id: "sample", channel: "telegram", turn: 1, fields: {}, history: "user: What's on my schedule today?" } }, null, 2);
  if (trigger.type === "shopify_order") return JSON.stringify({ order_id: "820982911946154508", order_number: "#1001", customer_name: "Ana Reyes", customer_email: "ana@example.com", customer_phone: "+639171234567", total: "1250.50", currency: "PHP", financial_status: "pending", created_at: new Date().toISOString(), shop: "your-shop.myshopify.com", item_count: 2, items: "2 x Tote bag [TOTE-BLU]", line_items: [{ title: "Tote bag", variant_title: "", quantity: 2, price: "625.25", sku: "TOTE-BLU" }] }, null, 2);
  if (trigger.type === "booking_event") return JSON.stringify({ event: trigger.config.events[0] ?? "created", bookingId: "sample-booking-id", reference: "BK-1001", resourceId, resourceName: "Sample room", start: `${tomorrowAtTen()}:00+08:00`, end: `${tomorrowAtTen().slice(0, 10)}T11:00:00+08:00`, minutes: 60, timezone: "Asia/Manila", status: "active", version: 1, mode: "slot" }, null, 2);
  if (trigger.type === "sheets_row") return JSON.stringify({ spreadsheetId: "sample-sheet", tab: trigger.config.tab, rowNumber: 2, values: ["Ana Reyes", "Ube jam"], cells: { name: "Ana Reyes", item: "Ube jam" } }, null, 2);
  if (trigger.type === "calendar_event") return JSON.stringify({ calendarId: "sample-calendar", event: trigger.config.on, eventId: "sample-event", title: "Ana Reyes, haircut", description: "", location: "Main branch", start: `${tomorrowAtTen()}:00+08:00`, end: `${tomorrowAtTen().slice(0, 10)}T11:00:00+08:00`, link: "" }, null, 2);
  if (trigger.type === "drive_file") return JSON.stringify({ folderId: "sample-folder", fileId: "sample-file", name: "receipt.pdf", mimeType: "application/pdf", size: 120000, createdTime: new Date().toISOString(), link: "", file: [] }, null, 2);
  if (trigger.type === "gmail_message") return JSON.stringify({ from: "ana@example.com", replyTo: "ana@example.com", to: ["inquiries@example.com"], subject: "Order inquiry", text: "Hello, I would like a quote.", messageId: "<sample-gmail@example.com>", receivedAt: new Date().toISOString(), gmailMessageId: "sample-gmail-id", threadId: "sample-thread-id", labelIds: [trigger.config.label ?? "INBOX"] }, null, 2);
  if (trigger.type === "outlook_message") return JSON.stringify({ from: "ana@example.com", replyTo: "ana@example.com", to: ["inquiries@example.com"], subject: "Order inquiry", text: "Hello, I would like a quote.", messageId: "<sample-outlook@example.com>", receivedAt: new Date().toISOString(), outlookMessageId: "sample-outlook-id", folder: trigger.config.folder ?? "Inbox" }, null, 2);
  if (trigger.type === "airtable_record") return JSON.stringify({ baseId: "appSampleBase", tableId: "tblSampleTable", event: trigger.config.on, recordId: "recSampleRecord01", createdTime: new Date().toISOString(), fields: { Name: "Ana Reyes", Status: "Pending" }, cells: { name: "Ana Reyes", status: "Pending" }, ...(trigger.config.on === "status_changed" ? { statusField: trigger.config.statusField ?? "Status", status: "Approved", previousStatus: "Pending" } : {}) }, null, 2);
  if (trigger.type === "notion_page") return JSON.stringify({ databaseId: "sample-database", event: trigger.config.on, pageId: "sample-page", title: "Ana Reyes order", url: "https://www.notion.so/sample-page", createdTime: new Date().toISOString(), lastEditedTime: new Date().toISOString(), fields: { Name: "Ana Reyes order", Status: "Pending" }, cells: { name: "Ana Reyes order", status: "Pending" }, ...(trigger.config.on === "status_changed" ? { statusProperty: trigger.config.statusProperty ?? "Status", status: "Done", previousStatus: "Pending" } : {}) }, null, 2);
  if (trigger.type === "trello_card") return JSON.stringify({ listId: "sample-list", listName: "To do", boardId: "sample-board", event: trigger.config.on, cardId: "sample-card", name: "Prepare order 1001", desc: "2 x Ube jam", url: "https://trello.com/c/sample", shortUrl: "https://trello.com/c/sample", ...(trigger.config.on === "moved_to_list" ? { previousListId: "sample-prev-list", previousListName: "Inbox" } : {}) }, null, 2);
  if (trigger.type === "payment_event") return JSON.stringify({ event: trigger.config.events[0] ?? "confirmed", dueId: "sample-due-id", reference: "ORD-1001", kind: "deposit", status: trigger.config.events[0] ?? "confirmed", amountCentavos: 35000, amountPesos: "350.00" }, null, 2);
  if (trigger.type === "page_changed") {
    return trigger.config.mode === "feed"
      ? JSON.stringify({ url: trigger.config.url, feedTitle: "Shop updates", itemId: "https://example.com/posts/1", title: "Sample update", link: "https://example.com/posts/1", summary: "Summary text", published: "2026-01-15T09:00:00Z", author: "Ana", checkedAt: "2026-01-15T09:05:00Z" }, null, 2)
      : JSON.stringify({ url: trigger.config.url, title: "Sample page", text: "Current page text", value: "PHP 55.00", previous: "PHP 52.00", hash: "abc123", previousHash: "def456", checkedAt: "2026-01-15T09:05:00Z" }, null, 2);
  }
  if (trigger.type === "slack_message") return JSON.stringify({ eventId: "Ev012345", teamId: "T012345", channelId: trigger.config.channelId ?? "C012345", userId: "U012345", text: "Hello team", ts: "1730000000.000100", threadTs: null, receivedAt: "2026-01-15T09:00:00Z" }, null, 2);
  if (trigger.type === "teams_message") return JSON.stringify({ messageId: "msg-1001", channelId: "19:general", channelName: "General", teamId: "team-1", senderId: "user-1", senderName: "Ana", text: "<at>kymavo</at> Hello team", cleanText: "Hello team", timestamp: "2026-01-15T09:00:00Z" }, null, 2);
  if (trigger.type === "discord_message") return JSON.stringify({ interactionId: "1234567890", channelId: trigger.config.channelId ?? "987654321", guildId: "111222333", userId: "444555666", username: "ana", commandName: trigger.config.commandName ?? "status", text: "Hello from Discord", options: {}, receivedAt: "2026-01-15T09:00:00Z" }, null, 2);
  const fields = trigger.type === "form" ? trigger.config.fields : trigger.type === "sub_workflow" ? (trigger.config.fields ?? []) : null;
  if (!fields || fields.length === 0) return "{}";
  // File fields are left out: a test run takes no files, and the server drops a value sent for one.
  const sample = Object.fromEntries(
    fields.filter((f) => f.type !== "file").map((f) => [f.name, f.type === "number" ? 1 : f.type === "email" ? "ana@example.com" : f.type === "datetime" ? tomorrowAtTen() : f.type === "resource" ? resourceId : `Sample ${f.label.toLowerCase()}`]),
  );
  return JSON.stringify(sample, null, 2);
}

// SchemaForm cannot render arrays, so the AI step's files are chosen with checkboxes below it.
const withoutFiles = (schema: JsonSchema): JsonSchema => ({ ...schema, properties: Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([k]) => k !== "files")) });
// The template of a Make a document step is chosen with the Google Picker below the form, not typed.
const withoutTemplate = (schema: JsonSchema): JsonSchema => ({ ...schema, properties: Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([k]) => k !== "templateId" && k !== "templateName")) });
// A browser step's actions are a list, edited with BrowserActions below the form.
const withoutActions = (schema: JsonSchema): JsonSchema => ({ ...schema, properties: Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([k]) => k !== "actions")) });
// A switch step's cases are a list of objects, edited with SwitchCases below the form.
const withoutCases = (schema: JsonSchema): JsonSchema => ({ ...schema, properties: Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([k]) => k !== "cases")) });
const TRANSFORM_VISIBLE: Record<string, readonly string[]> = {
  format_date: ["op", "value", "timezone", "format"],
  split: ["op", "value", "separator"],
  pick: ["op", "fields"],
};
const transformSchema = (schema: JsonSchema, op: string): JsonSchema => {
  const keep = new Set(TRANSFORM_VISIBLE[op] ?? ["op", "value"]);
  return { ...schema, properties: Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([k]) => keep.has(k))) };
};

export function Editor({ id, from }: { id: string; from?: string }) {
  const { t, language } = useLanguage();
  const [wf, setWf] = useState<Loaded | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  // Every edit goes through the history, so undo and redo restore exact drafts. Loading a draft starts a fresh history.
  const [history, setHistory] = useState(() => startHistory<Draft>(blankDraft()));
  const draft = history.present;
  const setDraft = (d: Draft) => setHistory(startHistory(d));
  const [dirty, setDirty] = useState(false);
  // What the last move, undo or redo did, in words, next to the undo buttons.
  const [note, setNote] = useState("");
  // The add menu: where it inserts (a step id and branch, or neither for the start of the flow), and where it opens on a wide screen.
  const [menu, setMenu] = useState<{ after?: string; on?: string; at?: Point } | null>(null);
  // The right-click menu (U2): its items and where it opens.
  const [context, setContext] = useState<{ label: string; at: Point; items: MenuItem[] } | null>(null);
  // The last copied step, so paste works when the system clipboard is refused or holds something else.
  const [clip, setClip] = useState<{ type: AddableType; config: Step["config"]; note?: string } | null>(null);
  // Connect mode from the right-click menu: the next step clicked becomes where this path leads.
  const [connecting, setConnecting] = useState<{ from: string; on?: string } | null>(null);
  const [folded, setFolded] = useState(panelFolded);
  // The step whose line in the test result to scroll to once "Test this step" has a result.
  const [testFocus, setTestFocus] = useState<string | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const phone = usePhone();
  // At 1000px and up the panel sits beside the canvas and can fold; below that it sits under it.
  const wide = useMedia("(min-width: 1000px)");
  const [selected, setSelected] = useState<string | null>(null);
  const [firstResource, setFirstResource] = useState<string | undefined>();
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const [message, setMessage] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [payload, setPayload] = useState("{}");
  // The reference of the run whose trigger data is the sample, after "Test with this data" on a run page (T2).
  const [fromRun, setFromRun] = useState<string | null>(null);
  const [mode, setMode] = useState<"mock" | "ai" | "live">("mock");
  // stepId -> a test choice as JSON text ("" = the default outcome), so a <select> can hold it.
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [runId, setRunId] = useState<string | null>(null);
  const { run } = useRun(runId);
  const [liveRuns, setLiveRuns] = useState<RunSummary[]>([]);
  // null until GET /settings/connections answers; a refused or failed read leaves it null and hides the setup banner.
  const [connected, setConnected] = useState<ReadonlySet<string> | null>(null);
  const [conns, setConns] = useState<ConnInfo[]>([]);
  // True until GET /settings/email answers, so a node never flashes "Connect Gmail" while the answer is on its way.
  const [mailReady, setMailReady] = useState(true);
  // A phone shows the list first: the whole diagram fitted to 360px is too small to read.
  const [view, setView] = useState<"diagram" | "list">(() => (matchMedia("(max-width: 599.98px)").matches ? "list" : "diagram"));
  // R2b: the last test run and the draft it ran on, the dialogs, and whether the owner has read "Explain this flow".
  const [sample, setSample] = useState<SampleResult | null>(null);
  const { run: sampleRun } = useRun(sample?.runId ?? null);
  const [showExplain, setShowExplain] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [showTurnOn, setShowTurnOn] = useState(false);
  const [explained, setExplained] = useState(() => wasExplained(id));

  const reload = async () => {
    const w = await api<Loaded>("GET", `/workflows/${id}`);
    setWf(w);
    return w;
  };
  useEffect(() => {
    void Promise.all([reload(), api<Catalog>("GET", "/step-schemas"), api<{ id: string; active: boolean }[]>("GET", "/resources").catch(() => [])])
      .then(([w, c, r]) => {
        const d = (w.latest?.definition as Draft | undefined) ?? blankDraft();
        setDraft(d);
        setFirstResource(r.find((x) => x.active)?.id);
        setPayload(samplePayload(d.trigger, r.find((x) => x.active)?.id));
        if (from) {
          void api<Run>("GET", `/runs/${from}`).then(
            (x) => {
              if (x.workflowId !== id) return;
              setPayload(JSON.stringify(x.triggerPayload ?? {}, null, 2));
              setFromRun(x.reference ?? x.id.slice(0, 8));
            },
            () => setMessage({ kind: "error", text: t("Couldn't load that run's data, so the sample data is the usual example.") }),
          );
        }
        setCatalog(c);
        // After guided setup, show the explanation once for a draft that is not live yet.
        if (w.setup && !w.live && d.steps.length > 0 && !wasExplained(id)) setShowExplain(true);
      })
      .catch((e: Error) => setMessage({ kind: "error", text: e.message }));
    api<{ connections: ConnInfo[] }>("GET", "/settings/connections").then(
      (r) => {
        setConns(r.connections);
        setConnected(new Set(r.connections.filter((c) => c.status === "active").map((c) => c.provider)));
      },
      () => setConnected(null),
    );
    api<{ sender: { status: string } | null; installationAllowed: boolean }>("GET", "/settings/email").then(
      (m) => setMailReady(m.sender?.status === "active" || m.installationAllowed),
      () => setMailReady(true),
    );
  }, [id]);
  const hasPublishedVersion = !!wf?.live;
  const isWorkflowPaused = !!wf?.pausedAt;
  useEffect(() => {
    if (!hasPublishedVersion) {
      setLiveRuns([]);
      return;
    }
    let cancelled = false;
    api<RunSummary[]>("GET", `/runs?workflowId=${id}&test=false&limit=5`).then(
      (rows) => {
        if (cancelled) return;
        setLiveRuns(rows);
        const newest = rows[0];
        if (newest && !isWorkflowPaused && !isLiveRunFinished(newest)) setRunId(newest.id);
      },
      () => undefined,
    );
    const onLiveRun = (e: Event) => {
      const detail = (e as CustomEvent<LiveRunChange>).detail;
      if (!detail?.run || detail.run.workflowId !== id) return;
      setLiveRuns((prev) => [detail.run, ...prev.filter((r) => r.id !== detail.run.id)].slice(0, 5));
      if (!isWorkflowPaused) setRunId(detail.run.id);
    };
    window.addEventListener(LIVE_RUN_EVENT, onLiveRun);
    return () => {
      cancelled = true;
      window.removeEventListener(LIVE_RUN_EVENT, onLiveRun);
    };
  }, [id, hasPublishedVersion, isWorkflowPaused]);

  const update = (next: Draft, key?: string) => {
    setHistory((h) => record(h, next, key));
    setDirty(true);
  };
  const stepHistory = (to: "undo" | "redo") => {
    const next = (to === "undo" ? undo : redo)(history);
    if (next === history) return;
    setHistory(next);
    setDirty(true);
    setNote(t(to === "undo" ? "Undid the last change." : "Redid the change."));
    // A selected step that the change removed has nothing left to show.
    if (selected && selected !== "trigger" && !next.present.steps.some((s) => s.id === selected)) setSelected(null);
  };
  // Shortcuts work outside text fields (those keep their own undo, copy and paste) and while no dialog is open: Ctrl+Z, Ctrl+Shift+Z
  // and Ctrl+Y (Cmd on a Mac), and from U2 Ctrl+D, Ctrl+C, Ctrl+V and Escape. `key` returns true when it used the key.
  const keys = useRef<{ history: typeof stepHistory; key?: (key: string) => boolean; paste?: (text: string) => void }>({ history: stepHistory });
  keys.current.history = stepHistory;
  useEffect(() => {
    const outside = (e: Event) => !document.querySelector("dialog[open]") && !(e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable='true']"));
    const on = (e: KeyboardEvent) => {
      if (e.altKey || !outside(e)) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && (key === "z" || key === "y")) {
        e.preventDefault();
        keys.current.history(key === "y" || e.shiftKey ? "redo" : "undo");
      } else if ((mod && !e.shiftKey && (key === "d" || key === "c")) || (!mod && key === "escape")) {
        if (keys.current.key?.(key)) e.preventDefault();
      }
    };
    // Ctrl+V arrives as a paste event, which carries the clipboard text without asking for permission.
    const onPaste = (e: ClipboardEvent) => {
      if (!outside(e) || !keys.current.paste) return;
      e.preventDefault();
      keys.current.paste(e.clipboardData?.getData("text/plain") ?? "");
    };
    addEventListener("keydown", on);
    addEventListener("paste", onPaste);
    return () => {
      removeEventListener("keydown", on);
      removeEventListener("paste", onPaste);
    };
  }, []);
  // "Test this step": once the new run reaches that step, bring its line in the result into view.
  useEffect(() => {
    if (!testFocus || !run || run.id !== runId || !run.steps.some((s) => s.stepId === testFocus)) return;
    const line = [...document.querySelectorAll<HTMLElement>(".a7-test .steps > li")].find((li) => new RegExp(`^\\S+ ${testFocus}(?![a-z0-9_])`).test(li.textContent ?? ""));
    line?.scrollIntoView({ block: "center" });
    setTestFocus(null);
  }, [run, runId, testFocus]);
  const flow = useMemo(() => toFlow(draft, selected, run ? runFlow(draft, run) : undefined, language, measured), [draft, selected, run, language, measured]);
  // Advice only (decision 0033): a draft that does not parse yet is a work in progress, so it gets no checks.
  const warnings = useMemo(() => {
    const parsed = definitionSchema.safeParse(draft);
    return parsed.success ? lintDefinition(parsed.data) : [];
  }, [draft]);
  const apps = useMemo(() => (connected ? setupLeft(draft, connected) : []), [draft, connected]);
  const missingApp = new Map(apps.filter((a) => !a.connected).flatMap((a) => a.steps.map((s) => [s, a.label] as const)));
  const chosen = useMemo(() => chosenFor(draft, conns), [draft, conns]);
  const unconnected = useMemo(() => (connected ? unconnectedNodes(draft, connected, mailReady) : new Map<string, string>()), [draft, connected, mailReady]);
  const nodes = flow.nodes.map((n) => ({
    ...n,
    ...(measured[n.id] && { measured: measured[n.id] }),
    data: {
      ...n.data,
      index: draft.steps.findIndex((s) => s.id === n.id) + 1,
      needsApp: unconnected.get(n.id),
      chosen: chosen.get(n.id),
      openExits: openExits(draft, n.id),
      onAdd: (on: string | undefined, at: Point) => setMenu(n.id === "trigger" ? { at } : { after: n.id, on, at }),
    },
  }));
  // Every editor edge uses the square editor edge; it carries the branch so the pill can take its colour.
  const edges = flow.edges.map((e) => ({ ...e, type: "editor", data: { ...e.data, on: e.sourceHandle ?? undefined, insert: (at: Point) => setMenu(e.source === "trigger" ? { at } : { after: e.source, on: e.sourceHandle ?? undefined, at }) } }));

  const onNodesChange = (changes: NodeChange[]) => {
    for (const c of changes) {
      if (c.type === "dimensions" && c.dimensions) {
        const next = c.dimensions;
        setMeasured((m) => {
          const prev = m[c.id];
          if (prev && Math.abs(prev.width - next.width) < 1 && Math.abs(prev.height - next.height) < 1) return m;
          return { ...m, [c.id]: next };
        });
      }
      if (c.type === "select" && c.selected) {
        setSelected(c.id);
        setFolded(false); // selecting a step opens a folded panel
      }
      if (c.type === "remove" && c.id !== "trigger") {
        update(removeStep(draft, c.id));
        setSelected(null);
      }
    }
  };

  const act = async (label: string, fn: () => Promise<string | void>) => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await fn();
      if (text) setMessage({ kind: "ok", text });
    } catch (e) {
      setMessage({ kind: "error", text: t("{action} failed: {error}", { action: t(label), error: (e as Error).message }) });
    } finally {
      setBusy(false);
    }
  };
  const save = (publish: boolean) =>
    act(publish ? "Publish" : "Save", async () => {
      const v = await api<{ version: number }>("POST", `/workflows/${id}/versions`, { definition: draft, publish });
      setDirty(false);
      await reload();
      return publish ? t("Version {version} is live.", { version: v.version }) : t("Saved as version {version}.", { version: v.version });
    });
  const parsedPayload = () => {
    try {
      return JSON.parse(payload) as unknown;
    } catch {
      throw new Error(t("the sample data is not valid JSON"));
    }
  };
  // liveStep: "Try this step for real" sends that one step and fakes the rest (decision 0110).
  const testRun = (testMode: typeof mode = mode, liveStep?: string) =>
    act("Test run", async () => {
      const chosenOutcomes = Object.fromEntries(draft.steps.flatMap((s) => (choices[s.id] && s.id !== liveStep ? [[s.id, JSON.parse(choices[s.id]!) as unknown]] : [])));
      const r = await api<{ id: string; duplicate?: boolean; mode?: string }>("POST", `/workflows/${id}/test-runs`, {
        definition: draft,
        payload: parsedPayload(),
        mode: testMode,
        choices: testMode === "live" ? {} : liveStep ? { ...chosenOutcomes, [liveStep]: { live: true } } : chosenOutcomes,
      });
      setDirty(false);
      setRunId(r.id);
      setSample({ key: JSON.stringify(draft), runId: r.id });
      await reload();
      // act() shows a returned string as the result message.
      if (r.duplicate) return t("This event key already ran, so nothing ran now. Showing the earlier {mode} test run; change the event id to test again.", { mode: t({ mock: "mocked", ai: "real AI only", live: "live" }[r.mode ?? "mock"] ?? "mocked") });
    });
  const runLive = () =>
    window.confirm(t("Run the live version now? It sends real email and calls real services.")) &&
    act("Run", async () => {
      const r = await api<{ id: string }>("POST", `/workflows/${id}/runs`, { payload: parsedPayload() });
      setRunId(r.id);
    });

  if (!wf || !catalog) return <main className="page a7-loading">{message ? <p role="alert">{message.text}</p> : <p>{t("Loading…")}</p>}</main>;

  const step = draft.steps.find((s) => s.id === selected);
  const problems = configProblems(draft, language);
  const test = testState(JSON.stringify(draft), sample, sample ? (sampleRun?.id === sample.runId ? sampleRun.state : null) : null);
  const closeExplain = () => {
    setShowExplain(false);
    setExplained(true);
    try {
      localStorage.setItem(explainedKey(id), "1");
    } catch {
      /* storage blocked: the dialog may show again */
    }
  };
  const status = dirty ? t("Unsaved changes") : wf.latest ? t("Version {version}{state}", { version: wf.latest.version, state: t(wf.latest.published ? " (live)" : ", draft") }) : t("Not saved yet");
  const isLive = !dirty && !!wf.latest?.published;
  const activeLiveRun = run && !run.test ? run : null;
  const liveRunSummary = activeLiveRun ? liveRuns.find((r) => r.id === activeLiveRun.id) : undefined;
  const liveRunFailedDelivery = Boolean(liveRunSummary?.deliveryFailed);
  const liveState: "idle" | "working" | "done" | "problem" | "waiting" = !activeLiveRun
    ? "idle"
    : activeLiveRun.needsReview || activeLiveRun.state === "needs_review" || activeLiveRun.state === "waiting"
      ? "waiting"
      : activeLiveRun.state === "failed" || liveRunFailedDelivery
        ? "problem"
        : activeLiveRun.state === "succeeded"
          ? "done"
          : "working";
  const missing = apps.filter((a) => !a.connected);
  const select = (next: string | null) => {
    setSelected(next);
    if (next) setFolded(false);
  };
  const editStep = (config: unknown) => {
    let nextConfig = config;
    if (step?.type === "transform") {
      const c = { ...(config as Record<string, unknown>) };
      const op = String(c.op ?? "trim");
      const allowed = new Set(TRANSFORM_VISIBLE[op] ?? ["op", "value"]);
      for (const k of ["value", "timezone", "format", "separator", "fields"]) {
        if (!allowed.has(k)) delete c[k];
      }
      if (op === "pick" && !c.fields) c.fields = { value: "{{trigger}}" };
      if (op !== "pick" && c.value === undefined) c.value = "{{trigger.text}}";
      nextConfig = c;
    }
    update({ ...draft, steps: draft.steps.map((s) => (s.id === step!.id ? ({ ...s, config: nextConfig } as Step) : s)) }, `config:${step!.id}`);
  };
  const editOnError = (policy: StepErrorPolicy) => {
    const steps = draft.steps.map((s) => {
      if (s.id !== step!.id) return s;
      const next = { ...s } as Step & { onError?: StepErrorPolicy };
      if (policy === "stop") delete next.onError;
      else next.onError = policy;
      return next as Step;
    });
    const edges = policy === "failed_edge" ? draft.edges : draft.edges.filter((e) => !(e.from === step!.id && e.on === "failed"));
    update({ ...draft, steps, edges }, `onError:${step!.id}`);
  };
  // T4: an empty note leaves no key, so a step without one saves as it did before.
  const editNote = (note: string) => {
    const steps = draft.steps.map((s) => {
      if (s.id !== step!.id) return s;
      const next = { ...s };
      delete next.note;
      return note ? { ...next, note } : next;
    });
    update({ ...draft, steps }, `note:${step!.id}`);
  };
  const move = (id: string, dir: "up" | "down") => {
    const next = moveStep(draft, id, dir);
    if (next === draft) return;
    update(next);
    setNote(t("Moved {id} to step {number}.", { id, number: next.steps.findIndex((s) => s.id === id) + 1 }));
    // Reordering rebuilds the row, which drops focus; put it back on the same button, or its twin at the end of the list.
    setTimeout(() => (document.querySelector<HTMLElement>(`[data-move="${id}:${dir}"]:not(:disabled)`) ?? document.querySelector<HTMLElement>(`[data-move="${id}:${dir === "up" ? "down" : "up"}"]`))?.focus(), 0);
  };
  const addFromMenu = (type: AddableType, on?: string) => {
    const at = menu?.after;
    const r = addStep(draft, type, at ? { id: at, on: on ?? menu?.on } : undefined, language);
    update(r.draft);
    select(r.id);
    setMenu(null);
  };
  const fold = (next: boolean) => {
    setFolded(next);
    try {
      localStorage.setItem(PANEL_KEY, next ? "collapsed" : "open");
    } catch {
      /* storage blocked: the choice lasts until the page reloads */
    }
  };
  const closeButton = !phone && (
    <button type="button" className="a7-close" onClick={() => select(null)}>
      {t("Close")}
    </button>
  );
  const addAfter = (after: string | undefined, label: string) => (
    <button type="button" onClick={(e) => setMenu({ ...(after && { after }), at: below(e.currentTarget) })}>
      {label}
    </button>
  );
  const showRun = () => document.getElementById("run-heading")?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });

  // U2 canvas actions. Each one is an edit through the history, so Ctrl+Z takes it back; refusals say why in the canvas note.
  // The last step of the flow, for "Add a step at the end", and where "Add step here" and paste go when no step is selected.
  const tail = [...draft.steps].reverse().find((s) => !draft.edges.some((e) => e.from === s.id));
  const where = (): { after?: string } => (step ? { after: step.id } : selected === "trigger" || !tail ? {} : { after: tail.id });
  const copyable = (s: Step) => (ADDABLE as readonly string[]).includes(s.type);
  const connect = (from: string, on: string | undefined, to: string) => {
    const r = connectSteps(draft, from, on, to);
    if ("error" in r) return setNote(connectReason(r.error, t));
    update(r.draft);
    setNote(t("Connected {from} to {to}.", { from, to }));
  };
  const duplicate = (stepId: string) => {
    const r = duplicateStep(draft, stepId);
    if ("error" in r) return setNote(t("{step} has branches, so it cannot be duplicated. Add a step and copy its settings instead.", { step: stepId }));
    update(r.draft);
    select(r.id);
    setNote(t("Duplicated {from} as {id}.", { from: stepId, id: r.id }));
  };
  const turnOff = (stepId: string, off: boolean) => {
    update(setDisabled(draft, stepId, off));
    setNote(t(off ? "Turned off {id}. Runs skip it and go on to the next step." : "Turned on {id}.", { id: stepId }));
  };
  const copyStep = (s: Step) => {
    const copied = { type: s.type as AddableType, config: s.config, ...(s.note && { note: s.note }) };
    setClip(copied);
    // Only the type, config and note: a config holds {{secrets.name}} references, never secret values. The system clipboard may refuse.
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(JSON.stringify(copied)))
      .catch(() => undefined);
    setNote(t("Copied {id}. Paste with Ctrl+V.", { id: s.id }));
  };
  const paste = (text: string) => {
    const s = readCopiedStep(text) ?? clip;
    if (!s) return setNote(t("Nothing to paste. Copy a step first."));
    const { after } = where();
    const r = addStep(draft, s.type, after ? { id: after } : undefined, language, s.config, s.note);
    update(r.draft);
    select(r.id);
    setNote(t("Pasted {id}.", { id: r.id }));
  };
  const startConnect = (s: Step) => {
    const labels = stepBranches(s);
    const on = labels?.find((l) => !draft.edges.some((e) => e.from === s.id && e.on === l)) ?? labels?.[0];
    setConnecting({ from: s.id, on });
    setNote(on ? t("Click the step {from} goes to on {branch}. Escape cancels.", { from: s.id, branch: t(on) }) : t("Click the step {from} goes to. Escape cancels.", { from: s.id }));
  };
  const cancelConnect = () => {
    setConnecting(null);
    setNote(t("Connect cancelled."));
  };
  const testStep = (stepId: string) => {
    select(null);
    void testRun("mock").then(() => {
      showRun();
      setTestFocus(stepId);
    });
  };
  const sendForReal = (s: Step) =>
    window.confirm(t("Send {step} for real? {where} Every other step stays a preview and sends nothing.", { step: s.id, where: destination(s, { language, trigger: draft.trigger, chosen: chosen.get(s.id) }) })) &&
    void testRun("mock", s.id);
  const nodeMenu = (nodeId: string, at: Point) => {
    const s = draft.steps.find((x) => x.id === nodeId);
    if (s) select(nodeId);
    const items: MenuItem[] = [
      { label: t("Test this step"), run: () => testStep(nodeId) },
      { label: t(s ? "Add a step after this one" : "Add a step at the start"), run: () => setMenu({ ...(s && { after: nodeId }), at }) },
    ];
    if (s) {
      items.push({ label: t("Duplicate"), keys: "Ctrl+D", run: () => duplicate(s.id) });
      if (copyable(s)) items.push({ label: t("Copy"), keys: "Ctrl+C", run: () => copyStep(s) });
      items.push({ label: t("Connect to"), run: () => startConnect(s) });
      if (!stepBranches(s)) items.push({ label: t(s.disabled ? "Enable" : "Disable"), run: () => turnOff(s.id, !s.disabled) });
      items.push({
        label: t("Delete"),
        keys: "Del",
        run: () => {
          update(removeStep(draft, s.id));
          select(null);
        },
      });
    }
    setContext({ label: t("Actions for {id}", { id: s ? s.id : t("the trigger") }), at, items });
  };
  const paneMenu = (at: Point) =>
    setContext({
      label: t("Canvas actions"),
      at,
      items: [
        ...(clip ? [{ label: t("Paste step"), keys: "Ctrl+V", run: () => void Promise.resolve().then(() => navigator.clipboard.readText()).then(paste, () => paste("")) }] : []),
        { label: t("Add step here"), run: () => setMenu({ ...where(), at }) },
        { label: t("Fit view"), run: () => fitRef.current?.() },
      ],
    });
  keys.current.paste = paste;
  keys.current.key = (key) => {
    if (key === "escape") {
      if (connecting) cancelConnect();
      else if (selected && !phone) select(null);
      else return false;
      return true;
    }
    // Ctrl+C with text selected on the page copies the text, as usual.
    if (!step || (key === "c" && (!copyable(step) || String(getSelection() ?? "") !== ""))) return false;
    if (key === "d") duplicate(step.id);
    else copyStep(step);
    return true;
  };
  const actions = (
    <div className="a7-actions" role="group" aria-label={t("Workflow actions")}>
      {/* The result shows in the panel's overview, so the selected step is closed first. */}
      <button
        type="button"
        onClick={() => {
          select(null);
          void testRun().then(showRun);
        }}
        disabled={busy || draft.steps.length === 0}
      >
        {t("Test run")}
      </button>
      <button type="button" aria-label={t("Explain this flow")} onClick={() => setShowExplain(true)} disabled={draft.steps.length === 0}>
        {t("Explain")}
      </button>
      {shareable(draft.trigger.type) && (
        <button type="button" onClick={() => void reload().then(() => setShowShare(true), () => setShowShare(true))}>
          {t("Share")}
        </button>
      )}
      <button type="button" onClick={() => save(false)} disabled={busy || draft.steps.length === 0}>
        {t("Save")}
      </button>
      <button type="button" className="primary" onClick={() => setShowTurnOn(true)} disabled={busy || draft.steps.length === 0}>
        {t("Publish")}
      </button>
    </div>
  );

  const shownRun = sample && sampleRun?.id === sample.runId ? sampleRun : null;
  // The selected step or trigger: in the side panel on a wide screen, in a sheet over the list on a phone.
  const inspector = (
    <>
      {selected === "trigger" && (
        <div className="a7-inspector">
          <div className="a7-kicker-row">
            <p className="a7-kicker a7-when">{t("When")}</p>
            {closeButton}
          </div>
          <TriggerPanel
            trigger={draft.trigger}
            wf={wf}
            onChange={(trigger) => {
              // A new trigger type gets matching sample data; edits within a type keep what the user typed.
              if (trigger.type !== draft.trigger.type) setPayload(samplePayload(trigger, firstResource));
              update({ ...draft, trigger });
            }}
          />
          {addAfter(undefined, t("Add a step at the start"))}
          <NextUp draft={draft} id="trigger" />
        </div>
      )}
      {step && (
        <section className="a7-inspector" aria-labelledby="step-heading">
          <div className="a7-kicker-row">
            <p className="a7-kicker">{t("Step {number} · {type}", { number: draft.steps.indexOf(step) + 1, type: stepLabel(step.type, language) })}</p>
            <button
              type="button"
              className="a7-delete"
              onClick={() => {
                update(removeStep(draft, step.id));
                select(null);
              }}
            >
              {t("Delete step")}
            </button>
            {closeButton}
          </div>
          <h2 id="step-heading">{step.id}</h2>
          <p className="a7-lead">{destination(step, { language, trigger: draft.trigger, chosen: chosen.get(step.id) })}</p>
          <p className="muted a7-describe">{stepEntry(step.type).description[language]}</p>
          {missingApp.get(step.id) && (
            <p className="a7-warn-note">
              {t("{app} is not connected yet.", { app: t(missingApp.get(step.id)!) })} <a href="#/apps">{t("Connect in Apps")}</a>
            </p>
          )}
          {step.type === "google_docs" && (
            <DocTemplatePicker key={`${step.id}-template`} templateId={step.config.templateId} templateName={step.config.templateName} onPick={(templateId, templateName) => editStep({ ...step.config, templateId, templateName })} />
          )}
          <SchemaForm key={step.id} schema={step.type === "ai" ? withoutFiles(catalog.schemas.ai!) : step.type === "google_docs" ? withoutTemplate(catalog.schemas.google_docs!) : step.type === "browser" ? withoutActions(catalog.schemas.browser!) : step.type === "switch" ? withoutCases(catalog.schemas.switch!) : step.type === "transform" ? transformSchema(catalog.schemas.transform!, step.config.op) : catalog.schemas[step.type]!} value={step.config as Record<string, unknown>} onChange={editStep} />
          {step.type === "whatsapp_reply" && (
            <p className="muted hint">
              {t("Meta bills WhatsApp Cloud API per delivered message to your Meta Business payment method. Free-form text works within 24 hours of the guest's last message; reminders outside 24 hours must use an approved Meta utility template.")}
            </p>
          )}
          {step.type === "browser" && <BrowserActions key={`${step.id}-actions`} actions={step.config.actions} onChange={(actions) => editStep({ ...step.config, actions })} />}
          {step.type === "switch" && <SwitchCases key={`${step.id}-cases`} cases={step.config.cases} onChange={(cases) => editStep({ ...step.config, cases })} />}
          {!stepBranches(step) && (
            <div className="field">
              <label htmlFor="step-on-error">{t("If this step fails")}</label>
              <select id="step-on-error" value={("onError" in step ? step.onError : undefined) ?? "stop"} onChange={(e) => editOnError(e.target.value as StepErrorPolicy)}>
                <option value="stop">{t("Stop the automation (default)")}</option>
                <option value="skip">{t("Skip and continue to the next step")}</option>
                <option value="failed_edge">{t("Follow the failed branch")}</option>
              </select>
            </div>
          )}
          {step.type === "ai" &&
            ((draft.trigger.type === "form" && draft.trigger.config.fields.some((f) => f.type === "file")) || draft.trigger.type === "meta_dm" || draft.trigger.type === "whatsapp_message" || draft.trigger.type === "telegram_message" || draft.trigger.type === "drive_file") && (
            <fieldset>
              <legend>{t("Let the AI read these files")}</legend>
              {(draft.trigger.type === "form"
                ? draft.trigger.config.fields.filter((f) => f.type === "file").map((f) => ({ name: f.name, label: f.label }))
                : draft.trigger.type === "telegram_message"
                  ? [{ name: "file", label: t("Telegram photo or PDF") }]
                  : draft.trigger.type === "drive_file"
                  ? [{ name: "file", label: t("Drive photo or PDF") }]
                  : [{ name: "image", label: t("DM photo attachment") }]
              ).map((f) => (
                <label key={f.name} className="check">
                  <input
                    type="checkbox"
                    checked={(step.config as { files?: string[] }).files?.includes(f.name) ?? false}
                    onChange={(e) => {
                      const { files = [], ...rest } = step.config as { files?: string[] };
                      const next = e.target.checked ? [...files, f.name] : files.filter((n) => n !== f.name);
                      editStep(next.length ? { ...rest, files: next } : rest);
                    }}
                  />
                  {f.label}
                </label>
              ))}
              <p className="muted hint">{t("Checked files are sent to the AI model you picked on the AI model page. Photos need Gemini, OpenAI or OpenRouter.")}</p>
            </fieldset>
          )}
          <div className="field">
            <label htmlFor="step-note">{t("Note")}</label>
            <textarea id="step-note" rows={2} maxLength={STEP_NOTE_MAX} value={step.note ?? ""} onChange={(e) => editNote(e.target.value)} aria-describedby="step-note-count" placeholder={t("What this step is for, in your own words.")} />
            <p id="step-note-count" className="muted hint">
              {t("{count} of {max} characters. Shown on the step and in Explain this flow.", { count: step.note?.length ?? 0, max: STEP_NOTE_MAX })}
            </p>
          </div>
          <StepTest
            step={step}
            run={shownRun}
            stale={!!sample && sample.key !== JSON.stringify(draft)}
            busy={busy}
            onTest={() => void testRun("mock")}
            onReal={canSendAlone(step.type) && !step.disabled ? () => sendForReal(step) : undefined}
          />
          <VariablePicker key={`${step.id}-vars`} groups={variableGroups(insertables(draft, step.id), shownRun?.steps ?? [], parseSample(payload), upstreamIds(draft, step.id))} stale={!!sample && sample.key !== JSON.stringify(draft)} />
          {addAfter(step.id, t("Add a step after this one"))}
          <ConnectTo draft={draft} step={step} onConnect={update} />
          <NextUp draft={draft} id={step.id} />
        </section>
      )}
    </>
  );

  return (
    <div className="a7-editor">
      <header className="a7-head">
        <div className="a7-head-main">
          <p className="a7-crumb">
            <a href="#/">{t("Automations")}</a> / {t(wf.live ? "Live" : "Drafts")}
          </p>
          <div className="a7-title">
            <h1>{wf.name}</h1>
            <span className="a7-chip" data-live={isLive || undefined} data-live-state={isLive && liveState !== "idle" ? liveState : undefined}>
              {t(isLive ? "Live" : "Draft")}
            </span>
            <span className="a7-meta status" aria-live="polite">
              {status}
              {wf.live && !wf.latest?.published && t(" · version {version} is live", { version: wf.live.version })}
            </span>
          </div>
          <div className="a7-tabs">
            <AutomationTabs id={id} here="steps" overview={!!wf.setup && !!wf.live} />
            <a href={`#/w/${id}/versions`}>{t("Versions")}</a>
          </div>
        </div>
        {/* Keep global workflow actions pinned in the desktop header regardless of panel fold state. */}
        {wide && actions}
      </header>
      <div className="a7-body">
        <section className="a7-canvas" aria-label={t("Workflow diagram. Tab to a step and press Enter to select it, Delete to remove it.")}>
          {!wide && actions}
          {missing.length > 0 && (
            <div className="a7-setup">
              <p className="a7-setup-count">{t("{done} of {total} apps connected", { done: apps.length - missing.length, total: apps.length })}</p>
              <span className="a7-setup-bars" aria-hidden="true">
                {apps.map((a) => (
                  <span key={a.provider} data-done={a.connected || undefined} />
                ))}
              </span>
              <p className="a7-setup-left">{t("Left: connect {apps}", { apps: missing.map((a) => t(a.label)).join(", ") })}</p>
              <a className="a7-setup-action" href="#/apps">
                {t("Connect {app}", { app: t(missing[0]!.label) })}
              </a>
            </div>
          )}
          {wf.live && !wf.pausedAt && (
            <div className="a7-live-bar" data-state={liveState}>
              <span className="a7-live-dot" aria-hidden="true" />
              <span className="a7-live-text">
                {liveState === "working"
                  ? t("Running live now…")
                  : liveState === "done"
                    ? t("Live run succeeded")
                    : liveState === "problem"
                      ? t("Live run failed")
                      : liveState === "waiting"
                        ? t(activeLiveRun?.needsReview || activeLiveRun?.state === "needs_review" ? "Live run needs your review" : "Live run is waiting")
                        : t("Listening for live events")}
              </span>
              {activeLiveRun && (
                <span className="a7-live-actions">
                  <button
                    type="button"
                    className="quiet"
                    onClick={() => {
                      select(null);
                      fold(false);
                      setTimeout(showRun, 0);
                    }}
                  >
                    {t("View logs")}
                  </button>
                  <button type="button" className="quiet" onClick={() => setRunId(null)}>
                    {t("Clear")}
                  </button>
                </span>
              )}
            </div>
          )}
          <div className="a7-tools">
          <div className="a7-undo" role="group" aria-label={t("Undo and redo")}>
            <button type="button" onClick={() => stepHistory("undo")} disabled={history.past.length === 0}>
              {t("Undo")}
            </button>
            <button type="button" onClick={() => stepHistory("redo")} disabled={history.future.length === 0}>
              {t("Redo")}
            </button>
            <span className="a7-note" aria-live="polite">
              {note}
            </span>
          </div>
          <div className="a7-view" role="group" aria-label={t("Show steps as")}>
            <button type="button" aria-pressed={view === "diagram"} onClick={() => setView("diagram")}>
              {t("Diagram")}
            </button>
            <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}>
              {t("List")}
            </button>
          </div>
          </div>
          {view === "diagram" ? (
            <div
              className="a7-flow"
              // Shift+F10 and the Menu key open the right-click menu for the focused step.
              onKeyDown={(e) => {
                if (!((e.shiftKey && e.key === "F10") || e.key === "ContextMenu")) return;
                const el = (e.target as HTMLElement).closest(".react-flow__node");
                const nodeId = el?.getAttribute("data-id");
                if (!el || !nodeId) return;
                e.preventDefault();
                nodeMenu(nodeId, below(el));
              }}
            >
              <ReactFlow
                ariaLabelConfig={flowAriaLabels(language)}
                nodes={nodes}
                edges={edges}
                nodeTypes={editorNodeTypes}
                edgeTypes={editorEdgeTypes}
                onNodesChange={onNodesChange}
                onInit={(instance) => (fitRef.current = () => void instance.fitView(PANEL_STEPS_FIT))}
                onPaneClick={() => {
                  select(null);
                  if (connecting) cancelConnect();
                }}
                onNodeClick={(_, node) => {
                  if (!connecting) return;
                  setConnecting(null);
                  if (node.id === "trigger") setNote(t("Connect cancelled."));
                  else connect(connecting.from, connecting.on, node.id);
                }}
                onNodeDoubleClick={(_, node) => {
                  select(node.id);
                  // The panel renders the step's form on this click; focus its first field once it is there.
                  setTimeout(() => document.querySelector<HTMLElement>(".a7-inspector :is(input, select, textarea)")?.focus(), 0);
                }}
                onNodeContextMenu={(e, node) => {
                  e.preventDefault();
                  nodeMenu(node.id, { x: e.clientX, y: e.clientY });
                }}
                onPaneContextMenu={(e) => {
                  e.preventDefault();
                  paneMenu({ x: e.clientX, y: e.clientY });
                }}
                // Drag from a step's dot: onto another step connects them (or says why not), onto empty canvas opens the add menu there.
                // onConnectEnd fires only after the pointer moved, so a plain click on a dot does nothing.
                onConnectEnd={(e, state) => {
                  if (!state.fromNode || !state.fromHandle) return;
                  const from = state.fromNode.id;
                  const on = state.fromHandle.id ?? undefined;
                  const point = "changedTouches" in e ? e.changedTouches[0]! : e;
                  // toNode is set only near a step's top dot; anywhere on a step's card counts too.
                  const to = state.toNode?.id ?? document.elementFromPoint(point.clientX, point.clientY)?.closest(".react-flow__node")?.getAttribute("data-id");
                  if (to) {
                    if (to !== from && to !== "trigger") connect(from, on, to);
                    return;
                  }
                  setMenu({ after: from, on, at: { x: point.clientX, y: point.clientY } });
                }}
                connectionLineComponent={DropLine}
                connectOnClick={false}
                zoomOnDoubleClick={false}
                nodesDraggable={false}
                nodesConnectable
                deleteKeyCode="Delete"
                colorMode={document.documentElement.dataset.theme === "dark" ? "dark" : "light"}
                proOptions={{ hideAttribution: true }}
                fitView
                fitViewOptions={PANEL_STEPS_FIT}
              >
                <Background gap={18} size={1.5} />
                <ZoomBar />
              </ReactFlow>
            </div>
          ) : (
            <StepList draft={draft} selected={selected} onSelect={select} onMove={move} chosen={chosen} />
          )}
          {/* The list (and a phone, and an empty flow) adds at the end; the diagram adds from a connection, a dot or a right click. */}
          {(phone || view === "list" || draft.steps.length === 0) && (
            <button type="button" className="a7-add" onClick={(e) => setMenu({ ...(tail && { after: tail.id }), at: below(e.currentTarget) })}>
              <span aria-hidden="true">+</span> {t("Add a step at the end")}
            </button>
          )}
        </section>
        <div className="a7-side" data-folded={(wide && folded) || undefined}>
          {wide && (
            <button type="button" className="a7-fold" aria-expanded={!folded} aria-controls={folded ? undefined : "a7-panel"} aria-label={t(folded ? "Show the side panel" : "Hide the side panel")} onClick={() => fold(!folded)}>
              <span aria-hidden="true">{folded ? "‹" : "›"}</span>
            </button>
          )}
          {!(wide && folded) && (
            <aside className="a7-panel" id="a7-panel" aria-label={t("Side panel")}>
              {message && (
                <p role={message.kind === "error" ? "alert" : "status"} className={`message ${message.kind}`}>
                  {message.text}
                </p>
              )}
              {selected && !phone ? (
                inspector
              ) : (
                <>
                  <SetupGuide facts={{ missingApps: missing.length, problems: problems.length, explained, test, live: isLive }} onExplain={() => setShowExplain(true)} onTry={() => void testRun("mock")} onTurnOn={() => setShowTurnOn(true)} />
                  {warnings.length > 0 && (
                    <section className="a7-checks" aria-labelledby="checks-heading">
                      <h2 id="checks-heading">{t("Check before publishing")}</h2>
                      <ul>
                        {warnings.map((w) => (
                          <li key={w}>{warningForLanguage(w, language)}</li>
                        ))}
                      </ul>
                    </section>
                  )}
                  <SampleTest draft={draft} apps={apps} test={test} run={sampleRun} busy={busy} onTry={() => void testRun("mock")} />
                  <div className="a7-ai">
                    <AskAi
                      workflowId={id}
                      draft={draft}
                      onApply={(d) => {
                        update(d);
                        select(null);
                        setPayload(samplePayload(d.trigger, firstResource));
                      }}
                    />
                  </div>
                  <details className="a7-test-settings" open={fromRun !== null}>
                    <summary>{t("Test settings")}</summary>
                    <div className="field">
                      <label htmlFor="payload">{t("Sample trigger data (JSON)")}</label>
                      <textarea id="payload" rows={5} value={payload} onChange={(e) => setPayload(e.target.value)} spellCheck={false} />
                      {fromRun && <p className="muted hint" role="status">{t("Sample data from request {reference}. Values hidden as [secret] stay hidden.", { reference: fromRun })}</p>}
                    </div>
                    <div className="field">
                      <label htmlFor="test-mode">{t("Test calls")}</label>
                      <select id="test-mode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
                        <option value="mock">{t("Mocked: nothing is sent and no model is called")}</option>
                        <option value="ai">{t("Real AI only: the model is called, everything else is mocked")}</option>
                        <option value="live">{t("Live: real HTTP, email, AI, approval emails and connected apps")}</option>
                      </select>
                    </div>
                    {mode !== "live" && <TestChoices steps={draft.steps} choices={choices} onChange={setChoices} />}
                    <div className="actions">
                      <button type="button" onClick={() => void testRun()} disabled={busy || draft.steps.length === 0}>
                        {t("Test run draft")}
                      </button>
                      <button type="button" onClick={runLive} disabled={busy || !wf.live}>
                        {t("Run live version")}
                      </button>
                    </div>
                  </details>
                  {run && (
                    <section className="a7-test" aria-labelledby="run-heading">
                      <h2 id="run-heading">{t(run.test ? "Run" : "Live run log")}</h2>
                      <RunResult run={run} />
                      <p>
                        <a href={`#/runs/${run.id}`}>{t("Open this run in the run history")}</a>
                      </p>
                    </section>
                  )}
                  {wf.live && (
                    <section className="a7-live-logs" aria-labelledby="live-logs-heading">
                      <h2 id="live-logs-heading">{t("Live logs")}</h2>
                      {liveRuns.length === 0 ? (
                        <p className="muted hint">{t("No live runs yet. Send a real event to see it run here.")}</p>
                      ) : (
                        <ul className="a7-live-list">
                          {liveRuns.map((r) => (
                            <li key={r.id} className={r.id === runId ? "is-active" : undefined}>
                              <button type="button" className="quiet a7-live-pick" onClick={() => setRunId(r.id)}>
                                <StatePill run={r} />
                                <span className="a7-live-when">{ago(r.createdAt, Date.now(), language)}</span>
                              </button>
                              <a className="a7-live-open" href={`#/runs/${r.id}`}>
                                {t("Full log")}
                              </a>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  )}
                </>
              )}
            </aside>
          )}
        </div>
      </div>
      {phone && selected && (
        <Sheet title={t(selected === "trigger" ? "Edit the trigger" : "Edit step")} onClose={() => select(null)}>
          {inspector}
          <div className="wk-sheet-actions">
            <button type="button" className="wk-button blue" onClick={(e) => e.currentTarget.closest("dialog")?.close()}>
              {t("Done")}
            </button>
          </div>
        </Sheet>
      )}
      {menu && <AddMenu draft={draft} after={menu.after ? draft.steps.find((s) => s.id === menu.after) : undefined} on={menu.on} at={menu.at} onPick={addFromMenu} onClose={() => setMenu(null)} />}
      {context && <ContextMenu label={context.label} at={context.at} items={context.items} onClose={() => setContext(null)} />}
      {showExplain && <ExplainSheet draft={draft} chosen={chosen} onClose={closeExplain} />}
      {showShare && wf && (
        <ShareSheet
          info={{
            slug: wf.slug,
            live: wf.live ? (definitionSchema.safeParse(wf.live.definition).data?.trigger ?? null) : null,
            triggerId: wf.trigger?.id ?? null,
            webhookPath: wf.trigger?.webhookPath ?? null,
          }}
          onClose={() => setShowShare(false)}
        />
      )}
      {showTurnOn && (
        <TurnOnSheet
          draft={draft}
          apps={apps}
          chosen={chosen}
          test={test}
          problems={problems.length}
          onConfirm={() => {
            setShowTurnOn(false);
            void save(true);
          }}
          onClose={() => setShowTurnOn(false)}
        />
      )}
    </div>
  );
}

/**
 * "Test this step" in the step's own panel (T1, decision 0110): a preview of the whole flow, with this step's last
 * attempt shown here so the owner does not have to find it in the run result. "Try this step for real" sends only it.
 */
function StepTest({ step, run, stale, busy, onTest, onReal }: { step: Step; run: Run | null; stale: boolean; busy: boolean; onTest: () => void; onReal?: () => void }) {
  const { t } = useLanguage();
  const last = run?.steps.filter((s) => s.stepId === step.id).at(-1);
  const real = run?.testChoices?.[step.id] && "live" in run.testChoices[step.id]!;
  return (
    <section className="a7-group a7-step-test" aria-labelledby="step-test-heading">
      <h3 id="step-test-heading">{t("Test this step")}</h3>
      <div className="a7-step-test-actions">
        <button type="button" onClick={onTest} disabled={busy}>
          {t("Test this step")}
        </button>
        {onReal && (
          <button type="button" onClick={onReal} disabled={busy}>
            {t("Try this step for real")}
          </button>
        )}
      </div>
      <p className="muted hint">{t(onReal ? "A test fakes every app. For real sends only this step, with the sample data." : "A test fakes every app and sends nothing.")}</p>
      {run && (
        <div className="a7-last-test" aria-live="polite">
          <h4>{t(real ? "Last test, sent for real" : "Last test")}</h4>
          {stale && <p className="muted">{t("From before your last change. Test again to see the new result.")}</p>}
          {last ? (
            <div className="run">
              <StepAttempt s={last} />
            </div>
          ) : (
            <p className="muted">{t(FINISHED.has(run.state) ? "The last test did not reach this step. Check the path before it and the sample data." : "Running…")}</p>
          )}
        </div>
      )}
    </section>
  );
}

/** The accessible list: every step as a button, in order, with the branch that leads to it. */
function StepList({ draft, selected, onSelect, onMove, chosen }: { draft: Draft; selected: string | null; onSelect: (id: string) => void; onMove: (id: string, dir: "up" | "down") => void; chosen: ReadonlyMap<string, string> }) {
  const { t, language } = useLanguage();
  return (
    <ol className="a7-list" aria-label={t("Steps")}>
      <li>
        <button type="button" aria-pressed={selected === "trigger"} onClick={() => onSelect("trigger")}>
          <AppMark decorative mark={triggerEntry(draft.trigger.type).mark} name={markText(triggerEntry(draft.trigger.type), language)} size={24} />
          {t("Trigger: {type}", { type: triggerLabel(draft.trigger.type, language) })}
        </button>
      </li>
      {draft.steps.map((s, i) => {
        const into = draft.edges.filter((e) => e.to === s.id && e.on);
        return (
          <li key={s.id}>
            <button type="button" aria-pressed={selected === s.id} onClick={() => onSelect(s.id)}>
              {/* The id comes first so the button's name starts with it; CSS puts the kicker before it. */}
              <AppMark decorative mark={stepEntry(s.type).mark} name={markText(stepEntry(s.type), language)} size={24} />
              <span className="a7-list-id">{s.id}</span>{" "}
              <span className="a7-list-kicker">
                {i + 1} · {stepLabel(s.type, language)}
              </span>
              <span className="a7-list-where">{destination(s, { language, trigger: draft.trigger, chosen: chosen.get(s.id) })}</span>
              {s.note && <span className="a7-list-note">{s.note}</span>}
              {into.map((e) => (
                <span key={e.from} className="a7-branch" data-branch={e.on}>
                  {t("{from} on {branch}", { from: e.from, branch: t(e.on!) })}
                </span>
              ))}
            </button>
            <span className="a7-move">
              {(["up", "down"] as const).map((dir) => (
                <button key={dir} type="button" data-move={`${s.id}:${dir}`} disabled={!canMove(draft, s.id, dir)} aria-label={t(dir === "up" ? "Move {id} up" : "Move {id} down", { id: s.id })} onClick={() => onMove(s.id, dir)}>
                  <span aria-hidden="true">{dir === "up" ? "↑" : "↓"}</span>
                </button>
              ))}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The searchable add menu: type to narrow the steps, arrow keys move through the results, Enter adds, Escape closes. */
function AddMenu({ draft, after, on, at, onPick, onClose }: { draft: Draft; after?: Step; on?: string; at?: Point; onPick: (type: AddableType, on?: string) => void; onClose: () => void }) {
  const { t, language } = useLanguage();
  const phone = usePhone();
  const [query, setQuery] = useState("");
  const [branch, setBranch] = useState("");
  const branchLabels = after && on === undefined ? stepBranches(after) : undefined;
  const labels = branchLabels ?? (after && on === undefined && "onError" in after && after.onError === "failed_edge" ? (["failed"] as const) : undefined);
  const q = query.trim().toLowerCase();
  const found = ADDABLE.filter((kind) => !q || `${stepLabel(kind, language)} ${stepEntry(kind).description[language]} ${kind}`.toLowerCase().includes(q));
  const where = after ? t("after {id}", { id: after.id }) : t(draft.steps.length ? "at the start" : "as the first step");
  const go = (kind: AddableType) => onPick(kind, labels && branch ? branch : undefined);
  const arrows = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>("input[type=search], .a7-menu-list button")];
    const next = items.indexOf(document.activeElement as HTMLElement) + (e.key === "ArrowDown" ? 1 : -1);
    if (next < 0 || next >= items.length) return;
    e.preventDefault();
    items[next]!.focus();
  };
  const title = t("Add a step {where}", { where });
  const body = (
    <div className="a7-menu" onKeyDown={arrows}>
      <input type="search" autoFocus aria-label={t("Search steps")} placeholder={t("Search steps")} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && found[0] && go(found[0])} />
      {labels && (
        <select aria-label={t("Branch")} value={branch} onChange={(e) => setBranch(e.target.value)}>
          <option value="">{t(branchLabels ? "next free branch" : "next step (default)")}</option>
          {labels.map((b) => (
            <option key={b} value={b}>
              {t("on {branch}", { branch: t(b) })}
            </option>
          ))}
        </select>
      )}
      <ul className="a7-menu-list">
        {found.map((kind) => (
          <li key={kind}>
            <button type="button" data-type={kind} onClick={() => go(kind)}>
              <AppMark decorative mark={stepEntry(kind).mark} name={markText(stepEntry(kind), language)} size={24} />
              <span>
                <strong>{stepLabel(kind, language)}</strong>
                <small>{stepEntry(kind).description[language]}</small>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {found.length === 0 && <p className="muted">{t("No step matches that.")}</p>}
    </div>
  );
  // A wide screen opens the menu by what opened it (the plus, the dot's drop point, the pointer); a phone gets the bottom sheet.
  return phone || !at ? (
    <Sheet title={title} onClose={onClose}>
      {body}
    </Sheet>
  ) : (
    <Popover title={title} at={at} className="a7-add-menu" onClose={onClose}>
      {body}
    </Popover>
  );
}

/** The right-click menu, Lucid style: arrow keys, Home and End move, Enter picks, Escape closes and focus goes back where it was. */
function ContextMenu({ label, at, items, onClose }: { label: string; at: Point; items: MenuItem[]; onClose: () => void }) {
  const arrows = (e: React.KeyboardEvent<HTMLElement>) => {
    const list = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]")];
    const i = list.indexOf(document.activeElement as HTMLElement);
    const next = { ArrowDown: (i + 1) % list.length, ArrowUp: (i - 1 + list.length) % list.length, Home: 0, End: list.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    list[next]!.focus();
  };
  return (
    <Popover title={label} hideTitle at={at} className="a7-context" onClose={onClose}>
      <ul role="menu" aria-label={label} onKeyDown={arrows}>
        {items.map((item) => (
          <li key={item.label} role="none">
            <button
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.currentTarget.closest("dialog")?.close();
                item.run();
              }}
            >
              <span>{item.label}</span>
              {item.keys && <kbd>{item.keys}</kbd>}
            </button>
          </li>
        ))}
      </ul>
    </Popover>
  );
}

/** Connect to: where each path of this step leads, chosen from a list so it works by touch and keyboard. A refused change says why. */
function ConnectTo({ draft, step, onConnect }: { draft: Draft; step: Step; onConnect: (next: Draft) => void }) {
  const { t } = useLanguage();
  const [error, setError] = useState<ConnectError | null>(null);
  const others = draft.steps.filter((s) => s.id !== step.id);
  if (others.length === 0) return null;
  const paths: readonly (string | undefined)[] = stepBranches(step) ?? ("onError" in step && step.onError === "failed_edge" ? [undefined, "failed"] : [undefined]);
  return (
    <section className="a7-group" aria-labelledby={`connect-${step.id}`}>
      <h3 id={`connect-${step.id}`}>{t("Connect to")}</h3>
      {paths.map((on) => (
        <div className="field" key={on ?? "next"}>
          <label htmlFor={`connect-${step.id}-${on ?? "next"}`}>{on ? t("On {branch} go to", { branch: t(on) }) : t("Go to")}</label>
          <select
            id={`connect-${step.id}-${on ?? "next"}`}
            value={draft.edges.find((e) => e.from === step.id && e.on === on)?.to ?? ""}
            onChange={(e) => {
              const r = connectSteps(draft, step.id, on, e.target.value);
              setError("error" in r ? r.error : null);
              if ("draft" in r) onConnect(r.draft);
            }}
          >
            <option value="" disabled>
              {t("Nothing yet")}
            </option>
            {others.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}
              </option>
            ))}
          </select>
        </div>
      ))}
      {error && (
        <p role="alert" className="message error">
          {connectReason(error, t)}
        </p>
      )}
    </section>
  );
}

/** What runs after this step, branch by branch. */
function NextUp({ draft, id }: { draft: Draft; id: string }) {
  const { t } = useLanguage();
  const paths = nextPaths(draft, id);
  return (
    <section className="a7-group" aria-labelledby={`next-${id}`}>
      <h3 id={`next-${id}`}>{t("What happens next")}</h3>
      {paths.length === 0 ? (
        <p className="muted">{t("The run ends here.")}</p>
      ) : (
        <dl className="a7-next">
          {paths.map((p) => (
            <div key={p.on ?? "next"}>
              <dt className="a7-branch-text" data-branch={p.on}>
                {p.on ? t(p.on) : t("Next")}
              </dt>
              <dd>{p.steps.map((s) => s.id).join(", ")}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

const TRIGGER_ORDER: Trigger["type"][] = ["manual", "webhook", "schedule", "page_changed", "form", "email", "gmail_message", "outlook_message", "payment", "booking_event", "payment_event", "sub_workflow", "meta_dm", "whatsapp_message", "telegram_message", "slack_message", "teams_message", "discord_message", "shopify_order", "sheets_row", "calendar_event", "drive_file", "airtable_record", "notion_page", "trello_card"];
const TRIGGER_DEFAULTS: Record<Trigger["type"], Trigger> = {
  manual: { type: "manual", config: {} },
  email: { type: "email", config: {} },
  gmail_message: { type: "gmail_message", config: {} },
  outlook_message: { type: "outlook_message", config: {} },
  webhook: { type: "webhook", config: {} },
  schedule: { type: "schedule", config: { cron: "0 9 * * 1" } },
  page_changed: { type: "page_changed", config: { mode: "page", url: "https://example.com", maxChars: 4000 } },
  form: { type: "form", config: { fields: [{ name: "email", label: "Email", type: "email", required: true }] } },
  payment: { type: "payment", config: { events: ["paid"] } },
  booking_event: { type: "booking_event", config: { events: ["created"] } },
  payment_event: { type: "payment_event", config: { events: ["confirmed"] } },
  sub_workflow: { type: "sub_workflow", config: {} },
  meta_dm: { type: "meta_dm", config: { channel: "both", requireImage: false } },
  whatsapp_message: { type: "whatsapp_message", config: { requireImage: false } },
  shopify_order: { type: "shopify_order", config: {} },
  telegram_message: { type: "telegram_message", config: { from: "my_chat", requireFile: true } },
  slack_message: { type: "slack_message", config: { signingSecret: "", ignoreBots: true } },
  teams_message: { type: "teams_message", config: { signingSecret: "" } },
  discord_message: { type: "discord_message", config: {} },
  sheets_row: { type: "sheets_row", config: { tab: "Sheet1" } },
  calendar_event: { type: "calendar_event", config: { on: "created", minutesBefore: 60 } },
  drive_file: { type: "drive_file", config: { requireFile: false } },
  airtable_record: { type: "airtable_record", config: { on: "created" } },
  notion_page: { type: "notion_page", config: { on: "created" } },
  trello_card: { type: "trello_card", config: { on: "created" } },
};

function TriggerPanel({ trigger, wf, onChange }: { trigger: Trigger; wf: Loaded; onChange: (t: Trigger) => void }) {
  const { t, language } = useLanguage();
  const id = useId();
  const published = wf.trigger && wf.live && wf.trigger.type === trigger.type ? wf.trigger : null;
  const [newPath, setNewPath] = useState<string | null>(null);
  const fields = trigger.type === "form" ? trigger.config.fields : trigger.type === "sub_workflow" ? (trigger.config.fields ?? []) : [];
  const setFields = (next: FormField[]) =>
    onChange(
      trigger.type === "sub_workflow"
        ? { type: "sub_workflow", config: next.length ? { fields: next } : {} }
        : { type: "form", config: { fields: next } },
    );
  const bookingLabels = { created: t("Booking created"), rescheduled: t("Booking rescheduled"), cancelled: t("Booking cancelled") } as const;
  const paymentEventLabels = { confirmed: t("Payment confirmed"), expired: t("Payment expired") } as const;
  return (
    <section aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>{t("Trigger")}</h2>
      <div className="field">
        <label htmlFor={`${id}-type`}>{t("Starts when")}</label>
        <select id={`${id}-type`} value={trigger.type} onChange={(e) => onChange(TRIGGER_DEFAULTS[e.target.value as Trigger["type"]])}>
          {TRIGGER_ORDER.map((type) => (
            <option key={type} value={type}>
              {triggerLabel(type, language)}
            </option>
          ))}
        </select>
      </div>
      {(trigger.type === "sheets_row" || trigger.type === "calendar_event" || trigger.type === "drive_file") && <GoogleTriggerSettings trigger={trigger} workflowId={wf.id} onChange={onChange} />}
      {(trigger.type === "gmail_message" || trigger.type === "outlook_message") && <MailboxTriggerSettings trigger={trigger} workflowId={wf.id} onChange={onChange} />}
      {trigger.type === "page_changed" && <MonitorTriggerSettings trigger={trigger} workflowId={wf.id} onChange={onChange} />}
      {trigger.type === "slack_message" && (
        <>
          <div className="field">
            <label htmlFor={`${id}-slack-secret`}>{t("Signing secret name")}</label>
            <input id={`${id}-slack-secret`} value={trigger.config.signingSecret} onChange={(e) => onChange({ type: "slack_message", config: { ...trigger.config, signingSecret: e.target.value } })} />
            <p className="muted hint">
              {t("Slack verifies each request with X-Slack-Signature using this secret.")}{" "}
              <a href="#/secrets">{t("Manage secrets")}</a>
            </p>
          </div>
          <div className="field">
            <label htmlFor={`${id}-slack-channel`}>
              {t("Channel ID")} <span className="muted">{t("(optional)")}</span>
            </label>
            <input id={`${id}-slack-channel`} placeholder="C01234567" value={trigger.config.channelId ?? ""} onChange={(e) => onChange({ type: "slack_message", config: { ...trigger.config, channelId: e.target.value || undefined } })} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-slack-kw`}>
              {t("Keyword filter")} <span className="muted">{t("(optional)")}</span>
            </label>
            <input id={`${id}-slack-kw`} value={trigger.config.textContains ?? ""} onChange={(e) => onChange({ type: "slack_message", config: { ...trigger.config, textContains: e.target.value || undefined } })} />
          </div>
          <div className="field">
            <label className="check">
              <input type="checkbox" checked={trigger.config.ignoreBots} onChange={(e) => onChange({ type: "slack_message", config: { ...trigger.config, ignoreBots: e.target.checked } })} />{" "}
              {t("Ignore messages from bots")}
            </label>
          </div>
        </>
      )}
      {trigger.type === "teams_message" && (
        <>
          <div className="field">
            <label htmlFor={`${id}-teams-secret`}>{t("Signing secret name")}</label>
            <input id={`${id}-teams-secret`} value={trigger.config.signingSecret} onChange={(e) => onChange({ type: "teams_message", config: { ...trigger.config, signingSecret: e.target.value } })} />
            <p className="muted hint">
              {t("Teams verifies Outgoing Webhooks with Authorization HMAC, or Teams Workflows with X-Daloy-Signature.")}{" "}
              <a href="#/secrets">{t("Manage secrets")}</a>
            </p>
          </div>
          <div className="field">
            <label htmlFor={`${id}-teams-channel`}>
              {t("Channel ID")} <span className="muted">{t("(optional)")}</span>
            </label>
            <input id={`${id}-teams-channel`} value={trigger.config.channelId ?? ""} onChange={(e) => onChange({ type: "teams_message", config: { ...trigger.config, channelId: e.target.value || undefined } })} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-teams-kw`}>
              {t("Keyword filter")} <span className="muted">{t("(optional)")}</span>
            </label>
            <input id={`${id}-teams-kw`} value={trigger.config.textContains ?? ""} onChange={(e) => onChange({ type: "teams_message", config: { ...trigger.config, textContains: e.target.value || undefined } })} />
          </div>
        </>
      )}
      {trigger.type === "discord_message" && (
        <>
          <div className="field">
            <label htmlFor={`${id}-discord-pubkey`}>
              {t("Discord Application Public Key")} <span className="muted">{t("(64 hex characters, for slash commands)")}</span>
            </label>
            <input id={`${id}-discord-pubkey`} value={trigger.config.publicKey ?? ""} onChange={(e) => onChange({ type: "discord_message", config: { ...trigger.config, publicKey: e.target.value.trim() || undefined } })} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-discord-secret`}>
              {t("Or signing secret name")} <span className="muted">{t("(for signed relay calls)")}</span>
            </label>
            <input id={`${id}-discord-secret`} value={trigger.config.signingSecret ?? ""} onChange={(e) => onChange({ type: "discord_message", config: { ...trigger.config, signingSecret: e.target.value || undefined } })} />
            <p className="muted hint">
              {t("Enter a Discord Application Public Key for slash command interactions, or a signing secret name for signed webhook calls.")}{" "}
              <a href="#/secrets">{t("Manage secrets")}</a>
            </p>
          </div>
          <div className="field">
            <label htmlFor={`${id}-discord-cmd`}>
              {t("Slash command filter")} <span className="muted">{t("(optional)")}</span>
            </label>
            <input id={`${id}-discord-cmd`} value={trigger.config.commandName ?? ""} onChange={(e) => onChange({ type: "discord_message", config: { ...trigger.config, commandName: e.target.value || undefined } })} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-discord-channel`}>
              {t("Channel ID")} <span className="muted">{t("(optional)")}</span>
            </label>
            <input id={`${id}-discord-channel`} value={trigger.config.channelId ?? ""} onChange={(e) => onChange({ type: "discord_message", config: { ...trigger.config, channelId: e.target.value || undefined } })} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-discord-kw`}>
              {t("Keyword filter")} <span className="muted">{t("(optional)")}</span>
            </label>
            <input id={`${id}-discord-kw`} value={trigger.config.textContains ?? ""} onChange={(e) => onChange({ type: "discord_message", config: { ...trigger.config, textContains: e.target.value || undefined } })} />
          </div>
        </>
      )}
      {(trigger.type === "airtable_record" || trigger.type === "notion_page" || trigger.type === "trello_card") && <RecordTriggerSettings trigger={trigger} workflowId={wf.id} onChange={onChange} />}
      {trigger.type === "shopify_order" && (
        <p className="muted hint">
          {t("Runs for each new order in your Shopify store. The order number, customer, total and items are available as trigger fields.")}{" "}
          <a href="#/apps">{t("Connect Shopify in Apps")}</a>
        </p>
      )}
      {trigger.type === "telegram_message" && (
        <>
          <div className="field">
            <label htmlFor={`${id}-tg-from`}>{t("Messages from")}</label>
            <select id={`${id}-tg-from`} value={trigger.config.from} onChange={(e) => onChange({ type: "telegram_message", config: { ...trigger.config, from: e.target.value as "my_chat" | "anyone" } })}>
              <option value="my_chat">{t("My chat only (the chat chosen in Apps)")}</option>
              <option value="anyone">{t("Anyone who messages the bot")}</option>
            </select>
          </div>
          <div className="field">
            <label className="check">
              <input type="checkbox" checked={trigger.config.requireFile} onChange={(e) => onChange({ type: "telegram_message", config: { ...trigger.config, requireFile: e.target.checked } })} />{" "}
              {t("Only run when the message has a photo or PDF")}
            </label>
          </div>
          <p className="muted hint">
            {t("A photo or PDF up to 5 MB becomes the file field, which an AI step can read. To reply to the sender, set a Telegram step's chat id to the trigger's chatId.")}{" "}
            <a href="#/apps">{t("Connect Telegram in Apps and turn on Receive messages")}</a>
          </p>
        </>
      )}
      {trigger.type === "meta_dm" && (
        <>
          <div className="field">
            <label htmlFor={`${id}-meta-channel`}>{t("Channel")}</label>
            <select
              id={`${id}-meta-channel`}
              value={trigger.config.channel}
              onChange={(e) => onChange({ type: "meta_dm", config: { ...trigger.config, channel: e.target.value as "messenger" | "instagram" | "both" } })}
            >
              <option value="both">{t("Messenger and Instagram")}</option>
              <option value="messenger">{t("Facebook Messenger only")}</option>
              <option value="instagram">{t("Instagram DM only")}</option>
            </select>
          </div>
          <div className="field">
            <label className="check">
              <input
                type="checkbox"
                checked={trigger.config.requireImage}
                onChange={(e) => onChange({ type: "meta_dm", config: { ...trigger.config, requireImage: e.target.checked } })}
              />{" "}
              {t("Only run when the message includes a photo")}
            </label>
          </div>
          <p className="muted hint">
            <a href="#/apps">{t("Connect Facebook Messenger & Instagram in Apps")}</a>
          </p>
        </>
      )}
      {trigger.type === "whatsapp_message" && (
        <>
          <div className="field">
            <label className="check">
              <input
                type="checkbox"
                checked={trigger.config.requireImage}
                onChange={(e) => onChange({ type: "whatsapp_message", config: { ...trigger.config, requireImage: e.target.checked } })}
              />{" "}
              {t("Only run when the message includes a photo")}
            </label>
          </div>
          <p className="muted hint">
            {t("Requires a verified Meta Business account and payment method; Meta bills per delivered message.")}{" "}
            <a href="#/apps">{t("Connect WhatsApp Cloud API in Apps")}</a>
          </p>
        </>
      )}
      {trigger.type === "payment" && (
        <fieldset>
          <legend>{t("Run when a payment is")}</legend>
          {(["paid", "refunded"] as const).map((e) => (
            <label key={e}>
              <input
                type="checkbox"
                checked={trigger.config.events.includes(e)}
                onChange={(ev) => {
                  const events = ev.target.checked ? [...trigger.config.events, e] : trigger.config.events.filter((x) => x !== e);
                  if (events.length) onChange({ type: "payment", config: { events } });
                }}
              />{" "}
              {t(e)}
            </label>
          ))}
        </fieldset>
      )}
      {trigger.type === "booking_event" && (
        <fieldset>
          <legend>{t("Run when a booking is")}</legend>
          {(["created", "rescheduled", "cancelled"] as const).map((e) => (
            <label key={e}>
              <input
                type="checkbox"
                checked={trigger.config.events.includes(e)}
                onChange={(ev) => {
                  const events = ev.target.checked ? [...trigger.config.events, e] : trigger.config.events.filter((x) => x !== e);
                  if (events.length) onChange({ type: "booking_event", config: { events } });
                }}
              />{" "}
              {bookingLabels[e]}
            </label>
          ))}
        </fieldset>
      )}
      {trigger.type === "payment_event" && (
        <fieldset>
          <legend>{t("Run when a kymavo payment is")}</legend>
          {(["confirmed", "expired"] as const).map((e) => (
            <label key={e}>
              <input
                type="checkbox"
                checked={trigger.config.events.includes(e)}
                onChange={(ev) => {
                  const events = ev.target.checked ? [...trigger.config.events, e] : trigger.config.events.filter((x) => x !== e);
                  if (events.length) onChange({ type: "payment_event", config: { events } });
                }}
              />{" "}
              {paymentEventLabels[e]}
            </label>
          ))}
        </fieldset>
      )}
      {trigger.type === "sub_workflow" && (
        <p className="muted hint">
          {t("Starts when another automation calls this slug ({slug}) with a Call another automation step.", { slug: wf.slug })}
        </p>
      )}
      {trigger.type === "email" && <EmailSource workflowId={wf.id} published={wf.trigger?.type === "email" && !!wf.live} />}
      {trigger.type === "schedule" && (
        <div className="field">
          <label htmlFor={`${id}-cron`}>{t("Cron expression (UTC)")}</label>
          <input id={`${id}-cron`} value={trigger.config.cron} onChange={(e) => onChange({ type: "schedule", config: { cron: e.target.value } })} />
        </div>
      )}
      {trigger.type === "webhook" && (
        <>
          <div className="field">
            <label htmlFor={`${id}-hmac`}>
              {t("Signing secret name")} <span className="muted">{t("(optional)")}</span>
            </label>
            <input id={`${id}-hmac`} value={trigger.config.hmacSecret ?? ""} onChange={(e) => onChange({ type: "webhook", config: { ...trigger.config, hmacSecret: e.target.value || undefined, requireTimestamp: e.target.value ? (trigger.config.hmacSecret ? trigger.config.requireTimestamp : true) : undefined } })} />
            <p className="muted hint"><a href="#/secrets">{t("Manage secrets")}</a></p>
          </div>
          {trigger.config.hmacSecret && (
            <div className="field">
              <label>
                <input type="checkbox" checked={trigger.config.requireTimestamp === true} onChange={(e) => onChange({ type: "webhook", config: { ...trigger.config, requireTimestamp: e.target.checked || undefined } })} />{" "}
                {t("Require the timestamp (recommended)")}
              </label>
              <p className="muted hint">
                {t("The caller sends X-Daloy-Timestamp (unix seconds) and signs the timestamp, a dot and the body: X-Daloy-Signature: sha256=HMAC-SHA256 of \"timestamp.body\". Calls more than 5 minutes off are refused, so a captured call cannot be replayed later.")}
              </p>
              {wf.trigger?.legacySignatureAt && !trigger.config.requireTimestamp && (
                <p role="status" className="message error">
                  {t("A call signed without a timestamp was accepted on {date}. Update the caller, then turn this on.", { date: new Date(wf.trigger.legacySignatureAt).toLocaleString() })}
                </p>
              )}
            </div>
          )}
          <div className="field">
            <label htmlFor={`${id}-event-key`}>
              {t("Event key")} <span className="muted">{t("(optional, e.g. {example}: a repeated event starts no second run)", { example: "{{trigger.event_id}}" })}</span>
            </label>
            <input id={`${id}-event-key`} value={trigger.config.eventKey ?? ""} onChange={(e) => onChange({ type: "webhook", config: { ...trigger.config, eventKey: e.target.value || undefined } })} />
          </div>
        </>
      )}
      {(trigger.type === "form" || trigger.type === "sub_workflow") && (
        <fieldset>
          <legend>{t(trigger.type === "sub_workflow" ? "Expected inputs" : "Form fields")}</legend>
          {fields.map((f, i) => {
            const set = (patch: Partial<FormField>) => setFields(fields.map((g, j) => (j === i ? { ...g, ...patch } : g)));
            return (
              <div className="row" key={i}>
                <input aria-label={t("Field {number} name", { number: i + 1 })} value={f.name} onChange={(e) => set({ name: e.target.value })} />
                <input aria-label={t("Field {number} label", { number: i + 1 })} value={f.label} onChange={(e) => set({ label: e.target.value })} />
                {/* Number limits and datetime zones only exist on their own types, so changing the type drops them. */}
                <select
                  aria-label={t("Field {number} type", { number: i + 1 })}
                  value={f.type}
                  onChange={(e) => {
                    const type = e.target.value as FormField["type"];
                    set({ type, min: undefined, max: undefined, integer: undefined, slotMinutes: undefined, timezone: type === "datetime" ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined });
                  }}
                >
                  {(trigger.type === "sub_workflow" ? ["text", "email", "textarea", "number", "datetime", "resource"] : ["text", "email", "textarea", "number", "datetime", "resource", "file"]).map((kind) => (
                    <option key={kind} value={kind}>{t(kind)}</option>
                  ))}
                </select>
                <label className="check">
                  <input type="checkbox" checked={f.required} onChange={(e) => set({ required: e.target.checked })} /> {t("required")}
                </label>
                {f.type === "number" && (
                  <>
                    <input aria-label={t("Field {number} minimum", { number: i + 1 })} type="number" step="any" placeholder={t("min")} value={f.min ?? ""} onChange={(e) => set({ min: e.target.value === "" ? undefined : Number(e.target.value) })} />
                    <input aria-label={t("Field {number} maximum", { number: i + 1 })} type="number" step="any" placeholder={t("max")} value={f.max ?? ""} onChange={(e) => set({ max: e.target.value === "" ? undefined : Number(e.target.value) })} />
                    <label className="check">
                      <input type="checkbox" checked={f.integer ?? false} onChange={(e) => set({ integer: e.target.checked || undefined })} /> {t("whole number")}
                    </label>
                  </>
                )}
                {f.type === "datetime" && (
                  <>
                    <input aria-label={t("Field {number} timezone", { number: i + 1 })} placeholder="Asia/Manila" value={f.timezone ?? ""} onChange={(e) => set({ timezone: e.target.value })} />
                    <input aria-label={t("Field {number} slot minutes", { number: i + 1 })} type="number" min={1} max={1440} step={1} placeholder={t("slot minutes")} value={f.slotMinutes ?? ""} onChange={(e) => set({ slotMinutes: e.target.value === "" ? undefined : Number(e.target.value) })} />
                  </>
                )}
                {f.type === "resource" && <span className="muted">{t("a resource from the Resources page")}</span>}
                {f.type === "file" && <span className="muted">{t("photos or PDFs, up to 5 MB each, 3 per field")}</span>}
                <button type="button" className="quiet" onClick={() => setFields(fields.filter((_, j) => j !== i))} disabled={trigger.type === "form" && fields.length === 1}>
                  {t("Remove")}
                </button>
              </div>
            );
          })}
          <button type="button" className="quiet" onClick={() => setFields([...fields, { name: `field_${fields.length + 1}`, label: t("New field"), type: "text", required: false }])}>
            {t("Add field")}
          </button>
        </fieldset>
      )}
      {published?.webhookPath && (
        <p className="muted hint">
          {t("Webhook URL:")}{" "}
          <code>{`${location.origin}${trigger.type === "slack_message" ? "/hooks/slack/" : trigger.type === "teams_message" ? "/hooks/teams/" : trigger.type === "discord_message" ? "/hooks/discord/" : "/hooks/"}${newPath ?? published.webhookPath}`}</code>{" "}
          <button
            type="button"
            className="quiet"
            onClick={() =>
              window.confirm(t("The old URL stops working at once. Continue?")) &&
              api<{ webhookPath: string }>("POST", `/workflows/${wf.id}/webhook-url`).then((r) => setNewPath(r.webhookPath), (e: Error) => window.alert(e.message))
            }
          >
            {t("New URL")}
          </button>
        </p>
      )}
      {published && trigger.type === "form" && (
        <div className="actions">
          {t("Public form:")} <a href={`/forms/${published.id}`}>{`${location.origin}/forms/${published.id}`}</a>
          <FormEmbed link={`${location.origin}/forms/${published.id}`} />
        </div>
      )}
    </section>
  );
}

const OUTSIDE = new Set(["http", "email", "approval", "sheets", "drive", "slack", "outlook", "teams", "telegram", "sms", "calendar", "airtable", "notion", "trello", "meta_reply", "whatsapp_reply", "shopify_create_product", "shopify_update_product", "discord", "google_docs", "read_spreadsheet", "browser", "read_page"]);

/** Per-step outcomes for a mocked or AI-only test run: a classify label, an approval decision, or a failure. */
function TestChoices({ steps, choices, onChange }: { steps: Step[]; choices: Record<string, string>; onChange: (c: Record<string, string>) => void }) {
  const { t } = useLanguage();
  const options = (s: Step): [string, string][] => [
    ...(s.type === "ai" && s.config.task === "classify" ? Object.keys(s.config.labels ?? {}).map((l): [string, string] => [JSON.stringify({ label: l }), t("label {label}", { label: l })]) : []),
    ...(s.type === "approval" ? ["approved", "rejected", "timeout"].map((d): [string, string] => [JSON.stringify({ decision: d }), t(d)]) : []),
    ...(OUTSIDE.has(s.type) ? (["retryable", "permanent"] as const).map((f): [string, string] => [JSON.stringify({ fail: f }), t("fail ({kind})", { kind: t(f) })]) : []),
  ];
  const choosable = steps.filter((s) => options(s).length > 0);
  if (choosable.length === 0) return null;
  return (
    <fieldset>
      <legend>{t("Test outcomes")}</legend>
      {choosable.map((s) => (
        <div className="row" key={s.id}>
          <label htmlFor={`choice-${s.id}`}>{s.id}</label>
          <select id={`choice-${s.id}`} value={choices[s.id] ?? ""} onChange={(e) => onChange({ ...choices, [s.id]: e.target.value })}>
            <option value="">{t(s.type === "approval" ? "approved (default)" : s.type === "ai" ? "model or mock (default)" : "succeeds (default)")}</option>
            {options(s).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </div>
      ))}
    </fieldset>
  );
}
