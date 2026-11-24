import "@xyflow/react/dist/style.css";
import "./styles.css";
import { createErrorReporter } from "@daloy/engine";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { followSystemTheme } from "./lib/theme";

const reporter = createErrorReporter({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  service: "web",
  environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
});
if (reporter.enabled) {
  window.addEventListener("error", (ev) => { void reporter.capture(ev.error ?? ev.message, { tags: { kind: "window.error" } }); });
  window.addEventListener("unhandledrejection", (ev) => { void reporter.capture(ev.reason, { tags: { kind: "unhandledrejection" } }); });
}

followSystemTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
