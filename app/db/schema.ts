import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  filename: text("filename").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  destinationPath: text("destination_path").notNull().default(""),
  status: text("status", {
    enum: [
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
    ],
  }).notNull(),
  rcloneJobId: integer("rclone_job_id"),
  error: text("error"),
  retryCount: integer("retry_count").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
