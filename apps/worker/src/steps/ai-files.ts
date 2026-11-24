import { Worker } from "node:worker_threads";
import { readUpload, type Db } from "@daloy/db";
import { FILE_MIME, StepError, type FileKind, type FileRef } from "@daloy/engine";

// Keeps the request under Gemini's 20 MB inline limit after base64.
export const MAX_AI_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_PAGES = 10;
export const MAX_PDF_CHARS = 50_000;
export const MAX_TOTAL_PDF_CHARS = 100_000;

export type PdfTextOptions = { timeoutMs?: number; maxPages?: number; maxChars?: number };

/** The text layer of a PDF, read in a thread so a hostile file can be stopped on a timer and capped in memory, pages, and characters. */
export function pdfText(data: Buffer, optsOrTimeoutMs: number | PdfTextOptions = 10_000): Promise<string> {
  const opts = typeof optsOrTimeoutMs === "number" ? { timeoutMs: optsOrTimeoutMs } : optsOrTimeoutMs;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxPages = opts.maxPages ?? MAX_PDF_PAGES;
  const maxChars = opts.maxChars ?? MAX_PDF_CHARS;
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./pdf-text-worker.mjs", import.meta.url), {
      workerData: { data, maxPages, maxChars },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    });
    const fail = (err: StepError) => {
      clearTimeout(timer);
      void worker.terminate();
      reject(err);
    };
    const timer = setTimeout(() => fail(new StepError("This PDF took too long to read.", false)), timeoutMs);
    const unreadable = () => fail(new StepError("This PDF could not be read.", false));
    worker.once("error", unreadable);
    worker.once("exit", unreadable);
    worker.once("message", (m: { text?: string; pages?: number; truncatedByChars?: boolean; error?: true }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (m.error || m.text === undefined) return reject(new StepError("This PDF could not be read.", false));
      const trimmed = m.text.trim();
      if (!trimmed) return reject(new StepError("This PDF has no text in it (it is probably a scan). Ask for a photo of it instead.", false));
      const capped = trimmed.slice(0, maxChars);
      const notes: string[] = [];
      if ((m.pages ?? 0) > maxPages) notes.push(`[Only the first ${maxPages} of ${m.pages} pages were read.]`);
      if (m.truncatedByChars || trimmed.length > maxChars) notes.push(`[PDF text was truncated at ${maxChars} characters.]`);
      resolve(notes.length ? `${capped}\n${notes.join(" ")}` : capped);
    });
  });
}

/** The files an AI step may read, checked and decoded before the step is counted, so a refused file costs nothing. */
export async function loadAiFiles(db: Db, { userId, runId, refs, imageTypes }: { userId: string; runId: string; refs: FileRef[]; imageTypes?: FileKind[] }) {
  const images: { type: string; base64: string }[] = [];
  const pdfs: { name: string; text: string }[] = [];
  let imageBytes = 0;
  let totalPdfChars = 0;
  for (const ref of refs) {
    const file = await readUpload(db, { userId, runId, id: ref.id });
    if (!file) throw new StepError(`The file ${ref.name} is no longer stored. Files are kept 7 days.`, false);
    if (file.type === "pdf") {
      const remaining = MAX_TOTAL_PDF_CHARS - totalPdfChars;
      if (remaining <= 0) throw new StepError(`The PDF files add up to more than ${MAX_TOTAL_PDF_CHARS} characters, more than an AI step reads in one request.`, false);
      const extracted = await pdfText(file.data, { maxChars: Math.min(MAX_PDF_CHARS, remaining) });
      totalPdfChars += extracted.length;
      pdfs.push({ name: ref.name, text: extracted });
      continue;
    }
    if (!imageTypes?.length) throw new StepError("The AI model picked on the AI model page does not read images. Pick Gemini, OpenAI, OpenRouter or DeepSeek there, or take the file field out of this AI step.", false);
    if (!imageTypes.includes(file.type)) throw new StepError("This AI model does not read HEIC photos. Ask for a JPEG or PNG, or pick Gemini on the AI model page.", false);
    imageBytes += file.data.length;
    if (imageBytes > MAX_AI_IMAGE_BYTES) throw new StepError("The photos add up to more than 10 MB, more than an AI step sends in one request.", false);
    images.push({ type: FILE_MIME[file.type], base64: file.data.toString("base64") });
  }
  return { images, pdfs };
}
