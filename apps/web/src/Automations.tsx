import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { WorkflowDefinition } from "@daloy/engine";
import { useLanguage } from "./Language";
import { api, getUsage, type RunSummary, type Usage, type Workflow } from "./api";
import { draftPlan } from "./lib/ai-build";
import { arrange, counts, displayStatus, statusOf, triggerLabel, withTrigger, type Filter } from "./lib/automations";
import { useCountUp, useSlidingPill } from "./lib/motion";
import { RUN_LIMIT, successRate, totals, type OverviewEntry } from "./lib/ops-stats";
import { ago, plainState } from "./lib/states";
import { FormEmbed } from "./FormEmbed";
import { OnboardingPrompt } from "./Onboarding";
import type { User } from "./Team";
import "./automations-ops.css";

const STATUS_FILTERS: [Filter, string][] = [
  ["all", "Any"],
  ["needs_you", "Needs you"],
  ["problem", "Problem"],
  ["waiting", "Waiting"],
  ["on", "On"],
  ["paused", "Paused"],
  ["off", "Off"],
  ["draft", "Draft"],
];

const SEG_FILTERS: [Filter, string][] = [
  ["all", "All"],
  ["needs_you", "Needs you"],
  ["problem", "Problem"],
  ["on", "On"],
  ["paused", "Paused"],
  ["draft", "Draft"],
];

/** What GET /workflows/:id adds to a list row: the trigger, the published version and the newest version. */
type Detail = {
  trigger: { type: string } | null;
  live: { version: number; createdAt: string; definition: WorkflowDefinition } | null;
  latest: { version: number; definition: WorkflowDefinition } | null;
};

type UndoToast = { id: string; name: string; paused: boolean };

const PANEL_STEPS = 6;
const TOAST_MS = 6000;

