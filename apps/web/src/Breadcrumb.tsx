import type { CSSProperties } from "react";
import { useLanguage } from "./Language";
import "./breadcrumb.css";

export type BreadcrumbEntry = {
  label: string;
  href?: string;
};

/**
 * SmoothUI-inspired animated breadcrumb (`smoothui.dev/docs/components/breadcrumb`)
 * with Tabler chevron separators and subtle staggered entrance.
 */
export function Breadcrumb({ items }: { items: BreadcrumbEntry[] }) {
  const { t } = useLanguage();
  if (!items.length) return null;
  return (
    <nav className="smooth-bc" aria-label={t("Breadcrumb")}>
      <ol className="smooth-bc-list">
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          return (
            <li
              key={`${i}-${item.label}`}
              className="smooth-bc-item"
              style={{ "--bc-index": i } as CSSProperties}
            >
              {i > 0 && (
                <svg
                  className="smooth-bc-sep"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M9 6l6 6l-6 6" />
                </svg>
              )}
              {item.href && !isLast ? (
                <a className="smooth-bc-link" href={item.href}>
                  {item.label}
                </a>
              ) : (
                <span className="smooth-bc-current" aria-current={isLast ? "page" : undefined}>
                  {item.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
