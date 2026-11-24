import { parentPort, workerData } from "node:worker_threads";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// Runs in its own thread so a hostile PDF can be stopped by terminate() and cannot exhaust the worker's memory.
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_MAX_CHARS = 50_000;

const raw = workerData instanceof Uint8Array || ArrayBuffer.isView(workerData) ? workerData : workerData?.data;
const maxPages = Number.isInteger(workerData?.maxPages) && workerData.maxPages > 0 ? workerData.maxPages : DEFAULT_MAX_PAGES;
const maxChars = Number.isInteger(workerData?.maxChars) && workerData.maxChars > 0 ? workerData.maxChars : DEFAULT_MAX_CHARS;

let pdf;
try {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  pdf = await getDocument({ data: bytes, disableFontFace: true, useSystemFonts: false, isOffscreenCanvasSupported: false, verbosity: 0 }).promise;
  const pages = [];
  let totalChars = 0;
  let truncatedByChars = false;
  for (let n = 1; n <= Math.min(pdf.numPages, maxPages); n++) {
    const page = await pdf.getPage(n);
    try {
      const content = await page.getTextContent();
      let pageText = "";
      for (const item of content.items) {
        const piece = item.str ?? "";
        if (!piece) continue;
        const remaining = maxChars - totalChars;
        if (remaining <= 0) {
          truncatedByChars = true;
          break;
        }
        if (piece.length > remaining) {
          pageText += piece.slice(0, remaining);
          totalChars += remaining;
          truncatedByChars = true;
          break;
        }
        pageText += piece;
        totalChars += piece.length;
      }
      pages.push(pageText);
    } finally {
      page.cleanup?.();
    }
    if (truncatedByChars) break;
  }
  parentPort.postMessage({ text: pages.join("\n"), pages: pdf.numPages, truncatedByChars });
} catch {
  parentPort.postMessage({ error: true });
} finally {
  await pdf?.destroy?.().catch(() => {});
}
