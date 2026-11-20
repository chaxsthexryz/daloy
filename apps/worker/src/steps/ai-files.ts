import { Worker } from "node:worker_threads";
import { readUpload, type Db } from "@daloy/db";
import { FILE_MIME, StepError, type FileKind, type FileRef } from "@daloy/engine";

// Keeps the request under Gemini's 20 MB inline limit after base64.
export const MAX_AI_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PAGES = 10;

/** The text layer of a PDF, read in a thread so a hostile file can be stopped on a timer. */
export function pdfText(data: Buffer, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./pdf-text-worker.mjs", import.meta.url), { workerData: data, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const fail = (err: StepError) => {
      clearTimeout(timer);
      void worker.terminate();
      reject(err);
    };
    const timer = setTimeout(() => fail(new StepError("This PDF took too long to read.", false)), timeoutMs);
    const unreadable = () => fail(new StepError("This PDF could not be read.", false));
    worker.once("error", unreadable);
    worker.once("exit", unreadable);
    worker.once("message", (m: { text?: string; pages?: number; error?: true }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (m.error || m.text === undefined) return reject(new StepError("This PDF could not be read.", false));
      const text = m.text.trim();
      if (!text) return reject(new StepError("This PDF has no text in it (it is probably a scan). Ask for a photo of it instead.", false));
      resolve(m.pages! > MAX_PAGES ? `${text}\n[Only the first ${MAX_PAGES} of ${m.pages} pages were read.]` : text);
    });
  });
}

/** The files an AI step may read, checked and decoded before the step is counted, so a refused file costs nothing. */
export async function loadAiFiles(db: Db, { userId, runId, refs, imageTypes }: { userId: string; runId: string; refs: FileRef[]; imageTypes?: FileKind[] }) {
  const images: { type: string; base64: string }[] = [];
  const pdfs: { name: string; text: string }[] = [];
  let imageBytes = 0;
  for (const ref of refs) {
    const file = await readUpload(db, { userId, runId, id: ref.id });
    if (!file) throw new StepError(`The file ${ref.name} is no longer stored. Files are kept 7 days.`, false);
    if (file.type === "pdf") {
      pdfs.push({ name: ref.name, text: await pdfText(file.data) });
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
