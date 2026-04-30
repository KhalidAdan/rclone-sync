import { eq } from "drizzle-orm";
import * as path from "node:path";
import { db } from "../db/client.server";
import { jobs, jobEvents } from "../db/schema";
import { decodeAax } from "./decoder.server";
import { startOrQueueArchive } from "./archiver.server";
import { config } from "./config.server";
import { logger } from "./logger.server";

async function logJobEvent(
  jobId: string,
  eventType: "created" | "decoding" | "decoded" | "queued" | "archiving" | "verifying" | "completed" | "failed" | "abandoned",
  message: string
) {
  const now = new Date().toISOString();
  await db.insert(jobEvents).values({
    jobId,
    eventType,
    message,
    timestamp: now,
  });
}

export async function processJob(jobId: string): Promise<void> {
  logger.info("[pipeline.processJob] Starting pipeline for job:", { jobId });

  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) {
    logger.error("[pipeline.processJob] Job not found:", { jobId });
    return;
  }

  await runDecodeStep(jobId, job.filename);
}

async function runDecodeStep(jobId: string, filename: string): Promise<boolean> {
  logger.info("[pipeline.runDecodeStep] Starting decode for job:", { jobId, filename });

  const stagingDir = path.join(config.stagingDir, jobId);
  const inputPath = path.join(stagingDir, filename);
  const outputFilename = filename.replace(/\.aax$/i, ".m4b");
  const outputPath = path.join(stagingDir, outputFilename);

  await db
    .update(jobs)
    .set({
      status: "DECODING",
      updatedAt: new Date().toISOString(),
    })
    .where(eq(jobs.id, jobId));

  await logJobEvent(jobId, "decoding", `Decoding ${filename} to M4B...`);

  try {
    await decodeAax(inputPath, outputPath, config.activationBytes);

    await db
      .update(jobs)
      .set({
        status: "DECODED",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(jobs.id, jobId));

    await logJobEvent(jobId, "decoded", `Decoded to ${outputFilename}`);

    logger.info("[pipeline.runDecodeStep] Decode succeeded, starting archive:", { jobId });
    await startOrQueueArchive(jobId);

    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[pipeline.runDecodeStep] Decode failed:", { jobId, error: message });

    await db
      .update(jobs)
      .set({
        status: "DECODE_FAILED",
        error: JSON.stringify({ step: "decode", message }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(jobs.id, jobId));

    await logJobEvent(jobId, "failed", `Decode failed: ${message}`);

    return false;
  }
}
