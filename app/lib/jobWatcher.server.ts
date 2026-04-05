import { eq, asc } from "drizzle-orm";
import * as path from "path";
import { db } from "../db/client.server";
import { jobs, jobEvents } from "../db/schema";
import { startArchiveJob } from "./archiver.server";
import { listFiles, getJobStatus } from "./rclone.server";
import { config } from "./config.server";
import { logger } from "./logger.server";
import * as fs from "node:fs/promises";

async function logJobEvent(jobId: string, eventType: "created" | "queued" | "archiving" | "verifying" | "completed" | "failed" | "abandoned", message: string) {
  const now = new Date().toISOString();
  await db.insert(jobEvents).values({
    jobId,
    eventType,
    message,
    timestamp: now,
  });
}

export function watchJob(id: string, rcloneJobId: number) {
  logger.info("[jobWatcher.watchJob] Starting watch for job", { jobId: id, rcloneJobId });
  
  const interval = setInterval(async () => {
    try {
      logger.debug(`[jobWatcher.watchJob] Checking status for job ${id}`);
      const status = await getJobStatus(rcloneJobId);
      logger.debug(`[jobWatcher.watchJob] Status for job ${id}:`, status);

      if (!status.finished) {
        logger.debug(`[jobWatcher.watchJob] Job ${id} not finished yet`);
        return;
      }
      
      clearInterval(interval);
      logger.info(`[jobWatcher.watchJob] Job ${id} finished, success:`, { success: status.success });

      if (status.success) {
        logger.info(`[jobWatcher.watchJob] Job ${id} succeeded, transitioning to VERIFYING`);
        await db
          .update(jobs)
          .set({ status: "VERIFYING", updatedAt: new Date().toISOString() })
          .where(eq(jobs.id, id));
        
        await logJobEvent(id, "verifying", "Archive copy complete, starting verification");

        logger.info(`[jobWatcher.watchJob] Verifying archive for job ${id}`);
        const verified = await verifyArchive(id);
        logger.debug(`[jobWatcher.watchJob] Verification result for job ${id}:`, { verified });

        if (verified) {
          logger.info(`[jobWatcher.watchJob] Job ${id} verified, transitioning to COMPLETED`);
          await db
            .update(jobs)
            .set({ status: "COMPLETED", updatedAt: new Date().toISOString() })
            .where(eq(jobs.id, id));
          
          await logJobEvent(id, "completed", "Archive verified successfully");
          await cleanupStaging(id);
        } else {
          logger.error(`[jobWatcher.watchJob] Job ${id} verification failed`);
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
      } else {
        logger.error(`[jobWatcher.watchJob] Job ${id} failed:`, { error: status.error });
        await db
          .update(jobs)
          .set({
            status: "ARCHIVE_FAILED",
            error: JSON.stringify({
              phase: "ARCHIVING",
              message: status.error || "Unknown error",
            }),
            updatedAt: new Date().toISOString(),
          })
          .where(eq(jobs.id, id));
        
        await logJobEvent(id, "failed", `Archive failed: ${status.error || "Unknown error"}`);
      }

      await startNextQueued();
    } catch (err) {
      logger.error(`[jobWatcher.watchJob] Error watching job ${id}:`, { error: String(err) });
      clearInterval(interval);
      await db
        .update(jobs)
        .set({
          status: "ARCHIVE_FAILED",
          error: JSON.stringify({ phase: "ARCHIVING", message: String(err) }),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(jobs.id, id));
      
      await logJobEvent(id, "failed", `Error watching job: ${String(err)}`);
      await startNextQueued();
    }
  }, 5000);
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
    await startArchiveJob(next.id);
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

  logger.debug("[jobWatcher.verifyArchive] Job details:", {
    id: job.id,
    filename: job.filename,
    destinationPath: job.destinationPath,
  });

  const fsPath = job.destinationPath 
    ? `${config.rcloneRemote}${job.destinationPath}`
    : config.rcloneRemote;
  
  logger.debug("[jobWatcher.verifyArchive] Calling listFiles with:", { fs: fsPath, remote: "" });
  
  const { list } = await listFiles(fsPath, "");
  logger.debug("[jobWatcher.verifyArchive] List result:", { list });

  const found = list.some((entry) => entry.Name === job.filename);
  logger.debug("[jobWatcher.verifyArchive] File found:", { found });
  
  return found;
}

export async function cleanupStaging(id: string) {
  logger.info("[jobWatcher.cleanupStaging] Cleaning up:", { jobId: id });
  const stagingPath = path.join(config.stagingDir, id);
  logger.debug("[jobWatcher.cleanupStaging] Path:", { stagingPath });
  
  try {
    await fs.rm(stagingPath, { recursive: true, force: true });
    logger.info("[jobWatcher.cleanupStaging] Cleanup complete", { jobId: id });
  } catch (err) {
    logger.error("[jobWatcher.cleanupStaging] Cleanup error:", { error: String(err) });
  }
}
