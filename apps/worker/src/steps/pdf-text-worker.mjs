import { parentPort, workerData } from "node:worker_threads";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// Runs in its own thread so a hostile PDF can be stopped by terminate() and cannot exhaust the worker's memory.
const MAX_PAGES = 10;

try {
  const pdf = await getDocument({ data: new Uint8Array(workerData), disableFontFace: true, useSystemFonts: false, isOffscreenCanvasSupported: false, verbosity: 0 }).promise;
  const pages = [];
  for (let n = 1; n <= Math.min(pdf.numPages, MAX_PAGES); n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    pages.push(content.items.map((item) => item.str ?? "").join(""));
  }
  parentPort.postMessage({ text: pages.join("\n"), pages: pdf.numPages });
} catch {
  parentPort.postMessage({ error: true });
}
