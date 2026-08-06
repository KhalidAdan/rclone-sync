export const JOB_STATUSES = [
  "UPLOADING",
  "STAGED",
  "DECODING",
  "DECODED",
  "QUEUED",
  "ARCHIVING",
  "VERIFYING",
  "COMPLETED",
  "UPLOAD_FAILED",
  "DECODE_FAILED",
  "ARCHIVE_FAILED",
  "VERIFY_FAILED",
  "ABANDONED",
  "RESTORE_QUEUED",
  "RESTORING",
  "RESTORE_FAILED",
] as const;

export const JOB_EVENT_TYPES = [
  "created",
  "decoding",
  "decoded",
  "queued",
  "archiving",
  "verifying",
  "completed",
  "failed",
  "abandoned",
  "restoring",
  "imported",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];
export type JobEventType = (typeof JOB_EVENT_TYPES)[number];

/** Derive the M4B name from the uploaded AAX filename (idempotent for .m4b). */
export function m4bNameOf(filename: string): string {
  return filename.toLowerCase().endsWith(".aax")
    ? filename.slice(0, -4) + ".m4b"
    : filename;
}
