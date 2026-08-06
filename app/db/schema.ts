import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  filename: text("filename").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  destinationPath: text("destination_path").notNull().default(""),
  status: text("status", {
    enum: [
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
      // Legacy AAX -> M4B migration pipeline (pull from B2, then re-enter
      // the normal decode -> archive flow).
      "RESTORE_QUEUED",
      "RESTORING",
      "RESTORE_FAILED",
    ],
  }).notNull(),
  rcloneJobId: integer("rclone_job_id"),
  error: text("error"),
  retryCount: integer("retry_count").notNull().default(0),
  downloadedAt: text("downloaded_at"),
  // "upload" = came in through the app; "imported" = adopted from B2 by
  // the reconciliation scan (no local staging ever existed).
  origin: text("origin", { enum: ["upload", "imported"] })
    .notNull()
    .default("upload"),
  // Format of the object in B2 for this book: "m4b" (target state),
  // "aax" (legacy — migration candidate), or null (not archived yet /
  // not yet reconciled).
  archivedAs: text("archived_as", { enum: ["aax", "m4b"] }),
  // Exact size of the M4B, needed for Content-Length/Range when streaming.
  // Set when decode completes (local stat) or on reconcile (remote listing).
  m4bSizeBytes: integer("m4b_size_bytes"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const jobEvents = sqliteTable("job_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: text("job_id").notNull(),
  eventType: text("event_type", {
    enum: [
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
    ],
  }).notNull(),
  message: text("message").notNull(),
  timestamp: text("timestamp").notNull(),
});

export const jobsRelations = relations(jobs, ({ many }) => ({
  events: many(jobEvents),
}));

export const jobEventsRelations = relations(jobEvents, ({ one }) => ({
  job: one(jobs, {
    fields: [jobEvents.jobId],
    references: [jobs.id],
  }),
}));
