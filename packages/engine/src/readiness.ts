export type ReadinessKind =
  | "connect"
  | "operator"
  | "resource"
  | "knowledge"
  | "secret"
  | "approver"
  | "email_source"
  | "config";

export type ReadinessBlocker = {
  id: string;
  kind: ReadinessKind;
  severity: "blocker" | "warning";
  app?: string;
  what?: string;
  stepId?: string;
  text: string;
  fix?: string;
};

export type ReadinessReport = {
  ready: boolean;
  blockers: ReadinessBlocker[];
  warnings: ReadinessBlocker[];
};

export type TemplateReadiness = ReadinessReport & {
  slug: string;
};
