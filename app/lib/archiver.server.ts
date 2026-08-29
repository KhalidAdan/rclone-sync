import { eq, ne, and } from "drizzle-orm";
import * as path from "path";
import { db } from "../db/client.server";
import { jobs } from "../db/schema";
import { logJobEvent } from "./jobEvents.server";
import { m4bNameOf } from "./types";
import { watchJob, startNextQueued } from "./jobWatcher.server";
import { copyFile } from "./rclone.server";
import { config } from "./config.server";
import { logger } from "./logger.server";

/**
 * Atomically claim the single archive slot. Exactly one job may hold
 * status ARCHIVING; the check and the claim happen in one synchronous
 * SQLite transaction, so two callers can never both claim.
 *
 * Returns true if `id` now holds the slot, false if it was queued.
 */
function claimArchiveSlot(id: string): boolean {
  return db.transaction((tx) => {
    const now = new Date().toISOString();
    const active = tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.status, "ARCHIVING"), ne(jobs.id, id)))
      .limit(1)
      .all();

    if (active.length > 0) {
      tx.update(jobs)
        .set({ status: "QUEUED", updatedAt: now })
        .where(eq(jobs.id, id))
        .run();
      return false;
    }

    tx.update(jobs)
      .set({ status: "ARCHIVING", rcloneJobId: null, updatedAt: now })
      .where(eq(jobs.id, id))
      .run();
    return true;
  });
}

export async function startOrQueueArchive(id: string) {
  logger.info("[archiver.startOrQueueArchive] Job ID:", { jobId: id });

  if (!claimArchiveSlot(id)) {
    logger.info("[archiver.startOrQueueArchive] Job queued, another is archiving", { jobId: id });
    await logJobEvent(id, "queued", "Job queued - waiting for previous archive to complete");
    return;
  }

  await launchArchive(id);
}

/**
 * Start the rclone copy for a job that already holds the ARCHIVING slot.
 * On failure the job is marked ARCHIVE_FAILED and the next queued job starts,
 * so a bad job can never wedge the queue.
 */
async function launchArchive(id: string) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  if (!job) {
    logger.error("[archiver.launchArchive] Job not found:", { jobId: id });
    return;
  }

  // The M4B is the archived asset: playable forever without activation
  // bytes, encrypted at rest by the crypt remote. The uploaded AAX is a
  // staging-only artifact and never leaves the box.
  const m4bName = m4bNameOf(job.filename);
  const srcFs = path.join(config.stagingDir, id) + path.sep;
  const srcRemote = m4bName;
  const dstFs = config.rcloneRemote;
  const dstRemote = `${job.destinationPath}${m4bName}`;

  logger.debug("[archiver.launchArchive] rclone copyfile params:", {
    srcFs,
    srcRemote,
    dstFs,
    dstRemote,
  });

  try {
    const { jobid } = await copyFile(srcFs, srcRemote, dstFs, dstRemote);
    logger.info("[archiver.launchArchive] rclone job started:", { jobId: id, rcloneJobId: jobid });

    await db
      .update(jobs)
      .set({ rcloneJobId: jobid, updatedAt: new Date().toISOString() })
      .where(eq(jobs.id, id));

    await logJobEvent(id, "archiving", `Archive started - copying to ${dstRemote}`);
    watchJob(id, jobid);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[archiver.launchArchive] Error starting archive:", { jobId: id, error: message });

    await db
      .update(jobs)
      .set({
        status: "ARCHIVE_FAILED",
        error: JSON.stringify({ phase: "ARCHIVING", message: `Failed to start rclone copy: ${message}` }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(jobs.id, id));

    await logJobEvent(id, "failed", `Archive failed to start: ${message}`);
    await startNextQueued();
  }
}
