import { eq, or, and, isNull } from "drizzle-orm";
import archiver from "archiver";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { db } from "../db/client.server";
import { jobs } from "../db/schema";
import { config } from "../lib/config.server";
import { logger } from "../lib/logger.server";
import { cleanupFull } from "../lib/jobWatcher.server";

export async function loader({ request }: { request: Request }) {
  logger.info("[api/download-all] Download all requested");

  const readyJobs = await db
    .select()
    .from(jobs)
    .where(
      and(
        isNull(jobs.downloadedAt),
        or(
          eq(jobs.status, "DECODED"),
          eq(jobs.status, "QUEUED"),
          eq(jobs.status, "ARCHIVING"),
          eq(jobs.status, "VERIFYING"),
          eq(jobs.status, "COMPLETED")
        )
      )
    );

  if (readyJobs.length === 0) {
    return Response.json(
      { error: "No files ready for download" },
      { status: 404 }
    );
  }

  logger.info("[api/download-all] Found jobs to download:", { count: readyJobs.length });

  const archive = archiver("zip", {
    zlib: { level: 0 },
  });

  let resolveStream: (value: ReadableStream<Uint8Array>) => void;
  let rejectStream: (reason?: unknown) => void;
  
  const streamPromise = new Promise<ReadableStream<Uint8Array>>((resolve, reject) => {
    resolveStream = resolve;
    rejectStream = reject;
  });

  const reader = new ReadableStream({
    start(controller) {
      archive.on("data", (chunk: Uint8Array) => controller.enqueue(chunk));
      archive.on("end", () => controller.close());
      archive.on("error", (err) => controller.error(err));
      resolveStream(controller as any);
    },
  });

  for (const job of readyJobs) {
    const m4bFilename = job.filename.replace(/\.aax$/i, ".m4b");
    const m4bPath = path.join(config.stagingDir, job.id, m4bFilename);

    try {
      await fs.access(m4bPath);
      archive.file(m4bPath, { name: m4bFilename });
      logger.debug("[api/download-all] Added to archive:", { jobId: job.id, filename: m4bFilename });
    } catch {
      logger.warn("[api/download-all] M4B file not found, skipping:", { jobId: job.id, m4bPath });
    }
  }

  archive.finalize();

  await new Promise<void>((resolve, reject) => {
    archive.on("close", resolve);
    archive.on("error", reject);
  });

  const zipSize = archive.pointer();
  const now = new Date().toISOString();

  const dateStr = new Date().toISOString().split("T")[0];
  const headers = new Headers();
  headers.set("Content-Type", "application/zip");
  headers.set("Content-Disposition", `attachment; filename="audiobooks-${dateStr}.zip"`);
  headers.set("Content-Length", String(zipSize));

  for (const job of readyJobs) {
    const m4bFilename = job.filename.replace(/\.aax$/i, ".m4b");
    const m4bPath = path.join(config.stagingDir, job.id, m4bFilename);

    try {
      await fs.access(m4bPath);
      await db
        .update(jobs)
        .set({
          downloadedAt: now,
          updatedAt: now,
        })
        .where(eq(jobs.id, job.id));
      logger.info("[api/download-all] Marked as downloaded:", { jobId: job.id });
    } catch {
      logger.warn("[api/download-all] Skipping mark - M4B not found:", { jobId: job.id });
    }
  }

  for (const job of readyJobs) {
    if (job.status === "COMPLETED") {
      await cleanupFull(job.id);
    }
  }

  return new Response(reader, { headers });
}
