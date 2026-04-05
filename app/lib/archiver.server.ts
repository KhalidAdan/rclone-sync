import { eq } from "drizzle-orm";
import * as path from "path";
import { db } from "../db/client.server";
import { jobs } from "../db/schema";
import { watchJob } from "./jobWatcher.server";
import { config } from "./config.server";

export async function startOrQueueArchive(id: string) {
  console.log("[archiver.startOrQueueArchive] Job ID:", id);
  
  const active = await db
    .select()
    .from(jobs)
    .where(eq(jobs.status, "ARCHIVING"))
    .limit(1);

  console.log("[archiver.startOrQueueArchive] Active jobs:", active.length);

  if (active.length > 0) {
    console.log("[archiver.startOrQueueArchive] Job queued, another is archiving");
    await db
      .update(jobs)
      .set({ status: "QUEUED", updatedAt: new Date().toISOString() })
      .where(eq(jobs.id, id));
    return;
  }

  await startArchiveJob(id);
}

export async function startArchiveJob(id: string) {
  console.log("[archiver.startArchiveJob] Starting archive for job:", id);
  
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  if (!job) {
    console.error("[archiver.startArchiveJob] Job not found:", id);
    return;
  }

  console.log("[archiver.startArchiveJob] Job details:", {
    id: job.id,
    filename: job.filename,
    sizeBytes: job.sizeBytes,
    destinationPath: job.destinationPath,
  });

  const srcFs = path.join(config.stagingDir, id) + path.sep;
  const srcRemote = job.filename;
  const dstFs = config.rcloneRemote;
  const dstRemote = `${job.destinationPath}${job.filename}`;

  console.log("[archiver.startArchiveJob] rclone copyfile params:", {
    srcFs,
    srcRemote,
    dstFs,
    dstRemote,
  });

  const { copyFile } = await import("./rclone.server");
  
  try {
    const { jobid } = await copyFile(srcFs, srcRemote, dstFs, dstRemote);
    console.log("[archiver.startArchiveJob] rclone job started, jobid:", jobid);

    await db
      .update(jobs)
      .set({
        status: "ARCHIVING",
        rcloneJobId: jobid,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(jobs.id, id));

    watchJob(id, jobid);
  } catch (err) {
    console.error("[archiver.startArchiveJob] Error starting archive:", err);
    throw err;
  }
}
