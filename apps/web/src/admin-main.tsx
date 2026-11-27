import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AdminApp } from "./Admin";
import { followSystemTheme } from "./lib/theme";

// The platform admin console, its own page at /admin (decision 0152).
followSystemTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AdminApp />
  </StrictMode>,
);
