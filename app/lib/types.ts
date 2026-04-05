export const JOB_STATUSES = [
  "UPLOADING",
  "STAGED",
  "QUEUED",
  "ARCHIVING",
  "VERIFYING",
  "COMPLETED",
  "UPLOAD_FAILED",
  "ARCHIVE_FAILED",
  "VERIFY_FAILED",
  "ABANDONED",
] as const;

export const JOB_EVENT_TYPES = [
  "created",
  "queued",
  "archiving",
  "verifying",
  "completed",
  "failed",
  "abandoned",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];
export type JobEventType = (typeof JOB_EVENT_TYPES)[number];