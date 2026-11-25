import { readUpload, type Db, type MailFile } from "@daloy/db";
import { EMAIL_MAX_ATTACHMENTS, FILE_MIME, StepError } from "@daloy/engine";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The files an email step attaches (decision 0140). Each resolved value is a FileRef, or a form field's list of them.
 * Only the id counts: the bytes, name and type come from this run's own uploads, so a ref copied from another run,
 * another workspace or typed into a form is refused before anything is counted or sent.
 */
export async function loadAttachments(db: Db, { userId, runId, values }: { userId: string; runId: string; values: unknown[] }): Promise<MailFile[]> {
  const refs = values.flat();
  if (refs.length > EMAIL_MAX_ATTACHMENTS) throw new StepError(`An email takes at most ${EMAIL_MAX_ATTACHMENTS} files; these attachments add up to ${refs.length}.`, false);
  const files: MailFile[] = [];
  for (const ref of refs) {
    const id = (ref as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !UUID.test(id)) throw new StepError(`An attachment is not a file. Use a file from this run, such as {{steps.<id>.output.file}}.`, false);
    const file = UUID.test(runId) ? await readUpload(db, { userId, runId, id }) : null;
    if (!file) throw new StepError(`The attachment ${String((ref as { name?: unknown }).name ?? id).slice(0, 100)} is not a file from this run, or it is no longer stored (files are kept 7 days).`, false);
    files.push({ filename: file.name, content: file.data, contentType: FILE_MIME[file.type] });
  }
  return files;
}
