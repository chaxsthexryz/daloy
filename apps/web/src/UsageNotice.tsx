import type { Usage } from "./api";
import { usageLines } from "./lib/usage";

/** Quiet lines about limits that are close or used up. Shows nothing while every count is below 80%. */
export function UsageNotice({ usage }: { usage: Usage }) {
  const lines = usageLines(usage);
  if (lines.length === 0) return null;
  return (
    <div className="notice">
      {lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
    </div>
  );
}
