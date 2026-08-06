import { eq } from "drizzle-orm";
import { db } from "../db/client.server";
import { jobs } from "../db/schema";
import {
  watchJob,
  settleFinishedArchive,
  finishVerification,
  cleanupFull,
  cleanupAax,
  cleanupStaging,
  startNextQueued,
} from "./jobWatcher.server";
import { startOrQueueArchive } from "./archiver.server";
import { logJobEvent } from "./jobEvents.server";
import { processJob } from "./pipeline.server";
import { getJobStatus } from "./rclone.server";
import { validateConfig } from "./config.server";
import { logger } from "./logger.server";

// Jobs younger than this in a transient state might still be actively worked
// on by this very process (dev-server module reloads re-run recovery), so
// leave them alone. Anything older is orphaned by a previous process.
const RECOVERY_AGE_MS = 10 * 60 * 1000;

let startupPromise: Promise<void> | null = null;

/**
 * Run once per process: validate config (warn loudly if rclone is down, but
 * keep serving the UI) and recover jobs orphaned by a previous process.
 * Called from the root loader so it works identically in dev and prod.
 */
export function ensureStartup(): Promise<void> {
  if (!startupPromise) {
    startupPromise = runStartup();
  }
  return startupPromise;
}

async function runStartup() {
  logger.info("[startup] Running startup checks");
  try {
    await validateConfig();
  } catch (err) {
    logger.error("[startup] Config validation failed (continuing — uploads will fail until fixed):", {
      error: String(err),
    });
  }

  try {
    await recoverOrphanedJobs();
  } catch (err) {
    logger.error("[startup] Job recovery failed:", { error: String(err) });
  }
}

function olderThanRecoveryAge(updatedAt: string): boolean {
  return Date.now() - new Date(updatedAt).getTime() > RECOVERY_AGE_MS;
}

export async function recoverOrphanedJobs() {
  // UPLOADING: the request died with the process (or the client vanished
  // and the abort handler never ran). Nothing can resume a half-read
  // request body — fail it so the user re-uploads.
  const uploading = await db.select().from(jobs).where(eq(jobs.status, "UPLOADING"));
  for (const job of uploading) {
    if (!olderThanRecoveryAge(job.updatedAt)) continue;
    logger.warn("[startup.recover] Failing orphaned UPLOADING job:", { jobId: job.id });
    await db
      .update(jobs)
      .set({
        status: "UPLOAD_FAILED",
        error: JSON.stringify({ phase: "UPLOADING", message: "Server restarted during upload" }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(jobs.id, job.id));
    await logJobEvent(job.id, "failed", "Server restarted during upload");
    await cleanupStaging(job.id);
  }

  // STAGED: upload finished but decode never ran. Resume the pipeline
  // (decode → archive), NOT the archive directly — archiving a STAGED job
  // would skip decoding and the M4B would never exist.
  const staged = await db.select().from(jobs).where(eq(jobs.status, "STAGED"));
  for (const job of staged) {
    if (!olderThanRecoveryAge(job.updatedAt)) continue;
    logger.warn("[startup.recover] Resuming orphaned STAGED job:", { jobId: job.id });
    await processJob(job.id);
  }

  // DECODING: ffmpeg was killed with the process. Decode is idempotent now
  // (ffmpeg -y overwrites partial output), so just re-run it.
  const decoding = await db.select().from(jobs).where(eq(jobs.status, "DECODING"));
  for (const job of decoding) {
    if (!olderThanRecoveryAge(job.updatedAt)) continue;
    logger.warn("[startup.recover] Re-running orphaned DECODING job:", { jobId: job.id });
    await logJobEvent(job.id, "decoding", "Server restarted during decode - retrying");
    await processJob(job.id);
  }

  // DECODED: decode succeeded but the archive was never started.
  const decoded = await db.select().from(jobs).where(eq(jobs.status, "DECODED"));
  for (const job of decoded) {
    logger.warn("[startup.recover] Archiving orphaned DECODED job:", { jobId: job.id });
    await startOrQueueArchive(job.id);
  }

  // ARCHIVING: the rclone daemon is a separate process, so the copy may have
  // survived or even finished. Re-attach or settle.
  const archiving = await db.select().from(jobs).where(eq(jobs.status, "ARCHIVING"));
  for (const job of archiving) {
    if (!job.rcloneJobId) {
      // Slot was claimed but the copy never started — requeue.
      if (!olderThanRecoveryAge(job.updatedAt)) continue;
      logger.warn("[startup.recover] Requeueing ARCHIVING job with no rclone job:", { jobId: job.id });
      await db
        .update(jobs)
        .set({ status: "QUEUED", updatedAt: new Date().toISOString() })
        .where(eq(jobs.id, job.id));
      continue;
    }

    try {
      const status = await getJobStatus(job.rcloneJobId);
      if (!status.finished) {
        logger.info("[startup.recover] Re-attaching watcher to live rclone job:", {
          jobId: job.id,
          rcloneJobId: job.rcloneJobId,
        });
        watchJob(job.id, job.rcloneJobId);
      } else {
        logger.info("[startup.recover] Settling finished archive:", { jobId: job.id });
        await settleFinishedArchive(job.id, status);
      }
    } catch (err) {
      // rclone restarted too — its job table is gone. State unknown;
      // verification is the source of truth, so run it.
      logger.warn("[startup.recover] rclone job state unknown, verifying directly:", {
        jobId: job.id,
        error: String(err),
      });
      await db
        .update(jobs)
        .set({ status: "VERIFYING", updatedAt: new Date().toISOString() })
        .where(eq(jobs.id, job.id));
      await finishVerification(job.id);
    }
  }

  // VERIFYING: verification was interrupted — just run it again.
  const verifying = await db.select().from(jobs).where(eq(jobs.status, "VERIFYING"));
  for (const job of verifying) {
    if (!olderThanRecoveryAge(job.updatedAt)) continue;
    logger.warn("[startup.recover] Re-running verification:", { jobId: job.id });
    await finishVerification(job.id);
  }

  // Kick the queue in case recovery left it idle.
  await startNextQueued();

  // COMPLETED jobs with stale staging leftovers.
  const completed = await db.select().from(jobs).where(eq(jobs.status, "COMPLETED"));
  for (const job of completed) {
    if (job.downloadedAt) {
      await cleanupFull(job.id);
    } else {
      await cleanupAax(job.id);
    }
  }

  logger.info("[startup.recover] Recovery pass complete");
}
