import { eq, or, and, isNull, inArray } from "drizzle-orm";
import archiver from "archiver";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { db } from "../db/client.server";
import { jobs } from "../db/schema";
import { config } from "../lib/config.server";
import { logger } from "../lib/logger.server";
import { cleanupFull } from "../lib/jobWatcher.server";

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const jobIds = url.searchParams.get("ids")?.split(",").filter(Boolean) ?? [];

  if (jobIds.length === 0) {
    return Response.json(
      { error: "No jobs selected" },
      { status: 400 }
    );
  }

  logger.info("[api/download-selected] Download requested:", { count: jobIds.length });

  const readyJobs = await db
    .select()
    .from(jobs)
    .where(
      and(
        inArray(jobs.id, jobIds),
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

  const filesToDownload: { jobId: string; m4bPath: string; m4bFilename: string; status: string }[] = [];

  for (const job of readyJobs) {
    const m4bFilename = job.filename.replace(/\.aax$/i, ".m4b");
    const m4bPath = path.join(config.stagingDir, job.id, m4bFilename);
    try {
      await fs.access(m4bPath);
      filesToDownload.push({ jobId: job.id, m4bPath, m4bFilename, status: job.status });
    } catch {
      logger.warn("[api/download-selected] M4B file not found, skipping:", { jobId: job.id });
    }
  }

  if (filesToDownload.length === 0) {
    return Response.json({ error: "No M4B files found on disk" }, { status: 404 });
  }

  logger.info("[api/download-selected] Found files to download:", { count: filesToDownload.length });

  const archive = archiver("zip", { zlib: { level: 0 } });

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

  for (const file of filesToDownload) {
    archive.file(file.m4bPath, { name: file.m4bFilename });
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

  const downloadedIds = filesToDownload.map((f) => f.jobId);

  await db
    .update(jobs)
    .set({ downloadedAt: now, updatedAt: now })
    .where(inArray(jobs.id, downloadedIds));

  logger.info("[api/download-selected] Marked as downloaded:", { count: downloadedIds.length });

  const cleanupPromises = filesToDownload
    .filter((f) => f.status === "COMPLETED")
    .map((f) => cleanupFull(f.jobId));
  await Promise.all(cleanupPromises);

  return new Response(reader, { headers });
}