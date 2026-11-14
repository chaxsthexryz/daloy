/**
 * Acceptance fixtures for the eight QA workflows of the fec03cc business report (QA-01 to QA-08).
 * Each fixture is a hand-written definition modelled on the saved v2 draft, never read from the development database.
 *
 * A run case states what the business wants. When today's engine does something else, the case carries a `gap`
 * with the phase that will fix it and what happens today. The harness asserts today's outcome for a gap, so a gap
 * only counts when that exact wrong outcome is observed: an unrelated error, a fixture that fails to load, or a
 * phase that changes the behaviour makes the test fail until the expectation is flipped.
 */

/** Step ids in the order they succeeded. A step whose last attempt failed and ended the run is written "<id>:failed". */
export type Path = string[];
/** The test run is refused at the boundary (HTTP 400) and no run starts. */
export const REJECTED = "rejected" as const;
export type Outcome = Path | typeof REJECTED;

export type Phase = "P2" | "P3" | "P4" | "P5" | "P6a" | "P6b" | "P7";

export type RunCase = {
  name: string;
  payload: Record<string, unknown>;
  /** Test-run options that later phases add (P3). Today's API drops unknown keys, so these change nothing yet. */
  options?: { choices?: Record<string, unknown>; mode?: "mock" | "ai" | "live" };
  want: Outcome;
  gap?: { phase: Phase; today: Outcome; why: string };
};

export type Scenario = { id: string; name: string; definition: Record<string, unknown>; cases: RunCase[] };

export const email = (id: string, to: string, subject: string) => ({ id, type: "email", config: { to, subject, text: `${subject}\n\n{{trigger}}` } });
export const condition = (id: string, left: string, op: string, right?: string | number) => ({ id, type: "condition", config: { condition: { left, op, ...(right === undefined ? {} : { right }) } } });
export const approval = (id: string, subject: string) => ({ id, type: "approval", config: { to: "manager@example.com", subject, message: `${subject}\n\n{{trigger}}`, timeoutSeconds: 86_400 } });
export const sheets = (id: string, ...columns: string[]) => ({ id, type: "sheets", config: { columns } });
export const edge = (from: string, to: string, on?: string) => ({ from, to, ...(on ? { on } : {}) });
