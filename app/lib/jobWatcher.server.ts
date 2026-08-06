import { eq, asc } from "drizzle-orm";
import * as path from "path";
import * as fs from "node:fs/promises";
import { db } from "../db/client.server";
import { jobs } from "../db/schema";
import { logJobEvent } from "./jobEvents.server";
import { listFiles, getJobStatus, type RcloneJobStatus } from "./rclone.server";
import { config } from "./config.server";
import { logger } from "./logger.server";

const POLL_INTERVAL_MS = 5_000;
// Tolerate transient rclone/network errors: only fail the job after this many
// consecutive poll failures (~2.5 minutes of continuous unreachability).
const MAX_CONSECUTIVE_POLL_ERRORS = 30;

/**
 * Poll rclone until the copy job finishes, then settle it. A setTimeout chain
 * (not setInterval) guarantees ticks never overlap even when rclone is slow.
 */
export function watchJob(id: string, rcloneJobId: number) {
  logger.info("[jobWatcher.watchJob] Starting watch for job", { jobId: id, rcloneJobId });
  let consecutiveErrors = 0;

  const tick = async () => {
    try {
      const status = await getJobStatus(rcloneJobId);
      consecutiveErrors = 0;

      if (!status.finished) {
        schedule();
        return;
      }

      logger.info(`[jobWatcher.watchJob] Job ${id} finished:`, { success: status.success });
      await settleFinishedArchive(id, status);
    } catch (err) {
      consecutiveErrors++;
      logger.warn(`[jobWatcher.watchJob] Poll error for job ${id} (${consecutiveErrors}/${MAX_CONSECUTIVE_POLL_ERRORS}):`, {
        error: String(err),
      });

      if (consecutiveErrors < MAX_CONSECUTIVE_POLL_ERRORS) {
        schedule();
        return;
      }

      // rclone has been unreachable for minutes — give up on this watch.
      // The copy itself may still succeed; startup recovery can re-settle it.
      await failArchive(id, `Lost contact with rclone while archiving: ${String(err)}`);
      await startNextQueued();
    }
  };

  const schedule = () => setTimeout(tick, POLL_INTERVAL_MS);
  schedule();
}

/**
 * Transition a finished rclone copy to its terminal state. Idempotent: only
 * acts if the job is still ARCHIVING, so a duplicate watcher (e.g. one started
 * by recovery alongside an original) cannot double-settle.
 */
export async function settleFinishedArchive(id: string, status: RcloneJobStatus) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  if (!job || job.status !== "ARCHIVING") {
    logger.debug("[jobWatcher.settleFinishedArchive] Job not in ARCHIVING, skipping:", {
      jobId: id,
      status: job?.status,
    });
    return;
  }

  if (status.success) {
    await db
      .update(jobs)
      .set({ status: "VERIFYING", updatedAt: new Date().toISOString() })
      .where(eq(jobs.id, id));
    await logJobEvent(id, "verifying", "Archive copy complete, starting verification");
    await finishVerification(id);
  } else {
    await failArchive(id, status.error || "Unknown error");
  }

  await startNextQueued();
}

async function failArchive(id: string, message: string) {
  await db
    .update(jobs)
    .set({
      status: "ARCHIVE_FAILED",
      error: JSON.stringify({ phase: "ARCHIVING", message }),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(jobs.id, id));
  await logJobEvent(id, "failed", `Archive failed: ${message}`);
}

/**
 * Verify a VERIFYING job against the remote listing and finish it.
 * Shared by the watcher and startup recovery.
 */
export async function finishVerification(id: string) {
  let verified = false;
  try {
    verified = await verifyArchive(id);
  } catch (err) {
    logger.error("[jobWatcher.finishVerification] Verification errored:", { jobId: id, error: String(err) });
  }

  if (verified) {
    await db
      .update(jobs)
      .set({ status: "COMPLETED", updatedAt: new Date().toISOString() })
      .where(eq(jobs.id, id));
    await logJobEvent(id, "completed", "Archive verified successfully");

    const [job] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
    if (job?.downloadedAt) {
      await cleanupFull(id);
    } else {
      await cleanupAax(id);
    }
  } else {
    await db
      .update(jobs)
      .set({
        status: "VERIFY_FAILED",
        error: JSON.stringify({
          phase: "VERIFYING",
          message: "File not found in remote after successful rclone job",
        }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(jobs.id, id));
    await logJobEvent(id, "failed", "Verification failed - file not found in remote");
  }
}

export async function startNextQueued() {
  logger.debug("[jobWatcher.startNextQueued] Checking for queued jobs");

  const [next] = await db
    .select()
    .from(jobs)
    .where(eq(jobs.status, "QUEUED"))
    .orderBy(asc(jobs.createdAt))
    .limit(1);

  if (next) {
    logger.info("[jobWatcher.startNextQueued] Found queued job:", { jobId: next.id, filename: next.filename });
    // Goes through the atomic claim — if something else grabbed the slot
    // in the meantime, the job simply stays QUEUED.
    const { startOrQueueArchive } = await import("./archiver.server");
    await startOrQueueArchive(next.id);
  } else {
    logger.debug("[jobWatcher.startNextQueued] No queued jobs found");
  }
}

export async function verifyArchive(id: string): Promise<boolean> {
  logger.info("[jobWatcher.verifyArchive] Verifying job:", { jobId: id });

  const [job] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  if (!job) {
    logger.error("[jobWatcher.verifyArchive] Job not found:", { jobId: id });
    return false;
  }

  const fsPath = job.destinationPath
    ? `${config.rcloneRemote}${job.destinationPath}`
    : config.rcloneRemote;

  const { list } = await listFiles(fsPath, "");
  const found = list.some((entry) => entry.Name === job.filename);
  logger.debug("[jobWatcher.verifyArchive] File found:", { jobId: id, found });

  return found;
}

export async function cleanupStaging(id: string) {
  logger.info("[jobWatcher.cleanupStaging] Cleaning up:", { jobId: id });
  const stagingPath = path.join(config.stagingDir, id);

  try {
    await fs.rm(stagingPath, { recursive: true, force: true });
    logger.info("[jobWatcher.cleanupStaging] Cleanup complete", { jobId: id });
  } catch (err) {
    logger.error("[jobWatcher.cleanupStaging] Cleanup error:", { error: String(err) });
  }
}

export async function cleanupAax(jobId: string) {
  logger.info("[jobWatcher.cleanupAax] Deleting AAX file:", { jobId });

  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) {
    logger.error("[jobWatcher.cleanupAax] Job not found:", { jobId });
    return;
  }

  const aaxPath = path.join(config.stagingDir, jobId, job.filename);

  try {
    await fs.rm(aaxPath, { force: true });
    logger.info("[jobWatcher.cleanupAax] AAX deleted:", { jobId, aaxPath });
  } catch (err) {
    logger.error("[jobWatcher.cleanupAax] Error deleting AAX:", { jobId, error: String(err) });
  }
}

export async function cleanupFull(jobId: string) {
  logger.info("[jobWatcher.cleanupFull] Deleting full staging directory:", { jobId });
  const stagingPath = path.join(config.stagingDir, jobId);

  try {
    await fs.rm(stagingPath, { recursive: true, force: true });
    logger.info("[jobWatcher.cleanupFull] Cleanup complete", { jobId });
  } catch (err) {
    logger.error("[jobWatcher.cleanupFull] Cleanup error:", { error: String(err) });
  }
}
