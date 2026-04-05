import { eq, asc } from "drizzle-orm";
import * as path from "path";
import { db } from "../db/client.server";
import { jobs } from "../db/schema";
import { startArchiveJob } from "./archiver.server";
import { listFiles, getJobStatus } from "./rclone.server";
import { rcloneConfig } from "./config";
import * as fs from "node:fs/promises";

const STAGING_DIR = process.env.NODE_ENV === "production" 
  ? "/data/staging" 
  : path.resolve("./data/staging");

console.log("[jobWatcher] STAGING_DIR:", STAGING_DIR);
console.log("[jobWatcher] RCLONE_FS:", rcloneConfig.fsPathWithSlash);

export function watchJob(id: string, rcloneJobId: number) {
  console.log(`[jobWatcher.watchJob] Starting watch for job ${id}, rclone jobid ${rcloneJobId}`);
  
  const interval = setInterval(async () => {
    try {
      console.log(`[jobWatcher.watchJob] Checking status for job ${id}`);
      const status = await getJobStatus(rcloneJobId);
      console.log(`[jobWatcher.watchJob] Status for job ${id}:`, status);

      if (!status.finished) {
        console.log(`[jobWatcher.watchJob] Job ${id} not finished yet`);
        return;
      }
      
      clearInterval(interval);
      console.log(`[jobWatcher.watchJob] Job ${id} finished, success:`, status.success);

      if (status.success) {
        console.log(`[jobWatcher.watchJob] Job ${id} succeeded, transitioning to VERIFYING`);
        await db
          .update(jobs)
          .set({ status: "VERIFYING", updatedAt: new Date().toISOString() })
          .where(eq(jobs.id, id));

        console.log(`[jobWatcher.watchJob] Verifying archive for job ${id}`);
        const verified = await verifyArchive(id);
        console.log(`[jobWatcher.watchJob] Verification result for job ${id}:`, verified);

        if (verified) {
          console.log(`[jobWatcher.watchJob] Job ${id} verified, transitioning to COMPLETED`);
          await db
            .update(jobs)
            .set({ status: "COMPLETED", updatedAt: new Date().toISOString() })
            .where(eq(jobs.id, id));
          await cleanupStaging(id);
        } else {
          console.error(`[jobWatcher.watchJob] Job ${id} verification failed`);
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
        }
      } else {
        console.error(`[jobWatcher.watchJob] Job ${id} failed:`, status.error);
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
      }

      await startNextQueued();
    } catch (err) {
      console.error(`[jobWatcher.watchJob] Error watching job ${id}:`, err);
      clearInterval(interval);
      await db
        .update(jobs)
        .set({
          status: "ARCHIVE_FAILED",
          error: JSON.stringify({ phase: "ARCHIVING", message: String(err) }),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(jobs.id, id));
      await startNextQueued();
    }
  }, 5000);
}

export async function startNextQueued() {
  console.log("[jobWatcher.startNextQueued] Checking for queued jobs");
  
  const [next] = await db
    .select()
    .from(jobs)
    .where(eq(jobs.status, "QUEUED"))
    .orderBy(asc(jobs.createdAt))
    .limit(1);

  if (next) {
    console.log("[jobWatcher.startNextQueued] Found queued job:", next.id, next.filename);
    await startArchiveJob(next.id);
  } else {
    console.log("[jobWatcher.startNextQueued] No queued jobs found");
  }
}

export async function verifyArchive(id: string): Promise<boolean> {
  console.log("[jobWatcher.verifyArchive] Verifying job:", id);
  
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  if (!job) {
    console.error("[jobWatcher.verifyArchive] Job not found:", id);
    return false;
  }

  console.log("[jobWatcher.verifyArchive] Job details:", {
    id: job.id,
    filename: job.filename,
    destinationPath: job.destinationPath,
  });

  // Handle empty destination path - use fsPathForList without trailing colon
  // B2 app keys fail with trailing colon due to bucket restriction
  const fsPath = job.destinationPath 
    ? `${rcloneConfig.fsPathForList}:${job.destinationPath}`
    : rcloneConfig.fsPathForList;
  
  console.log("[jobWatcher.verifyArchive] Calling listFiles with:", { fs: fsPath, remote: "" });
  
  const { list } = await listFiles(fsPath, "");
  console.log("[jobWatcher.verifyArchive] List result:", list);

  const found = list.some((entry) => entry.Name === job.filename);
  console.log("[jobWatcher.verifyArchive] File found:", found);
  
  return found;
}

export async function cleanupStaging(id: string) {
  console.log("[jobWatcher.cleanupStaging] Cleaning up:", id);
  const stagingPath = `${STAGING_DIR}/${id}`;
  console.log("[jobWatcher.cleanupStaging] Path:", stagingPath);
  
  try {
    await fs.rm(stagingPath, { recursive: true, force: true });
    console.log("[jobWatcher.cleanupStaging] Cleanup complete");
  } catch (err) {
    console.error("[jobWatcher.cleanupStaging] Cleanup error:", err);
  }
}
