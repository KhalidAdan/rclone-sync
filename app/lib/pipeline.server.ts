import { eq } from "drizzle-orm";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { db } from "../db/client.server";
import { jobs } from "../db/schema";
import { decodeAax } from "./decoder.server";
import { startOrQueueArchive } from "./archiver.server";
import { logJobEvent } from "./jobEvents.server";
import { config } from "./config.server";
import { logger } from "./logger.server";

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

    // Exact M4B size feeds Content-Length/Range when streaming later.
    const { size: m4bSizeBytes } = await fs.stat(outputPath);

    await db
      .update(jobs)
      .set({
        status: "DECODED",
        m4bSizeBytes,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(jobs.id, jobId));

    await logJobEvent(jobId, "decoded", `Decoded to ${outputFilename}`);

    // Metadata + cover while the file is local — cheap, and the library
    // card is fully dressed by the time the book completes.
    const { probeLocalAndApply } = await import("./metadata.server");
    await probeLocalAndApply(jobId, outputPath);

    logger.info("[pipeline.runDecodeStep] Decode succeeded, starting archive:", { jobId });
    await startOrQueueArchive(jobId);

    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[pipeline.runDecodeStep] Decode failed:", { jobId, error: message });

    // Don't leave a partial M4B behind — it would be picked up by the
    // download endpoints' "does the M4B exist" check.
    await fs.rm(outputPath, { force: true }).catch(() => {});

    await db
      .update(jobs)
      .set({
        status: "DECODE_FAILED",
        error: JSON.stringify({ phase: "DECODING", message }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(jobs.id, jobId));

    await logJobEvent(jobId, "failed", `Decode failed: ${message}`);

    return false;
  }
}
