import "@xyflow/react/dist/style.css";
import "../styles.css";
import "./demo.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Demo } from "./Demo";

// Light only, like the public site: no theme script and no saved choice.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
