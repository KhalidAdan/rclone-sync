import { eq, asc } from "drizzle-orm";
import { db } from "../db/client.server";
import { jobs } from "../db/schema";
import { watchJob, cleanupStaging } from "./jobWatcher.server";
import { startArchiveJob } from "./archiver.server";
import { getJobStatus } from "./rclone.server";

export async function recoverOrphanedJobs() {
  const archiving = await db
    .select()
    .from(jobs)
    .where(eq(jobs.status, "ARCHIVING"));

  for (const job of archiving) {
    if (!job.rcloneJobId) continue;

    try {
      const status = await getJobStatus(job.rcloneJobId);
      if (!status.finished) {
        watchJob(job.id, job.rcloneJobId);
      } else {
        if (status.success) {
          await db
            .update(jobs)
            .set({ status: "VERIFYING", updatedAt: new Date().toISOString() })
            .where(eq(jobs.id, job.id));
        } else {
          await db
            .update(jobs)
            .set({
              status: "ARCHIVE_FAILED",
              error: JSON.stringify({
                phase: "RECOVERY",
                message: status.error || "Server restarted, rclone job state unknown",
              }),
              updatedAt: new Date().toISOString(),
            })
            .where(eq(jobs.id, job.id));
        }
      }
    } catch {
      await db
        .update(jobs)
        .set({
          status: "ARCHIVE_FAILED",
          error: JSON.stringify({
            phase: "RECOVERY",
            message: "Server restarted, rclone job state unknown",
          }),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(jobs.id, job.id));
    }
  }

  const active = await db
    .select()
    .from(jobs)
    .where(eq(jobs.status, "ARCHIVING"))
    .limit(1);

  if (active.length === 0) {
    const [next] = await db
      .select()
      .from(jobs)
      .where(eq(jobs.status, "QUEUED"))
      .orderBy(asc(jobs.createdAt))
      .limit(1);

    if (next) {
      await startArchiveJob(next.id);
    }
  }

  const completed = await db
    .select()
    .from(jobs)
    .where(eq(jobs.status, "COMPLETED"));

  for (const job of completed) {
    await cleanupStaging(job.id);
  }
}