/** Home: the ops table. One row per automation, animated KPI counts above it and the selected one's inspector beside it. */
export function Automations({ user }: { user: User }) {
  const { t } = useLanguage();
  const owner = user.role === "owner";
  const [list, setList] = useState<Workflow[] | null>(null);
  const [listError, setListError] = useState(false);
  const [overview, setOverview] = useState<Record<string, OverviewEntry> | null | undefined>(undefined);
  // The selected automation's newest runs, for its panel. Undefined while loading, null when the call failed.
  const [recent, setRecent] = useState<RunSummary[] | null | undefined>(undefined);
  const [review, setReview] = useState<RunSummary[] | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [details, setDetails] = useState<Record<string, Detail | null>>({});
  const [copied, setCopied] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [trigger, setTrigger] = useState("any");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [toast, setToast] = useState<UndoToast | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const segPill = useSlidingPill<HTMLDivElement>();

  const load = () => {
    api<Workflow[]>("GET", "/workflows").then(
      (l) => {
        setListError(false);
        setList(l);
      },
      () => setListError(true),
    );
    // The figures around the table are best effort: a failure leaves that figure out instead of blocking the page.
    // Counts come from the server for every automation and every run, in the viewer's own time zone.
    const tz = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone);
    api<OverviewEntry[]>("GET", `/workflows/overview?tz=${tz}`).then(
      (o) => setOverview(Object.fromEntries(o.map((e) => [e.id, e]))),
      () => setOverview(null),
    );
    api<RunSummary[]>("GET", "/runs?review=true").then(setReview, () => setReview(null));
    getUsage().then(setUsage, () => setUsage(null));
  };
  useEffect(load, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const all = list ?? [];
  const now = Date.now();
  const total = counts(all);
  const typeOf = useMemo(() => Object.fromEntries(Object.entries(overview ?? {}).flatMap(([id, o]) => (o.trigger ? [[id, o.trigger]] : []))) as Record<string, string>, [overview]);
  const triggerTypes = [...new Set(Object.values(typeOf))].sort();
  const shown = withTrigger(arrange(all, query, filter).shown, trigger, typeOf);
  // Nothing is selected on load: the panel stays closed until a row is clicked.
  const selected = shown.find((w) => w.id === selectedId) ?? null;
  const stats = overview ? totals(Object.values(overview).map((o) => o.runs)) : null;
  const reviewOf = (id: string) => (review ?? []).filter((r) => r.workflowId === id);

  const todayCount = useCountUp(stats ? stats.today : 0);
  const needsYouNum = review ? review.length : total.needs_you;
  const needsYouCount = useCountUp(needsYouNum);
  const problemsCount = useCountUp(total.problem);
  const liveCount = useCountUp(usage ? usage.automations.live : 0);

  // The steps and versions of the selected automation, and its newest runs, load when it is selected and again after a change.
  const selectedKey = selected?.id;
  useEffect(() => {
    if (!selectedKey) return;
    let current = true;
    setRecent(undefined);
    api<Detail>("GET", `/workflows/${selectedKey}`).then(
      (d) => current && setDetails((prev) => ({ ...prev, [selectedKey]: d })),
      () => current && setDetails((prev) => ({ ...prev, [selectedKey]: null })),
    );
    api<RunSummary[]>("GET", `/runs?workflowId=${selectedKey}&test=false`).then(
      (r) => current && setRecent(r),
      () => current && setRecent(null),
    );
    return () => {
      current = false;
    };
  }, [selectedKey, list]);
  const filtered = query.trim() !== "" || filter !== "all" || trigger !== "any";

  const copy = (id: string, formId: string) => {
    const link = `${location.origin}/forms/${formId}`;
    navigator.clipboard.writeText(link).then(
      () => setCopied(t("Form link copied for {name}.", { name: list?.find((w) => w.id === id)?.name ?? t("this automation") })),
      () => setCopied(t("Copy this link: {link}", { link })),
    );
  };

  const setPaused = async (w: Workflow, paused: boolean, showToast = false) => {
    setError("");
    try {
      await api("POST", `/workflows/${w.id}/${paused ? "pause" : "resume"}`);
      load();
      if (showToast) setToast({ id: w.id, name: w.name, paused });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (w: Workflow) => {
    if (!window.confirm(t("Delete the draft {name}? This cannot be undone.", { name: `"${w.name}"` }))) return;
    setError("");
    try {
      await api("DELETE", `/workflows/${w.id}`);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const pick = (w: Workflow, from: HTMLElement | null) => {
    setSelectedId(w.id);
    // On a phone the details open as a sheet over the list; on a desktop they are always beside it.
    if (matchMedia("(max-width: 799.98px)").matches) {
      opener.current = from;
      setSheet(true);
    }
  };
  const closeSheet = () => {
    setSheet(false);
    setSelectedId(null);
  };
  // The list is inert while the sheet is open, so focus goes back to the row only after that has rendered.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (sheet) closeButton.current?.focus();
    else if (wasOpen.current) opener.current?.focus();
    wasOpen.current = sheet;
  }, [sheet]);
  useEffect(() => {
    if (!selectedKey) return;
    const onKey = (e: KeyboardEvent) => {
      // Escape in a field keeps its own meaning (clearing a search); the sheet is modal, so it always closes.
      if (e.key === "Escape" && (sheet || !(e.target instanceof HTMLElement && e.target.closest("input, select, textarea")))) closeSheet();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sheet, selectedKey]);

  const clear = () => {
    setQuery("");
    setFilter("all");
    setTrigger("any");
  };
  const percent = (n: number) => `${(n * 100).toFixed(1)}%`;

  const needsYou = review && review.length >= RUN_LIMIT ? `${RUN_LIMIT}+` : String(needsYouCount);

  const head = (
    <header className="ops-head">
      <div className="ops-title">
        <h1>{t("Automations")}</h1>
        {list && !listError && <span className="tnum">{t("{count} total", { count: list.length })}</span>}
      </div>
      {owner && (
        <div className="ops-actions">
          <a className="ops-button" href="#/ai">{t("Build with AI")}</a>
          <a className="ops-button dark" href="#/new">{t("New automation")}</a>
        </div>
      )}
    </header>
  );

  return (
    <main className="page ops">
      {owner && <OnboardingPrompt />}
      {!(list && list.length > 0 && !listError) && head}

      {listError && (
        <p role="alert" className="ops-alert error">
          {t("Couldn't load your automations.")} <button type="button" onClick={load}>{t("Retry")}</button>
        </p>
      )}
      {list === null ? (
        listError ? null : <p className="ops-muted">{t("Loading…")}</p>
      ) : list.length === 0 ? (
        <p className="ops-muted">{owner ? <>{t("No automations yet.")} <a href="#/new">{t("Add your first one")}</a>.</> : t("No automations yet.")}</p>
      ) : (
        <div className="ops-layout" data-panel={selected ? "open" : "closed"}>
          <div className="ops-main" inert={sheet}>
            {head}
            <section className="ops-kpis" aria-label={t("Overview")}>
              <div>
                <span>{t("Runs today")}</span>
                <b className="tnum">{stats ? todayCount : t("n/a")}</b>
              </div>
              <div>
                <span>{t("Success, 7 days")}</span>
                <b className="tnum">{stats ? (stats.rate === null ? t("n/a") : percent(stats.rate)) : t("n/a")}</b>
              </div>
              <button type="button" className="needs" aria-pressed={filter === "needs_you"} onClick={() => setFilter(filter === "needs_you" ? "all" : "needs_you")}>
                <span>{t("Needs you")}</span>
                <b className="tnum">{needsYou}</b>
              </button>
              <button type="button" className="problems" aria-pressed={filter === "problem"} onClick={() => setFilter(filter === "problem" ? "all" : "problem")}>
                <span>{t("Problems")}</span>
                <b className="tnum">{problemsCount}</b>
              </button>
              {usage && (
                <div>
                  <span>{t("Live automations")}</span>
                  <b className="tnum">{liveCount} {usage.automations.limit !== null && <i>{t("of {limit}", { limit: usage.automations.limit })}</i>}</b>
                </div>
              )}
            </section>

            {review && review.length > 0 && (
              <p role="status" className="ops-alert attn">
                <strong>{review.length >= RUN_LIMIT ? t("50 or more") : review.length}</strong> {t(review.length === 1 ? "request needs you." : "requests need you.")}{" "}
                <a href={`#/runs/${review[review.length - 1]!.id}`}>{t("Open the oldest")}</a>
              </p>
            )}
            <p role="status" className="ops-muted" hidden={!copied}>{copied}</p>
            <p role="alert" className="ops-alert error" hidden={!error}>{error}</p>

            <div className="ops-seg-row">
              <div
                ref={segPill.containerRef}
                className="ops-seg"
                role="group"
                aria-label={t("Filter by status")}
                onPointerLeave={segPill.onContainerLeave}
              >
                <span
                  className="ops-seg-pill motion-pill"
                  aria-hidden="true"
                  style={{
                    transform: `translate3d(${segPill.pillStyle.left}px, ${segPill.pillStyle.top}px, 0)`,
                    width: `${segPill.pillStyle.width}px`,
                    height: `${segPill.pillStyle.height}px`,
                    opacity: segPill.pillStyle.opacity,
                  }}
                />
                {SEG_FILTERS.map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className="ops-seg-btn"
                    aria-pressed={filter === key}
                    onPointerEnter={(e) => segPill.onItemEnter(e.currentTarget)}
                    onFocus={(e) => segPill.onItemEnter(e.currentTarget)}
                    onClick={() => setFilter(key)}
                  >
                    {t(label)}
                  </button>
                ))}
              </div>
            </div>

            <div className="ops-filters">
              <label className="ops-search" data-active={query.trim() ? "true" : undefined}>
                <span className="ops-sr">{t("Find an automation")}</span>
                <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="m11 11 3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                <input type="search" value={query} placeholder={t("Search")} onChange={(e) => setQuery(e.target.value)} />
              </label>
              <label className="ops-select">
                <span>{t("Status:")}</span>
                <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
                  {STATUS_FILTERS.map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}
                </select>
              </label>
              <label className="ops-select">
                <span>{t("Trigger:")}</span>
                <select value={trigger} onChange={(e) => setTrigger(e.target.value)}>
                  <option value="any">{t("Any")}</option>
                  {triggerTypes.map((type) => <option key={type} value={type}>{t(triggerLabel(type))}</option>)}
                  {trigger !== "any" && !triggerTypes.includes(trigger) && <option value={trigger}>{t(triggerLabel(trigger))}</option>}
                </select>
              </label>
              {filtered && <button type="button" className="ops-link" onClick={clear}>{t("Clear filters")}</button>}
            </div>

            <table className="ops-table">
              <thead>
                <tr>
                  <th scope="col" className="c-dot"><span className="ops-sr">{t("Status")}</span></th>
                  <th scope="col">{t("Name")}</th>
                  <th scope="col" className="c-trigger">{t("Trigger")}</th>
                  <th scope="col" className="c-bars">{t("7 days")}</th>
                  <th scope="col" className="c-rate">{t("Success")}</th>
                  <th scope="col" className="c-last">{t("Last run")}</th>
                  <th scope="col" className="c-toggle"><span className="ops-sr">{t("Active")}</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr><td colSpan={7} className="ops-empty">{t("None match.")}</td></tr>
                ) : (
                  shown.map((w, index) => (
                    <Row
                      key={w.id}
                      w={w}
                      index={index}
                      owner={owner}
                      selected={selected?.id === w.id}
                      reviewCount={reviewOf(w.id).length}
                      entry={overview?.[w.id]}
                      loading={overview === undefined}
                      now={now}
                      onPick={pick}
                      onTogglePause={(target, paused) => void setPaused(target, paused, true)}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>

          {selected && (
            <>
              {sheet && <div className="ops-backdrop" onClick={closeSheet} aria-hidden="true" />}
              <Panel
                key={selected.id}
                w={selected}
                owner={owner}
                detail={details[selected.id]}
                entry={overview?.[selected.id]}
                runs={recent}
                review={reviewOf(selected.id)}
                now={now}
                sheet={sheet}
                closeRef={closeButton}
                onClose={closeSheet}
                onCopy={copy}
                onPause={(target, paused) => void setPaused(target, paused, false)}
                onDelete={remove}
              />
            </>
          )}
        </div>
      )}

      {toast && (
        <div role="status" className="ops-toast motion-toast">
          <span>{t(toast.paused ? "Paused {name}." : "Resumed {name}.", { name: toast.name })}</span>
          <button
            type="button"
            className="ops-toast-undo"
            onClick={() => {
              const target = list?.find((item) => item.id === toast.id);
              const resumeTo = !toast.paused;
              setToast(null);
              if (target) void setPaused(target, resumeTo, false);
              else void api("POST", `/workflows/${toast.id}/${resumeTo ? "pause" : "resume"}`).then(load, (e) => setError((e as Error).message));
            }}
          >
            {t("Undo")}
          </button>
          <button type="button" className="ops-toast-close" aria-label={t("Dismiss")} onClick={() => setToast(null)}>×</button>
          <i className="ops-toast-bar" aria-hidden="true" />
        </div>
      )}
    </main>
  );
}

function Row({ w, index, owner, selected, reviewCount, entry, loading, now, onPick, onTogglePause }: {
  w: Workflow;
  index: number;
  owner: boolean;
  selected: boolean;
  reviewCount: number;
  entry: OverviewEntry | undefined;
  loading: boolean;
  now: number;
  onPick: (w: Workflow, from: HTMLElement | null) => void;
  onTogglePause: (w: Workflow, paused: boolean) => void;
}) {
  const { t, language } = useLanguage();
  const status = statusOf(w);
  const badge = displayStatus(w, reviewCount);
  const state = w.last ? plainState(w.last, now) : null;
  const bars = entry?.runs.days ?? null;
  const weekTotal = entry?.runs.week ?? 0;
  const rate = entry ? successRate(entry.runs) : null;
  const peak = Math.max(1, ...(bars ?? []).map((b) => b.total));

  const note =
    reviewCount > 0
      ? { text: t(reviewCount === 1 ? "1 request needs you" : "{count} requests need you", { count: reviewCount }), kind: "needs" }
      : status === "paused"
        ? { text: t("Paused on {date}", { date: new Date(w.pausedAt!).toLocaleDateString(language === "tl" ? "fil-PH" : "en", { month: "short", day: "numeric" }) }), kind: "paused" }
        : status === "draft"
          ? { text: t("Draft, setup not finished"), kind: "" }
          : status === "off"
            ? { text: t(w.last ? "Off" : "Off, set up, never turned on"), kind: "" }
            : w.scheduleMissedAt
              ? { text: t("Missed its schedule"), kind: "problem" }
              : state && state.key !== "done"
                ? { text: t(state.note ?? state.label), kind: state.key === "problem" ? "problem" : state.key === "needs_you" ? "needs" : "" }
                : null;

  return (
    <tr
      className="ops-row motion-stagger-row"
      style={{ "--row-index": Math.min(index, 12) } as CSSProperties}
      data-selected={selected || undefined}
      onDoubleClick={() => { location.hash = `#/w/${w.id}`; }}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest("button, a")) onPick(w, e.currentTarget.querySelector(".c-name button"));
      }}
    >
      <td className="c-dot"><i className={`dot ${badge.tone}`} aria-hidden="true" /></td>
      <th scope="row" className="c-name">
        <div className="ops-name-cell">
          <button
            type="button"
            aria-current={selected ? "true" : undefined}
            onClick={(e) => onPick(w, e.currentTarget)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.shiftKey) {
                e.preventDefault();
                location.hash = `#/w/${w.id}`;
              }
            }}
          >{w.name}</button>
          <a className="ops-sr" href={`#/w/${w.id}`}>{t("Steps of {name}", { name: w.name })}</a>
          {note && <span className={`sub ${note.kind}`}>{note.text}</span>}
        </div>
      </th>
      <td className="c-trigger">{loading ? "…" : entry?.trigger ? t(triggerLabel(entry.trigger)) : <span className="dash">-</span>}</td>
      <td className="c-bars">
        {bars === null ? t("n/a") : weekTotal === 0 ? <span className="ops-muted">{t(w.last ? "No runs this week" : "No runs")}</span> : (
          <span className="bars" role="img" aria-label={t("{count} runs in the last 7 days", { count: weekTotal })}>
            {bars.map((b, i) => (
              <i
                key={i}
                className={["motion-spark-bar", b.failed ? "bad" : b.total === 0 ? "none" : ""].filter(Boolean).join(" ")}
                style={{ height: b.total === 0 ? 2 : 4 + Math.round((b.total / peak) * 20), "--bar-index": i } as CSSProperties}
              />
            ))}
          </span>
        )}
      </td>
      <td className="c-rate tnum">{rate === null ? <span className="ops-muted">{t("n/a")}</span> : `${Math.round(rate * 100)}%`}</td>
      <td className="c-last">{w.last ? <time dateTime={w.last.createdAt}>{ago(w.last.createdAt, now, language)}</time> : <span className="ops-muted">{t("Never")}</span>}</td>
      <td className="c-toggle">
        {owner && w.live && (
          <button
            type="button"
            role="switch"
            aria-checked={!w.pausedAt}
            aria-label={t(w.pausedAt ? "Resume {name}" : "Pause {name}", { name: w.name })}
            className="ops-switch motion-switch"
            onClick={(e) => {
              e.stopPropagation();
              onTogglePause(w, !w.pausedAt);
            }}
          >
            <i className="ops-switch-thumb" aria-hidden="true" />
          </button>
        )}
      </td>
    </tr>
  );
}

