import { logger } from "@/lib/logger.server";
import { parseFormData } from "@remix-run/form-data-parser";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { db } from "../db/client.server";
import { jobEvents, jobs } from "../db/schema";
import { processJob } from "../lib/pipeline.server";
import { config } from "../lib/config.server";

const MAX_UPLOAD_SIZE = 1.5 * 1024 * 1024 * 1024; // 1.5GB
const PROGRESS_LOG_INTERVAL = 250 * 1024 * 1024; // 250MB

async function logJobEvent(
  jobId: string,
  eventType:
    | "created"
    | "decoding"
    | "decoded"
    | "queued"
    | "archiving"
    | "verifying"
    | "completed"
    | "failed"
    | "abandoned",
  message: string,
) {
  const now = new Date().toISOString();
  await db.insert(jobEvents).values({
    jobId,
    eventType,
    message,
    timestamp: now,
  });
}

export async function action({ request }: { request: Request }) {
  const url = new URL(request.url);
  const destinationPath = url.searchParams.get("destinationPath") || "";

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
      })
    );

    return Response.json(uploaded);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: "Upload failed", details: message },
      { status: 500 },
    );
  }
}

async function stageUpload(
  request: Request,
  destinationPath: string
): Promise<{ jobId: string; filename: string; sizeBytes: number } | null> {
  let result: { jobId: string; filename: string; sizeBytes: number } | null =
    null;

  await parseFormData(
    request,
    { maxFileSize: MAX_UPLOAD_SIZE },
    async (fileUpload) => {
      if (fileUpload.fieldName === "file") {
        const id = randomUUID();
        const filename = fileUpload.name;

        if (!filename.toLowerCase().endsWith(".aax")) {
          logger.warn("[api/upload] Rejected non-AAX file:", { filename });
          throw new Error("Only .aax files are accepted");
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
        const writable = fsSync.createWriteStream(dest);
        const reader = fileUpload.stream().getReader();
        let bytesWritten = 0;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            await new Promise<void>((resolve, reject) => {
              writable.write(value, (err) =>
                err ? reject(err) : resolve()
              );
            });

            bytesWritten += value.length;

            if (bytesWritten % PROGRESS_LOG_INTERVAL < value.length) {
              await logJobEvent(
                id,
                "created",
                `Uploading: ${(bytesWritten / 1024 / 1024).toFixed(1)} MB`,
              );
            }
          }
        } finally {
          writable.end();
        }

        const sizeBytes = (await fs.stat(dest)).size;
        const timestamp = new Date().toISOString();

        await db
          .update(jobs)
          .set({
            status: "STAGED",
            sizeBytes,
            updatedAt: timestamp,
          })
          .where(eq(jobs.id, id));

        await logJobEvent(
          id,
          "created",
          `File staged: ${filename} (${(sizeBytes / 1024 / 1024).toFixed(2)} MB)`,
        );

        result = { jobId: id, filename, sizeBytes };
      }
    },
  );

  return result;
}
