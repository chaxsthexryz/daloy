/** Where each step of a guided setup stands, for the "Setup steps" list beside the form. */
export type StepState = "complete" | "current" | "upcoming";

export const stepStates = (count: number, index: number): StepState[] =>
  Array.from({ length: count }, (_, i) => (i < index ? "complete" : i === index ? "current" : "upcoming"));