function Panel({ w, owner, detail, entry, runs, review, now, sheet, closeRef, onClose, onCopy, onPause, onDelete }: {
  w: Workflow;
  owner: boolean;
  detail: Detail | null | undefined;
  entry: OverviewEntry | undefined;
  runs: RunSummary[] | null | undefined;
  review: RunSummary[];
  now: number;
  sheet: boolean;
  closeRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onCopy: (id: string, formId: string) => void;
  onPause: (w: Workflow, paused: boolean) => void;
  onDelete: (w: Workflow) => void;
}) {
  const { t, language } = useLanguage();
  const status = statusOf(w);
  const badge = displayStatus(w, review.length);
  const guided = !!w.setup;
  const oldest = review[review.length - 1];
  const date = (iso: string) => new Date(iso).toLocaleDateString(language === "tl" ? "fil-PH" : "en", { month: "short", day: "numeric" });
  const primary =
    status === "draft"
      ? { href: `#/a/${w.id}`, label: t("Continue setup") }
      : oldest
        ? { href: `#/runs/${oldest.id}`, label: t(review.length === 1 ? "Review 1 request" : "Review {count} requests", { count: review.length }) }
        : guided
          ? { href: `#/a/${w.id}`, label: t("Open") }
          : { href: `#/w/${w.id}`, label: t("Open steps") };
  const editable = owner && status !== "draft" && primary.href !== `#/w/${w.id}`;
  const definition = detail?.live?.definition ?? detail?.latest?.definition;
  const plan = (() => {
    try {
      return definition ? draftPlan(definition, language) : null;
    } catch {
      return null;
    }
  })();
  const mine = runs ?? [];

  return (
    <aside className="ops-panel motion-sheet" aria-labelledby="ops-panel-title" data-sheet={sheet || undefined} role={sheet ? "dialog" : undefined} aria-modal={sheet || undefined}>
      <div className="panel-top">
        <span className={`panel-status ${badge.tone}`}><i className="dot" aria-hidden="true" />{t(badge.label)}</span>
        <span className="panel-version">
          {detail?.live ? t("v{version} · published {date}", { version: detail.live.version, date: date(detail.live.createdAt) }) : detail?.latest ? t("v{version} · not published", { version: detail.latest.version }) : ""}
        </span>
        <button type="button" className="panel-close" ref={closeRef} onClick={onClose}>{t("Close")}</button>
      </div>
      <h2 id="ops-panel-title">{w.name}</h2>
      {w.pausedAt && <p className="panel-note">{t("Paused: it starts no new runs from a form, link, email or schedule. Runs already started finish.")}</p>}

      <div className="panel-actions">
        <a className="ops-button blue" href={primary.href}>{primary.label}</a>
        {editable && <a className="ops-button" href={`#/w/${w.id}`}>{t("Edit")}</a>}
        {owner && w.live && <button type="button" className="ops-button" onClick={() => onPause(w, !w.pausedAt)}>{t(w.pausedAt ? "Resume" : "Pause")}</button>}
        {owner && status === "draft" && <button type="button" className="ops-button danger" onClick={() => onDelete(w)}>{t("Delete")}</button>}
      </div>

      {plan && plan.rows.length > 0 && (
        <section className="panel-card">
          <h3>{t("How it runs")}</h3>
          <p className="panel-when">{plan.when}</p>
          <ol>
            {plan.rows.slice(0, PANEL_STEPS).map((r, i) => <li key={r.step.id}><b aria-hidden="true">{i + 1}</b><span>{r.action}</span></li>)}
          </ol>
          {plan.rows.length > PANEL_STEPS && <a href={`#/w/${w.id}`}>{t("{count} more steps", { count: plan.rows.length - PANEL_STEPS })}</a>}
        </section>
      )}

      <section className="panel-runs">
        <div className="panel-runs-head">
          <h3>{t("Recent runs")}</h3>
          <a href={`#/w/${w.id}/runs`}>{t("View all")}</a>
        </div>
        {runs === undefined ? (
          <p className="ops-muted">…</p>
        ) : runs === null ? (
          <p className="ops-muted">{t("Runs could not be loaded.")}</p>
        ) : mine.length === 0 ? (
          <p className="ops-muted">{t("No activity yet")}</p>
        ) : (
          <ul>
            {mine.slice(0, 4).map((r) => {
              const s = plainState(r, now);
              return (
                <li key={r.id}>
                  <a href={`#/runs/${r.id}`}>
                    <span className={`run-state ${s.key}`}>{t(s.label)}</span>
                    <span className="run-name">{r.reference ?? date(r.createdAt)}</span>
                    <time dateTime={r.createdAt}>{ago(r.createdAt, now, language)}</time>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <dl className="panel-facts">
        <div><dt>{t("Runs in 7 days")}</dt><dd className="tnum">{entry ? entry.runs.week : t("n/a")}</dd></div>
        {w.live && w.formId && (
          <div className="panel-form">
            <dt>{t("Public form")}</dt>
            <dd>
              <button type="button" className="ops-link" onClick={() => onCopy(w.id, w.formId!)}>{t("Copy form link")}</button>
              <FormEmbed link={`${location.origin}/forms/${w.formId}`} />
            </dd>
          </div>
        )}
      </dl>
    </aside>
  );
}
