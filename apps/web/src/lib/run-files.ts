export type FileRef = { id: string; name: string; type: string; size: number };

const isRef = (v: unknown): v is FileRef => !!v && typeof v === "object" && typeof (v as FileRef).id === "string" && typeof (v as FileRef).name === "string" && typeof (v as FileRef).size === "number";

/** File refs in a run's trigger payload: any value that is a list of {id, name, size} objects. */
export function fileRefs(payload: unknown): FileRef[] {
  if (!payload || typeof payload !== "object") return [];
  return Object.values(payload).flatMap((v) => (Array.isArray(v) && v.length > 0 && v.every(isRef) ? (v as FileRef[]) : []));
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
