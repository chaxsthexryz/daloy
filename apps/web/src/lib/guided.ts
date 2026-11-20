import { takingLonger } from "./poll";

/** Where each step of a guided setup stands, for the "Setup steps" list beside the form. */
export type StepState = "complete" | "current" | "upcoming";

export const stepStates = (count: number, index: number): StepState[] =>
  Array.from({ length: count }, (_, i) => (i < index ? "complete" : i === index ? "current" : "upcoming"));

type RequestLike = { runState: string; createdAt: string };

/** What the live page says about one request. "slow" is work still going after 60 seconds. */
export type RequestKind = "done" | "failed" | "waiting" | "sending" | "slow";

export const requestKind = (r: RequestLike, now = Date.now()): RequestKind =>
  r.runState === "succeeded" ? "done" : r.runState === "failed" ? "failed" : r.runState === "waiting" ? "waiting" : takingLonger(r.createdAt, now) ? "slow" : "sending";

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** The three figures above the request list. "Today" is the viewer's calendar day. */
export const requestCounts = (rows: RequestLike[], now = Date.now()) => ({
  today: rows.filter((r) => sameDay(new Date(r.createdAt), new Date(now))).length,
  waiting: rows.filter((r) => r.runState === "waiting").length,
  completed: rows.filter((r) => r.runState === "succeeded").length,
});

/** A delivery that failed or waits for a person's check makes the request need attention, whatever its run says. */
export const needsAttention = (deliveries: { state: string }[]) => deliveries.some((d) => d.state === "failed" || d.state === "needs_review");
