import transitions from "./transitions.json";

export type Kind = keyof typeof transitions;
export type RunState = keyof typeof transitions.run;
export type StepState = keyof typeof transitions.step;

// The database enums are built from these, so the transition table stays the single source of states.
export const RUN_STATES = Object.keys(transitions.run) as [RunState, ...RunState[]];
export const STEP_STATES = Object.keys(transitions.step) as [StepState, ...StepState[]];

export class IllegalTransitionError extends Error {
  override name = "IllegalTransitionError";
  constructor(
    readonly kind: Kind,
    readonly from: string,
    readonly to: string,
  ) {
    super(`Illegal ${kind} transition: ${from} -> ${to}`);
  }
}

// Takes plain strings because states come back from the database untyped.
export function canTransition(kind: Kind, from: string, to: string): boolean {
  const table: Record<string, string[]> = transitions[kind];
  return Object.hasOwn(table, from) && table[from]!.includes(to);
}

export function assertTransition(kind: Kind, from: string, to: string): void {
  if (!canTransition(kind, from, to)) throw new IllegalTransitionError(kind, from, to);
}
