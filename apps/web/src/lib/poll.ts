import { FINISHED } from "../api";

/** Time to the next poll of a run: quick while work moves, slow while a person must act, none once finished. */
export const pollDelay = (state: string): number | null => (FINISHED.has(state) ? null : state === "waiting" || state === "needs_review" ? 10_000 : 1000);

export const LONGER_MS = 60_000;
/** A run or request still Working more than 60 s after it started is probably stuck, not slow. */
export const takingLonger = (since: string, now = Date.now()) => now - new Date(since).getTime() > LONGER_MS;
