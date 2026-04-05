import { eq } from "drizzle-orm";
import * as path from "path";
import { db } from "../db/client.server";
import { jobs, jobEvents } from "../db/schema";
import { watchJob } from "./jobWatcher.server";
import { config } from "./config.server";
import { logger } from "./logger.server";

async function logJobEvent(jobId: string, eventType: "created" | "queued" | "archiving" | "verifying" | "completed" | "failed" | "abandoned", message: string) {
  const now = new Date().toISOString();
  await db.insert(jobEvents).values({
    jobId,
    eventType,
    message,
    timestamp: now,
  });
}

export async function startOrQueueArchive(id: string) {
  logger.info("[archiver.startOrQueueArchive] Job ID:", { jobId: id });
  
  const active = await db
    .select()
    .from(jobs)
    .where(eq(jobs.status, "ARCHIVING"))
    .limit(1);

  logger.debug("[archiver.startOrQueueArchive] Active jobs:", { count: active.length });

  if (active.length > 0) {
    logger.info("[archiver.startOrQueueArchive] Job queued, another is archiving");
    await db
      .update(jobs)
      .set({ status: "QUEUED", updatedAt: new Date().toISOString() })
      .where(eq(jobs.id, id));
    await logJobEvent(id, "queued", "Job queued - waiting for previous archive to complete");
    return;
  }

  await startArchiveJob(id);
}

export async function startArchiveJob(id: string) {
  logger.info("[archiver.startArchiveJob] Starting archive for job:", { jobId: id });
  
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  if (!job) {
    logger.error("[archiver.startArchiveJob] Job not found:", { jobId: id });
    return;
  }

  logger.debug("[archiver.startArchiveJob] Job details:", {
    id: job.id,
    filename: job.filename,
    sizeBytes: job.sizeBytes,
    destinationPath: job.destinationPath,
  });

  const srcFs = path.join(config.stagingDir, id) + path.sep;
  const srcRemote = job.filename;
  const dstFs = config.rcloneRemote;
  const dstRemote = `${job.destinationPath}${job.filename}`;

  logger.debug("[archiver.startArchiveJob] rclone copyfile params:", {
    srcFs,
    srcRemote,
    dstFs,
    dstRemote,
  });

  const { copyFile } = await import("./rclone.server");
  
  try {
    const { jobid } = await copyFile(srcFs, srcRemote, dstFs, dstRemote);
    logger.info("[archiver.startArchiveJob] rclone job started, jobid:", { jobid, rcloneJobId: jobid });

    await db
      .update(jobs)
      .set({
        status: "ARCHIVING",
        rcloneJobId: jobid,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(jobs.id, id));

    await logJobEvent(id, "archiving", `Archive started - copying to ${dstRemote}`);
    watchJob(id, jobid);
  } catch (err) {
    logger.error("[archiver.startArchiveJob] Error starting archive:", { error: String(err) });
    throw err;
  }
}
