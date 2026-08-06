import { logger } from "@/lib/logger.server";
import { abortable, fromReadableStream, pipe, tap, writeTo } from "@culvert/stream";
import { parseFormData } from "@remix-run/form-data-parser";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Writable } from "node:stream";
import { db } from "../db/client.server";
import { jobs } from "../db/schema";
import { logJobEvent } from "../lib/jobEvents.server";
import { config } from "../lib/config.server";
import { processJob } from "../lib/pipeline.server";

const MAX_UPLOAD_SIZE = 1.5 * 1024 * 1024 * 1024; // 1.5GB
const PROGRESS_LOG_INTERVAL = 250 * 1024 * 1024; // 250MB

class ValidationError extends Error {}

/**
 * Client-supplied remote path → safe remote prefix. Strips traversal and
 * guarantees a single trailing slash (so `Fiction/Fantasy` and
 * `Fiction/Fantasy/` both file the book under that folder instead of
 * silently producing `Fiction/FantasyBook.aax`).
 */
function normalizeDestinationPath(input: string): string {
  const parts = input
    .replaceAll("\\", "/")
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p !== "" && p !== "." && p !== "..");
  return parts.length > 0 ? parts.join("/") + "/" : "";
}

export async function action({ request }: { request: Request }) {
  const url = new URL(request.url);
  const destinationPath = normalizeDestinationPath(
    url.searchParams.get("destinationPath") || "",
  );

  logger.info("[api/upload] destinationPath:", { path: destinationPath });

  try {
    const uploaded = await stageUpload(request, destinationPath);

    if (!uploaded) {
      return Response.json({ error: "No file provided" }, { status: 400 });
    }

    processJob(uploaded.jobId).catch((err) =>
      logger.error("[api/upload] Pipeline error:", {
        error: String(err),
        jobId: uploaded.jobId,
      }),
    );

    return Response.json(uploaded);
  } catch (err) {
    if (err instanceof ValidationError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: "Upload failed", details: message },
      { status: 500 },
    );
  }
}

function uploadProgress(jobId: string, intervalBytes: number) {
  let bytes = 0;
  let lastLogged = 0;
  return {
    observe: tap<Uint8Array>(async (chunk) => {
      bytes += chunk.length;
      if (bytes - lastLogged >= intervalBytes) {
        lastLogged = bytes;
        await logJobEvent(
          jobId,
          "created",
          `Uploading: ${(bytes / 1024 / 1024).toFixed(1)} MB`,
        );
      }
    }),
    getBytes: () => bytes,
  };
}

async function streamToDisk(
  jobId: string,
  source: ReadableStream<Uint8Array>,
  dest: string,
  signal: AbortSignal,
) {
  const nodeWritable = fsSync.createWriteStream(dest);
  const progress = uploadProgress(jobId, PROGRESS_LOG_INTERVAL);
  try {
    await pipe(
      abortable(fromReadableStream(source), signal),
      progress.observe,
      writeTo(Writable.toWeb(nodeWritable)),
    );
  } catch (error) {
    await logJobEvent(
      jobId,
      "failed",
      `Upload aborted at ${(progress.getBytes() / 1024 / 1024).toFixed(1)} MB`,
    );
    await fs.unlink(dest).catch(() => {});
    throw error;
  }

  return { sizeBytes: progress.getBytes() };
}

async function stageUpload(
  request: Request,
  destinationPath: string,
): Promise<{ jobId: string; filename: string; sizeBytes: number } | null> {
  let result: { jobId: string; filename: string; sizeBytes: number } | null =
    null;

  await parseFormData(
    request,
    { maxFileSize: MAX_UPLOAD_SIZE },
    async (fileUpload) => {
      if (fileUpload.fieldName === "file") {
        const id = randomUUID();
        // basename() strips any client-supplied directory components —
        // a name like "..\evil.aax" must not escape the staging dir.
        const filename = path.basename(fileUpload.name.replaceAll("\\", "/"));

        if (!filename.toLowerCase().endsWith(".aax")) {
          logger.warn("[api/upload] Rejected non-AAX file:", { filename });
          throw new ValidationError("Only .aax files are accepted");
        }

        const now = new Date().toISOString();

        await db.insert(jobs).values({
          id,
          filename,
          sizeBytes: 0,
          destinationPath,
          status: "UPLOADING",
          createdAt: now,
          updatedAt: now,
        });

        await logJobEvent(id, "created", `Upload started: ${filename}`);

        const jobStagingDir = path.join(config.stagingDir, id);
        await fs.mkdir(jobStagingDir, { recursive: true });
        const dest = path.join(jobStagingDir, filename);

        try {
          const { sizeBytes } = await streamToDisk(
            id,
            fileUpload.stream(),
            dest,
            request.signal,
          );

          await db
            .update(jobs)
            .set({
              status: "STAGED",
              sizeBytes,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(jobs.id, id));

          await logJobEvent(
            id,
            "created",
            `File staged: ${filename} (${(sizeBytes / 1024 / 1024).toFixed(2)} MB)`,
          );

          result = { jobId: id, filename, sizeBytes };
        } catch (err) {
          // Client disconnect or disk error mid-stream: don't leave a
          // zombie UPLOADING row behind.
          await db
            .update(jobs)
            .set({
              status: "UPLOAD_FAILED",
              error: JSON.stringify({
                phase: "UPLOADING",
                message: err instanceof Error ? err.message : String(err),
              }),
              updatedAt: new Date().toISOString(),
            })
            .where(eq(jobs.id, id));
          await fs.rm(jobStagingDir, { recursive: true, force: true }).catch(() => {});
          throw err;
        }
      }
    },
  );

  return result;
}
