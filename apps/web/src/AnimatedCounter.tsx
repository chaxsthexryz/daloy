import type { CSSProperties } from "react";

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

/**
 * RareUI-inspired odometer digit counter (`swamimalode07/rare-ui/animated-counter`).
 * Renders fixed-width vertical 0..9 digit reels so numbers transition smoothly without horizontal jitter.
 */
export function AnimatedCounter({ value, className }: { value: number | string; className?: string }) {
  const chars = String(value).split("");
  return (
    <span className={className ? `rare-counter ${className}` : "rare-counter"} data-slot="animated-counter">
      {chars.map((ch, idx) =>
        ch >= "0" && ch <= "9" ? (
          <span key={`${idx}-d`} className="rare-digit" data-slot="animated-counter-digit" aria-hidden="true">
            <span
              className="rare-reel"
              style={{ transform: `translateY(-${Number(ch) * 10}%)` } as CSSProperties}
            >
              {DIGITS.map((d) => (
                <span key={d}>{d}</span>
              ))}
            </span>
          </span>
        ) : (
          <span key={`${idx}-m`} className="rare-mark" data-slot="animated-counter-mark" aria-hidden="true">
            {ch}
          </span>
        ),
      )}
      <span className="ops-sr">{String(value)}</span>
    </span>
  );
}
