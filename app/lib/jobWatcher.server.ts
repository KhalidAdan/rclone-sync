import { eq, asc } from "drizzle-orm";
import * as path from "path";
import * as fs from "node:fs/promises";
import { db } from "../db/client.server";
import { jobs } from "../db/schema";
import { logJobEvent } from "./jobEvents.server";
import { m4bNameOf } from "./types";
import {
  listFiles,
  getJobStatus,
  deleteFile,
  type RcloneJobStatus,
} from "./rclone.server";
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
 *
 * On success: record the archived M4B (format + exact size), clean up the
 * legacy remote AAX if this was a migration, and delete local staging —
 * B2 is now the source of truth, so nothing needs to linger on disk.
 */
export async function finishVerification(id: string) {
  let remoteM4b: { size: number } | null = null;
  try {
    remoteM4b = await verifyArchive(id);
  } catch (err) {
    logger.error("[jobWatcher.finishVerification] Verification errored:", { jobId: id, error: String(err) });
  }

  if (remoteM4b) {
    const [job] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);

    await db
      .update(jobs)
      .set({
        status: "COMPLETED",
        archivedAs: "m4b",
        m4bSizeBytes: remoteM4b.size,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(jobs.id, id));
    await logJobEvent(id, "completed", "Archive verified successfully");

    // Migration jobs carried a legacy AAX in the remote. The M4B is now
    // verified present — delete the AAX, but only if the M4B size passes
    // a sanity check (remux output is nearly the same size as the input;
    // a tiny M4B means something went badly wrong).
    if (job?.archivedAs === "aax") {
      await deleteLegacyRemoteAax(job.id, job.filename, job.destinationPath, job.sizeBytes, remoteM4b.size);
    }

    await cleanupFull(id);
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

const MIN_SANE_M4B_BYTES = 1024 * 1024;

async function deleteLegacyRemoteAax(
  jobId: string,
  aaxFilename: string,
  destinationPath: string,
  aaxSizeBytes: number,
  m4bSizeBytes: number,
) {
  const aaxRemote = `${destinationPath}${aaxFilename}`;
  const sane =
    m4bSizeBytes >= MIN_SANE_M4B_BYTES &&
    (aaxSizeBytes <= 0 || m4bSizeBytes >= aaxSizeBytes * 0.5);

  if (!sane) {
    logger.warn("[jobWatcher.deleteLegacyRemoteAax] M4B size failed sanity check — keeping remote AAX:", {
      jobId,
      aaxRemote,
      aaxSizeBytes,
      m4bSizeBytes,
    });
    await logJobEvent(jobId, "completed", "Legacy AAX kept in remote (M4B size sanity check failed)");
    return;
  }

  try {
    await deleteFile(config.rcloneRemote, aaxRemote);
    logger.info("[jobWatcher.deleteLegacyRemoteAax] Deleted legacy remote AAX:", { jobId, aaxRemote });
    await logJobEvent(jobId, "completed", `Legacy AAX removed from archive: ${aaxRemote}`);
  } catch (err) {
    // Non-fatal: the M4B is safe; an orphaned AAX just costs storage.
    logger.error("[jobWatcher.deleteLegacyRemoteAax] Failed to delete remote AAX:", {
      jobId,
      aaxRemote,
      error: String(err),
    });
    await logJobEvent(jobId, "failed", `Could not remove legacy AAX (M4B is safe): ${String(err)}`);
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

/**
 * Check the remote listing for this job's M4B. Returns its size when
 * present, null otherwise. The destination folder is passed as the list
 * *path* (not appended to the fs string, which mangles crypt remotes).
 */
export async function verifyArchive(id: string): Promise<{ size: number } | null> {
  logger.info("[jobWatcher.verifyArchive] Verifying job:", { jobId: id });

  const [job] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  if (!job) {
    logger.error("[jobWatcher.verifyArchive] Job not found:", { jobId: id });
    return null;
  }

  const m4bName = m4bNameOf(job.filename);
  const dir = job.destinationPath.replace(/\/+$/, "");
  const { list } = await listFiles(config.rcloneRemote, dir);
  const entry = list.find((e) => !e.IsDir && e.Name === m4bName);
  logger.debug("[jobWatcher.verifyArchive] M4B found:", { jobId: id, found: !!entry });

  return entry ? { size: entry.Size } : null;
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
