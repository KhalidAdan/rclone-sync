import { eq, asc, isNull, and } from "drizzle-orm";
import { db } from "../db/client.server";
import { jobs } from "../db/schema";
import { watchJob, cleanupStaging, cleanupFull, cleanupAax } from "./jobWatcher.server";
import { startArchiveJob, startOrQueueArchive } from "./archiver.server";
import { getJobStatus } from "./rclone.server";
import { logger } from "./logger.server";

export async function recoverOrphanedJobs() {
  // Recover DECODING jobs - FFmpeg was interrupted
  const decoding = await db
    .select()
    .from(jobs)
    .where(eq(jobs.status, "DECODING"));

  if (decoding.length > 0) {
    logger.warn("[startup.recoverOrphanedJobs] Recovering orphaned DECODING jobs:", { count: decoding.length });
  }

  for (const job of decoding) {
    await db
      .update(jobs)
      .set({
        status: "DECODE_FAILED",
        error: JSON.stringify({
          step: "decode",
          message: "Server restarted during decode",
        }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(jobs.id, job.id));
  }

  // Recover DECODED jobs - decode succeeded but archive never started
  const decoded = await db
    .select()
    .from(jobs)
    .where(eq(jobs.status, "DECODED"));

  if (decoded.length > 0) {
    logger.warn("[startup.recoverOrphanedJobs] Recovering orphaned DECODED jobs:", { count: decoded.length });
  }

  for (const job of decoded) {
    await startOrQueueArchive(job.id);
  }

  // Recover ARCHIVING jobs (existing logic)
  const archiving = await db
    .select()
    .from(jobs)
    .where(eq(jobs.status, "ARCHIVING"));

  if (archiving.length > 0) {
    logger.warn("[startup.recoverOrphanedJobs] Recovering orphaned ARCHIVING jobs:", { count: archiving.length });
  }

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

  // Check for queued jobs to start
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

  // Recover COMPLETED jobs with stale staging
  const completed = await db
    .select()
    .from(jobs)
    .where(eq(jobs.status, "COMPLETED"));

  for (const job of completed) {
    if (job.downloadedAt) {
      await cleanupFull(job.id);
    } else {
      await cleanupAax(job.id);
    }
  }
}
